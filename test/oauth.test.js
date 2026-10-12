import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AuthRequiredError,
  TokenManager,
  buildAuthorizeUrl,
  createState,
  exchangeCode,
  isAuthError,
  sameState,
} from '../src/google/oauth.js';
import { installFetch, json, tokenAnswer } from './helpers/fakeFetch.js';

let fake;
afterEach(() => fake?.restore());

test('the authorize URL goes to the Partner Connections Manager of the project', () => {
  const url = new URL(
    buildAuthorizeUrl({
      projectId: 'abc-123',
      clientId: 'client.apps.googleusercontent.com',
      redirectUri: 'https://my.gladysassistant.com/redirect/oauth',
      state: 'xyz',
    }),
  );
  assert.equal(
    url.origin + url.pathname,
    'https://nestservices.google.com/partnerconnections/abc-123/auth',
  );
  assert.equal(
    url.searchParams.get('redirect_uri'),
    'https://my.gladysassistant.com/redirect/oauth',
  );
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('state'), 'xyz');
  assert.deepEqual(url.searchParams.get('scope').split(' '), [
    'https://www.googleapis.com/auth/sdm.service',
    'https://www.googleapis.com/auth/pubsub',
  ]);
});

test('states are random, URL-safe and compared exactly', () => {
  const a = createState();
  assert.match(a, /^[\w-]{32}$/);
  assert.notEqual(a, createState());
  assert.ok(sameState(a, a));
  assert.ok(!sameState(a, `${a}x`));
  assert.ok(!sameState(a, undefined));
});

test('the code exchange posts the redirect URI unchanged', async () => {
  fake = installFetch([
    ['POST', /oauth2\.googleapis\.com\/token/, () => tokenAnswer({ refresh_token: 'r1' })],
  ]);
  const answer = await exchangeCode({
    clientId: 'id',
    clientSecret: 'secret',
    code: 'the-code',
    redirectUri: 'https://gladys.example.org/dashboard/x/oauth-callback',
  });
  assert.equal(answer.refresh_token, 'r1');
  assert.deepEqual(fake.calls[0].body, {
    client_id: 'id',
    client_secret: 'secret',
    code: 'the-code',
    grant_type: 'authorization_code',
    redirect_uri: 'https://gladys.example.org/dashboard/x/oauth-callback',
  });
});

test('the access token is refreshed once for concurrent callers, then reused', async () => {
  fake = installFetch([['POST', /token/, () => tokenAnswer()]]);
  let now = 0;
  const tokens = new TokenManager({
    clientId: 'id',
    clientSecret: 's',
    refreshToken: 'r',
    now: () => now,
  });
  const [a, b] = await Promise.all([tokens.getAccessToken(), tokens.getAccessToken()]);
  assert.equal(a, 'access-1');
  assert.equal(b, 'access-1');
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].body.grant_type, 'refresh_token');
  now = 50 * 60_000;
  await tokens.getAccessToken();
  assert.equal(fake.calls.length, 1, 'still valid 50 minutes later');
  now = 56 * 60_000;
  await tokens.getAccessToken();
  assert.equal(fake.calls.length, 2, 'refreshed 5 minutes before it expires');
});

test('a rotated refresh token is persisted', async () => {
  fake = installFetch([['POST', /token/, () => tokenAnswer({ refresh_token: 'r2' })]]);
  const stored = [];
  const tokens = new TokenManager({
    clientId: 'id',
    clientSecret: 's',
    refreshToken: 'r1',
    onRefreshToken: async (token) => stored.push(token),
  });
  await tokens.getAccessToken();
  assert.deepEqual(stored, ['r2']);
});

test('a refused refresh token asks for a new connection', async () => {
  fake = installFetch([
    [
      'POST',
      /token/,
      () =>
        json(
          { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' },
          400,
        ),
    ],
  ]);
  const tokens = new TokenManager({ clientId: 'id', clientSecret: 's', refreshToken: 'r' });
  await assert.rejects(tokens.getAccessToken(), (err) => {
    assert.ok(err instanceof AuthRequiredError);
    assert.ok(isAuthError(err));
    return true;
  });
  const none = new TokenManager({ clientId: 'id', clientSecret: 's' });
  assert.equal(none.connected, false);
  await assert.rejects(none.getAccessToken(), AuthRequiredError);
});

test('a state with other characters of the same length is refused, not thrown', () => {
  assert.equal(sameState('aé', 'ab'), false);
});
