import { test } from 'node:test';
import assert from 'node:assert/strict';
import { badCloudProjectId, normalizeConfig, parsePastedAuthorization } from '../src/config.js';

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

test('the events come from the own topic of a Cloud project, unless a topic is given', () => {
  const own = normalizeConfig({ cloud_project_id: ' gladys-nest-123 ' });
  assert.equal(own.eventSource, 'projects/gladys-nest-123/topics/gladys-google-nest');
  assert.equal(own.ownEvents, true);
  assert.equal(badCloudProjectId(own), false);

  const given = normalizeConfig({
    cloud_project_id: 'gladys-nest-123',
    pubsub: 'projects/other/topics/mine',
  });
  assert.equal(given.eventSource, 'projects/other/topics/mine');
  assert.equal(given.ownEvents, false);

  // A project number or a display name is not a project ID.
  for (const bad of ['123456789012', 'My Project', 'ab', 'Gladys-Nest']) {
    const config = normalizeConfig({ cloud_project_id: bad });
    assert.equal(config.eventSource, '', bad);
    assert.equal(badCloudProjectId(config), true, bad);
  }
  assert.equal(badCloudProjectId(normalizeConfig({})), false);
});
