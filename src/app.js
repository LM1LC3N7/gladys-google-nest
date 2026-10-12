// -----------------------------------------------------------------------------
// The integration itself: connects the Google account, keeps the Nest devices
// in sync with Gladys, runs the commands and turns the events into states,
// pictures and scene triggers. index.js only wires the SDK handlers to it.
//
// Sync sources, from the most to the least reactive:
//   1. the Pub/Sub event stream (trait changes and device events), optional;
//   2. a devices.list refresh every few minutes (the source of truth);
//   3. the state a successful command implies, published at once.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { CameraPictures, NoPictureError } from './camera.js';
import { STORED, hasCredentials, normalizeConfig } from './config.js';
import {
  DETECTION_HOLD,
  DOORBELL_HOLD,
  EVENT_DEDUP_TTL,
  EVENT_IMAGE_TTL,
  EVENT_MAX_AGE,
  OAUTH_STATE_TTL,
} from './constants.js';
import {
  AuthRequiredError,
  ClientConfigError,
  TokenManager,
  buildAuthorizeUrl,
  createState,
  exchangeCode,
  isAuthError,
  sameState,
} from './google/oauth.js';
import { EventStream, PubSubClient, parseEventSource } from './google/pubsub.js';
import { SdmClient } from './google/sdm.js';
import { GoogleApiError, googleClockOffset } from './http.js';
import { T, connectionReport } from './i18n.js';
import { CommandError, impliedTraits, planThermostatCommand } from './nest/commands.js';
import { FEATURE, buildDevice, buildStates, displayName, idsOf } from './nest/devices.js';
import { parseMessage } from './nest/events.js';
import { KIND, applyTraits, deviceKind, isOnline, readCamera } from './nest/traits.js';

// Scene trigger keys, as declared in the manifest. Keys are forever.
export const SCENE_TRIGGERS = {
  chime: 'doorbell_pressed',
  motion: 'motion_detected',
  person: 'person_detected',
  sound: 'sound_detected',
};

// The binary feature an event pulses, and for how long.
const PULSES = {
  chime: [FEATURE.RING, DOORBELL_HOLD],
  motion: [FEATURE.MOTION, DETECTION_HOLD],
  person: [FEATURE.PERSON, DETECTION_HOLD],
};

export { EVENT_MAX_AGE };
// Several changes in a row (a device added, an unknown device) cost one list.
const REFRESH_DEBOUNCE = 10_000;

const defaultTimers = { setTimeout, clearTimeout, setInterval, clearInterval };

