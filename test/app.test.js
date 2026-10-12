import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EVENT_MAX_AGE, NestApp, SCENE_TRIGGERS } from '../src/app.js';
import { STORED } from '../src/config.js';
import { setFfmpegRunner } from '../src/ffmpeg.js';
import { COMMANDS } from '../src/nest/commands.js';
import {
  FIXTURE_NOW,
  fixture,
  googleError,
  googleRoutes,
  installFetch,
  json,
  tokenAnswer,
} from './helpers/fakeFetch.js';
import { createFakeGladys, createFakeTimers } from './helpers/fakeGladys.js';

const CREDENTIALS = {
  project_id: 'project-id',
  client_id: 'client.apps.googleusercontent.com',
  client_secret: 'secret',
};
const CONNECTED = { ...CREDENTIALS, [STORED.REFRESH_TOKEN]: 'refresh-1' };
const THERMOSTAT = 'ext:google-nest:thermostat:THERMO-1';
const CAMERA = 'ext:google-nest:camera:CAM-RTSP';
const DOORBELL = 'ext:google-nest:doorbell:DOORBELL-WEBRTC';
const quiet = {
  info() {},
  warn: (...a) => process.env.DEBUG_TEST && console.error(...a),
  error() {},
  debug() {},
};

let fake;
let restoreRunner;
beforeEach(() => {
  restoreRunner = setFfmpegRunner(async () => Buffer.alloc(100, 1));
});
afterEach(() => {
  fake?.restore();
  setFfmpegRunner(restoreRunner);
});

function setup({ config = CONNECTED, routes = googleRoutes(), now = FIXTURE_NOW } = {}) {
  fake = installFetch(routes);
  const gladys = createFakeGladys({ config });
  const timers = createFakeTimers();
  const clock = { now };
  const tmpDir = mkdtempSync(join(tmpdir(), 'nest-app-'));
  const app = new NestApp({ gladys, logger: quiet, now: () => clock.now, timers, tmpDir });
  return { app, gladys, timers, clock };
}

const stateOf = (gladys, featureId) =>
  gladys.calls.states.filter((s) => s.device_feature_external_id === featureId).at(-1)?.state;

const message = (event) => ({ timestamp: new Date(FIXTURE_NOW).toISOString(), ...event });

test('without credentials, the status says what to fill in', async () => {
  const { app, gladys } = setup({ config: {} });
  await app.start({});
  assert.equal(gladys.calls.statuses.at(-1).connected, false);
  assert.match(gladys.calls.statuses.at(-1).message.en, /project ID/);
  assert.equal(fake.calls.length, 0);
});

test('with credentials but no account, the status asks to connect', async () => {
  const { app, gladys } = setup({ config: CREDENTIALS });
  await app.start(CREDENTIALS);
  assert.match(gladys.calls.statuses.at(-1).message.en, /Connect your Google account/);
});

test('a start publishes the devices, their states and transports', async () => {
  const { app, gladys, timers } = setup();
  await app.start(CONNECTED);
  const devices = gladys.calls.discovered.at(-1);
  assert.deepEqual(
    devices.map((d) => d.external_id),
    [THERMOSTAT, CAMERA, DOORBELL],
  );
  assert.equal(stateOf(gladys, `${THERMOSTAT}:heat_setpoint`), 20.5);
  assert.equal(stateOf(gladys, `${THERMOSTAT}:hvac`), 1);
  assert.deepEqual(
    gladys.calls.transports.at(-1).map((t) => t.transport),
    ['cloud', 'cloud', 'cloud'],
  );
  // Connected, with the hint about the missing Pub/Sub topic.
  const status = gladys.calls.statuses.at(-1);
  assert.equal(status.connected, true);
  assert.match(status.message.en, /Pub\/Sub/);
  // One refresh interval (5 minutes by default), no snapshot interval.
  assert.deepEqual(
    timers.intervals().map((t) => t.ms),
    [5 * 60_000],
  );
});

