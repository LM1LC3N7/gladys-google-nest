// -----------------------------------------------------------------------------
// ffmpeg, for the camera pictures: one frame of an RTSP stream or of an event
// clip, and the re-encoding of a picture too big for Gladys.
//
// ffmpeg is installed in the image by the Dockerfile (apk). It writes to its
// stdout only (the rootfs is read-only) and reads a clip from a temporary
// file under /data. The tests replace the runner with `setFfmpegRunner()`.
// -----------------------------------------------------------------------------

import { spawn } from 'node:child_process';

const MAX_OUTPUT = 8 * 1024 * 1024;

function defaultRunner(args, { input, timeout }) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    let size = 0;
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`ffmpeg timed out after ${timeout} ms`));
    }, timeout);
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_OUTPUT) {
        child.kill('SIGKILL');
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-500);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const output = Buffer.concat(chunks);
      if (code === 0 && output.length > 0) {
        resolve(output);
      } else {
        reject(new Error(`ffmpeg failed (${code}): ${redact(stderr.trim()) || 'no image'}`));
      }
    });
    // ffmpeg may exit before reading its whole input (one frame is enough).
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

// Stream URLs carry a credential (`auth=` query): never log one.
export function redact(text) {
  return String(text).replace(/(auth=|Bearer\s+)[^\s&'"]+/gi, '$1***');
}

let runner = defaultRunner;

/** Replace the ffmpeg runner (tests only). Returns the previous one. */
export function setFfmpegRunner(impl) {
  const previous = runner;
  runner = impl;
  return previous;
}

// One JPEG frame on stdout, at most `width` pixels wide (never enlarged).
const jpegOutput = (width, quality) => [
  '-frames:v',
  '1',
  '-vf',
  `scale='min(${width},iw)':-2`,
  '-q:v',
  String(quality),
  '-f',
  'image2',
  '-c:v',
  'mjpeg',
  'pipe:1',
];

const QUIET = ['-hide_banner', '-loglevel', 'error', '-nostdin'];

/** One frame of a live RTSP stream (rtsps:// URL from GenerateRtspStream). */
export function grabRtspFrame(url, { timeout, width = 1280, quality = 7 }) {
  if (!String(url).startsWith('rtsps://')) {
    return Promise.reject(new Error('Google returned an unexpected stream URL'));
  }
  return runner(
    [
      ...QUIET,
      // Only what an rtsps stream needs: no file, no http, no concat tricks.
      '-protocol_whitelist',
      'rtsps,rtsp,tls,tcp,udp,rtp,srtp,crypto',
      '-rtsp_transport',
      'tcp',
      '-i',
      url,
      ...jpegOutput(width, quality),
    ],
    { timeout },
  );
}

/**
 * The first frame of a clip file. A file, not a pipe: an mp4 whose index
 * (moov) comes last cannot be read from a non-seekable input.
 */
export function grabFileFrame(path, { timeout, width = 1280, quality = 7 }) {
  return runner(
    [
      ...QUIET,
      '-protocol_whitelist',
      'file',
      '-f',
      'mp4',
      '-i',
      path,
      ...jpegOutput(width, quality),
    ],
    { timeout },
  );
}

/** Re-encode a picture smaller (JPEG in, JPEG out, through the pipes). */
export function shrinkJpeg(buffer, { timeout, width, quality }) {
  // -nostdin would close the pipe the picture comes from: not here.
  return runner(
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-protocol_whitelist',
      'pipe',
      '-f',
      'image2pipe',
      '-i',
      'pipe:0',
      ...jpegOutput(width, quality),
    ],
    { timeout, input: buffer },
  );
}
