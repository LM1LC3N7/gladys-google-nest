# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for
human contributors.

## What this is

A Gladys Assistant **external integration** of type `device`: a Node.js
service (Node 22+, ESM, no build step) in its own sandboxed Docker container,
talking to Gladys through `@gladysassistant/integration-sdk` (v0.14). It
brings the Google Nest thermostats, cameras, doorbells and displays into
Gladys through the official **Smart Device Management (SDM) API**, with the
user's own Device Access project and Google Cloud OAuth client, and the
events through the user's own **Cloud Pub/Sub** topic. Unofficial: not
affiliated with Google.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npm run audit                             # npm audit --omit=dev
npx github:GladysAssistant/integration-store .   # store admission checks
```

Run `format:check`, `lint`, `test` and `audit` before every commit.

## Architecture

```
index.js                SDK wiring only (handlers registered before connect())
src/app.js              NestApp: lifecycle, refresh, commands, events, OAuth
src/config.js           config_schema + off-schema token keys, normalized
src/google/oauth.js     PCM authorize URL, code exchange, TokenManager
src/google/sdm.js       SDM REST: devices.list, executeCommand (spaced)
src/google/pubsub.js    Pub/Sub REST: subscription, pull loop, ack
src/google/authorized.js  one retry with a fresh token on 401
src/nest/traits.js      SDM traits -> plain values (pure)
src/nest/devices.js     SDM device -> Gladys device + states (pure)
src/nest/commands.js    Gladys value -> SDM commands (pure)
src/nest/events.js      Pub/Sub message -> trait update / events (pure)
src/camera.js           pictures: RTSP frame, event image, clip preview
src/ffmpeg.js           the only child process (one JPEG frame on stdout)
src/http.js             the only network access (fetch, timeouts, errors)
src/i18n.js             runtime texts (en/fr)
test/fixtures/          SDM device list shaped like Google's answers
test/helpers/           fake fetch, fake Gladys SDK, fake timers
```

No Google client library: `googleapis` costs about 160 MB of memory and the
Pub/Sub gRPC client about 90 MB, in a 256 MB sandbox, for six REST calls.

## Rules

- **Unofficial.** Every user-facing surface (manifest description and intro,
  cover, README, docs) says "unofficial connector, not affiliated with
  Google". Never use Google or Nest logos, icons or the Nest blue #00AFD8.
- **Keys are forever**: manifest `config_schema`, `actions`,
  `scene_triggers` and `scene_actions` keys, the feature keys of
  `src/nest/devices.js` (`FEATURE`), the device types of the external_ids
  (`thermostat`, `camera`, `doorbell`, `display`) and the off-schema config
  keys (`oauth_refresh_token`…) are stored in user scenes, dashboards and
  configs. Never rename them.
- **No hosted service**: authentication must work for anyone with only a
  local Gladys. Never depend on Gladys Plus or on a server of the author;
  keep the local connection (`google_account_local`, redirect
  `https://www.google.com`, pasted into `finish_local_connection`) working.
- **Gladys acks the OAuth relays within 5 s**: `onOAuthCallback` exchanges
  the code, stores the refresh token, acks, and reads the devices in the
  background. Never hardcode the redirect URI: use the one Gladys hands over,
  byte for byte, in the exchange.
- **Google quotas** (Sandbox): devices.list 5/min, executeCommand 10/min, the
  same command on one device 5/min. Keep the refresh at 1 minute or more and
  the per-device command spacing (`COMMAND_MIN_INTERVAL`).
- **Events are a nice-to-have**: everything must keep working without the
  Pub/Sub topic (periodic refresh). Messages are acked before they are
  handled (a doorbell press replayed minutes later is worse than a missed
  one), and event ages are judged on Google's clock (`googleClockOffset`).
- **Lifecycle**: `start()` and `stop()` are serialized; code running inside a
  start calls `doStop()`, never `stop()` (it would wait for itself).
- **Pictures**: ≤ 150 KB (`fitJpeg`), ≤ 12 per minute per camera (we publish
  one every 10 s at most), onGetImage under 15 s (`SNAPSHOT_TIMEOUT`).
- **Never log a credential**: tokens, stream URLs (`auth=` query) go through
  `redact()` or are not logged. The bearer token only goes to Google hosts
  (`isGoogleUrl`): a clip URL comes from a Pub/Sub message.
- **Memory** (256 MB): one picture job (download + ffmpeg) at a time,
  downloads capped (`MAX_CLIP_SIZE`, `MAX_IMAGE_SIZE`).
- **Read-only rootfs**: write nothing outside `/data`. The only file we
  write is an event clip in `/data/tmp`, while ffmpeg reads it (an mp4 whose
  index comes last cannot be read from a pipe), removed right after.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag.
- **Changelog**: every user-visible change adds a line under
  `## [Unreleased]` in `CHANGELOG.md`.
- **Manifest texts** are `{ en, fr }` objects; the catalog description holds
  10 to 100 characters per language; `test/manifest.test.js` ties the
  manifest to the code.
- **User-facing text** is bilingual, `docs/en.md` and `docs/fr.md` kept in
  sync. Comments explain why, in English.
- **Tests never touch the network** (`installFetch` throws on an unknown URL)
  nor run ffmpeg (`setFfmpegRunner`).

## CI and pushes

- Group the commits and push **at most once a day**, unless the maintainer
  explicitly asks otherwise: the GitHub Actions quota is limited.
- If every CI job fails in under 2 seconds, the quota is exhausted: it is
  not a bug in the code.
- The Docker image cannot be built in the Claude Code cloud container (no
  network for `apk` inside `docker build`): the CI builds it.
