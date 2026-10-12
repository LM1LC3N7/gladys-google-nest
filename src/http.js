// -----------------------------------------------------------------------------
// The only place that talks to the network.
//
// Node 22+ provides `fetch`: no HTTP dependency. Every request carries the
// identifiable User-Agent and a timeout. The tests replace `fetch` with
// `setFetch()`, so no test ever reaches the network.
// -----------------------------------------------------------------------------

import { GOOGLE_HOSTS, HTTP_TIMEOUT, USER_AGENT } from './constants.js';

let fetchImpl = (...args) => globalThis.fetch(...args);

/** Replace the fetch implementation (tests only). Returns the previous one. */
export function setFetch(impl) {
  const previous = fetchImpl;
  fetchImpl = impl;
  clockOffset = 0;
  return previous;
}

// Local clock minus Google's clock (the `Date` header of its answers), in ms.
// Event ages are judged on Google's clock: a Raspberry Pi without a real-time
// clock may run minutes off before NTP catches up.
let clockOffset = 0;

/** Local time minus Google time, in milliseconds (0 until a first answer). */
export function googleClockOffset() {
  return clockOffset;
}

function trackClock(response) {
  const date = Date.parse(response.headers?.get?.('date') ?? '');
  if (Number.isFinite(date)) {
    // The header has a one-second resolution: only a real drift matters.
    const offset = Date.now() - date;
    clockOffset = Math.abs(offset) > 2_000 ? offset : 0;
  }
}

/** True for an https URL on a Google host, the only ones given a token. */
export function isGoogleUrl(url) {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && GOOGLE_HOSTS.some((suffix) => hostname.endsWith(suffix));
  } catch {
    return false;
  }
}

/**
 * An error answered by a Google API. `status` is the HTTP status, `reason`
 * the Google status ("UNAUTHENTICATED", "FAILED_PRECONDITION"…) or the OAuth
 * error ("invalid_grant"), `detail` Google's own explanation when given.
 */
export class GoogleApiError extends Error {
  constructor(status, reason, detail, url) {
    super(`${reason ?? `HTTP ${status}`}${detail ? `: ${detail}` : ''} (${new URL(url).pathname})`);
    this.name = 'GoogleApiError';
    this.status = status;
    this.reason = reason;
    this.detail = detail;
  }
}

async function errorFrom(response, url) {
  let body;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  // Google APIs answer { error: { code, status, message } }, the OAuth token
  // endpoint { error: "invalid_grant", error_description }.
  const reason = typeof body?.error === 'string' ? body.error : (body?.error?.status ?? undefined);
  const detail = body?.error_description ?? body?.error?.message;
  return new GoogleApiError(response.status, reason, detail, url);
}

/**
 * Send one request. `body` is sent as JSON, `form` as
 * application/x-www-form-urlencoded. Resolves the Response (2xx only).
 */
export async function request(
  url,
  { method = 'GET', token, auth, body, form, timeout = HTTP_TIMEOUT, signal } = {},
) {
  const headers = { 'User-Agent': USER_AGENT };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (auth) {
    headers.Authorization = auth;
  }
  let payload;
  if (form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    payload = new URLSearchParams(form).toString();
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const timeoutSignal = AbortSignal.timeout(Math.max(1, timeout));
  const response = await fetchImpl(url, {
    method,
    headers,
    body: payload,
    signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
  });
  trackClock(response);
  if (!response.ok) {
    throw await errorFrom(response, url);
  }
  return response;
}

export async function requestJson(url, options = {}) {
  const response = await request(url, options);
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

/**
 * Download a binary body of at most `maxBytes`: refused from its
 * Content-Length when announced, and cut while streaming otherwise.
 */
export async function requestBuffer(url, { maxBytes = Infinity, ...options } = {}) {
  const response = await request(url, options);
  const announced = Number(response.headers.get('content-length'));
  if (Number.isFinite(announced) && announced > maxBytes) {
    await response.body?.cancel();
    throw new Error(`Download too big: ${announced} bytes`);
  }
  const chunks = [];
  let size = 0;
  if (response.body) {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > maxBytes) {
        throw new Error(`Download too big: over ${maxBytes} bytes`);
      }
      chunks.push(chunk);
    }
  }
  return {
    buffer: Buffer.concat(chunks),
    type: response.headers.get('content-type') ?? '',
  };
}
