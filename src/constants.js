// -----------------------------------------------------------------------------
// Constants: endpoints, timeouts, intervals and Google limits.
// -----------------------------------------------------------------------------

export const USER_AGENT = 'gladys-google-nest (+https://github.com/LM1LC3N7/gladys-google-nest)';

export const SDM_API = 'https://smartdevicemanagement.googleapis.com/v1';
export const PUBSUB_API = 'https://pubsub.googleapis.com/v1';
export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
// Partner Connections Manager: the Nest consent screen of a Device Access
// project, where the user picks the homes and devices to share.
export const PCM_URL = 'https://nestservices.google.com/partnerconnections';

// sdm.service reads and commands the devices; pubsub lets the same token pull
// the device events from the user's own Cloud project (no service account).
export const OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/sdm.service',
  'https://www.googleapis.com/auth/pubsub',
];

// Gladys acks the OAuth relays and the commands within 5 s: their Google
// calls (token included) must fit.
export const OAUTH_TIMEOUT = 3_000;
export const COMMAND_TIMEOUT = 4_000;
export const HTTP_TIMEOUT = 10_000;
// A Pub/Sub pull without returnImmediately is held by Google until messages
// arrive or its own deadline (well under a minute): the client waits longer.
export const PULL_TIMEOUT = 90_000;
export const PULL_MAX_MESSAGES = 50;

// An access token lives one hour: refresh it a bit before it expires.
export const TOKEN_REFRESH_MARGIN = 5 * 60_000;
// A pending authorization (state) older than this is refused.
export const OAUTH_STATE_TTL = 30 * 60_000;

// Sandbox quotas (per project and user): devices.list 5/min, executeCommand
// and devices.get 10/min, and the same command on one device 5/min. The same
// command is spaced by a second on a device, and a value waiting its turn is
// replaced by a newer one (a slider drag sends one command, not ten).
export const COMMAND_MIN_INTERVAL = 1_000;

// Backoff of the event loop after an error: 5 s, doubled up to 5 minutes.
export const PULL_BACKOFF_MIN = 5_000;
export const PULL_BACKOFF_MAX = 5 * 60_000;
// Consecutive pull failures before the status shows the events as broken.
export const PULL_FAILURES_REPORTED = 3;
// An empty pull answered at once is followed by this pause (no busy loop).
export const PULL_MIN_PERIOD = 1_000;
// Pub/Sub keeps unacknowledged messages for days: an event published longer
// ago than this (a backlog after a restart) updates states but fires nothing.
export const EVENT_MAX_AGE = 3 * 60_000;

// A motion, person or sound detection is shown on its binary feature for this
// long, then cleared: Nest sends no "motion ended" event.
export const DETECTION_HOLD = 60_000;
// A doorbell press is cleared faster: it is a push, not a state.
export const DOORBELL_HOLD = 10_000;
// The same event (one Nest event session) never fires a scene twice.
export const EVENT_DEDUP_TTL = 10 * 60_000;

// Event images must be fetched within 30 s of the event (Google's limit).
export const EVENT_IMAGE_TTL = 30_000;
// Gladys accepts a camera image string of at most 150 KB, prefix included.
export const CAMERA_IMAGE_PREFIX = 'image/jpg;base64,';
export const MAX_CAMERA_IMAGE_LENGTH = 150 * 1024;
// The only writable place of the sandbox (read-only rootfs).
export const DATA_DIR = '/data';
// An event clip preview is a few seconds of video, an event image a JPEG:
// refuse anything bigger before downloading it (256 MB sandbox).
export const MAX_CLIP_SIZE = 8 * 1024 * 1024;
export const MAX_IMAGE_SIZE = 4 * 1024 * 1024;
// The bearer token is only sent to Google hosts (a clip URL comes from a
// Pub/Sub message, which anyone allowed on the topic can publish).
export const GOOGLE_HOSTS = [
  '.googleapis.com',
  '.google.com',
  '.googleusercontent.com',
  '.nest.com',
];
// Gladys awaits onGetImage under 15 s: the whole capture (stream, ffmpeg,
// shrinking) must end before.
export const SNAPSHOT_TIMEOUT = 13_000;
// Gladys accepts 12 images a minute per camera; we stay far below.
export const MIN_IMAGE_INTERVAL = 10_000;

// Nest thermostats accept setpoints from 9 to 32 °C.
export const SETPOINT_MIN = 9;
export const SETPOINT_MAX = 32;
