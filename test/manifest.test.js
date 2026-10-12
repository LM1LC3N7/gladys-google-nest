// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SCENE_TRIGGERS } from '../src/app.js';
import { DEFAULTS, normalizeConfig } from '../src/config.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const index = read('index.js');

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) {
      yield* texts(item, `${path}[${i}]`);
    }
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      yield* texts(value, `${path}.${key}`);
    }
  }
}

test('the store basics', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.ok(manifest.name.length >= 3 && manifest.name.length <= 30);
  assert.match(manifest.gladys_version, />=5\.1\.0/, 'scene triggers and actions need Gladys 5.1');
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-google-nest:${manifest.version}`);
  const pkg = JSON.parse(read('package.json'));
  assert.equal(manifest.version, pkg.version);
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
  }
});

test('every text is bilingual', () => {
  for (const [path, text] of texts(manifest)) {
    assert.ok(text.en?.trim() && text.fr?.trim(), `${path} needs en and fr`);
  }
});

test('the catalog says it is unofficial', () => {
  assert.match(manifest.description.en, /Unofficial/);
  assert.match(manifest.description.fr, /non officiel/);
  const intro = manifest.config_schema.find((f) => f.key === 'intro');
  assert.match(intro.description.en, /not affiliated with Google/);
  assert.match(intro.description.fr, /sans lien avec Google/);
});

test('config defaults match the code', () => {
  const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));
  for (const [key, value] of Object.entries(DEFAULTS)) {
    assert.equal(fields[key].default, value, key);
    assert.ok(
      fields[key].options.some((o) => o.value === value),
      `${key}: the default is one of the options`,
    );
  }
  assert.equal(fields.google_account.type, 'oauth2');
  assert.equal(fields.google_account_local.type, 'account_link');
  assert.equal(fields.client_secret.type, 'secret');
  // Every config key the code reads is declared (the stored ones excepted).
  const declared = new Set(manifest.config_schema.map((f) => f.key));
  for (const key of ['project_id', 'client_id', 'client_secret', 'pubsub']) {
    assert.ok(declared.has(key), key);
  }
  const config = normalizeConfig({
    refresh_interval: '15',
    snapshot_interval: '60',
    fan_duration: '720',
  });
  assert.deepEqual(
    [config.refreshMinutes, config.snapshotMinutes, config.fanMinutes],
    [15, 60, 720],
  );
});

test('scene triggers fired by the code are all declared, and vice versa', () => {
  const declared = manifest.scene_triggers.map((t) => t.key).sort();
  assert.deepEqual(declared, Object.values(SCENE_TRIGGERS).sort());
  for (const trigger of manifest.scene_triggers) {
    assert.deepEqual(
      trigger.fields.map((f) => [f.key, f.source]),
      [['device', 'devices']],
    );
    assert.deepEqual(
      trigger.variables.map((v) => v.key),
      ['device_name'],
    );
  }
});

test('every action and scene action has a handler', () => {
  for (const action of manifest.actions) {
    assert.ok(index.includes(`onAction('${action.key}'`), action.key);
  }
  for (const action of manifest.scene_actions) {
    assert.ok(index.includes(`onSceneAction('${action.key}'`), action.key);
    assert.deepEqual(
      action.outputs.map((o) => o.key),
      ['captured', 'taken_at'],
    );
  }
});

test('the docs exist in both languages, long enough for the store', () => {
  for (const lang of ['en', 'fr']) {
    const doc = read(`docs/${lang}.md`);
    assert.ok(doc.length >= 300, `docs/${lang}.md`);
    assert.match(doc, /my\.gladysassistant\.com\/redirect\/oauth/);
    assert.match(doc, /`https:\/\/www\.google\.com`/, 'the local redirect URI');
    assert.match(doc, /Matter/);
    assert.match(doc, /sdm-publisher@googlegroups\.com/);
  }
});
