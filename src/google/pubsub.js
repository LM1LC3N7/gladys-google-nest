// -----------------------------------------------------------------------------
// Cloud Pub/Sub: where Google publishes the Nest events (doorbell, motion,
// person, sound) and the trait changes (a setpoint changed in the Nest app).
//
// Since 2025 the topic lives in the user's own Cloud project. We PULL from a
// subscription with the user's OAuth token (pubsub scope), like Home
// Assistant: no public endpoint, no Gladys Plus, no service account. The REST
// pull is enough for a few messages a minute; the gRPC client library would
// add about 90 MB of memory.
// -----------------------------------------------------------------------------

import {
  PUBSUB_API,
  PULL_BACKOFF_MAX,
  PULL_BACKOFF_MIN,
  PULL_FAILURES_REPORTED,
  PULL_MAX_MESSAGES,
  PULL_MIN_PERIOD,
  PULL_TIMEOUT,
} from '../constants.js';
import { requestJson } from '../http.js';
import { authorized } from './authorized.js';
import { isAuthError } from './oauth.js';

// Our subscription, when the user gives a topic: one per topic project.
export const DEFAULT_SUBSCRIPTION = 'gladys-google-nest';

// The Google group that publishes the Nest events: it must be allowed to
// publish on the topic (Google's Device Access guide, "Create a topic").
export const SDM_PUBLISHER = 'group:sdm-publisher@googlegroups.com';
const PUBLISHER_ROLE = 'roles/pubsub.publisher';

const RESOURCE =
  /^projects\/([a-z][a-z0-9-]{4,28}[a-z0-9])\/(topics|subscriptions)\/([A-Za-z][\w.~+%-]{2,254})$/;

/**
 * Parse the topic or subscription the user typed. Resolves
 * `{ subscription, topic? }` (full resource names), or null when invalid.
 * A topic means "create our own subscription on it".
 */
export function parseEventSource(input) {
  const match = RESOURCE.exec(String(input ?? '').trim());
  if (!match) {
    return null;
  }
  const [, project, kind, name] = match;
  if (kind === 'subscriptions') {
    return { subscription: `projects/${project}/subscriptions/${name}` };
  }
  return {
    topic: `projects/${project}/topics/${name}`,
    subscription: `projects/${project}/subscriptions/${DEFAULT_SUBSCRIPTION}`,
  };
}

export class PubSubClient {
  constructor({ tokens }) {
    this.tokens = tokens;
  }

  async getSubscription(subscription) {
    return authorized(this.tokens, (token) =>
      requestJson(`${PUBSUB_API}/${subscription}`, { token }),
    );
  }

  /**
   * Create our own topic in the user's Cloud project and let Google publish
   * on it: the two steps of the setup guide nobody enjoys. Idempotent: an
   * existing topic and an existing binding are left as they are. Resolves
   * `{ created }`.
   */
  async ensureTopic(topic) {
    let created = false;
    try {
      await authorized(this.tokens, (token) =>
        requestJson(`${PUBSUB_API}/${topic}`, { method: 'PUT', token, body: {} }),
      );
      created = true;
    } catch (err) {
      if (err.status !== 409) {
        throw err;
      }
    }
    const policy = await authorized(this.tokens, (token) =>
      requestJson(`${PUBSUB_API}/${topic}:getIamPolicy`, { token }),
    );
    const bindings = Array.isArray(policy.bindings) ? policy.bindings : [];
    const binding = bindings.find((b) => b.role === PUBLISHER_ROLE);
    if (binding?.members?.includes(SDM_PUBLISHER)) {
      return { created };
    }
    if (binding) {
      binding.members = [...(binding.members ?? []), SDM_PUBLISHER];
    } else {
      bindings.push({ role: PUBLISHER_ROLE, members: [SDM_PUBLISHER] });
    }
    // The etag makes the write fail instead of overwriting a concurrent one.
    await authorized(this.tokens, (token) =>
      requestJson(`${PUBSUB_API}/${topic}:setIamPolicy`, {
        method: 'POST',
        token,
        body: { policy: { etag: policy.etag, bindings } },
      }),
    );
    return { created };
  }

  /** Create a subscription that never expires (the default is 31 idle days). */
  async createSubscription(subscription, topic) {
    return authorized(this.tokens, (token) =>
      requestJson(`${PUBSUB_API}/${subscription}`, {
        method: 'PUT',
        token,
        body: { topic, ackDeadlineSeconds: 30, expirationPolicy: {} },
      }),
    );
  }