test('an unchanged device list is not published twice', async () => {
  const { app, gladys } = setup();
  await app.start(CONNECTED);
  await app.refresh();
  assert.equal(gladys.calls.discovered.length, 1);
  await app.refresh({ force: true });
  assert.equal(gladys.calls.discovered.length, 2);
});

test('a refused account stops everything and asks to reconnect', async () => {
  const { app, gladys, timers } = setup({
    routes: [['POST', /token/, () => json({ error: 'invalid_grant' }, 400)]],
  });
  await app.start(CONNECTED);
  const status = gladys.calls.statuses.at(-1);
  assert.equal(status.connected, false);
  assert.match(status.message.en, /connect your Google account again/);
  assert.equal(timers.intervals().length, 0);
});

test('a Google outage keeps the refresh running to recover', async () => {
  const { app, gladys, timers } = setup({
    routes: [
      ['POST', /token/, () => tokenAnswer()],
      ['GET', /devices$/, () => googleError(503, 'UNAVAILABLE', 'try later')],
    ],
  });
  await app.start(CONNECTED);
  assert.match(gladys.calls.statuses.at(-1).message.en, /unreachable/);
  assert.equal(timers.intervals().length, 1);
});

test('a setpoint command runs on Google and shows at once in Gladys', async () => {
  const { app, gladys } = setup();
  await app.start(CONNECTED);
  await app.setValue(
    { external_id: THERMOSTAT },
    { external_id: `${THERMOSTAT}:heat_setpoint` },
    22,
  );
  const command = fake.calls.find((c) => c.body?.command);
  assert.equal(
    command.url,
    'https://smartdevicemanagement.googleapis.com/v1/enterprises/project-id/devices/THERMO-1:executeCommand',
  );
  assert.deepEqual(command.body, { command: COMMANDS.SET_HEAT, params: { heatCelsius: 22 } });
  assert.equal(stateOf(gladys, `${THERMOSTAT}:heat_setpoint`), 22);
});

test('a refused command explains why', async () => {
  const { app } = setup({
    routes: googleRoutes({
      extra: [['POST', /:executeCommand$/, () => googleError(429, 'RESOURCE_EXHAUSTED', 'quota')]],
    }),
  });
  await app.start(CONNECTED);
  await assert.rejects(
    app.setValue({ external_id: THERMOSTAT }, { external_id: `${THERMOSTAT}:mode` }, 2),
    /Too many commands/,
  );
  await assert.rejects(
    app.setValue({ external_id: CAMERA }, { external_id: `${CAMERA}:image` }, 1),
    /no command/,
  );
  await assert.rejects(
    app.setValue({ external_id: 'ext:google-nest:thermostat:GONE' }, { external_id: 'x' }, 1),
    /Unknown Nest device/,
  );
});

test('a trait event updates the states without a full read', async () => {
  const { app, gladys, clock } = setup();
  await app.start(CONNECTED);
  clock.now += 1000;
  await app.handleMessage(
    message({
      timestamp: new Date(clock.now).toISOString(),
      resourceUpdate: {
        name: 'enterprises/project-id/devices/THERMO-1',
        traits: { 'sdm.devices.traits.ThermostatHvac': { status: 'OFF' } },
      },
    }),
  );
  assert.equal(stateOf(gladys, `${THERMOSTAT}:hvac`), 0);
  const lists = fake.calls.filter((c) => c.method === 'GET');
  assert.equal(lists.length, 1);
});

test('a trait event older than the last read is ignored', async () => {
  const { app, gladys } = setup();
  await app.start(CONNECTED);
  const before = gladys.calls.states.length;
  await app.handleMessage(
    message({
      timestamp: new Date(FIXTURE_NOW - 60_000).toISOString(),
      resourceUpdate: {
        name: 'enterprises/project-id/devices/THERMO-1',
        traits: { 'sdm.devices.traits.ThermostatHvac': { status: 'OFF' } },
      },
    }),
  );
  assert.equal(gladys.calls.states.length, before);
});

