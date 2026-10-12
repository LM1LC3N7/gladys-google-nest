import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FEATURE, buildDevice, buildStates, displayName } from '../src/nest/devices.js';
import { applyTraits, deviceKind, readCamera } from '../src/nest/traits.js';
import { fixture } from './helpers/fakeFetch.js';
import { createFakeGladys } from './helpers/fakeGladys.js';

const [thermostat, rtspCamera, doorbell, speaker] = fixture('sdm-devices.json').devices;
const gladys = createFakeGladys();
const featureKeys = (device) => device.features.map((f) => f.external_id.split(':').pop());

test('device kinds, unsupported types left out', () => {
  assert.equal(deviceKind(thermostat), 'thermostat');
  assert.equal(deviceKind(rtspCamera), 'camera');
  assert.equal(deviceKind(doorbell), 'doorbell');
  assert.equal(deviceKind(speaker), undefined);
  assert.equal(buildDevice(gladys, speaker), null);
});

test('names: the Google Home name, else the room and the kind', () => {
  assert.equal(displayName(thermostat), 'Living Room Thermostat');
  assert.equal(displayName(rtspCamera), 'Garage');
  assert.equal(displayName(doorbell), 'Entryway Doorbell');
  assert.equal(displayName({ type: 'sdm.devices.types.CAMERA', traits: {} }), 'Nest Camera');
});

test('a heat/cool thermostat exposes every feature, ids stable', () => {
  const device = buildDevice(gladys, thermostat);
  assert.equal(device.external_id, 'ext:google-nest:thermostat:THERMO-1');
  assert.deepEqual(device.params, [
    { name: 'NEST_DEVICE', value: 'enterprises/project-id/devices/THERMO-1' },
  ]);
  assert.deepEqual(featureKeys(device), [
    FEATURE.TEMPERATURE,
    FEATURE.HUMIDITY,
    FEATURE.MODE,
    FEATURE.HVAC,
    FEATURE.HEAT_SETPOINT,
    FEATURE.COOL_SETPOINT,
    FEATURE.ECO,
    FEATURE.FAN,
  ]);
  const mode = device.features.find((f) => f.external_id.endsWith(':mode'));
  assert.equal(mode.category, 'thermostat');
  assert.equal(mode.type, 'mode');
  assert.deepEqual(
    mode.supported_options.map((o) => o.value),
    [1, 2, 3, 0],
  );
  const heat = device.features.find((f) => f.external_id.endsWith(':heat_setpoint'));
  assert.deepEqual(
    [heat.type, heat.unit, heat.min, heat.max, heat.read_only],
    ['target-temperature', 'celsius', 9, 32, false],
  );
});

test('a heat-only thermostat without fan nor humidity has fewer features', () => {
  const heatOnly = applyTraits(thermostat, {
    'sdm.devices.traits.ThermostatMode': { mode: 'HEAT', availableModes: ['HEAT', 'OFF'] },
    'sdm.devices.traits.Fan': {},
    'sdm.devices.traits.Humidity': {},
  });
  assert.deepEqual(featureKeys(buildDevice(gladys, heatOnly)), [
    FEATURE.TEMPERATURE,
    FEATURE.MODE,
    FEATURE.HVAC,
    FEATURE.HEAT_SETPOINT,
    FEATURE.ECO,
  ]);
});

test('thermostat states: rounded values, Gladys enums', () => {
  const states = Object.fromEntries(
    buildStates(gladys, thermostat).map((s) => [
      s.device_feature_external_id.split(':').pop(),
      s.state,
    ]),
  );
  assert.deepEqual(states, {
    temperature: 19.8,
    humidity: 41,
    mode: 1,
    hvac: 1,
    heat_setpoint: 20.5,
    eco: 0,
    fan: 0,
  });
});

test('in Eco, the setpoints keep their last value in Gladys', () => {
  const eco = applyTraits(thermostat, {
    'sdm.devices.traits.ThermostatEco': {
      availableModes: ['OFF', 'MANUAL_ECO'],
      mode: 'MANUAL_ECO',
    },
    'sdm.devices.traits.ThermostatTemperatureSetpoint': {},
  });
  const keys = buildStates(gladys, eco).map((s) => s.device_feature_external_id.split(':').pop());
  assert.ok(!keys.includes('heat_setpoint'));
  assert.ok(keys.includes('eco'));
});

test('cameras: image plus the detections they support, doorbells ring', () => {
  assert.deepEqual(featureKeys(buildDevice(gladys, rtspCamera)), ['image', 'motion', 'person']);
  assert.deepEqual(featureKeys(buildDevice(gladys, doorbell)), [
    'image',
    'ring',
    'motion',
    'person',
  ]);
  const image = buildDevice(gladys, rtspCamera).features[0];
  assert.deepEqual([image.category, image.type, image.keep_history], ['camera', 'image', false]);
  // At rest, the detections are 0 (a restart may have left one at 1)...
  assert.deepEqual(
    buildStates(gladys, doorbell).map((st) => [
      st.device_feature_external_id.split(':').pop(),
      st.state,
    ]),
    [
      ['ring', 0],
      ['motion', 0],
      ['person', 0],
    ],
  );
  // ...except the one shown right now.
  const held = new Set(['ext:google-nest:doorbell:DOORBELL-WEBRTC:ring']);
  assert.deepEqual(
    buildStates(gladys, doorbell, held).map((st) => st.device_feature_external_id.split(':').pop()),
    ['motion', 'person'],
  );
});

test('camera capabilities follow the live stream protocols', () => {
  assert.deepEqual(
    [readCamera(rtspCamera.traits).rtsp, readCamera(rtspCamera.traits).eventImage],
    [true, true],
  );
  const webrtc = readCamera(doorbell.traits);
  assert.deepEqual(
    [webrtc.rtsp, webrtc.webrtc, webrtc.clipPreview, webrtc.chime],
    [false, true, true, true],
  );
});
