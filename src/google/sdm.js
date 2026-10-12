// -----------------------------------------------------------------------------
// Smart Device Management API: the handful of endpoints we need, over fetch.
//
// No Google client library: `googleapis` weighs about 160 MB of memory once
// loaded, the sandbox has 256 MB, and we call three endpoints.
// -----------------------------------------------------------------------------

import { COMMAND_MIN_INTERVAL, COMMAND_TIMEOUT, SDM_API } from '../constants.js';
import { requestJson } from '../http.js';
import { authorized } from './authorized.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class SdmClient {
  /**
   * @param {{ projectId: string, tokens: import('./oauth.js').TokenManager,
   *   now?: () => number, sleep?: (ms: number) => Promise<void> }} options
   */
  constructor({ projectId, tokens, now = Date.now, sleep = delay }) {
    this.projectId = projectId;
    this.tokens = tokens;
    this.now = now;
    this.sleep = sleep;
    // Per device: the promise of its last command.
    this.queues = new Map();
    // Per device and command: when it was last sent.
    this.lastSent = new Map();
    // Per device and command: the call waiting its turn, whose params a
    // newer call replaces (last value wins).
    this.waiting = new Map();
  }

  get enterprise() {
    return `enterprises/${encodeURIComponent(this.projectId)}`;
  }

  async listDevices() {
    const answer = await authorized(this.tokens, (token) =>
      requestJson(`${SDM_API}/${this.enterprise}/devices`, { token }),
    );
    return Array.isArray(answer.devices) ? answer.devices : [];
  }

  /**
   * Run one command on a device; resolves the `results` of the answer.
   * Commands on one device run in order. Google allows the same command 5
   * times a minute per device: it is spaced by a second, and a call still
   * waiting its turn takes the params of a newer identical call (both
   * resolve with the result of the one sent).
   */
  executeCommand(name, command, params = {}) {
    const key = `${name} ${command}`;
    const waiting = this.waiting.get(key);
    if (waiting) {
      waiting.params = params;
      return waiting.promise;
    }
    const entry = { params };
    const previous = this.queues.get(name) ?? Promise.resolve();
    entry.promise = previous
      .catch(() => {})
      .then(async () => {
        const last = this.lastSent.get(key);
        const wait = last === undefined ? 0 : last + COMMAND_MIN_INTERVAL - this.now();
        if (wait > 0) {
          await this.sleep(wait);
        }
        // From here on, a new identical call queues behind this one.
        this.waiting.delete(key);
        this.lastSent.set(key, this.now());
        const answer = await authorized(this.tokens, (token) =>
          requestJson(`${SDM_API}/${name}:executeCommand`, {
            method: 'POST',
            token,
            timeout: COMMAND_TIMEOUT,
            body: { command, params: entry.params },
          }),
        );
        return answer.results ?? {};
      });
    this.waiting.set(key, entry);
    this.queues.set(name, entry.promise);
    entry.promise
      .catch(() => {})
      .finally(() => {
        if (this.queues.get(name) === entry.promise) {
          this.queues.delete(name);
        }
      });
    return entry.promise;
  }
}
