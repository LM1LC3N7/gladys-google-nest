// -----------------------------------------------------------------------------
// Camera pictures.
//
// Nest cameras come in two families (the CameraLiveStream protocols):
//   - RTSP (older Nest Cams, Hub Max, wired doorbell): a live stream URL valid
//     5 minutes, from which ffmpeg grabs one frame on demand; their events
//     also offer a still picture (GenerateImage, within 30 s of the event);
//   - WebRTC (every newer model): no RTSP and no still picture. Their events
//     carry a short clip preview (an mp4), whose first frame becomes the
//     picture. A live picture would need a WebRTC stack in the container.
// Gladys gets the picture through publishCameraImage (events, periodic
// snapshots) or onGetImage (dashboard, chat), under 150 KB.
//
// Memory: one picture job (download + ffmpeg) at a time, whatever the number
// of cameras firing together: the sandbox has 256 MB.
// -----------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CAMERA_IMAGE_PREFIX,
  COMMAND_TIMEOUT,
  DATA_DIR,
  MAX_CAMERA_IMAGE_LENGTH,
  MAX_CLIP_SIZE,
  MAX_IMAGE_SIZE,
  MIN_IMAGE_INTERVAL,
  SNAPSHOT_TIMEOUT,
} from './constants.js';
import { grabFileFrame, grabRtspFrame, shrinkJpeg } from './ffmpeg.js';
import { isGoogleUrl, requestBuffer } from './http.js';
import { COMMANDS } from './nest/commands.js';
import { readCamera } from './nest/traits.js';

// Successive re-encodings, from the mildest: [max width, ffmpeg -q:v].
const SHRINK_STEPS = [
  [1280, 9],
  [960, 11],
  [640, 13],
  [480, 16],
];

export function fitsGladys(buffer) {
  return CAMERA_IMAGE_PREFIX.length + Math.ceil(buffer.length / 3) * 4 <= MAX_CAMERA_IMAGE_LENGTH;
}

export function toCameraImage(buffer) {
  return `${CAMERA_IMAGE_PREFIX}${buffer.toString('base64')}`;
}

/**
 * Shrink a JPEG until Gladys accepts it, within `timeLeft()` milliseconds
 * (the frames are already grabbed at 1280 px: this rarely runs).
 */
export async function fitJpeg(buffer, timeLeft = () => SNAPSHOT_TIMEOUT) {
  let last = buffer;
  for (const [width, quality] of SHRINK_STEPS) {
    if (fitsGladys(last)) {
      return last;
    }
    last = await shrinkJpeg(buffer, { timeout: remaining(timeLeft), width, quality });
  }
  if (!fitsGladys(last)) {
    throw new Error('The picture is too big for Gladys even once shrunk');
  }
  return last;
}

function remaining(timeLeft) {
  const ms = timeLeft();
  if (ms < 500) {
    throw new Error('No time left to take the picture');
  }
  return ms;
}

/** The user-facing reason a camera has no live picture. */
export class NoPictureError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NoPictureError';
  }
}

export class CameraPictures {
  /**
   * @param {{ gladys: object, sdm: import('./google/sdm.js').SdmClient,
   *   tokens: import('./google/oauth.js').TokenManager, logger: object,
   *   now?: () => number, tmpDir?: string }} options
   *   `tmpDir` holds the event clips while ffmpeg reads them (under /data,
   *   the only writable place of the sandbox).
   */
  constructor({ gladys, sdm, tokens, logger, now = Date.now, tmpDir = join(DATA_DIR, 'tmp') }) {
    this.gladys = gladys;
    this.sdm = sdm;
    this.tokens = tokens;
    this.logger = logger;
    this.now = now;
    this.tmpDir = tmpDir;
    this.tmpReady = undefined;
    // Per Gladys device: { image, at } of the last picture.
    this.last = new Map();
    // Per Gladys device: the live capture in progress (one at a time).
    this.inFlight = new Map();
    // Per Gladys device: when a picture was last published.
    this.published = new Map();
    // The tail of the picture jobs: one download and one ffmpeg at a time.
    this.slot = Promise.resolve();
  }

  /** Run picture jobs one at a time. */
  exclusive(job) {
    const run = this.slot.catch(() => {}).then(job);
    this.slot = run.catch(() => {});
    return run;
  }

  /** The last picture of a device, if any. */
  lastPicture(externalId) {
    return this.last.get(externalId);
  }

  /**
   * A picture for Gladys (onGetImage, scene action, periodic refresh), under
   * 15 s. RTSP cameras grab a live frame (`fresh: true`); the others answer
   * their last event picture, or explain why there is none.
   * @returns {Promise<{ image: string, fresh: boolean }>}
   */
  async capture(externalId, sdmDevice) {
    const camera = readCamera(sdmDevice.traits);
    if (!camera.online) {
      throw new NoPictureError('The camera is offline');
    }
    if (!camera.rtsp) {
      const last = this.last.get(externalId);
      if (last) {
        return { image: last.image, fresh: false };
      }
      throw new NoPictureError(
        'This camera only streams over WebRTC: its picture is taken on its next event (motion, person, doorbell)',
      );
    }
    let pending = this.inFlight.get(externalId);
    if (!pending) {
      const deadline = this.now() + SNAPSHOT_TIMEOUT;
      pending = this.exclusive(() => this.grabLive(sdmDevice, () => deadline - this.now())).finally(
        () => this.inFlight.delete(externalId),
      );
      this.inFlight.set(externalId, pending);
    }
    const image = await pending;
    this.remember(externalId, image);
    return { image, fresh: true };
  }

