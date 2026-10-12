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
  REDIRECT_URI: 'oauth_redirect_uri',
};

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
    eventSource: text(raw.pubsub),
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
    redirectUri: text(raw[STORED.REDIRECT_URI]) || undefined,
  };
}

/** The three values the user copies from Google before connecting. */
export function hasCredentials(config) {
  return Boolean(config.projectId && config.clientId && config.clientSecret);
}
