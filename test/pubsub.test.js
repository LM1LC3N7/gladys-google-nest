import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { TokenManager } from '../src/google/oauth.js';
import {
  EventStream,
  PubSubClient,
  SDM_PUBLISHER,
  decodeMessage,
  parseEventSource,
} from '../src/google/pubsub.js';
import { GoogleApiError } from '../src/http.js';
import { googleError, installFetch, json, tokenAnswer } from './helpers/fakeFetch.js';

let fake;
afterEach(() => fake?.restore());

const tokens = () => new TokenManager({ clientId: 'id', clientSecret: 's', refreshToken: 'r' });
const encode = (event) => Buffer.from(JSON.stringify(event)).toString('base64');

test('a topic means our own subscription; a subscription is used as is', () => {
  assert.deepEqual(parseEventSource(' projects/my-home-123/topics/nest-events '), {
    topic: 'projects/my-home-123/topics/nest-events',
    subscription: 'projects/my-home-123/subscriptions/gladys-google-nest',
  });
  assert.deepEqual(parseEventSource('projects/my-home-123/subscriptions/mine'), {
    subscription: 'projects/my-home-123/subscriptions/mine',
  });
  for (const bad of [
    '',
    'nest-events',
    'projects/x/topics/t',
    'https://pubsub/projects/abcdef/topics/t',
  ]) {
    assert.equal(parseEventSource(bad), null, bad);
  }
});

test('a missing subscription is created on the topic, never expiring', async () => {
  fake = installFetch([
    ['POST', /token/, () => tokenAnswer()],
    ['GET', /subscriptions\/gladys-google-nest$/, () => googleError(404, 'NOT_FOUND')],
    ['PUT', /subscriptions\/gladys-google-nest$/, (call) => json({ name: 'x', ...call.body })],
  ]);
  const client = new PubSubClient({ tokens: tokens() });
  await client.ensureSubscription(parseEventSource('projects/my-home-123/topics/nest-events'));
  const put = fake.calls.find((c) => c.method === 'PUT');
  assert.equal(
    put.url,
    'https://pubsub.googleapis.com/v1/projects/my-home-123/subscriptions/gladys-google-nest',
  );
  assert.deepEqual(put.body, {
    topic: 'projects/my-home-123/topics/nest-events',
    ackDeadlineSeconds: 30,
    expirationPolicy: {},
  });
});

test('ensureTopic creates the topic and lets Google publish on it, once', async () => {
  let policy = { etag: 'e1', bindings: [{ role: 'roles/pubsub.viewer', members: ['user:me'] }] };
  fake = installFetch([
    ['POST', /token/, () => tokenAnswer()],
    ['PUT', /topics\/gladys-google-nest$/, () => json({ name: 'x' })],
    ['GET', /:getIamPolicy$/, () => json(policy)],
    [
      'POST',
      /:setIamPolicy$/,
      (call) => {
        policy = { etag: 'e2', bindings: call.body.policy.bindings };
        return json(policy);
      },
    ],
  ]);
  const client = new PubSubClient({ tokens: tokens() });
  const topic = 'projects/my-home-123/topics/gladys-google-nest';
  assert.deepEqual(await client.ensureTopic(topic), { created: true });
  const set = fake.calls.find((c) => c.url.endsWith(':setIamPolicy'));
  assert.deepEqual(set.body, {
    policy: {
      etag: 'e1',
      bindings: [
        { role: 'roles/pubsub.viewer', members: ['user:me'] },
        { role: 'roles/pubsub.publisher', members: [SDM_PUBLISHER] },
      ],
    },
  });

  // Second run: the topic exists (409) and the binding is there: no write.
  fake.restore();
  fake = installFetch([
    ['POST', /token/, () => tokenAnswer()],
    ['PUT', /topics\/gladys-google-nest$/, () => googleError(409, 'ALREADY_EXISTS')],
    ['GET', /:getIamPolicy$/, () => json(policy)],
  ]);
  assert.deepEqual(await client.ensureTopic(topic), { created: false });
  assert.ok(!fake.calls.some((c) => c.url.endsWith(':setIamPolicy')));
});

test('ensureTopic adds the publisher to an existing publisher binding', async () => {
  fake = installFetch([
    ['POST', /token/, () => tokenAnswer()],
    ['PUT', /topics\/gladys-google-nest$/, () => googleError(409, 'ALREADY_EXISTS')],
    [
      'GET',
      /:getIamPolicy$/,
      () =>
        json({ etag: 'e', bindings: [{ role: 'roles/pubsub.publisher', members: ['user:me'] }] }),
    ],
    ['POST', /:setIamPolicy$/, (call) => json(call.body.policy)],
  ]);
  const client = new PubSubClient({ tokens: tokens() });
  await client.ensureTopic('projects/my-home-123/topics/gladys-google-nest');
  const set = fake.calls.find((c) => c.url.endsWith(':setIamPolicy'));
  assert.deepEqual(set.body.policy.bindings, [
    { role: 'roles/pubsub.publisher', members: ['user:me', SDM_PUBLISHER] },
  ]);
});

test('ensureTopic fails on a project the account cannot manage', async () => {
  fake = installFetch([
    ['POST', /token/, () => tokenAnswer()],
    ['PUT', /topics\/gladys-google-nest$/, () => googleError(403, 'PERMISSION_DENIED')],
  ]);
  const client = new PubSubClient({ tokens: tokens() });
  await assert.rejects(
    client.ensureTopic('projects/my-home-123/topics/gladys-google-nest'),
    /PERMISSION_DENIED/,
  );
});