  async grabLive(sdmDevice, timeLeft) {
    const results = await this.sdm.executeCommand(sdmDevice.name, COMMANDS.GENERATE_RTSP);
    const url = results?.streamUrls?.rtspUrl;
    if (!url) {
      throw new Error('Google returned no RTSP stream URL');
    }
    try {
      const frame = await grabRtspFrame(url, { timeout: remaining(timeLeft) });
      return toCameraImage(await fitJpeg(frame, timeLeft));
    } finally {
      // Free the stream at once instead of letting it run its 5 minutes.
      if (results.streamExtensionToken) {
        this.sdm
          .executeCommand(sdmDevice.name, COMMANDS.STOP_RTSP, {
            streamExtensionToken: results.streamExtensionToken,
          })
          .catch((err) => this.logger.debug(`StopRtspStream failed: ${err.message}`));
      }
    }
  }

  /**
   * The picture of a device event, published to Gladys. `event` is a parsed
   * event (see nest/events.js); an event image must be requested before
   * `imageExpiresAt` (local time: 30 s after the event, Google's limit).
   * Resolves true when a picture was published.
   */
  async fromEvent(externalId, sdmDevice, event, { imageExpiresAt = Infinity } = {}) {
    const camera = readCamera(sdmDevice.traits);
    const wantsClip = event.type === 'clip' && event.previewUrl;
    const wantsImage = !wantsClip && camera.eventImage && event.eventId && event.type !== 'clip';
    if (!wantsClip && !wantsImage) {
      return false;
    }
    if (wantsClip && !isGoogleUrl(event.previewUrl)) {
      // Never send the account token to a host that is not Google's.
      this.logger.warn(`Clip preview on an unexpected host refused: ${hostOf(event.previewUrl)}`);
      return false;
    }
    const image = await this.exclusive(async () => {
      if (wantsImage && this.now() > imageExpiresAt) {
        return undefined;
      }
      const deadline = this.now() + SNAPSHOT_TIMEOUT;
      const timeLeft = () => deadline - this.now();
      const buffer = wantsClip
        ? await this.clipFrame(event.previewUrl, timeLeft)
        : await this.eventImage(sdmDevice, event.eventId, timeLeft);
      return buffer && toCameraImage(await fitJpeg(buffer, timeLeft));
    });
    if (!image) {
      return false;
    }
    this.remember(externalId, image);
    await this.publish(externalId, image);
    return true;
  }

  async eventImage(sdmDevice, eventId, timeLeft) {
    const results = await this.sdm.executeCommand(sdmDevice.name, COMMANDS.GENERATE_IMAGE, {
      eventId,
    });
    if (!results?.url || !results?.token) {
      return undefined;
    }
    const url = new URL(results.url);
    url.searchParams.set('width', '1280');
    const { buffer } = await requestBuffer(url.toString(), {
      auth: `Basic ${results.token}`,
      timeout: Math.min(COMMAND_TIMEOUT * 2, remaining(timeLeft)),
      maxBytes: MAX_IMAGE_SIZE,
    });
    return buffer;
  }

  /** Download an event clip (bearer token), and extract its first frame. */
  async clipFrame(previewUrl, timeLeft) {
    const { buffer: clip } = await requestBuffer(previewUrl, {
      token: await this.tokens.getAccessToken(),
      timeout: remaining(timeLeft),
      maxBytes: MAX_CLIP_SIZE,
    });
    if (clip.length === 0) {
      throw new Error('Empty clip preview');
    }
    // A crash between write and removal leaves a clip behind: start clean.
    this.tmpReady ??= rm(this.tmpDir, { recursive: true, force: true }).then(() =>
      mkdir(this.tmpDir, { recursive: true }),
    );
    await this.tmpReady;
    const path = join(this.tmpDir, `clip-${randomUUID()}.mp4`);
    try {
      await writeFile(path, clip, { mode: 0o600 });
      return await grabFileFrame(path, { timeout: remaining(timeLeft) });
    } finally {
      await rm(path, { force: true });
    }
  }

  remember(externalId, image) {
    this.last.set(externalId, { image, at: this.now() });
  }

  /** Publish a picture, at most one every 10 s per camera. */
  async publish(externalId, image) {
    const previous = this.published.get(externalId);
    if (previous !== undefined && this.now() - previous < MIN_IMAGE_INTERVAL) {
      return false;
    }
    this.published.set(externalId, this.now());
    await this.gladys.publishCameraImage(externalId, image);
    return true;
  }
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid URL';
  }
}
