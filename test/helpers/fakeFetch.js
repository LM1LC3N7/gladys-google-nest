// -----------------------------------------------------------------------------
// Fake `fetch` for the tests: routes requests to handlers, records every
// call, and fails loudly on an unexpected URL. No test touches the network.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { setFetch } from '../../src/http.js';

// Outside installFetch, any request fails: a test that forgets its fake
// cannot reach the real network.
setFetch(async (url) => {
  throw new Error(`Network call without a fake fetch in a test: ${url}`);
});

export function fixture(name) {
  return JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));
}

export const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

export const googleError = (status, reason, message = 'refused') =>
  json({ error: { code: status, status: reason, message } }, status);

export const binary = (buffer, type = 'image/jpeg') =>
  new Response(buffer, { status: 200, headers: { 'content-type': type } });

/**
 * Install a fake fetch. `routes` is a list of [method, pattern, handler]: the
 * first route whose method and RegExp match answers handler(call). A call is
 * `{ url, method, headers, body }`, the body parsed from JSON or form data.
 */
export function installFetch(routes) {
  const calls = [];
  const previous = setFetch(async (url, init = {}) => {
    const method = init.method ?? 'GET';
    let body = init.body;
    if (typeof body === 'string') {
      body = init.headers?.['Content-Type']?.includes('json')
        ? JSON.parse(body)
        : Object.fromEntries(new URLSearchParams(body));
    }
    const call = { url, method, headers: init.headers ?? {}, body, signal: init.signal };
    calls.push(call);
    const route = routes.find(([m, pattern]) => m === method && pattern.test(url));
    if (!route) {
      throw new Error(`Unexpected network call in a test: ${method} ${url}`);
    }
    return route[2](call);
  });
  return { calls, restore: () => setFetch(previous) };
}

export const tokenAnswer = (extra = {}) =>
  json({ access_token: 'access-1', expires_in: 3599, token_type: 'Bearer', ...extra });

/** The usual Google routes: token refresh and the fixture device list. */
export function googleRoutes({ devices = fixture('sdm-devices.json'), extra = [] } = {}) {
  return [
    ...extra,
    ['POST', /oauth2\.googleapis\.com\/token/, () => tokenAnswer()],
    [
      'GET',
      /smartdevicemanagement\.googleapis\.com\/v1\/enterprises\/[^/]+\/devices$/,
      () => json(devices),
    ],
    ['POST', /:executeCommand$/, () => json({ results: {} })],
  ];
}

// The fixtures describe the devices as Google answered on 2026-10-12.
export const FIXTURE_NOW = Date.parse('2026-10-12T15:00:00Z');