test('a doorbell press: ring pulse, scene event once per session, picture', async () => {
  const { app, gladys, timers } = setup({
    routes: googleRoutes({
      extra: [
        [
          'GET',
          /nest-camera-frontend\.googleapis\.com/,
          () => new Response(Buffer.alloc(100, 1), { status: 200 }),
        ],
      ],
    }),
  });
  await app.start(CONNECTED);
  const chime = message({
    resourceUpdate: {
      name: 'enterprises/project-id/devices/DOORBELL-WEBRTC',
      events: { 'sdm.devices.events.DoorbellChime.Chime': { eventSessionId: 'S1', eventId: 'E1' } },
    },
    eventThreadState: 'STARTED',
  });
  await app.handleMessage(chime);
  await app.handleMessage({ ...chime, eventThreadState: 'UPDATED' });
  assert.deepEqual(gladys.calls.sceneEvents, [
    { key: SCENE_TRIGGERS.chime, data: { device: DOORBELL, device_name: 'Entryway Doorbell' } },
  ]);
  assert.equal(stateOf(gladys, `${DOORBELL}:ring`), 1);
  assert.equal(
    gladys.calls.states.filter(
      (st) => st.device_feature_external_id === `${DOORBELL}:ring` && st.state === 1,
    ).length,
    1,
    'one pulse for the session',
  );
  await timers.runTimeouts();
  assert.equal(stateOf(gladys, `${DOORBELL}:ring`), 0);

  // The clip preview of the same session becomes the picture.
  await app.handleMessage(
    message({
      resourceUpdate: {
        name: 'enterprises/project-id/devices/DOORBELL-WEBRTC',
        events: {
          'sdm.devices.events.CameraClipPreview.ClipPreview': {
            eventSessionId: 'S1',
            previewUrl: 'https://nest-camera-frontend.googleapis.com/clip.mp4',
          },
        },
      },
    }),
  );
  for (let i = 0; i < 20 && gladys.calls.images.length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(gladys.calls.images.at(-1).externalId, DOORBELL);
  assert.equal(gladys.calls.sceneEvents.length, 1);
});

test('person and motion events pulse their features and fire their triggers', async () => {
  const { app, gladys } = setup({
    routes: googleRoutes({
      extra: [
        [
          'POST',
          /:executeCommand$/,
          () => json({ results: { url: 'https://img.googleusercontent.com/e', token: 't' } }),
        ],
        [
          'GET',
          /img\.googleusercontent\.com/,
          () => new Response(Buffer.alloc(10), { status: 200 }),
        ],
      ],
    }),
  });
  await app.start(CONNECTED);
  await app.handleMessage(
    message({
      resourceUpdate: {
        name: 'enterprises/project-id/devices/CAM-RTSP',
        events: {
          'sdm.devices.events.CameraMotion.Motion': { eventId: 'M1' },
          'sdm.devices.events.CameraPerson.Person': { eventId: 'P1' },
          'sdm.devices.events.CameraSound.Sound': { eventId: 'S1' },
        },
      },
    }),
  );
  assert.deepEqual(
    gladys.calls.sceneEvents.map((e) => e.key),
    ['motion_detected', 'person_detected', 'sound_detected'],
  );
  assert.equal(stateOf(gladys, `${CAMERA}:motion`), 1);
  assert.equal(stateOf(gladys, `${CAMERA}:person`), 1);
  // One event picture for the message, the person's (most telling).
  await new Promise((resolve) => setTimeout(resolve, 20));
  const generate = fake.calls.filter((c) => c.body?.command?.endsWith('GenerateImage'));
  assert.deepEqual(
    generate.map((c) => c.body.params.eventId),
    ['P1'],
  );
  // A stop clears what is still shown.
  await app.stop();
  assert.equal(stateOf(gladys, `${CAMERA}:motion`), 0);
  assert.equal(stateOf(gladys, `${CAMERA}:person`), 0);
});

test('events delivered late (after a restart) fire nothing', async () => {
  const { app, gladys, clock } = setup();
  await app.start(CONNECTED);
  clock.now = FIXTURE_NOW + EVENT_MAX_AGE + 1;
  await app.handleMessage(
    message({
      resourceUpdate: {
        name: 'enterprises/project-id/devices/DOORBELL-WEBRTC',
        events: { 'sdm.devices.events.DoorbellChime.Chime': { eventId: 'E9' } },
      },
    }),
  );
  assert.equal(gladys.calls.sceneEvents.length, 0);
});

test('an unknown device or a relation change schedules one refresh', async () => {
  const { app, timers } = setup();
  await app.start(CONNECTED);
  await app.handleMessage(message({ relationUpdate: { type: 'CREATED' } }));
  await app.handleMessage(
    message({ resourceUpdate: { name: 'enterprises/project-id/devices/NEW' } }),
  );
  const scheduled = [...timers.pending.values()].filter((t) => t.kind === 'timeout');
  assert.equal(scheduled.length, 1);
  await timers.runTimeouts();
  assert.equal(fake.calls.filter((c) => c.method === 'GET').length, 2);
});

test('the Pub/Sub topic starts the event stream', async () => {
  const pulled = [];
  const { app, gladys } = setup({
    config: { ...CONNECTED, pubsub: 'projects/my-home-123/topics/nest' },
    routes: googleRoutes({
      extra: [
        [
          'GET',
          /pubsub\.googleapis\.com.*subscriptions\/gladys-google-nest$/,
          () => json({ name: 'sub' }),
        ],
        [
          'POST',
          /:pull$/,
          (call) => {
            pulled.push(call.url);
            return new Promise((_resolve, reject) => {
              call.signal.addEventListener('abort', () => reject(new Error('aborted')));
            });
          },
        ],
      ],
    }),
  });
  await app.start({ ...CONNECTED, pubsub: 'projects/my-home-123/topics/nest' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    pulled[0],
    'https://pubsub.googleapis.com/v1/projects/my-home-123/subscriptions/gladys-google-nest:pull',
  );
  assert.equal(gladys.calls.statuses.at(-1).message, undefined, 'no hint: all is well');
  await app.stop();
});

test('an invalid Pub/Sub topic is reported, the devices still work', async () => {
  const { app, gladys } = setup({ config: { ...CONNECTED, pubsub: 'nest-events' } });
  await app.start({ ...CONNECTED, pubsub: 'nest-events' });
  const status = gladys.calls.statuses.at(-1);
  assert.equal(status.connected, true);
  assert.match(status.message.en, /topic is invalid/);
  assert.equal(gladys.calls.discovered.length, 1);
});

test('OAuth: no authorize URL before the credentials are saved', async () => {
  const { app } = setup({ config: {} });
  await app.start({});
  await assert.rejects(app.authorizeUrl('google_account_local'), /client secret/);
});

test('OAuth: the state of a pasted address survives a restart of the container', async () => {
  const { app, gladys } = setup({
    config: CREDENTIALS,
    routes: [['POST', /token/, () => tokenAnswer({ refresh_token: 'r' })]],
  });
  await app.start(CREDENTIALS);
  const url = new URL(await app.authorizeUrl('google_account_local'));
  await new Promise((resolve) => setImmediate(resolve));
  const restarted = new NestApp({
    gladys,
    logger: quiet,
    now: () => FIXTURE_NOW,
    timers: createFakeTimers(),
  });
  await restarted.start(await gladys.getConfig());
  const message = await restarted.finishLocalConnection({
    answer: `https://www.google.com/?state=${url.searchParams.get('state')}&code=4/0AbCdEfGhIj`,
  });
  assert.match(message.en, /connected/);
  assert.equal(gladys.config[STORED.REFRESH_TOKEN], 'r');
});

test('the test action reports the devices and the events', async () => {
  const { app } = setup();
  await app.start(CONNECTED);
  const report = await app.testConnection();
  assert.match(report.en, /1 thermostat, 1 camera, 1 doorbell; events: off/);
  assert.match(report.fr, /1 thermostat, 1 caméra, 1 sonnette ; événements : désactivés/);
});

test('take_snapshot refreshes an RTSP camera, and says no for a WebRTC one', async () => {
  const { app, gladys } = setup({
    routes: googleRoutes({
      extra: [
        [
          'POST',
          /:executeCommand$/,
          () =>
            json({ results: { streamUrls: { rtspUrl: 'rtsps://x' }, streamExtensionToken: 'e' } }),
        ],
      ],
    }),
  });
  await app.start(CONNECTED);
  const done = await app.takeSnapshot({ camera: CAMERA });
  assert.equal(done.captured, true);
  assert.equal(done.taken_at, new Date(FIXTURE_NOW).toISOString());
  assert.equal(gladys.calls.images.at(-1).externalId, CAMERA);
  assert.deepEqual(await app.takeSnapshot({ camera: DOORBELL }), { captured: false, taken_at: '' });
});

test('a configured snapshot interval refreshes the RTSP cameras only', async () => {
  const config = { ...CONNECTED, snapshot_interval: '10' };
  const { app, gladys, timers } = setup({
    config,
    routes: googleRoutes({
      extra: [
        [
          'POST',
          /:executeCommand$/,
          () =>
            json({ results: { streamUrls: { rtspUrl: 'rtsps://x' }, streamExtensionToken: 'e' } }),
        ],
      ],
    }),
  });
  await app.start(config);
  assert.deepEqual(
    timers.intervals().map((t) => t.ms),
    [5 * 60_000, 10 * 60_000],
  );
  await app.refreshPictures();
  assert.deepEqual(
    gladys.calls.images.map((i) => i.externalId),
    [CAMERA],
  );
});

test('the fixture still has what the tests rely on', () => {
  assert.equal(fixture('sdm-devices.json').devices.length, 4);
});

test('a fixed topic after a bad one leaves exactly one event stream', async () => {
  const pulls = [];
  const good = { ...CONNECTED, pubsub: 'projects/my-home-123/topics/nest' };
  const { app } = setup({
    config: { ...CONNECTED, pubsub: 'bad' },
    routes: googleRoutes({
      extra: [
        ['GET', /subscriptions\/gladys-google-nest$/, () => json({ name: 'sub' })],
        [
          'POST',
          /:pull$/,
          (call) => {
            pulls.push(call);
            return new Promise((_resolve, reject) => {
              call.signal.addEventListener('abort', () => reject(new Error('aborted')));
            });
          },
        ],
      ],
    }),
  });
  await app.start({ ...CONNECTED, pubsub: 'bad' });
  await app.start(good);
  await app.refresh();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pulls.length, 1, 'one pull loop');
  await app.stop();
  assert.ok(pulls[0].signal.aborted, 'and stop() ends it');
});

test('concurrent starts run one after the other: one set of timers', async () => {
  const { app, timers } = setup();
  await Promise.all([app.start(CONNECTED), app.start(CONNECTED), app.start(CONNECTED)]);
  assert.equal(timers.intervals().length, 1);
});

test('a wrong client secret is a configuration error, not a reconnection', async () => {
  const { app, gladys } = setup({
    routes: [['POST', /token/, () => json({ error: 'invalid_client' }, 401)]],
  });
  await app.start(CONNECTED);
  assert.match(gladys.calls.statuses.at(-1).message.en, /client ID or secret/);
});

test('"Connect" right after "Save" uses the saved credentials', async () => {
  const { app, gladys } = setup({ config: {} });
  await app.start({});
  // The SDK updates gladys.config before the restart has run.
  Object.assign(gladys.config, CREDENTIALS);
  const url = new URL(await app.authorizeUrl('google_account_local'));
  assert.equal(url.searchParams.get('client_id'), CREDENTIALS.client_id);
});

test('event ages are judged on Google clock, not on a drifting local one', async () => {
  // The local clock runs 10 minutes fast; Google's Date header tells it.
  const googleNow = FIXTURE_NOW;
  const { app, gladys, clock } = setup({
    routes: [
      ['POST', /token/, () => tokenAnswer()],
      [
        'GET',
        /devices$/,
        () =>
          new Response(JSON.stringify(fixture('sdm-devices.json')), {
            status: 200,
            headers: {
              'content-type': 'application/json',
              date: new Date(googleNow).toUTCString(),
            },
          }),
      ],
    ],
  });
  const realNow = Date.now;
  const drift = 10 * 60_000;
  clock.now = googleNow + drift;
  // The HTTP layer reads the local clock itself: the same drifting one.
  Date.now = () => clock.now;
  try {
    await app.start(CONNECTED);
  } finally {
    Date.now = realNow;
  }
  await app.handleMessage(
    message({
      resourceUpdate: {
        name: 'enterprises/project-id/devices/DOORBELL-WEBRTC',
        events: { 'sdm.devices.events.DoorbellChime.Chime': { eventId: 'E7' } },
      },
    }),
  );
  assert.equal(gladys.calls.sceneEvents.length, 1);
});

test('local connection: Google own redirect URI, pasted address, exchange here', async () => {
  const { app, gladys, timers } = setup({
    config: CREDENTIALS,
    routes: googleRoutes({
      extra: [
        [
          'POST',
          /oauth2\.googleapis\.com\/token/,
          (call) =>
            call.body.grant_type === 'authorization_code'
              ? tokenAnswer({ refresh_token: 'refresh-local' })
              : tokenAnswer(),
        ],
      ],
    }),
  });
  await app.start(CREDENTIALS);
  // account_link: Gladys hands no redirect URI.
  const url = new URL(await app.authorizeUrl('google_account_local'));
  assert.equal(url.searchParams.get('redirect_uri'), 'https://www.google.com');
  const state = url.searchParams.get('state');

  const pasted = `https://www.google.com/?state=${state}&code=4%2F0AbCdEfGhIj&scope=https://www.googleapis.com/auth/sdm.service`;
  const message = await app.finishLocalConnection({ answer: pasted });
  assert.match(message.en, /connected/);
  const exchange = fake.calls.find((c) => c.body?.grant_type === 'authorization_code');
  assert.equal(exchange.body.code, '4/0AbCdEfGhIj');
  assert.equal(exchange.body.redirect_uri, 'https://www.google.com');
  assert.equal(gladys.config[STORED.REFRESH_TOKEN], 'refresh-local');
  await timers.runTimeouts();
  assert.equal(gladys.calls.discovered.length, 1);
});

test('local connection: a bare code works, a foreign state or an error does not', async () => {
  const { app } = setup({
    config: CREDENTIALS,
    routes: [['POST', /token/, () => tokenAnswer({ refresh_token: 'r' })]],
  });
  await app.start(CREDENTIALS);
  await app.authorizeUrl('google_account_local');
  assert.match(
    (
      await app.finishLocalConnection({
        answer: 'https://www.google.com/?state=forged&code=4/abcdefghijk',
      })
    ).en,
    /older or unknown/,
  );
  assert.match(
    (await app.finishLocalConnection({ answer: 'https://www.google.com/?error=access_denied' })).en,
    /did not grant/,
  );
  assert.match(
    (await app.finishLocalConnection({ answer: 'hello world' })).en,
    /No authorization code/,
  );
  assert.match((await app.finishLocalConnection({ answer: '4/0AbCdEfGhIjKl' })).en, /connected/);
});

test('local connection: a refused code says what to check', async () => {
  const { app } = setup({
    config: CREDENTIALS,
    routes: [
      [
        'POST',
        /token/,
        () => json({ error: 'invalid_grant', error_description: 'Bad Request' }, 400),
      ],
    ],
  });
  await app.start(CREDENTIALS);
  const message = await app.finishLocalConnection({ answer: '4/0AbCdEfGhIjKl' });
  assert.match(message.en, /https:\/\/www\.google\.com is an authorized redirect URI/);
});
