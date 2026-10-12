// -----------------------------------------------------------------------------
// Pub/Sub messages of the SDM API (pure functions).
//
// A message carries either a resource update (trait changes and/or device
// events) or a relation update (a device added, removed or moved). Newer
// cameras group the events of one visit in a "session": the same
// eventSessionId comes back with STARTED, UPDATED and ENDED threads.
// -----------------------------------------------------------------------------

const EVENT_TYPES = {
  'sdm.devices.events.CameraMotion.Motion': 'motion',
  'sdm.devices.events.CameraPerson.Person': 'person',
  'sdm.devices.events.CameraSound.Sound': 'sound',
  'sdm.devices.events.DoorbellChime.Chime': 'chime',
  'sdm.devices.events.CameraClipPreview.ClipPreview': 'clip',
};

export function parseMessage(message) {
  const update = message?.resourceUpdate;
  const timestamp = Date.parse(message?.timestamp ?? '');
  return {
    name: typeof update?.name === 'string' ? update.name : undefined,
    traits: update?.traits && typeof update.traits === 'object' ? update.traits : undefined,
    events: Object.entries(update?.events ?? {})
      .map(([key, event]) => ({
        type: EVENT_TYPES[key],
        eventId: event?.eventId,
        sessionId: event?.eventSessionId ?? event?.eventId,
        previewUrl: event?.previewUrl,
      }))
      .filter((event) => event.type),
    timestamp: Number.isFinite(timestamp) ? timestamp : undefined,
    relation: Boolean(message?.relationUpdate),
  };
}
