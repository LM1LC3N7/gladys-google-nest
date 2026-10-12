// -----------------------------------------------------------------------------
// In-memory stand-in for the Gladys SDK object: records every call the
// integration makes, so tests assert them without a Gladys server.
// -----------------------------------------------------------------------------

export function createFakeGladys({ config = {} } = {}) {
  const calls = {
    discovered: [],
    states: [],
    state: [],
    transports: [],
    sceneEvents: [],
    images: [],
    statuses: [],
    setConfig: [],
  };
  return {
    calls,
    config: { ...config },
    selector: 'google-nest',

    externalId(suffix) {
      return `ext:${this.selector}:${suffix}`;
    },
    externalIds(type, platformId) {
      const device = this.externalId(`${type}:${platformId}`);
      return { device, feature: (key) => `${device}:${key}` };
    },
    async getConfig() {
      return { ...this.config };
    },
    async setConfig(values) {
      calls.setConfig.push(values);
      Object.assign(this.config, values);
    },
    async publishDiscoveredDevices(devices) {
      calls.discovered.push(devices);
    },
    async publishChangedStates(states) {
      calls.states.push(...states);
      return { success: true, count: states.length };
    },
    async publishState(externalId, value) {
      calls.state.push({ externalId, value });
    },
    async publishTransports(transports) {
      calls.transports.push(transports);
    },
    async publishSceneEvent(key, data) {
      calls.sceneEvents.push({ key, data });
      return { success: true };
    },
    async publishCameraImage(externalId, image) {
      calls.images.push({ externalId, image });
    },
    async setConnectionStatus(connected, message) {
      calls.statuses.push({ connected, message });
    },
  };
}

/** Timers the test fires by hand: nothing runs on its own. */
export function createFakeTimers() {
  const pending = new Map();
  let next = 1;
  const add = (kind) => (fn, ms) => {
    const id = next++;
    pending.set(id, { fn, ms, kind });
    return id;
  };
  const clear = (id) => pending.delete(id);
  return {
    pending,
    setTimeout: add('timeout'),
    setInterval: add('interval'),
    clearTimeout: clear,
    clearInterval: clear,
    /** Run every pending timeout once (intervals stay). */
    async runTimeouts() {
      for (const [id, timer] of [...pending]) {
        if (timer.kind === 'timeout') {
          pending.delete(id);
          await timer.fn();
        }
      }
    },
    intervals() {
      return [...pending.values()].filter((t) => t.kind === 'interval');
    },
  };
}
