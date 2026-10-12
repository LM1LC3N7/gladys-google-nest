import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CameraPictures, NoPictureError, fitJpeg, fitsGladys } from '../src/camera.js';
import { redact, setFfmpegRunner } from '../src/ffmpeg.js';
import { TokenManager } from '../src/google/oauth.js';
import { SdmClient } from '../src/google/sdm.js';
import { COMMANDS } from '../src/nest/commands.js';
import { applyTraits } from '../src/nest/traits.js';
import { binary, fixture, installFetch, json, tokenAnswer } from './helpers/fakeFetch.js';
import { createFakeGladys } from './helpers/fakeGladys.js';

const [, rtspCamera, doorbell] = fixture('sdm-devices.json').devices;
const SMALL = Buffer.alloc(1000, 1);
const BIG = Buffer.alloc(200 * 1024, 2);

let fake;
let ffmpegCalls;
let restoreRunner;
beforeEach(() => {
  ffmpegCalls = [];
  restoreRunner = setFfmpegRunner(async (args, options) => {
    const file = args[args.indexOf('-i') + 1];
    ffmpegCalls.push({ args, input: options.input, fileExisted: existsSync(file) });
    return SMALL;
  });
});
afterEach(() => {
  fake?.restore();
  setFfmpegRunner(restoreRunner);
});

function pictures({ now = () => 0 } = {}) {
  const gladys = createFakeGladys();
  const tokens = new TokenManager({ clientId: 'id', clientSecret: 's', refreshToken: 'r', now });
  const sdm = new SdmClient({ projectId: 'project-id', tokens, now, sleep: async () => {} });
  const logger = { debug() {}, warn() {} };
  const tmpDir = mkdtempSync(join(tmpdir(), 'nest-clips-'));
  return {
    gladys,
    tmpDir,
    camera: new CameraPictures({ gladys, sdm, tokens, logger, now, tmpDir }),
  };
}

test('a picture under 150 KB is kept, a bigger one re-encoded smaller', async () => {
  assert.ok(fitsGladys(SMALL));
  assert.ok(!fitsGladys(BIG));
  assert.equal(await fitJpeg(SMALL), SMALL);
  assert.equal(ffmpegCalls.length, 0);
  assert.equal(await fitJpeg(BIG), SMALL);
  assert.equal(ffmpegCalls.length, 1);
  assert.equal(ffmpegCalls[0].input, BIG);
  assert.ok(ffmpegCalls[0].args.includes('pipe:0'));
});

test('an RTSP camera: stream, one ffmpeg frame, stream stopped', async () => {
  fake = installFetch([
    ['POST', /token/, () => tokenAnswer()],
    [
      'POST',
      /:executeCommand$/,
      (call) =>
        call.body.command === COMMANDS.GENERATE_RTSP
          ? json({
              results: {
                streamUrls: { rtspUrl: 'rtsps://stream.example/x?auth=SECRET' },
                streamExtensionToken: 'ext-token',
                streamToken: 'tok',
                expiresAt: '2026-10-12T15:05:00Z',
              },
            })
          : json({ results: {} }),
    ],
  ]);
  const { camera } = pictures();
  const { image, fresh } = await camera.capture('ext:cam', rtspCamera);
  assert.equal(fresh, true);
  assert.equal(image, `image/jpg;base64,${SMALL.toString('base64')}`);
  assert.ok(ffmpegCalls[0].args.includes('rtsps://stream.example/x?auth=SECRET'));
  assert.ok(ffmpegCalls[0].args.includes('tcp'));
  await new Promise((resolve) => setImmediate(resolve));
  const commands = fake.calls.filter((c) => c.body?.command).map((c) => c.body);
  assert.deepEqual(commands, [
    { command: COMMANDS.GENERATE_RTSP, params: {} },
    { command: COMMANDS.STOP_RTSP, params: { streamExtensionToken: 'ext-token' } },
  ]);
  assert.equal(camera.lastPicture('ext:cam').image, image);
});

test('a WebRTC camera answers its last event picture, or says why there is none', async () => {
  const { camera } = pictures();
  await assert.rejects(camera.capture('ext:door', doorbell), NoPictureError);
  camera.remember('ext:door', 'image/jpg;base64,AAAA');
  assert.deepEqual(await camera.capture('ext:door', doorbell), {
    image: 'image/jpg;base64,AAAA',
    fresh: false,
  });
  const offline = applyTraits(rtspCamera, {
    'sdm.devices.traits.Connectivity': { status: 'OFFLINE' },
  });
  await assert.rejects(camera.capture('ext:cam', offline), /offline/);
});

test('an event image is generated, fetched with its Basic token, and published', async () => {
  fake = installFetch([
    ['POST', /token/, () => tokenAnswer()],
    [
      'POST',
      /:executeCommand$/,
      () =>
        json({
          results: {
            url: 'https://domain/sdm_event_snapshot/dGNUlTU2CHkhB',
            token: 'g.0.eventToken',
          },
        }),
    ],
    ['GET', /sdm_event_snapshot/, () => binary(SMALL)],
  ]);
  const { camera, gladys } = pictures();
  const published = await camera.fromEvent('ext:cam', rtspCamera, {
    type: 'motion',
    eventId: 'E1',
  });
  assert.equal(published, true);
  const generate = fake.calls.find((c) => c.body?.command);
  assert.deepEqual(generate.body, { command: COMMANDS.GENERATE_IMAGE, params: { eventId: 'E1' } });
  const get = fake.calls.find((c) => /sdm_event_snapshot/.test(c.url));
  assert.equal(get.headers.Authorization, 'Basic g.0.eventToken');
  assert.equal(new URL(get.url).searchParams.get('width'), '1280');
  assert.equal(gladys.calls.images.length, 1);
});

