// -----------------------------------------------------------------------------
// Run a request with the current access token, and retry once with a fresh
// one when Google answers 401 (a token revoked or expired early).
// -----------------------------------------------------------------------------

import { GoogleApiError } from '../http.js';

export async function authorized(tokens, call) {
  const token = await tokens.getAccessToken();
  try {
    return await call(token);
  } catch (err) {
    if (err instanceof GoogleApiError && err.status === 401) {
      tokens.invalidate();
      return call(await tokens.getAccessToken());
    }
    throw err;
  }
}
