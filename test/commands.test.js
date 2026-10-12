import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMMANDS,
  CommandError,
  impliedTraits,
  planThermostatCommand,
} from '../src/nest/commands.js';
import { FEATURE } from '../src/nest/devices.js';
import { applyTraits } from '../src/nest/traits.js';
import { fixture } from './helpers/fakeFetch.js';

const [thermostat] = fixture('sdm-devices.json').devices;
const options = { fanMinutes: 15 };
const plan = (device, key, value) => planThermostatCommand(device, key, value, options);
const withTraits = (traits) => applyTraits(thermostat, traits);
const mode = (m) => ({
  'sdm.devices.traits.ThermostatMode': {
    mode: m,
    availableModes: ['HEAT', 'COOL', 'HEATCOOL', 'OFF'],
  },
});

test('modes map from the Gladys enum, unsupported ones refused', () => {
  assert.deepEqual(plan(thermostat, FEATURE.MODE, 3), [
    { command: COMMANDS.SET_MODE, params: { mode: 'HEATCOOL' } },
  ]);
  assert.deepEqual(plan(thermostat, FEATURE.MODE, 0), [
    { command: COMMANDS.SET_MODE, params: { mode: 'OFF' } },
  ]);
  const heatOnly = withTraits({
    'sdm.devices.traits.ThermostatMode': { mode: 'HEAT', availableModes: ['HEAT', 'OFF'] },
  });
  assert.throws(() => plan(heatOnly, FEATURE.MODE, 2), CommandError);
  assert.throws(() => plan(thermostat, FEATURE.MODE, 9), CommandError);
});

test('eco and fan', () => {
  assert.deepEqual(plan(thermostat, FEATURE.ECO, 1), [
    { command: COMMANDS.SET_ECO, params: { mode: 'MANUAL_ECO' } },
  ]);
  assert.deepEqual(plan(thermostat, FEATURE.FAN, 1), [
    { command: COMMANDS.SET_FAN, params: { timerMode: 'ON', duration: '900s' } },
  ]);
  assert.deepEqual(plan(thermostat, FEATURE.FAN, 0), [
    { command: COMMANDS.SET_FAN, params: { timerMode: 'OFF' } },
  ]);
});

test('the setpoint of the current mode, rounded to half a degree and bounded', () => {
  assert.deepEqual(plan(thermostat, FEATURE.HEAT_SETPOINT, 21.26), [
    { command: COMMANDS.SET_HEAT, params: { heatCelsius: 21.5 } },
  ]);
  assert.deepEqual(plan(thermostat, FEATURE.HEAT_SETPOINT, 40), [
    { command: COMMANDS.SET_HEAT, params: { heatCelsius: 32 } },
  ]);
  const cooling = withTraits({
    ...mode('COOL'),
    'sdm.devices.traits.ThermostatTemperatureSetpoint': { coolCelsius: 24 },
  });
  assert.deepEqual(plan(cooling, FEATURE.COOL_SETPOINT, 23), [
    { command: COMMANDS.SET_COOL, params: { coolCelsius: 23 } },
  ]);
  assert.throws(() => plan(cooling, FEATURE.HEAT_SETPOINT, 20), /cooling/);
  assert.throws(() => plan(thermostat, FEATURE.COOL_SETPOINT, 20), /heating/);
  assert.throws(() => plan(withTraits(mode('OFF')), FEATURE.HEAT_SETPOINT, 20), /off/);
  assert.throws(() => plan(thermostat, FEATURE.HEAT_SETPOINT, 'abc'), CommandError);
});

test('a range move keeps the other end', () => {
  const range = withTraits({
    ...mode('HEATCOOL'),
    'sdm.devices.traits.ThermostatTemperatureSetpoint': { heatCelsius: 19, coolCelsius: 25 },
  });
  assert.deepEqual(plan(range, FEATURE.COOL_SETPOINT, 26), [
    { command: COMMANDS.SET_RANGE, params: { heatCelsius: 19, coolCelsius: 26 } },
  ]);
  assert.deepEqual(plan(range, FEATURE.HEAT_SETPOINT, 18), [
    { command: COMMANDS.SET_RANGE, params: { heatCelsius: 18, coolCelsius: 25 } },
  ]);
});

test('a setpoint leaves Eco first, except for a range', () => {
  const eco = withTraits({
    'sdm.devices.traits.ThermostatEco': {
      availableModes: ['OFF', 'MANUAL_ECO'],
      mode: 'MANUAL_ECO',
    },
    'sdm.devices.traits.ThermostatTemperatureSetpoint': {},
  });
  assert.deepEqual(plan(eco, FEATURE.HEAT_SETPOINT, 20), [
    { command: COMMANDS.SET_ECO, params: { mode: 'OFF' } },
    { command: COMMANDS.SET_HEAT, params: { heatCelsius: 20 } },
  ]);
  const ecoRange = applyTraits(eco, mode('HEATCOOL'));
  assert.throws(() => plan(ecoRange, FEATURE.HEAT_SETPOINT, 20), /Eco/);
});

test('read-only features cannot be commanded', () => {
  assert.throws(() => plan(thermostat, FEATURE.TEMPERATURE, 20), CommandError);
});

test('a successful command implies its traits at once', () => {
  const step = { command: COMMANDS.SET_HEAT, params: { heatCelsius: 22 } };
  const after = applyTraits(thermostat, impliedTraits(thermostat, step));
  assert.equal(after.traits['sdm.devices.traits.ThermostatTemperatureSetpoint'].heatCelsius, 22);
  const fan = applyTraits(
    thermostat,
    impliedTraits(thermostat, { command: COMMANDS.SET_FAN, params: { timerMode: 'ON' } }),
  );
  assert.equal(fan.traits['sdm.devices.traits.Fan'].timerMode, 'ON');
  assert.deepEqual(impliedTraits(thermostat, { command: 'other', params: {} }), {});
});