test('an event image is not requested after its 30 s window', async () => {
  const { camera } = pictures({ now: () => 31_000 });
  assert.equal(
    await camera.fromEvent(
      'ext:cam',
      rtspCamera,
      { type: 'motion', eventId: 'E1' },
      { imageExpiresAt: 30_000 },
    ),
    false,
  );
});

test('a clip preview is downloaded with the bearer token, read from a temporary file', async () => {
  fake = installFetch([
    ['POST', /token/, () => tokenAnswer()],
    [
      'GET',
      /nest-camera-frontend\.googleapis\.com/,
      () => binary(Buffer.alloc(5000, 3), 'video/mp4'),
    ],
  ]);
  const { camera, gladys, tmpDir } = pictures();
  const event = {
    type: 'clip',
    previewUrl: 'https://nest-camera-frontend.googleapis.com/clip.mp4',
  };
  assert.equal(await camera.fromEvent('ext:door', doorbell, event), true);
  const download = fake.calls.find((c) => /nest-camera-frontend\.googleapis\.com/.test(c.url));
  assert.equal(download.headers.Authorization, 'Bearer access-1');
  const args = ffmpegCalls[0].args;
  const file = args[args.indexOf('-i') + 1];
  assert.ok(file.startsWith(tmpDir), 'the clip is written under the temporary directory');
  assert.ok(ffmpegCalls[0].fileExisted, 'ffmpeg reads a file that exists');
  assert.deepEqual(readdirSync(tmpDir), [], 'and the file is removed afterwards');
  assert.ok(!args.some((a) => a.includes('access-1')), 'no token on the ffmpeg command line');
  assert.equal(gladys.calls.images.length, 1);
  // A doorbell event without a clip: nothing to fetch (no event image).
  assert.equal(
    await camera.fromEvent('ext:door', doorbell, { type: 'chime', eventId: 'E2' }, 0),
    false,
  );
});

test('an empty clip is refused', async () => {
  fake = installFetch([
    ['POST', /token/, () => tokenAnswer()],
    ['GET', /nest-camera-frontend\.googleapis\.com/, () => binary(Buffer.alloc(0), 'video/mp4')],
  ]);
  const { camera } = pictures();
  await assert.rejects(
    camera.fromEvent('ext:door', doorbell, {
      type: 'clip',
      previewUrl: 'https://nest-camera-frontend.googleapis.com/c',
    }),
    /Empty clip/,
  );
});

test('pictures are published at most once every 10 s per camera', async () => {
  let now = 0;
  const { camera, gladys } = pictures({ now: () => now });
  await camera.publish('ext:cam', 'a');
  await camera.publish('ext:cam', 'b');
  now = 10_000;
  await camera.publish('ext:cam', 'c');
  assert.deepEqual(
    gladys.calls.images.map((i) => i.image),
    ['a', 'c'],
  );
});

test('stream credentials never reach the logs', () => {
  assert.equal(
    redact('rtsps://x/y?auth=SECRET&z=1 Bearer abc.def failed'),
    'rtsps://x/y?auth=***&z=1 Bearer *** failed',
  );
});

test('the account token is never sent to a host that is not Google', async () => {
  fake = installFetch([['POST', /token/, () => tokenAnswer()]]);
  const { camera, gladys } = pictures();
  for (const url of [
    'https://evil.example/clip.mp4',
    'http://nest-camera-frontend.googleapis.com/c',
    'https://googleapis.com.evil.example/c',
  ]) {
    assert.equal(
      await camera.fromEvent('ext:door', doorbell, { type: 'clip', previewUrl: url }),
      false,
      url,
    );
  }
  assert.equal(fake.calls.length, 0);
  assert.equal(gladys.calls.images.length, 0);
});

test('a clip bigger than announced is refused before download', async () => {
  fake = installFetch([
    ['POST', /token/, () => tokenAnswer()],
    [
      'GET',
      /googleapis\.com\/big/,
      () =>
        new Response(Buffer.alloc(10), {
          status: 200,
          headers: { 'content-length': String(50 * 1024 * 1024) },
        }),
    ],
  ]);
  const { camera } = pictures();
  await assert.rejects(
    camera.fromEvent('ext:door', doorbell, {
      type: 'clip',
      previewUrl: 'https://x.googleapis.com/big',
    }),
    /too big/,
  );
});

test('a stream URL that is not rtsps is refused', async () => {
  const { grabRtspFrame } = await import('../src/ffmpeg.js');
  await assert.rejects(
    grabRtspFrame('file:///etc/passwd', { timeout: 1000 }),
    /unexpected stream URL/,
  );
});
