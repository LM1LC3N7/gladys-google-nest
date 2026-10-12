// -----------------------------------------------------------------------------
// SDM devices -> Gladys devices and states (pure functions).
//
// Feature keys are forever: they are part of the feature external_ids that
// scenes, dashboards and the history refer to. Never rename one.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as CAT,
  DEVICE_FEATURE_TYPES as TYPE,
  DEVICE_FEATURE_UNITS as UNIT,
} from '@gladysassistant/integration-sdk';
import { SETPOINT_MAX, SETPOINT_MIN } from '../constants.js';
import { KIND, deviceId, deviceKind, readCamera, readThermostat, roomName } from './traits.js';

export const FEATURE = {
  TEMPERATURE: 'temperature',
  HUMIDITY: 'humidity',
  MODE: 'mode',
  HVAC: 'hvac',
  HEAT_SETPOINT: 'heat_setpoint',
  COOL_SETPOINT: 'cool_setpoint',
  ECO: 'eco',
  FAN: 'fan',
  IMAGE: 'image',
  MOTION: 'motion',
  PERSON: 'person',
  RING: 'ring',
};

// THERMOSTAT_MODE of the Gladys core (the SDK exports no integer maps).
export const GLADYS_MODE = { OFF: 0, HEAT: 1, COOL: 2, HEATCOOL: 3 };
const MODE_LABELS = { OFF: 'Off', HEAT: 'Heat', COOL: 'Cool', HEATCOOL: 'Heat · Cool' };
// THERMOSTAT_OPERATING_STATE of the Gladys core.
const HVAC_STATE = { OFF: 0, HEATING: 1, COOLING: 2 };

const KIND_LABELS = {
  [KIND.THERMOSTAT]: 'Thermostat',
  [KIND.CAMERA]: 'Camera',
  [KIND.DOORBELL]: 'Doorbell',
  [KIND.DISPLAY]: 'Display',
};

/** The Gladys ids of an SDM device: `{ device, feature(key) }`. */
export function idsOf(gladys, sdmDevice) {
  return gladys.externalIds(deviceKind(sdmDevice), deviceId(sdmDevice.name));
}

/** "Living Room Thermostat", or the name given in the Google Home app. */
export function displayName(sdmDevice) {
  const custom = sdmDevice.traits?.['sdm.devices.traits.Info']?.customName;
  if (typeof custom === 'string' && custom.trim()) {
    return custom.trim();
  }
  const label = KIND_LABELS[deviceKind(sdmDevice)] ?? 'Nest';
  const room = roomName(sdmDevice);
  return room ? `${room} ${label}` : `Nest ${label}`;
}

const sensor = (name, externalId, category, type, extra = {}) => ({
  name,
  external_id: externalId,
  category,
  type,
  read_only: true,
  has_feedback: false,
  keep_history: true,
  ...extra,
});

const command = (name, externalId, category, type, extra = {}) => ({
  name,
  external_id: externalId,
  category,
  type,
  read_only: false,
  // Google confirms a command, and the new state comes back through the
  // refresh or the event stream.
  has_feedback: true,
  keep_history: true,
  ...extra,
});

function thermostatFeatures(ids, t) {
  const canHeat = t.availableModes.some((m) => m === 'HEAT' || m === 'HEATCOOL');
  const canCool = t.availableModes.some((m) => m === 'COOL' || m === 'HEATCOOL');
  const setpoint = { unit: UNIT.CELSIUS, min: SETPOINT_MIN, max: SETPOINT_MAX };
  const features = [
    sensor(
      'Temperature',
      ids.feature(FEATURE.TEMPERATURE),
      CAT.TEMPERATURE_SENSOR,
      TYPE.SENSOR.DECIMAL,
      { unit: UNIT.CELSIUS, min: -20, max: 60 },
    ),
  ];
  if (t.humidity !== undefined) {
    features.push(
      sensor('Humidity', ids.feature(FEATURE.HUMIDITY), CAT.HUMIDITY_SENSOR, TYPE.SENSOR.DECIMAL, {
        unit: UNIT.PERCENT,
        min: 0,
        max: 100,
      }),
    );
  }
  const modes = t.availableModes.filter((m) => m in GLADYS_MODE);
  if (modes.length > 0) {
    features.push(
      command('Mode', ids.feature(FEATURE.MODE), CAT.THERMOSTAT, TYPE.THERMOSTAT.MODE, {
        min: 0,
        max: 3,
        supported_options: modes.map((m, i) => ({
          value: GLADYS_MODE[m],
          label: MODE_LABELS[m],
          sort_order: i,
        })),
      }),
    );
  }
  features.push(
    sensor('Activity', ids.feature(FEATURE.HVAC), CAT.THERMOSTAT, TYPE.THERMOSTAT.OPERATING_STATE, {
      min: 0,
      max: 2,
      keep_history: true,
    }),
  );
  if (canHeat) {
    features.push(
      command(
        'Heating setpoint',
        ids.feature(FEATURE.HEAT_SETPOINT),
        CAT.THERMOSTAT,
        TYPE.THERMOSTAT.TARGET_TEMPERATURE,
        setpoint,
      ),
    );
  }
  if (canCool) {
    features.push(
      command(
        'Cooling setpoint',
        ids.feature(FEATURE.COOL_SETPOINT),
        CAT.THERMOSTAT,
        TYPE.THERMOSTAT.TARGET_TEMPERATURE,
        setpoint,
      ),
    );
  }
  if (t.ecoAvailable) {
    features.push(
      command('Eco', ids.feature(FEATURE.ECO), CAT.SWITCH, TYPE.SWITCH.BINARY, { min: 0, max: 1 }),
    );
  }
  if (t.fanAvailable) {
    features.push(
      command('Fan', ids.feature(FEATURE.FAN), CAT.SWITCH, TYPE.SWITCH.BINARY, { min: 0, max: 1 }),
    );
  }
  return features;
}

