// -----------------------------------------------------------------------------
// Reading the SDM device resources (pure functions).
//
// The API documents its traits, but a trait or a field is absent whenever it
// does not apply (setpoints in Eco or Off mode, humidity on some models):
// every reader tolerates a missing value and answers undefined.
// -----------------------------------------------------------------------------

const TRAIT_PREFIX = 'sdm.devices.traits.';
const TYPE_PREFIX = 'sdm.devices.types.';

export const KIND = {
  THERMOSTAT: 'thermostat',
  CAMERA: 'camera',
  DOORBELL: 'doorbell',
  DISPLAY: 'display',
};

const KINDS_BY_TYPE = {
  THERMOSTAT: KIND.THERMOSTAT,
  CAMERA: KIND.CAMERA,
  DOORBELL: KIND.DOORBELL,
  DISPLAY: KIND.DISPLAY,
};

export function trait(traits, name) {
  return traits?.[`${TRAIT_PREFIX}${name}`];
}

const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

/** "enterprises/p/devices/ABC" -> "ABC" */
export function deviceId(name) {
  return String(name ?? '')
    .split('/')
    .pop();
}

/** The kind of a device, or undefined for a type we do not handle. */
export function deviceKind(device) {
  const type = String(device?.type ?? '');
  return type.startsWith(TYPE_PREFIX) ? KINDS_BY_TYPE[type.slice(TYPE_PREFIX.length)] : undefined;
}

/** The room the user placed the device in, in the Google Home app. */
export function roomName(device) {
  const relation = (device?.parentRelations ?? []).find((r) => r?.displayName);
  return relation?.displayName;
}

/** Whether Google can reach the device right now. Unknown counts as online. */
export function isOnline(traits) {
  return trait(traits, 'Connectivity')?.status !== 'OFFLINE';
}

export function readThermostat(traits) {
  const mode = trait(traits, 'ThermostatMode');
  const eco = trait(traits, 'ThermostatEco');
  const setpoint = trait(traits, 'ThermostatTemperatureSetpoint');
  const fan = trait(traits, 'Fan');
  const availableModes = Array.isArray(mode?.availableModes) ? mode.availableModes : [];
  const ecoModes = Array.isArray(eco?.availableModes) ? eco.availableModes : [];
  return {
    temperature: num(trait(traits, 'Temperature')?.ambientTemperatureCelsius),
    humidity: num(trait(traits, 'Humidity')?.ambientHumidityPercent),
    mode: mode?.mode,
    availableModes,
    hvac: trait(traits, 'ThermostatHvac')?.status,
    heat: num(setpoint?.heatCelsius),
    cool: num(setpoint?.coolCelsius),
    ecoAvailable: ecoModes.includes('MANUAL_ECO'),
    eco: eco?.mode === 'MANUAL_ECO',
    ecoHeat: num(eco?.heatCelsius),
    ecoCool: num(eco?.coolCelsius),
    // A fan without a timer mode cannot be driven (no fan wired).
    fanAvailable: Boolean(fan && 'timerMode' in fan),
    fanOn: fan?.timerMode === 'ON',
    scale: trait(traits, 'Settings')?.temperatureScale,
    online: isOnline(traits),
  };
}

export function readCamera(traits) {
  const live = trait(traits, 'CameraLiveStream');
  const protocols = Array.isArray(live?.supportedProtocols) ? live.supportedProtocols : [];
  return {
    rtsp: protocols.includes('RTSP'),
    webrtc: protocols.includes('WEB_RTC'),
    // GenerateImage on events: older (RTSP era) cameras only.
    eventImage: Boolean(trait(traits, 'CameraEventImage')),
    // A short mp4 preview of each event: newer battery cameras and doorbells.
    clipPreview: Boolean(trait(traits, 'CameraClipPreview')),
    motion: Boolean(trait(traits, 'CameraMotion')),
    person: Boolean(trait(traits, 'CameraPerson')),
    sound: Boolean(trait(traits, 'CameraSound')),
    chime: Boolean(trait(traits, 'DoorbellChime')),
    online: isOnline(traits),
  };
}

/**
 * Apply a trait update (Pub/Sub `resourceUpdate.traits`) to a device. Each
 * updated trait replaces the stored one as a whole, like the reference
 * client does: a thermostat switched to cooling sends a setpoint trait with
 * `coolCelsius` only, and the stale `heatCelsius` must go.
 */
export function applyTraits(device, update) {
  return { ...device, traits: { ...(device.traits ?? {}), ...(update ?? {}) } };
}
