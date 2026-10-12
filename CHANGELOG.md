# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [1.0.0] - 2026-10-12

### Added

- Local Google account connection through the official Smart Device
  Management API (your own Device Access project and Google Cloud OAuth
  client), never through Gladys Plus, a server of the author or a third-party
  redirect page: Google's own redirect page, and a copy and paste of its
  address into the "Finish the connection" action.
- Setup guide: Matter-compatible Nest thermostats (2020, Learning 4th gen)
  can be paired locally with the Gladys Matter integration instead.
- Thermostats: temperature, humidity, activity (heating, cooling, idle), mode
  (heat, cool, heat · cool, off), heating and cooling setpoints, Eco and fan
  timer.
- Cameras, doorbells and Nest Hub Max: picture (live for RTSP cameras, event
  picture or clip preview frame for WebRTC ones), motion, person and doorbell
  states.
- Real-time events from your own Pub/Sub topic (no Gladys Plus needed): the
  integration creates its subscription, updates the thermostats instantly and
  fires the scene triggers "doorbell pressed", "motion detected", "person
  detected" and "sound detected".
- Scene action "take a Nest snapshot", "Test the connection" button, and
  configurable refresh, snapshot and fan run time.

[Unreleased]: https://github.com/LM1LC3N7/gladys-google-nest/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/LM1LC3N7/gladys-google-nest/releases/tag/v1.0.0
