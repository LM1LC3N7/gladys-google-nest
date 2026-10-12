# TODO

## Before the first release

- [ ] Test on a real Gladys 5.1+ with a real Device Access project: OAuth
      through https://my.gladysassistant.com/redirect/oauth, consent in the
      Partner Connections Manager, first devices.list.
- [ ] Check the Docker image in CI (ffmpeg from apk, multi-arch).
- [ ] Draw the cover (800×534, ≤ 150 KB, no Google or Nest logo, no Nest blue
      #00AFD8), then run the store validator.
- [ ] Reserve "Google Nest" in the forum thread t/10385 (row #22 of the
      ideas list below, "Cloud", available on 2026-10-12), then add the
      `gladys-assistant-integration` topic to publish in the store.
- [ ] Turn on "Private vulnerability reporting" (SECURITY.md points there).

## To confirm on real devices

- [ ] Thermostat E and Learning Thermostat 4th gen: traits and setpoint range.
- [ ] Does the Pub/Sub pull need a billing account on the Cloud project?
- [ ] Event picture of an RTSP camera fetched within 30 s, clip preview of a
      battery doorbell through ffmpeg over HTTPS.
- [ ] Sound events (CameraSound) on which models.

## Ideas

- The maintainer's list of 1,190 integration ideas, by priority, with
  access (local / cloud), "no hardware needed" and claim status:
  <https://gist.github.com/Pierre-Gilles/9c4ba77a0faa47c4ea67c74351db9094>.
  Related to this connector: #423 Google Nest Protect and #839 Nest Legacy,
  both only reachable through the unofficial cookie API (not the SDM API).
- Live picture of WebRTC cameras: a WebRTC client (werift) feeding ffmpeg.
  Heavy for the 256 MB sandbox; only if users ask.
- Gladys Plus webhook as an alternative to the Pub/Sub pull.
- A "doorbell" dashboard widget (last picture, last ring), like Ring's.
- Thermostat schedule: expose the Nest eco temperatures as presets.