export class NestApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'google-nest' }),
    now = Date.now,
    timers = defaultTimers,
    tmpDir,
  }) {
    this.tmpDir = tmpDir;
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.timers = timers;
    this.raw = {};
    this.config = normalizeConfig();
    this.tokens = undefined;
    this.sdm = undefined;
    this.pubsub = undefined;
    this.pictures = undefined;
    this.stream = undefined;
    this.pending = undefined;
    // Gladys device external_id -> SDM device resource (and the reverse).
    this.devices = new Map();
    this.byName = new Map();
    this.fetchedAt = 0;
    this.signature = undefined;
    this.intervals = [];
    this.refreshTimer = undefined;
    this.holds = new Map();
    this.seen = new Map();
    this.lastStatus = undefined;
    this.healthy = false;
    // Google refused the account: nothing runs until a new authorization.
    this.authFailed = false;
    this.eventsState = { status: 'off' };
    // Bumped on every (re)start: a slower start that was overtaken stops.
    this.generation = 0;
    // start() and stop() run one at a time, in call order.
    this.lifecycle = Promise.resolve();
    this.eventsStarting = undefined;
  }

  /** Google's clock, from ours (see googleClockOffset). */
  googleNow() {
    return this.now() - googleClockOffset();
  }

  // --- Lifecycle -------------------------------------------------------------

  /**
   * (Re)start from a configuration: every connection, every config change and
   * every new authorization goes through here. `token` is the answer of a
   * code exchange, used at once instead of refreshing it again.
   */
  start(raw = this.raw, options = {}) {
    return this.serialize(() => this.doStart(raw, options));
  }

  stop() {
    return this.serialize(() => this.doStop());
  }

  serialize(job) {
    const run = this.lifecycle.then(job, job);
    this.lifecycle = run.catch(() => {});
    return run;
  }

  async doStart(raw, { token } = {}) {
    await this.doStop();
    const generation = ++this.generation;
    this.eventsState = { status: 'off' };
    // The config Gladys sends may lack the off-schema keys: keep ours.
    this.raw = { ...pickStored(this.raw), ...raw };
    this.config = normalizeConfig(this.raw);
    this.healthy = false;
    this.authFailed = false;
    if (!hasCredentials(this.config)) {
      await this.setStatus(false, T.missingCredentials);
      return;
    }
    this.tokens = new TokenManager({
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
      refreshToken: this.config.refreshToken,
      now: this.now,
      onRefreshToken: (refreshToken) => this.store({ [STORED.REFRESH_TOKEN]: refreshToken }),
    });
    if (token) {
      this.tokens.accept(token);
    }
    this.sdm = new SdmClient({
      projectId: this.config.projectId,
      tokens: this.tokens,
      now: this.now,
    });
    this.pubsub = new PubSubClient({ tokens: this.tokens });
    this.pictures = new CameraPictures({
      gladys: this.gladys,
      sdm: this.sdm,
      tokens: this.tokens,
      logger: this.logger,
      now: this.now,
      tmpDir: this.tmpDir,
    });
    if (!this.tokens.connected) {
      await this.setStatus(false, T.notConnected);
      return;
    }
    await this.refresh({ force: true });
    if (generation !== this.generation || this.authFailed) {
      return;
    }
    this.intervals.push(
      this.timers.setInterval(() => this.refresh(), this.config.refreshMinutes * 60_000),
    );
    if (this.config.snapshotMinutes > 0) {
      this.intervals.push(
        this.timers.setInterval(() => this.refreshPictures(), this.config.snapshotMinutes * 60_000),
      );
    }
    await this.startEvents(generation);
  }

  async doStop() {
    for (const interval of this.intervals) {
      this.timers.clearInterval(interval);
    }
    this.intervals = [];
    this.timers.clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    // A detection shown at 1 goes back to 0 now: nothing else would clear it.
    const held = [...this.holds.entries()];
    this.holds.clear();
    for (const [, timer] of held) {
      this.timers.clearTimeout(timer);
    }
    if (held.length > 0) {
      await this.gladys
        .publishChangedStates(
          held.map(([featureId]) => ({ device_feature_external_id: featureId, state: 0 })),
        )
        .catch((err) => this.logger.debug(`Clearing the detections failed: ${err.message}`));
    }
    const stream = this.stream;
    this.stream = undefined;
    await stream?.stop();
  }

  /** Persist off-schema values (tokens, pending authorization). */
  async store(values) {
    this.raw = { ...this.raw, ...values };
    await this.gladys.setConfig(values);
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  /** The connected status, with the most useful hint for the user. */
  async updateStatus() {
    if (!this.healthy) {
      return;
    }
    let message;
    if (this.devices.size === 0) {
      message = T.noDevices;
    } else if (this.eventsState.status === 'off') {
      message = T.noEvents;
    } else if (this.eventsState.status === 'error') {
      message = this.eventsState.text;
    }
    await this.setStatus(true, message);
  }

  async handleError(err, context) {
    this.healthy = false;
    if (isAuthError(err)) {
      this.authFailed = true;
      this.logger.warn(`${context}: the Google account must be connected again (${err.message})`);
      // Retrying with a refused token cannot work: wait for a new connection.
      // (doStop, not stop: this may run inside a start.)
      await this.doStop();
      await this.setStatus(false, T.reconnect);
      return;
    }
    this.logger.warn(`${context} failed: ${err.message}`);
    await this.setStatus(
      false,
      err instanceof ClientConfigError ? T.badClient : T.googleError(err.message),
    );
  }

  // --- Devices ---------------------------------------------------------------

  /** Read every device from Google and publish what changed. */
  async refresh({ force = false } = {}) {
    if (!this.tokens?.connected || this.authFailed) {
      return;
    }
    const generation = this.generation;
    try {
      // Taken before the request: a change made while it runs is newer.
      const requestedAt = this.googleNow();
      const list = await this.sdm.listDevices();
      if (generation !== this.generation) {
        return;
      }
      this.fetchedAt = requestedAt;
      this.devices.clear();
      this.byName.clear();
      for (const sdmDevice of list) {
        if (deviceKind(sdmDevice) && typeof sdmDevice.name === 'string') {
          const externalId = idsOf(this.gladys, sdmDevice).device;
          this.devices.set(externalId, sdmDevice);
          this.byName.set(sdmDevice.name, externalId);
        }
      }
      await this.publishDevices({ force });
      await this.publishStates([...this.devices.values()]);
      await this.publishTransports();
      this.healthy = true;
      await this.updateStatus();
      // An event stream that could not start is retried with the refresh.
      if (this.config.eventSource && !this.stream && this.eventsState.status === 'error') {
        await this.startEvents(generation);
      }
    } catch (err) {
      if (generation === this.generation) {
        await this.handleError(err, 'Reading the Nest devices');
      }
    }
  }

  /** Refresh soon, once, whatever the number of reasons. */
  scheduleRefresh() {
    if (this.refreshTimer) {
      return;
    }
    this.refreshTimer = this.timers.setTimeout(() => {
      this.refreshTimer = undefined;
      this.refresh().catch((err) => this.logger.error('Refresh failed', err));
    }, REFRESH_DEBOUNCE);
  }

  async publishDevices({ force = false } = {}) {
    const devices = [...this.devices.values()]
      .map((sdmDevice) => buildDevice(this.gladys, sdmDevice))
      .filter(Boolean);
    const signature = JSON.stringify(devices);
    if (!force && signature === this.signature) {
      return;
    }
    this.signature = signature;
    await this.gladys.publishDiscoveredDevices(devices);
  }

  async publishStates(sdmDevices) {
    const held = new Set(this.holds.keys());
    const states = sdmDevices.flatMap((sdmDevice) => buildStates(this.gladys, sdmDevice, held));
    if (states.length > 0) {
      await this.gladys.publishChangedStates(states);
    }
  }

  async publishTransports() {
    const transports = [...this.devices.entries()].map(([externalId, sdmDevice]) => ({
      external_id: externalId,
      transport: isOnline(sdmDevice.traits) ? 'cloud' : 'unreachable',
    }));
    if (transports.length > 0) {
      await this.gladys.publishTransports(transports);
    }
  }

  deviceOf(externalId) {
    const sdmDevice = this.devices.get(externalId);
    if (!sdmDevice) {
      throw new CommandError('Unknown Nest device: Google does not share it (any more)');
    }
    return sdmDevice;
  }

  // --- Commands --------------------------------------------------------------

  async setValue(device, feature, value) {
    const sdmDevice = this.deviceOf(device.external_id);
    const prefix = `${device.external_id}:`;
    const featureKey = String(feature.external_id ?? '').startsWith(prefix)
      ? feature.external_id.slice(prefix.length)
      : undefined;
    if (deviceKind(sdmDevice) !== KIND.THERMOSTAT) {
      throw new CommandError('This Nest device has no command');
    }
    const plan = planThermostatCommand(sdmDevice, featureKey, value, {
      fanMinutes: this.config.fanMinutes,
    });
    for (const step of plan) {
      try {
        await this.sdm.executeCommand(sdmDevice.name, step.command, step.params);
      } catch (err) {
        if (isAuthError(err)) {
          await this.handleError(err, 'Command');
        }
        throw new Error(commandFailure(err), { cause: err });
      }
      // On the latest copy: a refresh may have landed during the call.
      const latest = this.devices.get(device.external_id) ?? sdmDevice;
      const updated = applyTraits(latest, impliedTraits(latest, step));
      this.devices.set(device.external_id, updated);
      await this.publishStates([updated]);
    }
  }

  // --- Events ----------------------------------------------------------------

  /** Start the event stream, once, whoever asks (start or refresh). */
  async startEvents(generation) {
    if (this.stream || this.eventsStarting) {
      return this.eventsStarting;
    }
    this.eventsStarting = this.openEvents(generation).finally(() => {
      this.eventsStarting = undefined;
    });
    return this.eventsStarting;
  }

  async openEvents(generation) {
    if (!this.config.eventSource) {
      this.eventsState = { status: 'off' };
      await this.updateStatus();
      return;
    }
    const source = parseEventSource(this.config.eventSource);
    if (!source) {
      this.eventsState = { status: 'error', text: T.badEventSource, message: 'invalid topic' };
      await this.updateStatus();
      return;
    }
    try {
      await this.pubsub.ensureSubscription(source);
    } catch (err) {
      if (generation !== this.generation) {
        return;
      }
      if (isAuthError(err)) {
        await this.handleError(err, 'Pub/Sub');
        return;
      }
      this.logger.warn(`Pub/Sub subscription unavailable: ${err.message}`);
      this.eventsState = {
        status: 'error',
        text: T.eventsFailed(err.message),
        message: err.message,
      };
      await this.updateStatus();
      return;
    }
    if (generation !== this.generation || this.authFailed || this.stream) {
      return;
    }
    const stream = new EventStream({
      client: this.pubsub,
      subscription: source.subscription,
      onMessage: (message, meta) => this.handleMessage(message, meta),
      onError: (err) => this.logger.warn(`Nest event stream: ${err.message}`),
      onHealth: (ok, err) => {
        this.eventsState = ok
          ? { status: 'ok' }
          : { status: 'error', text: T.eventsFailed(err.message), message: err.message };
        this.updateStatus().catch(() => {});
      },
      onAuthError: (err) => {
        if (this.stream === stream) {
          this.stream = undefined;
          this.handleError(err, 'Nest event stream');
        }
      },
    });
    this.stream = stream;
    stream.start();
    this.eventsState = { status: 'ok' };
    this.logger.info(`Listening to the Nest events of ${source.subscription}`);
    await this.updateStatus();
  }

  /**
   * One Pub/Sub message. `publishTime` (Google's clock) tells a live event
   * from a backlog delivered after a restart.
   */
  async handleMessage(message, { publishTime } = {}) {
    const parsed = parseMessage(message);
    if (parsed.relation) {
      this.scheduleRefresh();
      return;
    }
    const externalId = this.byName.get(parsed.name);
    if (!externalId) {
      // A device shared after the last refresh.
      if (parsed.name) {
        this.scheduleRefresh();
      }
      return;
    }
    let sdmDevice = this.devices.get(externalId);
    // A trait change older than the last full read is already in it.
    if (parsed.traits && (parsed.timestamp ?? Infinity) >= this.fetchedAt) {
      sdmDevice = applyTraits(sdmDevice, parsed.traits);
      this.devices.set(externalId, sdmDevice);
      await this.publishStates([sdmDevice]);
      if ('sdm.devices.traits.Connectivity' in parsed.traits) {
        await this.publishTransports();
      }
    }
    const eventAt = parsed.timestamp ?? publishTime;
    const age = eventAt === undefined ? 0 : this.googleNow() - eventAt;
    if (parsed.events.length === 0 || age > EVENT_MAX_AGE) {
      return;
    }
    for (const event of parsed.events) {
      await this.handleEvent(externalId, sdmDevice, event);
    }
    // One picture per visit. Newer cameras send a clip preview of the
    // session; older ones offer an image of its most telling event (the
    // doorbell, a person, then any motion).
    const canImage = readCamera(sdmDevice.traits).eventImage;
    const picture =
      parsed.events.find((e) => e.type === 'clip') ??
      (canImage
        ? ['chime', 'person', 'motion']
            .map((t) => parsed.events.find((e) => e.type === t))
            .find(Boolean)
        : undefined);
    if (
      picture &&
      this.firstTime(`${externalId}:picture:${picture.sessionId}`, picture.sessionId)
    ) {
      this.pictures
        .fromEvent(externalId, sdmDevice, picture, {
          imageExpiresAt: this.now() + EVENT_IMAGE_TTL - age,
        })
        .catch((err) => this.logger.warn(`Event picture failed: ${err.message}`));
    }
  }

  /**
   * True the first time a key is seen (within EVENT_DEDUP_TTL). Without an
   * id to tell events apart, every event is a first time.
   */
  firstTime(key, id) {
    if (id === undefined || id === null || id === '') {
      return true;
    }
    const now = this.now();
    for (const [seenKey, at] of this.seen) {
      if (now - at > EVENT_DEDUP_TTL) {
        this.seen.delete(seenKey);
      }
    }
    if (this.seen.has(key)) {
      return false;
    }
    this.seen.set(key, now);
    return true;
  }

  async handleEvent(externalId, sdmDevice, event) {
    if (event.type === 'clip') {
      return;
    }
    if (!this.firstTime(`${externalId}:${event.type}:${event.sessionId}`, event.sessionId)) {
      return;
    }
    const pulse = PULSES[event.type];
    if (pulse && hasFeature(sdmDevice, event.type)) {
      await this.pulse(idsOf(this.gladys, sdmDevice).feature(pulse[0]), pulse[1]);
    }
    await this.gladys
      .publishSceneEvent(SCENE_TRIGGERS[event.type], {
        device: externalId,
        device_name: displayName(sdmDevice),
      })
      .catch((err) => this.logger.warn(`Scene event ${event.type} refused: ${err.message}`));
  }

  /**
   * Set a binary feature to 1, and back to 0 after `hold` ms. Through
   * publishChangedStates, like the refresh: its memory of the last value
   * must know about the 1, or the 0 of a later refresh would be skipped.
   */
  async pulse(featureId, hold) {
    this.timers.clearTimeout(this.holds.get(featureId));
    const publish = (state) =>
      this.gladys
        .publishChangedStates([{ device_feature_external_id: featureId, state }])
        .catch((err) => this.logger.warn(`Publishing a detection failed: ${err.message}`));
    this.holds.set(
      featureId,
      this.timers.setTimeout(() => {
        this.holds.delete(featureId);
        publish(0);
      }, hold),
    );
    await publish(1);
  }

  // --- Pictures --------------------------------------------------------------

  async getImage(device) {
    const sdmDevice = this.deviceOf(device.external_id);
    return (await this.pictures.capture(device.external_id, sdmDevice)).image;
  }

  /** Periodic snapshots of the RTSP cameras (the only live ones). */
  async refreshPictures() {
    for (const [externalId, sdmDevice] of this.devices) {
      const camera =
        deviceKind(sdmDevice) === KIND.THERMOSTAT ? null : readCamera(sdmDevice.traits);
      if (!camera?.rtsp || !camera.online) {
        continue;
      }
      try {
        await this.pictures.publish(externalId, await this.pictures.capture(externalId, sdmDevice));
      } catch (err) {
        this.logger.warn(`Snapshot of ${displayName(sdmDevice)} failed: ${err.message}`);
      }
    }
  }

  /**
   * Scene action `take_snapshot`: `captured` is true only for a fresh live
   * picture (RTSP cameras); a WebRTC camera keeps its last event picture.
   */
  async takeSnapshot({ camera }) {
    try {
      const sdmDevice = this.deviceOf(camera);
      const { image, fresh } = await this.pictures.capture(camera, sdmDevice);
      if (!fresh) {
        return { captured: false, taken_at: '' };
      }
      await this.pictures.publish(camera, image);
      const at = this.pictures.lastPicture(camera)?.at ?? this.now();
      return { captured: true, taken_at: new Date(at).toISOString() };
    } catch (err) {
      if (!(err instanceof NoPictureError || err instanceof CommandError)) {
        this.logger.warn(`take_snapshot failed: ${err.message}`);
      }
      return { captured: false, taken_at: '' };
    }
  }

  // --- OAuth -----------------------------------------------------------------

  async authorizeUrl(_key, redirectUri) {
    // The SDK updates gladys.config as soon as the user saves: "Connect"
    // right after "Save" must not wait for the restart.
    const config = normalizeConfig({ ...this.raw, ...this.gladys.config });
    if (!hasCredentials(config)) {
      throw new Error(
        'Fill in the Device Access project ID, the client ID and the client secret, then save, before connecting',
      );
    }
    this.pending = { state: createState(), at: this.now() };
    // Off the critical path: Gladys gives the handler 5 s, and a restart
    // between the two steps must still find the state.
    this.store({
      [STORED.STATE]: this.pending.state,
      [STORED.STATE_AT]: this.pending.at,
      [STORED.REDIRECT_URI]: redirectUri,
    }).catch((err) => this.logger.error('Storing the pending authorization failed', err));
    return buildAuthorizeUrl({
      projectId: config.projectId,
      clientId: config.clientId,
      redirectUri,
      state: this.pending.state,
    });
  }

  async oauthCallback(_key, { code, state, redirectUri }) {
    let pending = this.pending;
    if (!pending || !sameState(pending.state, state)) {
      // The container may have restarted while the user was consenting.
      const stored = normalizeConfig(await this.gladys.getConfig());
      pending = stored.pendingState
        ? { state: stored.pendingState, at: stored.pendingStateAt }
        : undefined;
    }
    if (!pending || !sameState(pending.state, state) || this.now() - pending.at > OAUTH_STATE_TTL) {
      throw new Error('Unknown or expired authorization: click "Connect" again');
    }
    if (!code) {
      throw new Error('Google returned no authorization code');
    }
    const config = normalizeConfig({ ...this.raw, ...this.gladys.config });
    const answer = await exchangeCode({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      code,
      redirectUri,
    });
    if (!answer.refresh_token) {
      throw new Error(
        'Google returned no refresh token: remove the access of your Device Access project in your Google account, then connect again',
      );
    }
    this.pending = undefined;
    await this.store({
      [STORED.REFRESH_TOKEN]: answer.refresh_token,
      [STORED.STATE]: '',
      [STORED.STATE_AT]: 0,
      [STORED.REDIRECT_URI]: redirectUri,
    });
    this.logger.info('Google account connected');
    // Acknowledge now (5 s budget); the first devices.list, which also
    // completes the Device Access authorization, runs in the background.
    this.timers.setTimeout(
      () =>
        this.start(this.raw, { token: answer }).catch((err) =>
          this.logger.error('Start after the authorization failed', err),
        ),
      0,
    );
  }

  // --- Configuration action --------------------------------------------------

  async testConnection() {
    if (!hasCredentials(this.config)) {
      return T.missingCredentials;
    }
    if (!this.tokens?.connected) {
      return T.notConnected;
    }
    let list;
    try {
      list = await this.sdm.listDevices();
    } catch (err) {
      if (isAuthError(err)) {
        return T.reconnect;
      }
      return T.googleError(err.message);
    }
    const kinds = list.map(deviceKind);
    const count = (kind) => kinds.filter((k) => k === kind).length;
    let events = { status: 'off' };
    const source = this.config.eventSource && parseEventSource(this.config.eventSource);
    if (this.config.eventSource && !source) {
      events = { status: 'error', message: T.badEventSource.en };
    } else if (source) {
      try {
        await this.pubsub.ensureSubscription(source);
        events = { status: 'ok' };
      } catch (err) {
        events = { status: 'error', message: err.message };
      }
    }
    return connectionReport({
      devices: {
        thermostats: count(KIND.THERMOSTAT),
        cameras: count(KIND.CAMERA),
        doorbells: count(KIND.DOORBELL),
        displays: count(KIND.DISPLAY),
      },
      events,
      redirectUri: this.config.redirectUri,
    });
  }
}