  /**
   * Make sure the subscription exists, and listens to the expected topic;
   * create it on the topic when missing.
   */
  async ensureSubscription({ subscription, topic }) {
    let answer;
    try {
      answer = await this.getSubscription(subscription);
    } catch (err) {
      if (err.status === 404 && topic) {
        return this.createSubscription(subscription, topic);
      }
      throw err;
    }
    // Our subscription name is fixed per project: after a topic change, the
    // old one would stay, silently listening to the old topic.
    if (topic && answer.topic && answer.topic !== topic) {
      throw new Error(
        `${subscription} listens to ${answer.topic}, not ${topic}: delete it in the Cloud console, the integration creates it again`,
      );
    }
    return answer;
  }

  async pull(subscription, signal) {
    const answer = await authorized(this.tokens, (token) =>
      requestJson(`${PUBSUB_API}/${subscription}:pull`, {
        method: 'POST',
        token,
        timeout: PULL_TIMEOUT,
        signal,
        body: { maxMessages: PULL_MAX_MESSAGES },
      }),
    );
    return Array.isArray(answer.receivedMessages) ? answer.receivedMessages : [];
  }

  async acknowledge(subscription, ackIds) {
    if (ackIds.length === 0) {
      return;
    }
    await authorized(this.tokens, (token) =>
      requestJson(`${PUBSUB_API}/${subscription}:acknowledge`, {
        method: 'POST',
        token,
        body: { ackIds },
      }),
    );
  }
}

/** Decode the JSON payload of a Pub/Sub message, or undefined. */
export function decodeMessage(received) {
  try {
    return JSON.parse(Buffer.from(received?.message?.data ?? '', 'base64').toString('utf8'));
  } catch {
    return undefined;
  }
}

/**
 * The pull loop: pull, acknowledge, then hand every decoded message to
 * `onMessage(event, { publishTime })`. Acknowledging first: a message whose
 * handling fails or takes long is never replayed (a doorbell press replayed
 * minutes later would be worse than a missed one), and a slow Gladys cannot
 * push the batch past its ack deadline. Errors back off from 5 s to 5
 * minutes, and `onHealth(false, err)` reports them after a few in a row
 * (`onHealth(true)` once it works again); an authentication error stops the
 * loop (`onAuthError`), since retrying cannot fix it.
 */
export class EventStream {
  constructor({ client, subscription, onMessage, onError, onAuthError, onHealth, sleep, now }) {
    this.client = client;
    this.subscription = subscription;
    this.onMessage = onMessage;
    this.onError = onError ?? (() => {});
    this.onAuthError = onAuthError ?? (() => {});
    this.onHealth = onHealth ?? (() => {});
    this.now = now ?? Date.now;
    this.sleep =
      sleep ??
      ((ms, signal) =>
        new Promise((resolve) => {
          const done = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', done);
            resolve();
          };
          const timer = setTimeout(done, ms);
          signal.addEventListener('abort', done, { once: true });
        }));
    this.controller = undefined;
    this.done = undefined;
  }

  get running() {
    return Boolean(this.controller);
  }

  start() {
    if (this.controller) {
      return;
    }
    this.controller = new AbortController();
    this.done = this.loop(this.controller.signal);
  }

  async stop() {
    this.controller?.abort();
    this.controller = undefined;
    await this.done;
  }

  async loop(signal) {
    let backoff = PULL_BACKOFF_MIN;
    let failures = 0;
    while (!signal.aborted) {
      const startedAt = this.now();
      let messages;
      try {
        messages = await this.client.pull(this.subscription, signal);
        if (failures >= PULL_FAILURES_REPORTED) {
          this.onHealth(true);
        }
        failures = 0;
        backoff = PULL_BACKOFF_MIN;
      } catch (err) {
        if (signal.aborted) {
          break;
        }
        if (isAuthError(err)) {
          this.controller = undefined;
          this.onAuthError(err);
          break;
        }
        // A pull held to its deadline is normal: retry at once.
        if (err.name !== 'TimeoutError') {
          failures += 1;
          this.onError(err);
          if (failures === PULL_FAILURES_REPORTED) {
            this.onHealth(false, err);
          }
          await this.sleep(backoff, signal);
          backoff = Math.min(backoff * 2, PULL_BACKOFF_MAX);
        }
        continue;
      }
      try {
        await this.client.acknowledge(
          this.subscription,
          messages.map((m) => m.ackId).filter(Boolean),
        );
      } catch (err) {
        // Redelivered later at worst; the events are deduplicated.
        this.onError(err);
      }
      for (const received of messages) {
        if (signal.aborted) {
          break;
        }
        const event = decodeMessage(received);
        if (event) {
          try {
            const publishTime = Date.parse(received.message?.publishTime ?? '');
            await this.onMessage(event, {
              publishTime: Number.isFinite(publishTime) ? publishTime : undefined,
            });
          } catch (err) {
            this.onError(err);
          }
        }
      }
      // Google may answer an empty pull at once: no busy loop.
      if (messages.length === 0 && this.now() - startedAt < PULL_MIN_PERIOD && !signal.aborted) {
        await this.sleep(PULL_MIN_PERIOD, signal);
      }
    }
  }
}
