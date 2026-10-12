# Google Nest for Gladys Assistant

**Unofficial connector, not affiliated with Google.** A
[Gladys Assistant](https://gladysassistant.com) external integration that
brings the Google Nest thermostats, cameras, doorbells and Nest Hub Max into
Gladys, through Google's official
[Smart Device Management API](https://developers.google.com/nest/device-access)
and your own Device Access project. Google Nest is a trademark of Google LLC.

- **Thermostats**: temperature, humidity, activity, mode, heating and cooling
  setpoints, Eco, fan timer.
- **Cameras and doorbells**: picture (live for RTSP cameras, last event for
  WebRTC ones), motion, person, doorbell press.
- **Events** from your own Pub/Sub topic, without Gladys Plus: instant
  thermostat updates and the scene triggers "doorbell pressed", "motion
  detected", "person detected", "sound detected".
- Scene action "take a Nest snapshot", "Test the connection" button.

User guide and setup (Device Access, Cloud project, OAuth client, Pub/Sub):
[English](docs/en.md) · [Français](docs/fr.md).

Requires Gladys 5.1 or later.

## How it works

```
Gladys ◄─ WebSocket ─► this container ── HTTPS ──► smartdevicemanagement.googleapis.com
                              │                    pubsub.googleapis.com (pull)
                              └── ffmpeg (one JPEG frame of an RTSP stream or of an event clip)
```

- **Local first**: Matter-compatible thermostats (Nest Thermostat 2020,
  Learning Thermostat 4th gen) are better paired with the Gladys Matter
  integration, fully local. Cameras and the other thermostats have no local
  interface: this connector uses Google's cloud API.
- **Two ways to connect, without Gladys Plus nor any server of the author**:
  each user brings their own Device Access project and OAuth client. The
  `google_account` field (`oauth2`) lets the Gladys frontend carry the flow
  (its static redirect page, or the instance itself over HTTPS) and bring
  the code back; the `google_account_local` field (`account_link`) opens the
  consent with Google's own page `https://www.google.com` as redirect URI,
  and the user pastes the address it ends on into the
  `finish_local_connection` action. Both exchange the code in the container;
  the refresh token is stored in the integration config, outside the schema.
- **Events made easy**: given the Cloud project ID, the integration creates
  the Pub/Sub topic, grants `sdm-publisher@googlegroups.com` the publisher
  role and creates its subscription; only the topic name is left to paste in
  the Device Access console.
- **Sync**: a `devices.list` every few minutes (the source of truth), the
  Pub/Sub events in between, and the state implied by each successful
  command, published at once.
- **No Google client library**: plain `fetch` on six REST endpoints. The
  official libraries cost 90 to 160 MB of memory in a 256 MB sandbox.

## Development

```bash
npm install
npm test               # node --test: no network, no ffmpeg (both faked)
npm run lint
npm run format:check
npm run audit
npx github:GladysAssistant/integration-store .   # store admission checks
```

See [`CLAUDE.md`](CLAUDE.md) for the architecture and the project rules, and
[`TODO.md`](TODO.md) for what remains before the first release.

## Release

Describe the changes under `## [Unreleased]` in [`CHANGELOG.md`](CHANGELOG.md),
then **Actions → Release → Run workflow** (`patch` / `minor` / `major`): it
bumps the versions, tags, builds the multi-arch image to
`ghcr.io/lm1lc3n7/gladys-google-nest` and publishes the GitHub Release.
The GitHub topic `gladys-assistant-integration` publishes the connector in
the Gladys store (indexed hourly): add it once the first release is tested.

## Licence

Apache-2.0. Not affiliated with, endorsed or sponsored by Google LLC.