/** The off-schema keys of a raw config. */
function pickStored(raw) {
  return Object.fromEntries(
    Object.values(STORED)
      .filter((key) => raw?.[key] !== undefined)
      .map((key) => [key, raw[key]]),
  );
}

function hasFeature(sdmDevice, eventType) {
  const camera = readCamera(sdmDevice.traits);
  if (eventType === 'chime') {
    return deviceKind(sdmDevice) === KIND.DOORBELL || camera.chime;
  }
  return Boolean(camera[eventType]);
}

/** A command failure, worded for the user. */
function commandFailure(err) {
  if (err instanceof AuthRequiredError || isAuthError(err)) {
    return 'Google refused the access: connect your Google account again';
  }
  if (err instanceof GoogleApiError) {
    if (err.reason === 'RESOURCE_EXHAUSTED') {
      return 'Too many commands: Google limits each device, try again in a minute';
    }
    if (err.reason === 'FAILED_PRECONDITION') {
      return `Nest refused the command: ${err.detail ?? 'the thermostat is not in a mode that allows it'}`;
    }
    if (err.reason === 'UNAVAILABLE' || err.status >= 500) {
      return 'Google Nest is unavailable right now, try again later';
    }
    return `Nest refused the command: ${err.detail ?? err.reason ?? err.status}`;
  }
  return err.message;
}