test('a missing subscription without a topic is an error', async () => {
  fake = installFetch([
    ['POST', /token/, () => tokenAnswer()],
    ['GET', /subscriptions\/mine$/, () => googleError(404, 'NOT_FOUND')],
  ]);
  const client = new PubSubClient({ tokens: tokens() });
  await assert.rejects(
    client.ensureSubscription({ subscription: 'projects/my-home-123/subscriptions/mine' }),
    /NOT_FOUND/,
  );
});

test('undecodable messages are skipped', () => {
  assert.equal(
    decodeMessage({ message: { data: Buffer.from('not json').toString('base64') } }),
    undefined,
  );
  assert.deepEqual(decodeMessage({ message: { data: encode({ a: 1 }) } }), { a: 1 });
});

test('the stream hands every message over and acknowledges them, even a failing one', async () => {
  const handled = [];
  const acked = [];
  let pulls = 0;
  let stream;
  const client = {
    async pull() {
      pulls += 1;
      if (pulls === 1) {
        return [
          { ackId: 'a1', message: { data: encode({ n: 1 }) } },
          { ackId: 'a2', message: { data: encode({ n: 2 }) } },
        ];
      }
      // Second pull: stop the loop from inside, like a shutdown would.
      stream.controller.abort();
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    },
    async acknowledge(_subscription, ids) {
      order.push('ack');
      acked.push(...ids);
    },
  };
  const order = [];
  const errors = [];
  stream = new EventStream({
    client,
    subscription: 'projects/p/subscriptions/s',
    onMessage: async (event) => {
      order.push('handle');
      handled.push(event.n);
      if (event.n === 2) {
        throw new Error('boom');
      }
    },
    onError: (err) => errors.push(err.message),
  });
  stream.start();
  await stream.done;
  assert.deepEqual(handled, [1, 2]);
  assert.deepEqual(acked, ['a1', 'a2']);
  assert.deepEqual(errors, ['boom']);
  assert.deepEqual(order.slice(0, 2), ['ack', 'handle'], 'acknowledged before handling');
});

test('the stream backs off on errors and stops on an authentication error', async () => {
  const sleeps = [];
  let pulls = 0;
  let authError;
  const client = {
    async pull() {
      pulls += 1;
      if (pulls < 3) {
        throw new Error('UNAVAILABLE');
      }
      throw new GoogleApiError(
        401,
        'UNAUTHENTICATED',
        'expired',
        'https://pubsub.googleapis.com/v1/x',
      );
    },
    async acknowledge() {},
  };
  const stream = new EventStream({
    client,
    subscription: 's',
    onMessage: async () => {},
    onAuthError: (err) => {
      authError = err;
    },
    sleep: async (ms) => sleeps.push(ms),
  });
  stream.start();
  await stream.done;
  assert.deepEqual(sleeps, [5000, 10000]);
  assert.ok(authError);
  assert.equal(stream.running, false);
});

test('a pull held to its deadline is retried at once, without backoff', async () => {
  const sleeps = [];
  let pulls = 0;
  let stream;
  const client = {
    async pull() {
      pulls += 1;
      if (pulls === 1) {
        throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
      }
      stream.controller.abort();
      throw new Error('aborted');
    },
    async acknowledge() {},
  };
  stream = new EventStream({
    client,
    subscription: 's',
    onMessage: async () => {},
    sleep: async (ms) => sleeps.push(ms),
  });
  stream.start();
  await stream.done;
  assert.equal(pulls, 2);
  assert.deepEqual(sleeps, []);
});

test('repeated failures are reported, and the recovery too', async () => {
  const health = [];
  let pulls = 0;
  let stream;
  const client = {
    async pull() {
      pulls += 1;
      if (pulls <= 3) {
        throw new Error('PERMISSION_DENIED');
      }
      if (pulls === 4) {
        return [];
      }
      stream.controller.abort();
      throw new Error('aborted');
    },
    async acknowledge() {},
  };
  let clock = 0;
  stream = new EventStream({
    client,
    subscription: 's',
    onMessage: async () => {},
    onHealth: (ok, err) => health.push([ok, err?.message]),
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  });
  stream.start();
  await stream.done;
  assert.deepEqual(health, [
    [false, 'PERMISSION_DENIED'],
    [true, undefined],
  ]);
});

test('the publish time of each message is handed over', async () => {
  const seen = [];
  let stream;
  let pulls = 0;
  const client = {
    async pull() {
      pulls += 1;
      if (pulls === 1) {
        return [
          {
            ackId: 'a',
            message: { data: encode({ n: 1 }), publishTime: '2026-10-12T15:00:00.123Z' },
          },
        ];
      }
      stream.controller.abort();
      throw new Error('aborted');
    },
    async acknowledge() {},
  };
  stream = new EventStream({
    client,
    subscription: 's',
    onMessage: async (event, meta) => seen.push(meta.publishTime),
  });
  stream.start();
  await stream.done;
  assert.deepEqual(seen, [Date.parse('2026-10-12T15:00:00.123Z')]);
});

test('a subscription on another topic is refused', async () => {
  fake = installFetch([
    ['POST', /token/, () => tokenAnswer()],
    [
      'GET',
      /subscriptions\/gladys-google-nest$/,
      () => json({ topic: 'projects/my-home-123/topics/old' }),
    ],
  ]);
  const client = new PubSubClient({ tokens: tokens() });
  await assert.rejects(
    client.ensureSubscription(parseEventSource('projects/my-home-123/topics/new')),
    /listens to projects\/my-home-123\/topics\/old/,
  );
});
