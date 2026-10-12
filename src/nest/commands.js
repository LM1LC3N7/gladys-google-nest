// -----------------------------------------------------------------------------
// Gladys commands -> SDM commands (pure functions).
//
// Each function answers the list of commands to run, in order, or throws an
// error whose message is shown to the user. A setpoint is only accepted in a
// mode that uses it: Google refuses it otherwise, with a less helpful message.
// -----------------------------------------------------------------------------

import { SETPOINT_MAX, SETPOINT_MIN } from '../constants.js';
import { FEATURE, GLADYS_MODE } from './devices.js';
import { readThermostat } from './traits.js';

const CMD = 'sdm.devices.commands.';

export const COMMANDS = {
  SET_MODE: `${CMD}ThermostatMode.SetMode`,
  SET_ECO: `${CMD}ThermostatEco.SetMode`,
  SET_HEAT: `${CMD}ThermostatTemperatureSetpoint.SetHeat`,
  SET_COOL: `${CMD}ThermostatTemperatureSetpoint.SetCool`,
  SET_RANGE: `${CMD}ThermostatTemperatureSetpoint.SetRange`,
  SET_FAN: `${CMD}Fan.SetTimer`,
  GENERATE_RTSP: `${CMD}CameraLiveStream.GenerateRtspStream`,
  STOP_RTSP: `${CMD}CameraLiveStream.StopRtspStream`,
  GENERATE_IMAGE: `${CMD}CameraEventImage.GenerateImage`,
};

/** A user-facing refusal (bad value, wrong mode): not a Google failure. */
export class CommandError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CommandError';
  }
}

const clampSetpoint = (value) =>
  Math.min(SETPOINT_MAX, Math.max(SETPOINT_MIN, Math.round(Number(value) * 2) / 2));

/**
 * Plan the commands for one thermostat feature.
 * @param {object} sdmDevice the current SDM resource
 * @param {string} featureKey one of FEATURE
 * @param {number} value the value Gladys sent
 * @param {{ fanMinutes: number }} options
 * @returns {{ command: string, params: object }[]}
 */
export function planThermostatCommand(sdmDevice, featureKey, value, { fanMinutes }) {
  const t = readThermostat(sdmDevice.traits);
  switch (featureKey) {
    case FEATURE.MODE: {
      const mode = Object.keys(GLADYS_MODE).find((m) => GLADYS_MODE[m] === Number(value));
      if (!mode || !t.availableModes.includes(mode)) {
        throw new CommandError(`This thermostat does not support the mode ${value}`);
      }
      return [{ command: COMMANDS.SET_MODE, params: { mode } }];
    }
    case FEATURE.ECO:
      return [
        { command: COMMANDS.SET_ECO, params: { mode: Number(value) ? 'MANUAL_ECO' : 'OFF' } },
      ];
    case FEATURE.FAN:
      return [
        {
          command: COMMANDS.SET_FAN,
          params: Number(value)
            ? { timerMode: 'ON', duration: `${Math.round(fanMinutes * 60)}s` }
            : { timerMode: 'OFF' },
        },
      ];
    case FEATURE.HEAT_SETPOINT:
    case FEATURE.COOL_SETPOINT:
      return planSetpoint(t, featureKey, value);
    default:
      throw new CommandError(`The feature "${featureKey}" cannot be controlled`);
  }
}

function planSetpoint(t, featureKey, value) {
  if (!Number.isFinite(Number(value))) {
    throw new CommandError(`Invalid temperature: ${value}`);
  }
  const target = clampSetpoint(value);
  const heat = featureKey === FEATURE.HEAT_SETPOINT;
  if (t.mode === 'OFF') {
    throw new CommandError('The thermostat is off: choose a mode first');
  }
  if (t.mode === 'HEATCOOL') {
    // A range move sends both ends; the other one keeps its current value,
    // which Google hides while Eco is on.
    const other = heat ? t.cool : t.heat;
    if (t.eco) {
      throw new CommandError('Eco is on: turn it off before changing the range');
    }
    if (other === undefined) {
      throw new CommandError('The current range is unknown yet, try again in a minute');
    }
    return [
      {
        command: COMMANDS.SET_RANGE,
        params: heat
          ? { heatCelsius: target, coolCelsius: other }
          : { heatCelsius: other, coolCelsius: target },
      },
    ];
  }
  // Like on the thermostat itself, a new setpoint leaves Eco.
  const leaveEco = t.eco ? [{ command: COMMANDS.SET_ECO, params: { mode: 'OFF' } }] : [];
  if (heat && t.mode === 'HEAT') {
    return [...leaveEco, { command: COMMANDS.SET_HEAT, params: { heatCelsius: target } }];
  }
  if (!heat && t.mode === 'COOL') {
    return [...leaveEco, { command: COMMANDS.SET_COOL, params: { coolCelsius: target } }];
  }
  throw new CommandError(
    heat
      ? 'The thermostat is cooling: set the cooling setpoint, or change the mode'
      : 'The thermostat is heating: set the heating setpoint, or change the mode',
  );
}

/**
 * The traits a successful command implies, applied at once so Gladys shows
 * the new value without waiting for Google's event or the next refresh.
 */
export function impliedTraits(sdmDevice, { command, params }) {
  const traits = sdmDevice.traits ?? {};
  const T = 'sdm.devices.traits.';
  switch (command) {
    case COMMANDS.SET_MODE:
      return { [`${T}ThermostatMode`]: { ...traits[`${T}ThermostatMode`], mode: params.mode } };
    case COMMANDS.SET_ECO:
      return { [`${T}ThermostatEco`]: { ...traits[`${T}ThermostatEco`], mode: params.mode } };
    case COMMANDS.SET_HEAT:
    case COMMANDS.SET_COOL:
    case COMMANDS.SET_RANGE:
      return {
        [`${T}ThermostatTemperatureSetpoint`]: {
          ...traits[`${T}ThermostatTemperatureSetpoint`],
          ...params,
        },
      };
    case COMMANDS.SET_FAN:
      return { [`${T}Fan`]: { ...traits[`${T}Fan`], timerMode: params.timerMode } };
    default:
      return {};
  }
}
