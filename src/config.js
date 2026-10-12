// -----------------------------------------------------------------------------
// Integration configuration.
//
// The user fills the `config_schema` of the manifest; the OAuth tokens and the
// pending authorization live in the same config under keys OUTSIDE the schema
// (never shown in the UI). This module normalizes both, so the rest of the
// code never deals with `undefined` or strings from a form.
// -----------------------------------------------------------------------------

// Off-schema keys, written by the integration itself.
export const STORED = {
  REFRESH_TOKEN: 'oauth_refresh_token',
  STATE: 'oauth_state',
  STATE_AT: 'oauth_state_at',
  // The redirect URI of the authorization in progress: Google wants it back
  // byte for byte in the code exchange, maybe after a container restart.
  REDIRECT_URI: 'oauth_redirect_uri',
};

// Two ways to connect the Google account, both exchanging the code here:
//  - `google_account` (oauth2): the Gladys frontend carries the flow and hands
//    us the redirect URI (its static redirect page, or the instance itself
//    over HTTPS), then the code: nothing to paste;
//  - `google_account_local` (account_link): the consent ends on Google's own
//    page, nothing comes back to Gladys, and the user pastes the address the
//    browser ends on. For those who want no third-party page at all.
export const ACCOUNT_FIELD = 'google_account';
export const LOCAL_ACCOUNT_FIELD = 'google_account_local';
export const LOCAL_REDIRECT_URI = 'https://www.google.com';

// The topic the integration creates itself in the user's Cloud project, when
// given its ID instead of an existing topic.
export const DEFAULT_TOPIC = 'gladys-google-nest';

// Defaults: they MUST match the `default` values of the manifest.
export const DEFAULTS = {
  refresh_interval: '5',
  snapshot_interval: '0',
  fan_duration: '15',
};

const text = (value) => (typeof value === 'string' ? value.trim() : '');

function minutes(value, fallback, { min, max }) {
  const n = Number(value ?? fallback);
  return Number.isFinite(n) && n >= min && n <= max ? n : Number(fallback);
}

export function normalizeConfig(raw = {}) {
  return {
    projectId: text(raw.project_id),
    clientId: text(raw.client_id),
    clientSecret: text(raw.client_secret),
    cloudProjectId: text(raw.cloud_project_id),
    // An existing topic or subscription wins over the topic we would create.
    eventSource: text(raw.pubsub) || ownTopic(text(raw.cloud_project_id)),
    ownEvents: !text(raw.pubsub) && Boolean(ownTopic(text(raw.cloud_project_id))),
    refreshMinutes: minutes(raw.refresh_interval, DEFAULTS.refresh_interval, { min: 1, max: 60 }),
    // 0 = only on events and on request.
    snapshotMinutes: minutes(raw.snapshot_interval, DEFAULTS.snapshot_interval, {
      min: 0,
      max: 1440,
    }),
    fanMinutes: minutes(raw.fan_duration, DEFAULTS.fan_duration, { min: 1, max: 720 }),
    refreshToken: text(raw[STORED.REFRESH_TOKEN]) || undefined,
    pendingState: text(raw[STORED.STATE]) || undefined,
    pendingStateAt: Number(raw[STORED.STATE_AT]) || 0,
    pendingRedirectUri: text(raw[STORED.REDIRECT_URI]) || undefined,
  };
}

// A Cloud project ID: 6 to 30 lowercase letters, digits and hyphens. The user
// may paste the project number or the name instead: the topic creation
// would then fail with a Google error nobody understands.
const CLOUD_PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

/** The full name of our own topic in a Cloud project, or '' when none. */
export function ownTopic(cloudProjectId) {
  return CLOUD_PROJECT_ID.test(cloudProjectId)
    ? `projects/${cloudProjectId}/topics/${DEFAULT_TOPIC}`
    : '';
}

/** True when the Cloud project ID is filled but cannot be one. */
export function badCloudProjectId(config) {
  return Boolean(config.cloudProjectId) && !CLOUD_PROJECT_ID.test(config.cloudProjectId);
}

/** The three values the user copies from Google before connecting. */
export function hasCredentials(config) {
  return Boolean(config.projectId && config.clientId && config.clientSecret);
}

/**
 * Read what the user pasted after the local connection: the whole address
 * (https://www.google.com/?state=…&code=…&scope=…), its query alone, or
 * the bare code. Resolves `{ code?, state?, error? }`.
 */
export function parsePastedAuthorization(input) {
  const raw = text(input);
  if (!raw) {
    return {};
  }
  let params;
  if (/^https?:\/\//i.test(raw)) {
    try {
      params = new URL(raw).searchParams;
    } catch {
      return {};
    }
  } else if (/(^|[?&])(code|error|state)=/.test(raw)) {
    params = new URLSearchParams(raw.replace(/^\?/, ''));
  }
  if (!params) {
    // A bare code: Google's are like "4/0Ab…", no space.
    return /^[\w./~+-]{10,}$/.test(raw) ? { code: raw } : {};
  }
  return {
    code: params.get('code') || undefined,
    state: params.has('state') ? params.get('state') : undefined,
    error: params.get('error') || undefined,
  };
}
