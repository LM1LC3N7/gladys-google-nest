// -----------------------------------------------------------------------------
// Google OAuth 2.0 for the Device Access program.
//
// We build the Partner Connections Manager URL (the Nest consent screen) and
// exchange the code ourselves. The redirect URI must come back byte for byte
// in the token exchange; the app uses Google's own page (see
// LOCAL_REDIRECT_URI), so nothing but Google and Gladys sees the code.
// -----------------------------------------------------------------------------

import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  OAUTH_SCOPES,
  OAUTH_TIMEOUT,
  PCM_URL,
  TOKEN_REFRESH_MARGIN,
  TOKEN_URL,
} from '../constants.js';
import { GoogleApiError, requestJson } from '../http.js';

/** A fresh anti-CSRF state, URL-safe. */
export function createState() {
  return randomBytes(24).toString('base64url');
}

/** Constant-time comparison of two states (strings). */
export function sameState(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function buildAuthorizeUrl({ projectId, clientId, redirectUri, state }) {
  const url = new URL(`${PCM_URL}/${encodeURIComponent(projectId)}/auth`);
  url.search = new URLSearchParams({
    redirect_uri: redirectUri,
    // offline + consent: Google only hands a refresh token on a fresh consent.
    access_type: 'offline',
    prompt: 'consent',
    client_id: clientId,
    response_type: 'code',
    scope: OAUTH_SCOPES.join(' '),
    state,
  }).toString();
  return url.toString();
}

export async function exchangeCode({ clientId, clientSecret, code, redirectUri }) {
  return requestJson(TOKEN_URL, {
    method: 'POST',
    timeout: OAUTH_TIMEOUT,
    form: {
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    },
  });
}

export async function refreshAccessToken({ clientId, clientSecret, refreshToken }) {
  return requestJson(TOKEN_URL, {
    method: 'POST',
    // Refreshes happen on the path of a command, acked by Gladys within 5 s.
    timeout: OAUTH_TIMEOUT,
    form: {
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    },
  });
}

/**
 * The account must be connected again: no refresh token, or Google refused
 * it (revoked, unused for 6 months, or 7 days old while the OAuth consent
 * screen is still in "Testing").
 */
export class AuthRequiredError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = 'AuthRequiredError';
  }
}

/** True when an error means the user must connect the account again. */
export function isAuthError(err) {
  return (
    err instanceof AuthRequiredError ||
    (err instanceof GoogleApiError && (err.status === 401 || err.reason === 'invalid_grant'))
  );
}

/**
 * Google refused the OAuth client itself (wrong client ID or secret): a
 * configuration mistake, not an account to reconnect.
 */
export class ClientConfigError extends Error {
  constructor(cause) {
    super('Google refused the OAuth client ID or secret: check them in the configuration', {
      cause,
    });
    this.name = 'ClientConfigError';
  }
}

/**
 * Holds the tokens of the connected account and refreshes the access token
 * on demand (one refresh at a time, however many callers wait for it).
 */
export class TokenManager {
  /**
   * @param {{ clientId: string, clientSecret: string, refreshToken?: string,
   *   now?: () => number, onRefreshToken?: (token: string) => Promise<void> }} options
   *   `onRefreshToken` persists a refresh token Google rotated.
   */
  constructor({ clientId, clientSecret, refreshToken, now = Date.now, onRefreshToken }) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.refreshToken = refreshToken || undefined;
    this.now = now;
    this.onRefreshToken = onRefreshToken;
    this.accessToken = undefined;
    this.expiresAt = 0;
    this.pending = undefined;
  }

  get connected() {
    return Boolean(this.refreshToken);
  }

  /** Store the answer of a code exchange or a refresh. */
  accept(answer) {
    if (!answer?.access_token) {
      throw new Error('Google answered without an access token');
    }
    this.accessToken = answer.access_token;
    this.expiresAt = this.now() + Number(answer.expires_in ?? 3600) * 1000;
    if (answer.refresh_token) {
      this.refreshToken = answer.refresh_token;
    }
  }

  /** Forget the access token, so the next call refreshes it (after a 401). */
  invalidate() {
    this.accessToken = undefined;
    this.expiresAt = 0;
  }

  async getAccessToken() {
    if (this.accessToken && this.now() < this.expiresAt - TOKEN_REFRESH_MARGIN) {
      return this.accessToken;
    }
    if (!this.refreshToken) {
      throw new AuthRequiredError('The Google account is not connected');
    }
    this.pending ??= this.refresh().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  async refresh() {
    const previous = this.refreshToken;
    let answer;
    try {
      answer = await refreshAccessToken({
        clientId: this.clientId,
        clientSecret: this.clientSecret,
        refreshToken: previous,
      });
    } catch (err) {
      if (err instanceof GoogleApiError && err.reason === 'invalid_grant') {
        throw new AuthRequiredError('Google refused the refresh token', err);
      }
      if (err instanceof GoogleApiError && err.reason === 'invalid_client') {
        throw new ClientConfigError(err);
      }
      throw err;
    }
    this.accept(answer);
    if (this.refreshToken !== previous) {
      await this.onRefreshToken?.(this.refreshToken);
    }
    return this.accessToken;
  }
}
