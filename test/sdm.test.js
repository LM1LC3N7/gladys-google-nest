import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { TokenManager } from '../src/google/oauth.js';
import { SdmClient } from '../src/google/sdm.js';
import { GoogleApiError } from '../src/http.js';
import { googleError, googleRoutes, installFetch, json, tokenAnswer } from './helpers/fakeFetch.js';

let fake;
afterEach(() => fake?.restore());

function client({ now = () => 0, sleep } = {}) {
  const tokens = new TokenManager({ clientId: 'id', clientSecret: 's', refreshToken: 'r', now });
  return new SdmClient({ projectId: 'project-id', tokens, now, sleep });
}

test('devices are listed with the bearer token and the User-Agent', async () => {
  fake = installFetch(googleRoutes());
  const devices = await client().listDevices();
  assert.equal(devices.length, 4);
  const list = fake.calls.find((c) => c.method === 'GET');
  assert.equal(
    list.url,
    'https://smartdevicemanagement.googleapis.com/v1/enterprises/project-id/devices',
  );
  assert.equal(list.headers.Authorization, 'Bearer access-1');
  assert.match(list.headers['User-Agent'], /^gladys-google-nest/);
});

test('an empty answer is an empty list', async () => {
  fake = installFetch(googleRoutes({ devices: {} }));
  assert.deepEqual(await client().listDevices(), []);
});

test('a command posts its name and params, and resolves the results', async () => {
  fake = installFetch([
    ['POST', /token/, () => tokenAnswer()],
    ['POST', /:executeCommand$/, () => json({ results: { ok: 1 } })],
  ]);
  const results = await client().executeCommand('enterprises/project-id/devices/D', 'cmd.X', {
    a: 1,
  });
  assert.deepEqual(results, { ok: 1 });
  const call = fake.calls.at(-1);
  assert.equal(
    call.url,
    'https://smartdevicemanagement.googleapis.com/v1/enterprises/project-id/devices/D:executeCommand',
  );
  assert.deepEqual(call.body, { command: 'cmd.X', params: { a: 1 } });
});

test('a 401 refreshes the token and retries once', async () => {
  let first = true;
  fake = installFetch([
    ['POST', /token/, () => tokenAnswer()],
    [
      'GET',
      /devices$/,
      () => {
        if (first) {
          first = false;
          return googleError(401, 'UNAUTHENTICATED');
        }
        return json({ devices: [] });
      },
    ],
  ]);
  assert.deepEqual(await client().listDevices(), []);
  assert.equal(fake.calls.filter((c) => /token/.test(c.url)).length, 2);
});

test('Google errors carry their status and reason', async () => {
  fake = installFetch([
    ['POST', /token/, () => tokenAnswer()],
    [
      'POST',
      /:executeCommand$/,
      () => googleError(400, 'FAILED_PRECONDITION', 'Cannot set heat in COOL mode.'),
    ],
  ]);
  await assert.rejects(client().executeCommand('enterprises/p/devices/D', 'cmd'), (err) => {
    assert.ok(err instanceof GoogleApiError);
    assert.equal(err.status, 400);
    assert.equal(err.reason, 'FAILED_PRECONDITION');
    assert.equal(err.detail, 'Cannot set heat in COOL mode.');
    return true;
  });
});

test('the same command on one device is spaced by a second, others are not', async () => {
  let now = 0;
  const waits = [];
  fake = installFetch([
    ['POST', /token/, () => tokenAnswer()],
    ['POST', /:executeCommand$/, () => json({ results: {} })],
  ]);
  const sdm = client({
    now: () => now,
    sleep: async (ms) => {
      waits.push(ms);
      now += ms;
    },
  });
  await sdm.executeCommand('enterprises/p/devices/D', 'a');
  await Promise.all([
    sdm.executeCommand('enterprises/p/devices/D', 'b'),
    sdm.executeCommand('enterprises/p/devices/OTHER', 'a'),
  ]);
  await sdm.executeCommand('enterprises/p/devices/D', 'a');
  assert.deepEqual(waits, [1000]);
  const order = fake.calls.filter((c) => c.body?.command).map((c) => c.body.command);
  assert.deepEqual(order, ['a', 'b', 'a', 'a']);
});

test('a value waiting its turn is replaced by a newer one (slider drag)', async () => {
  let now = 0;
  fake = installFetch([
    ['POST', /token/, () => tokenAnswer()],
    ['POST', /:executeCommand$/, () => json({ results: {} })],
  ]);
  const sdm = client({
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  });
  const name = 'enterprises/p/devices/D';
  await sdm.executeCommand(name, 'set', { v: 1 });
  await Promise.all([
    sdm.executeCommand(name, 'set', { v: 2 }),
    sdm.executeCommand(name, 'set', { v: 3 }),
    sdm.executeCommand(name, 'set', { v: 4 }),
  ]);
  const sent = fake.calls.filter((c) => c.body?.command).map((c) => c.body.params.v);
  assert.deepEqual(sent, [1, 4]);
});