function cameraFeatures(ids, c, kind) {
  const features = [
    {
      name: 'Image',
      external_id: ids.feature(FEATURE.IMAGE),
      category: CAT.CAMERA,
      type: TYPE.CAMERA.IMAGE,
      read_only: true,
      has_feedback: false,
      // Images never go through the states history.
      keep_history: false,
      // The core stores min/max as NOT NULL: a camera without them is shown
      // in Discovery but cannot be created.
      min: 0,
      max: 0,
    },
  ];
  if (kind === KIND.DOORBELL || c.chime) {
    features.push(
      sensor('Ring', ids.feature(FEATURE.RING), CAT.DOORBELL, TYPE.DOORBELL.RING, {
        min: 0,
        max: 1,
      }),
    );
  }
  if (c.motion) {
    features.push(
      sensor('Motion', ids.feature(FEATURE.MOTION), CAT.MOTION_SENSOR, TYPE.SENSOR.BINARY, {
        min: 0,
        max: 1,
      }),
    );
  }
  if (c.person) {
    features.push(
      sensor('Person', ids.feature(FEATURE.PERSON), CAT.MOTION_SENSOR, TYPE.SENSOR.BINARY, {
        min: 0,
        max: 1,
      }),
    );
  }
  return features;
}

/** The Gladys discovery payload of an SDM device, or null if unsupported. */
export function buildDevice(gladys, sdmDevice) {
  const kind = deviceKind(sdmDevice);
  if (!kind) {
    return null;
  }
  const ids = idsOf(gladys, sdmDevice);
  const features =
    kind === KIND.THERMOSTAT
      ? thermostatFeatures(ids, readThermostat(sdmDevice.traits))
      : cameraFeatures(ids, readCamera(sdmDevice.traits), kind);
  return {
    name: displayName(sdmDevice),
    external_id: ids.device,
    // The SDM resource name: what every command and image call needs.
    params: [{ name: 'NEST_DEVICE', value: sdmDevice.name }],
    should_poll: false,
    features,
  };
}

/**
 * The current states of a device, as `publishChangedStates` entries. Only
 * the values the device reports: a setpoint absent in Eco or Off mode keeps
 * its last value in Gladys. A camera reports its detections at rest (0),
 * except those `held` right now (a ring or a motion still shown), so a full
 * refresh clears a detection a restart left at 1.
 * @param {Set<string>} [held] feature external_ids currently pulsed
 */
export function buildStates(gladys, sdmDevice, held = new Set()) {
  const ids = idsOf(gladys, sdmDevice);
  const states = [];
  const add = (key, value) => {
    if (value !== undefined) {
      states.push({ device_feature_external_id: ids.feature(key), state: value });
    }
  };
  const kind = deviceKind(sdmDevice);
  if (kind !== KIND.THERMOSTAT) {
    const c = readCamera(sdmDevice.traits);
    const detections = [
      [FEATURE.RING, kind === KIND.DOORBELL || c.chime],
      [FEATURE.MOTION, c.motion],
      [FEATURE.PERSON, c.person],
    ];
    for (const [key, present] of detections) {
      if (present && !held.has(ids.feature(key))) {
        add(key, 0);
      }
    }
    return states;
  }
  const t = readThermostat(sdmDevice.traits);
  add(FEATURE.TEMPERATURE, round(t.temperature));
  add(FEATURE.HUMIDITY, round(t.humidity));
  add(FEATURE.MODE, GLADYS_MODE[t.mode]);
  add(FEATURE.HVAC, HVAC_STATE[t.hvac]);
  if (!t.eco) {
    add(FEATURE.HEAT_SETPOINT, round(t.heat));
    add(FEATURE.COOL_SETPOINT, round(t.cool));
  }
  if (t.ecoAvailable) {
    add(FEATURE.ECO, t.eco ? 1 : 0);
  }
  if (t.fanAvailable) {
    add(FEATURE.FAN, t.fanOn ? 1 : 0);
  }
  return states;
}

/** One decimal: Nest reports setpoints like 20.5 and readings like 21.12. */
function round(value) {
  return value === undefined ? undefined : Math.round(value * 10) / 10;
}
