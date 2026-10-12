import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePastedAuthorization } from '../src/config.js';

test('what the user pastes after the local connection', () => {
  assert.deepEqual(
    parsePastedAuthorization(' https://www.google.com/?state=s1&code=4%2F0Ab&scope=x '),
    {
      code: '4/0Ab',
      state: 's1',
      error: undefined,
    },
  );
  assert.deepEqual(parsePastedAuthorization('state=s1&code=4/0Ab'), {
    code: '4/0Ab',
    state: 's1',
    error: undefined,
  });
  assert.deepEqual(parsePastedAuthorization('4/0AbCdEfGhIjKl'), { code: '4/0AbCdEfGhIjKl' });
  assert.equal(
    parsePastedAuthorization('https://www.google.com/?error=access_denied').error,
    'access_denied',
  );
  assert.deepEqual(parsePastedAuthorization(''), {});
  assert.deepEqual(parsePastedAuthorization('two words'), {});
  assert.deepEqual(parsePastedAuthorization(undefined), {});
});
