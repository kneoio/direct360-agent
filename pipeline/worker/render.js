// RunPod worker job: the server's heavy steps, on RunPod hardware instead —
// `task: "render"` (default) is renderFromEdl (preview or final, from the
// job's `preview` flag), `task: "matrix"` is buildMatrix for freshly uploaded
// footage, `task: "stitch"` turns a GoPro MAX .360 into one equirectangular
// MP4, `task: "stitch_matrix"` does that stitch and the matrix in one
// download, `task: "proxy"` builds only the preview proxy of a normal (flat)
// video, which has no camera matrix, and `task: "telemetry"` reads GPMF from the stored source and
// PUTs telemetry.json. Reads the job input as JSON on stdin, downloads the
// source with aria2c (several Range connections; the single-connection GET
// remains the fallback), runs the task, uploads the result back to the
// server in 8MB chunks (same size the browser uploads use, so it fits
// whatever body limit the proxy in front of the server enforces; several
// chunks at once, see upload.js), and prints
// one JSON line to stdout: {chunks, bytes} or {error}. Human logs go to stderr.
// Progress is a `PROGRESS ` + JSON line on stderr; handler.py forwards that to
// Runpod via progress_update, and the server reads it back from /status.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { containerLimits, renderFromEdl } from '../src/edl.js';
import { buildFlatProxy, buildMatrix, LEGACY_MATRIX_FPS } from '../src/matrix.js';
import { stitchGopro } from '../src/gopro.js';
import { captureTelemetry, captureOrientation, orientationLogLine } from '../src/telemetry.js';
import { extractAudioTrack, startDiskWatch } from '../src/ffmpegTools.js';
import { workerVersion } from '../src/version.js';
import { assertOverlayAvailable, OVERLAY_UNAVAILABLE } from '../src/overlayFilter.js';
import { computeCorrection, decodeOrientation, stabModeValid } from '../src/stabilize.js';
import { cacheFile, cacheKey, storeProduced, volumeCacheDir } from './volumeCache.js';
import { uploadBuffer, uploadConfig, uploadFile } from './upload.js';

const CHUNK = 8 * 1024 * 1024;
const t0 = Date.now();
const log = (msg) => console.error(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);
// Skip unchanged payloads: each line becomes a Runpod progress_update.
let lastReport = '';
let sourceState = null;

function report(progress) {
  if (sourceState) progress = { ...progress, source: sourceState };
  const line = JSON.stringify(progress);
  if (line === lastReport) return;
  lastReport = line;
  console.error(`PROGRESS ${line}`);
}

const DOWNLOAD_BACKOFF_MS = [2000, 5000, 10000, 20000, 30000];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestGet(url, headers, timeoutMs = 0) {
  const lib = new URL(url).protocol === 'http:' ? http : https;
  return new Promise((resolve, reject) => {
    const req = lib.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        requestGet(new URL(res.headers.location, url), headers, timeoutMs).then(resolve, reject);
        return;
      }
      resolve(res);
    });
    if (timeoutMs > 0) req.setTimeout(timeoutMs, () => req.destroy(new Error(`no answer in ${timeoutMs / 1000}s`)));
    req.on('error', reject);
  });
}

function expectedLength(res, already) {
  if (res.statusCode === 206) {
    const total = /\/(\d+)\s*$/.exec(res.headers['content-range'] || '');
    return total ? Number(total[1]) : null;
  }
  const len = Number(res.headers['content-length']);
  if (!Number.isFinite(len) || len < 0) return null;
  return already + len;
}

function downloadConnections(env = process.env) {
  const raw = env.D360_DOWNLOAD_CONNECTIONS;
  if (raw == null || raw === '') return 16;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : 16;
}

/**
 * Download watchdog: a stall is NO new bytes for `windowMs`, not a low
 * average (a slow tail is fine). A stalled aria2c run is killed and a new one
 * resumes from its control file with fresh connections for the remaining
 * pieces. After `restarts` restarts the download falls back to the
 * single-connection resumable GET. MB/s is only logged.
 */
export function downloadWatchdog(env = process.env) {
  const num = (raw, fallback) => {
    const n = Number(raw);
    return raw != null && raw !== '' && Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return {
    windowMs: num(env.D360_DOWNLOAD_STALL_SEC, 45) * 1000,
    restarts: Math.trunc(num(env.D360_DOWNLOAD_RESTARTS, 2)),
  };
}

/** Bytes left at which a download counts as being in its tail: 5% of the object or 32 MB, whichever is larger. */
export function tailBytes(total) {
  return Math.max(total * 0.05, 32 * 1024 * 1024);
}

/**
 * Object size from a presigned GET. Range is tried first (those URLs are
 * signed for GET, and they accept Range); HEAD is only a fallback.
 * The response body is dropped immediately.
 */
function discard(res) {
  if (!res) return;
  res.on('error', () => {});
  res.destroy();
}

function is2xx(code) {
  return code >= 200 && code < 300;
}

const OBJECT_INFO_TIMEOUT_MS = 15000;
const OBJECT_INFO_WAITS_MS = [2000, 5000];

/** One Range-then-HEAD attempt. {size, etag, why}; size null when neither gave a length. */
async function objectInfoOnce(url, timeoutMs) {
  let why = '';
  const ranged = await requestGet(url, { Range: 'bytes=0-0' }, timeoutMs).catch((e) => {
    why = `range: ${e.message}`;
    return null;
  });
  if (ranged) {
    const total = is2xx(ranged.statusCode) ? expectedLength(ranged, 0) : null;
    const etag = ranged.headers?.etag || ranged.headers?.['last-modified'] || null;
    discard(ranged);
    if (total != null) return { size: total, etag, why: '' };
    why = `range: HTTP ${ranged.statusCode}`;
  }
  const head = await new Promise((resolve) => {
    const lib = new URL(url).protocol === 'http:' ? http : https;
    const req = lib.request(url, { method: 'HEAD' }, (res) => {
      res.resume();
      resolve(res);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`no answer in ${timeoutMs / 1000}s`)));
    req.on('error', (e) => {
      why += `; head: ${e.message}`;
      resolve(null);
    });
    req.end();
  });
  if (!head) return { size: null, etag: null, why };
  if (!is2xx(head.statusCode)) return { size: null, etag: null, why: `${why}; head: HTTP ${head.statusCode}` };
  const len = Number(head.headers?.['content-length']);
  return {
    size: Number.isFinite(len) && len >= 0 ? len : null,
    etag: head.headers?.etag || head.headers?.['last-modified'] || null,
    why: `${why}; head: no length`,
  };
}

/**
 * {size, etag} of a presigned GET. Each attempt has a 15 s timeout; up to 3
 * attempts (waits 2 s, 5 s). size is null when every attempt failed — callers
 * then download without a size check instead of failing.
 */
export async function objectInfo(url, { timeoutMs = OBJECT_INFO_TIMEOUT_MS, waitsMs = OBJECT_INFO_WAITS_MS } = {}) {
  for (let attempt = 0; ; attempt++) {
    const info = await objectInfoOnce(url, timeoutMs);
    if (info.size != null) return { size: info.size, etag: info.etag };
    if (attempt >= waitsMs.length) {
      log(`object size unknown after ${attempt + 1} attempts (${info.why}); downloading without a size check`);
      return { size: null, etag: null };
    }
    log(`object size attempt ${attempt + 1} failed (${info.why}); retrying in ${waitsMs[attempt] / 1000}s`);
    await sleep(waitsMs[attempt]);
  }
}

export async function objectSize(url) {
  return (await objectInfo(url)).size;
}

function downloadStats(bytes, started, connections, restarts = 0, extra = {}) {
  const seconds = Math.max((Date.now() - started) / 1000, 0.001);
  const mbps = bytes / 1e6 / seconds;
  const label = connections === 1 ? '1 connection' : `${connections} connections`;
  const again = restarts ? `, ${restarts} restart${restarts === 1 ? '' : 's'}` : '';
  const tail = extra.tailSlow ? ', slow tail' : '';
  const fell = extra.fallback ? ', single-connection after restarts' : '';
  log(`source download ${bytes} bytes in ${seconds.toFixed(1)}s (${mbps.toFixed(1)} MB/s, ${label}${again}${tail}${fell})`);
  return {
    bytes,
    seconds: Number(seconds.toFixed(3)),
    mbps: Number(mbps.toFixed(2)),
    connections,
    restarts,
    tailSlow: Boolean(extra.tailSlow),
    fallback: Boolean(extra.fallback),
  };
}

const ARIA2_UNITS = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4 };

/** Completed bytes from an aria2c summary line: `[#2967b7 4.5MiB/8.0MiB(57%) CN:4 DL:4.8MiB]`. */
export function aria2Completed(text) {
  const re = /\[#\w+\s+([\d.]+)(B|KiB|MiB|GiB|TiB)\//g;
  let last = null;
  for (let m = re.exec(text); m; m = re.exec(text)) last = Number(m[1]) * ARIA2_UNITS[m[2]];
  return last;
}

/** Bytes a process has written so far (Linux /proc/<pid>/io `wchar`), or null. */
function procWrittenBytes(pid) {
  try {
    const m = /^wchar:\s*(\d+)/m.exec(fs.readFileSync(`/proc/${pid}/io`, 'utf8'));
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/**
 * One aria2c run. Resolves {code, err, stalled, completed, tailSlow}. `stalled`
 * means the watchdog killed it: no new bytes for `windowMs`
 * (bytes written per /proc, else the summary's completed count). `tailSlow` is
 * whether the final stretch (see tailBytes) averaged under 2 MB/s; that is
 * logged, never acted on.
 */
function runAria2(url, dest, connections, watch, total = null) {
  const args = [
    '--allow-overwrite=true',
    '--auto-file-renaming=false',
    '--file-allocation=none',
    '--continue=true',
    '--max-tries=5',
    '--retry-wait=2',
    '-x', String(connections),
    '-s', String(connections),
    '--min-split-size=8M',
    '--disk-cache=0',
    '--console-log-level=warn',
    '--show-console-readout=false',
    '--summary-interval=1',
    '-d', path.dirname(dest),
    '-o', path.basename(dest),
    url,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn('aria2c', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    let completed = null;
    let stalled = false;
    let killTimer = null;
    let lastProgress = Date.now();
    let tailFrom = null;
    let tailAt = 0;
    child.stdout.on('data', (chunk) => {
      const got = aria2Completed(String(chunk));
      if (got == null) return;
      const now = Date.now();
      if (completed == null || got > completed) lastProgress = now;
      completed = got;
      if (total != null && tailFrom == null && got >= total - tailBytes(total)) {
        tailFrom = got;
        tailAt = now;
      }
    });
    child.stderr.on('data', (chunk) => { err += chunk; });
    // The summary line rounds to whole MiB past 10 MiB, so a slow tail looks
    // frozen for seconds. Bytes aria2c writes to the file are exact (the disk
    // cache is off, so each received chunk is written as it arrives).
    let ioBase = null;
    const tick = watch && watch.windowMs > 0 ? setInterval(() => {
      const wrote = child.pid ? procWrittenBytes(child.pid) : null;
      if (wrote != null) {
        if (ioBase == null) ioBase = wrote;
        else if (wrote - ioBase >= 16 * 1024) {
          ioBase = wrote;
          lastProgress = Date.now();
        }
      }
      if (Date.now() - lastProgress < watch.windowMs) return;
      stalled = true;
      clearInterval(tick);
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 3000);
    }, watch.tickMs || 1000) : null;
    child.on('error', (e) => {
      if (tick) clearInterval(tick);
      reject(e);
    });
    child.on('close', (code) => {
      if (tick) clearInterval(tick);
      if (killTimer) clearTimeout(killTimer);
      let tailSlow = false;
      if (tailFrom != null && completed != null) {
        const secs = (Date.now() - tailAt) / 1000;
        tailSlow = secs >= 1 && (completed - tailFrom) / 1e6 / secs < 2;
      }
      resolve({ code, err, stalled, completed, tailSlow });
    });
  });
}

/**
 * aria2c with several Range connections and the stall watchdog. A stalled run
 * is restarted (fresh connections for the remaining pieces). Throws an
 * `aria2c ...` error if the binary is missing or exits non-zero. Returns
 * {restarts, exhausted, tailSlow}; `exhausted` means every restart stalled
 * too, and the caller falls back to one connection.
 */
async function downloadWithAria2(url, dest, connections, watch = downloadWatchdog(), total = null) {
  let tailSlow = false;
  for (let run = 0; ; run++) {
    const res = await runAria2(url, dest, connections, watch, total);
    tailSlow = tailSlow || res.tailSlow;
    if (res.stalled) {
      const have = res.completed == null ? '?' : `${(res.completed / 1e6).toFixed(1)} MB`;
      const why = `no new bytes for ${(watch.windowMs / 1000).toFixed(0)}s at ${have}`;
      if (run >= watch.restarts) {
        log(`source download stalled (${why}) after ${run} restart${run === 1 ? '' : 's'}; single-connection fallback`);
        return { restarts: run, exhausted: true, tailSlow };
      }
      log(`source download ${why}; restarting aria2c (${run + 1}/${watch.restarts})`);
      continue;
    }
    if (res.code !== 0) {
      const detail = res.err.trim().split('\n').slice(-3).join(' ').slice(0, 400);
      throw new Error(`aria2c exited ${res.code}${detail ? `: ${detail}` : ''}`);
    }
    return { restarts: run, exhausted: false, tailSlow };
  }
}

/**
 * Download `url` to `dest`. aria2c uses several connections; a missing binary
 * or a non-zero exit falls back to the single-connection resumable GET.
 * The file is checked against the object size before it is returned.
 * Returns {bytes, seconds, mbps, connections, restarts}.
 */
export async function fetchSource(url, dest, { expected = null, watch = downloadWatchdog(), probe = true } = {}) {
  report({ phase: 'download', progress: 0 });
  if (expected == null && probe) expected = await objectSize(url);
  // Unknown size: download anyway; the size checks below are skipped.
  const started = Date.now();
  const connections = downloadConnections();
  let restarts = 0;
  let tailSlow = false;
  let exhausted = false;
  try {
    const ran = await downloadWithAria2(url, dest, connections, watch, expected);
    ({ restarts, tailSlow, exhausted } = ran);
    if (!exhausted) {
      const size = fs.statSync(dest).size;
      if (expected != null && size !== expected) {
        fs.rmSync(dest, { force: true });
        throw new Error(`aria2c size ${size} != object ${expected}`);
      }
      report({ phase: 'download', progress: 100 });
      return downloadStats(size, started, connections, restarts, { tailSlow });
    }
  } catch (e) {
    if (e.code !== 'ENOENT' && !String(e.message || '').startsWith('aria2c')) throw e;
    log(`aria2c download failed (${e.message}), single-connection fallback`);
  }
  // The aria2c file may have holes from parallel pieces, so start over.
  fs.rmSync(dest, { force: true });
  fs.rmSync(`${dest}.aria2`, { force: true });
  try {
    await downloadFile(url, dest, expected);
  } catch (e) {
    if (!exhausted) throw e;
    const err = new Error(`source download stalled after ${restarts} restart${restarts === 1 ? '' : 's'} and the single-connection fallback: ${e.message}`);
    err.code = 'DOWNLOAD_STALLED';
    throw err;
  }
  const size = fs.statSync(dest).size;
  if (expected != null && size !== expected) throw new Error(`source download size mismatch: file is ${size} bytes, object is ${expected}`);
  return downloadStats(size, started, 1, restarts, { tailSlow, fallback: exhausted });
}

export async function downloadSource(url, dest) {
  return (await fetchSource(url, dest)).bytes;
}

export function sourceCacheDir(env = process.env) {
  return env.D360_SOURCE_CACHE_DIR || path.join(os.tmpdir(), 'd360-source-cache');
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** Takes `${dir}/lock` for this process. False when another live process holds it. */
function lockCache(dir) {
  const lock = path.join(dir, 'lock');
  for (let i = 0; i < 2; i++) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
      return () => fs.rmSync(lock, { force: true });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const owner = Number(fs.readFileSync(lock, 'utf8'));
      if (pidAlive(owner)) return null;
      fs.rmSync(lock, { force: true });
    }
  }
  return null;
}

/**
 * The source through the network-volume cache (see volumeCache.js): one job
 * downloads, the rest wait and reuse. Logs hit/miss, bytes and seconds.
 */
async function volumeSource(url, info, volume, { watch } = {}) {
  const started = Date.now();
  const id = cacheKey(url, info.size, info.etag);
  const got = await cacheFile(volume, id, info.size, (partial) => {
    sourceState = 'cold';
    return fetchSource(url, partial, { expected: info.size, watch });
  }).finally(() => { sourceState = null; });
  const seconds = Number(((Date.now() - started) / 1000).toFixed(3));
  log(`source cache ${got.hit ? 'hit' : 'miss'}: ${info.size} bytes in ${seconds}s`);
  if (got.hit) {
    sourceState = 'warm';
    report({ phase: 'download', progress: 100 });
  }
  const download = got.hit
    ? { bytes: info.size, seconds, mbps: null, connections: 0, restarts: 0, cached: true, cache: { volume: true, waitedMs: got.waitedMs } }
    : { ...got.download, cached: false, cache: { volume: true, waitedMs: got.waitedMs } };
  return { path: got.path, download, release: got.release };
}

/** Tasks whose input is the original upload (.360), which only the stitch needs and the cache must not keep. */
export function discardsSource(task) {
  return task === 'stitch' || task === 'stitch_matrix';
}

/** Puts a file this worker just uploaded into the volume cache. Never fails the job. */
function cacheUploaded(file, upload, uploaded) {
  const volume = volumeCacheDir();
  if (!volume) return;
  try {
    const started = Date.now();
    if (storeProduced(volume, file, upload.urls[0], uploaded.parts)) {
      log(`cached ${uploaded.bytes} bytes of the upload in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    }
  } catch (e) {
    log(`could not cache the upload: ${e.message}`);
  }
}

/**
 * Part jobs keep their input across jobs on a warm worker: a second part of
 * the same job (same object, size and ETag) reuses the file instead of
 * downloading it again. One input is kept; anything else in the cache is
 * removed before a new download. An interrupted download resumes from its
 * aria2c control file. RunPod runs one job per worker; if another live
 * process holds the cache anyway, this job downloads to `fallback` instead.
 * The cache stays locked until `release()`, so nothing evicts the file while
 * the job reads it. Returns {path, download, release}; download.cached is
 * true on reuse.
 */
export async function cachedSource(url, options = {}) {
  const started = Date.now();
  const got = await cachedSourceInner(url, options);
  const d = got.download;
  // Per input file, in the job's final output (and from there the server's stats).
  d.cache = {
    volume: Boolean(d.cache?.volume),
    hit: Boolean(d.cached),
    waitedMs: d.cache?.waitedMs || 0,
    bytes: d.bytes,
    seconds: Number(((Date.now() - started) / 1000).toFixed(3)),
  };
  return got;
}

async function cachedSourceInner(url, { dir = sourceCacheDir(), fallback = null, watch, volume = volumeCacheDir() } = {}) {
  const info = await objectInfo(url);
  if (volume && info.size != null) return volumeSource(url, info, volume, { watch });
  if (info.size == null) {
    // No size, no cache key: download this job's copy without the cache.
    const dest = fallback || path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'd360-nocache-')), 'source.mp4');
    const download = await fetchSource(url, dest, { watch, probe: false });
    return { path: dest, download: { ...download, cached: false }, release: () => {} };
  }
  fs.mkdirSync(dir, { recursive: true });
  const unlock = lockCache(dir);
  if (!unlock) {
    if (!fallback) throw new Error('source cache is in use by another job');
    log('source cache is in use by another job; downloading without it');
    const download = await fetchSource(url, fallback, { expected: info.size, watch });
    return { path: fallback, download: { ...download, cached: false }, release: () => {} };
  }
  try {
    const target = new URL(url);
    const id = createHash('sha256')
      .update(`${target.host}${target.pathname}|${info.size}|${info.etag || ''}`)
      .digest('hex')
      .slice(0, 24);
    const file = path.join(dir, `${id}.mp4`);
    if (fs.existsSync(file) && fs.statSync(file).size === info.size) {
      log(`source reused from this worker's cache (${info.size} bytes)`);
      report({ phase: 'download', progress: 100 });
      return { path: file, download: { bytes: info.size, seconds: 0, mbps: null, connections: 0, restarts: 0, cached: true }, release: unlock };
    }
    for (const name of fs.readdirSync(dir)) {
      if (name !== 'lock' && !name.startsWith(id)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    }
    const partial = `${file}.part`;
    const download = await fetchSource(url, partial, { expected: info.size, watch });
    fs.renameSync(partial, file);
    fs.rmSync(`${partial}.aria2`, { force: true });
    return { path: file, download: { ...download, cached: false }, release: unlock };
  } catch (e) {
    unlock();
    throw e;
  }
}

/** Stream a URL to disk. A dropped connection resumes with Range, up to 5 attempts. */
export async function downloadFile(url, dest, knownSize = null) {
  let expected = knownSize;
  let lastLoggedPct = -1;
  for (let attempt = 0; attempt < DOWNLOAD_BACKOFF_MS.length; attempt++) {
    const already = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
    if (expected != null && already === expected) break;
    const headers = already > 0 ? { Range: `bytes=${already}-` } : {};
    let res;
    try {
      res = await requestGet(url, headers);
      if (res.statusCode === 416 && expected != null && already === expected) {
        res.resume();
        break;
      }
      const ok = res.statusCode === 200 || res.statusCode === 206;
      if (!ok) {
        res.resume();
        throw new Error(`HTTP ${res.statusCode}`);
      }
      // A 200 on a resume ignored the Range header. Start the file over.
      if (res.statusCode === 200 && already > 0) {
        fs.truncateSync(dest, 0);
      }
      const from = res.statusCode === 200 ? 0 : already;
      const total = expectedLength(res, from);
      if (total != null) expected = total;
      let written = from;
      res.on('data', (chunk) => {
        written += chunk.length;
        if (!expected) return;
        const pct = Math.min(100, Math.floor((written / expected) * 10) * 10);
        if (pct < lastLoggedPct + 10 && pct !== 100) return;
        if (pct === lastLoggedPct) return;
        lastLoggedPct = pct;
        log(`source download ${pct}% (${(written / 1e6).toFixed(1)} MB)`);
        report({ phase: 'download', progress: pct });
      });
      await pipeline(res, fs.createWriteStream(dest, { flags: res.statusCode === 200 ? 'w' : 'a' }));
      const size = fs.statSync(dest).size;
      if (expected == null || size >= expected) break;
      throw new Error(`connection closed at ${size} of ${expected} bytes`);
    } catch (e) {
      if (res) res.resume?.();
      if (attempt === DOWNLOAD_BACKOFF_MS.length - 1) {
        throw new Error(`source download failed after ${DOWNLOAD_BACKOFF_MS.length} attempts: ${e.message}`);
      }
      const have = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
      log(`source download interrupted at ${(have / 1e6).toFixed(1)} MB (${e.message}), retry in ${DOWNLOAD_BACKOFF_MS[attempt] / 1000}s`);
      await sleep(DOWNLOAD_BACKOFF_MS[attempt]);
    }
  }
  const size = fs.statSync(dest).size;
  if (expected != null && size !== expected) {
    throw new Error(`source download size mismatch: file is ${size} bytes, object is ${expected}`);
  }
  return size;
}

/** Upload records of this job, for the output line: [{what, bytes, seconds, mbps, retries}]. */
const uploadRecords = [];
function recordUpload(what, got) {
  uploadRecords.push({ what, bytes: got.bytes, seconds: got.seconds, mbps: got.mbps, retries: got.retries });
}

/** Fresh presigned part URLs from the server, for an upload whose URLs are about to expire. */
let refreshEndpoint = null;
async function fetchPartUrls(uploadId, partNumbers) {
  if (!refreshEndpoint || !uploadId) throw new Error('no way to refresh upload URLs');
  const res = await fetch(refreshEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploadId, partNumbers }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`refresh upload URLs: HTTP ${res.status}`);
  const body = await res.json();
  return body.urls || {};
}

/** A small body (telemetry, orientation) with the upload stall guard and retries. */
async function putSmall(url, buf, what, contentType) {
  const got = await uploadBuffer(url, buf, { label: what, contentType, ...uploadConfig(), log });
  recordUpload(what, got);
  log(`${what} uploaded ${buf.length} bytes in ${got.seconds.toFixed(1)}s (${got.mbps ?? '?'} MB/s, ${got.retries} retries)`);
}

/**
 * GPMF from the original file, normalized and PUT to a presigned URL.
 * No track, a huge raw dump, or a bad file is skipped — the stitch still runs.
 * Returns {bytes, device, streams, orientation} or {reason}.
 */
async function uploadTelemetry(src, putUrl, orientationPutUrl = null) {
  if (!putUrl && !orientationPutUrl) {
    log('telemetry: skipped (no upload url)');
    return { reason: 'no upload url' };
  }
  report({ phase: 'telemetry', progress: 0 });
  const result = {};
  if (putUrl) {
    let captured;
    try {
      captured = await captureTelemetry(src);
    } catch (e) {
      log(`telemetry: skipped (${e.message})`);
      return { reason: e.message };
    }
    if (!captured) {
      log('telemetry: skipped (no GPMF track)');
      return { reason: 'no GPMF track' };
    }
    const buf = Buffer.from(JSON.stringify(captured.doc));
    try {
      await putSmall(putUrl, buf, 'telemetry', 'application/json');
    } catch (e) {
      log(`telemetry: skipped (${e.message})`);
      return { reason: e.message };
    }
    const streams = captured.streams.join(', ');
    log(`telemetry: stored ${buf.length} bytes (${captured.device || 'unknown'}, ${streams})`);
    Object.assign(result, { bytes: buf.length, device: captured.device, streams: captured.streams, orientation: captured.orientation });
  }
  if (orientationPutUrl) {
    try {
      const ori = await captureOrientation(src);
      log(orientationLogLine(ori));
      if (ori) {
        await putSmall(orientationPutUrl, ori.buffer, 'orientation', 'application/octet-stream');
        result.orientationBytes = ori.buffer.length;
        result.orientationFrames = ori.frames;
        result.orientationResampled = ori.resampled;
      } else if (!putUrl) {
        result.reason = 'no CORI';
      }
    } catch (e) {
      log(`orientation: skipped (${e.message})`);
      if (!putUrl) result.reason = e.message;
    }
  }
  report({ phase: 'telemetry', progress: 100 });
  return result;
}

/**
 * Per-frame correction quaternions for a stabilized render or matrix, from the
 * orientation file at a presigned URL. Null when stabilization is off.
 * Every part job computes the whole track, so frame numbers are global.
 */
async function loadStabilization(mode, orientationUrl, frameOffset = 0) {
  if (!mode || mode === 'off') return null;
  if (!stabModeValid(mode)) throw new Error(`unknown stabilization "${mode}"`);
  if (!orientationUrl) throw new Error('stabilization needs orientation_url');
  const res = await fetch(orientationUrl);
  if (!res.ok) throw new Error(`orientation download failed (${res.status})`);
  const track = decodeOrientation(Buffer.from(await res.arrayBuffer()));
  const corrections = computeCorrection(track, { mode, fps: track.fps });
  log(`stabilization ${mode}: ${corrections.length} frames @ ${track.fps.toFixed(3)} fps`);
  return { corrections, frameOffset };
}

/**
 * PUT a file to presigned multipart part URLs, several parts at once. Returns
 * {bytes, parts:[{partNumber, etag}]} and records the speed for the job stats.
 */
export async function uploadParts(file, upload, label, { cache = false } = {}) {
  const phase = /proxy/i.test(label) ? 'proxy' : (/render part|render audio/i.test(label) ? 'upload' : 'source');
  report({ phase, progress: 0 });
  const got = await uploadFile(file, {
    partSize: Number(upload?.partSize),
    urls: upload?.urls,
    refreshUrls: upload?.uploadId && refreshEndpoint ? (numbers) => fetchPartUrls(upload.uploadId, numbers) : null,
    label,
    ...uploadConfig(),
    onProgress: (progress) => report({ phase, progress }),
    log,
  });
  recordUpload(label, got);
  // `parts` (one etag per part, up to 10000) stays in memory for the cache but
  // is not enumerable, so it never reaches the printed output: RunPod rejects
  // oversized job results. The server lists the parts from storage instead.
  const uploaded = { bytes: got.bytes, count: got.count };
  Object.defineProperty(uploaded, 'parts', { value: got.parts, enumerable: false });
  if (cache) cacheUploaded(file, upload, uploaded);
  return uploaded;
}

/**
 * task bench_range: compare a full download with HTTP range reads of the
 * same source. Existing tasks are not used. Prints one JSON report.
 *
 * RunPod input:
 * { "task": "bench_range", "source_url": "<presigned GET>",
 *   "format": "youtube", "yaws": [0], "pitches": [0], "grid": "3x7",
 *   "edl": [{ "t": 0, "camera": 1 }] }
 */
async function benchRange(input) {
  const { source_url } = input;
  if (!source_url) throw new Error('bench_range needs source_url');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd360-bench-'));
  let proxy = null;
  try {
    const src = path.join(dir, 'source.mp4');
    const started = Date.now();
    const bytes = await downloadSource(source_url, src);
    const downloadSeconds = (Date.now() - started) / 1000;
    const probed = JSON.parse(await new Promise((resolve, reject) => {
      const child = spawn('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=avg_frame_rate,nb_frames,duration,codec_name', '-of', 'json', src], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (c) => { out += c; });
      child.on('error', reject);
      child.on('close', (code) => code === 0 ? resolve(out) : reject(new Error(`ffprobe exited ${code}`)));
    }));
    const stream = probed.streams?.[0] || {};
    const duration = Number(stream.duration) || 0;
    const [num, den] = String(stream.avg_frame_rate || '0/1').split('/').map(Number);
    const fps = den ? num / den : 0;
    const keys = await new Promise((resolve) => {
      const child = spawn('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-skip_frame', 'nokey', '-show_frames', '-read_intervals', '%+20', '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'csv=p=0', src], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      child.stdout.on('data', (c) => { out += c; });
      child.on('close', () => resolve(out.trim().split('\n').filter(Boolean).map(Number)));
    });
    const gop = keys.length >= 2 ? keys[1] - keys[0] : null;

    proxy = await startByteProxy(source_url);
    const lengths = [10, 30, 60];
    const positions = [
      ['start', 0],
      ['middle', Math.max(0, duration / 2 - 30)],
      ['last10', Math.max(0, duration * 0.9)],
    ];
    const ranges = [];
    const errors = [];
    for (const [name, at] of positions) {
      for (const length of lengths) {
        if (at + length > duration + 0.5) continue;
        const localFile = path.join(dir, `local-${name}-${length}.mp4`);
        const rangeFile = path.join(dir, `range-${name}-${length}.mp4`);
        let local;
        try {
          local = await transcodeSegment(['-ss', String(at), '-i', src, '-t', String(length)], localFile);
        } catch (err) {
          ranges.push({
            position: name,
            startSec: Number(at.toFixed(3)),
            lengthSec: length,
            exact: false,
            error: err.message || String(err),
          });
          continue;
        }
        const read = await rangeRead(proxy, at, length, rangeFile);
        const localFrames = await packetCount(localFile);
        const got = read.error ? { frames: 0, duration: 0 } : await packetCount(rangeFile);
        ranges.push({
          position: name,
          startSec: Number(at.toFixed(3)),
          lengthSec: length,
          bytes: read.bytes,
          seconds: Number(read.seconds.toFixed(3)),
          mbps: read.seconds > 0 ? Number((read.bytes / 1e6 / read.seconds).toFixed(2)) : null,
          firstFrameSec: read.firstFrameSec,
          frames: got.frames,
          duration: got.duration,
          exact: !read.error && Math.abs(got.frames - localFrames.frames) <= 1,
          localRenderSeconds: Number(local.seconds.toFixed(3)),
          localFrames: localFrames.frames,
          status: read.status,
          error: read.error,
        });
        if (read.status && read.status !== 200 && read.status !== 206) errors.push(read.status);
      }
    }

    const parallel = [];
    const parallelStarts = [0, duration * 0.2, duration * 0.4, duration * 0.6, duration * 0.8].filter((t) => t + 10 <= duration);
    const settled = await Promise.allSettled(parallelStarts.map(async (at, i) => {
      const file = path.join(dir, `par-${i}.mp4`);
      const read = await rangeRead(proxy, at, 10, file);
      return {
        index: i,
        mbps: read.seconds > 0 ? Number((read.bytes / 1e6 / read.seconds).toFixed(2)) : null,
        status: read.status,
        error: read.error,
      };
    }));
    for (const item of settled) {
      if (item.status === 'fulfilled') {
        parallel.push(item.value);
        const code = item.value.status;
        if (code && code !== 200 && code !== 206) errors.push(code);
      } else {
        parallel.push({ error: String(item.reason?.message || item.reason) });
      }
    }

    let seamless = null;
    if (duration > 20) {
      try {
        seamless = await seamlessJoin(dir, src, 0, 10);
      } catch (err) {
        seamless = { seamless: false, error: err.message || String(err) };
      }
    }

    const exact = ranges.length > 0 && ranges.every((row) => row.exact);
    const throttled = errors.some((code) => code === 429 || code === 503);
    const timed = ranges.filter((row) => row.localRenderSeconds != null && row.seconds != null);
    const overhead = timed.length
      ? timed.reduce((sum, row) => sum + (row.seconds - row.localRenderSeconds), 0) / timed.length
      : null;
    const joined = seamless?.seamless === true;
    return {
      baseline: {
        bytes,
        seconds: Number(downloadSeconds.toFixed(3)),
        mbps: downloadSeconds > 0 ? Number((bytes / 1e6 / downloadSeconds).toFixed(2)) : null,
      },
      source: { codec: stream.codec_name || null, duration, fps, gopSec: gop },
      ranges,
      parallel,
      seamless,
      verdict: {
        viable: exact && joined && !throttled,
        overheadSeconds: overhead == null ? null : Number(overhead.toFixed(3)),
        minimumSegmentSec: exact ? 10 : null,
        throttled,
        notes: [
          'Each case transcodes the same segment from the downloaded file and from an HTTP range.',
          'The join is two adjacent lossless transcodes against one lossless transcode of the whole span, checked by frame count and PSNR.',
          'Range reads use -ss before -i with reconnect and multiple_requests.',
          'A moov atom at the end of the file makes the first range request read the tail before any media.',
          'Presigned URLs expire; a long bench can fail with 403 after the signature window.',
        ],
      },
    };
  } finally {
    proxy?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Same ultrafast transcode the range path uses, so the two times compare. */
function transcodeSegment(inputArgs, dest) {
  const before = Date.now();
  return runFfmpeg([
    '-hide_banner', '-nostats', '-y',
    ...inputArgs,
    '-map', '0:v:0', '-an',
    '-vf', 'showinfo',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p',
    dest,
  ]).then(() => ({ seconds: (Date.now() - before) / 1000 }));
}

/**
 * Two adjacent lossless transcodes concatenated, compared with one lossless
 * transcode of the same span. Seamless means the frame counts match and PSNR stays high.
 */
async function seamlessJoin(dir, src, start, length) {
  const a = path.join(dir, 'join-a.mp4');
  const b = path.join(dir, 'join-b.mp4');
  const whole = path.join(dir, 'join-whole.mp4');
  const plain = (ss, t, dest) => runFfmpeg([
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', String(ss), '-i', src, '-t', String(t),
    '-map', '0:v:0', '-an',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0', '-pix_fmt', 'yuv420p',
    dest,
  ]);
  await plain(start, length, a);
  await plain(start + length, length, b);
  await plain(start, length * 2, whole);
  const list = path.join(dir, 'join.txt');
  fs.writeFileSync(list, `file '${a}'\nfile '${b}'\n`);
  const joined = path.join(dir, 'joined.mp4');
  await runFfmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', joined]);
  const parts = await packetCount(a);
  const more = await packetCount(b);
  const both = await packetCount(joined);
  const span = await packetCount(whole);
  const psnr = await psnrDb(joined, whole);
  const framesMatch = both.frames === parts.frames + more.frames && both.frames === span.frames;
  return {
    frames: both.frames,
    partFrames: parts.frames + more.frames,
    spanFrames: span.frames,
    psnrDb: psnr,
    seamless: framesMatch && psnr != null && psnr >= 40,
  };
}

function psnrDb(got, reference) {
  return new Promise((resolve) => {
    const child = spawn('ffmpeg', [
      '-hide_banner', '-i', got, '-i', reference,
      '-lavfi', 'psnr', '-f', 'null', '-',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', () => resolve(null));
    child.on('close', () => {
      const match = /psnr_avg:([\d.]+|inf)/i.exec(err);
      if (!match) { resolve(null); return; }
      resolve(match[1].toLowerCase() === 'inf' ? 100 : Number(match[1]));
    });
  });
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(err.slice(-400) || `ffmpeg exited ${code}`)));
  });
}

function packetCount(file) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffprobe', ['-v', 'error', '-count_packets', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_packets,duration', '-of', 'json', file], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) { reject(new Error('ffprobe failed')); return; }
      const info = JSON.parse(out);
      resolve({
        frames: Number(info.streams?.[0]?.nb_read_packets) || 0,
        duration: Number(info.streams?.[0]?.duration) || 0,
      });
    });
  });
}

function startByteProxy(targetUrl) {
  const target = new URL(targetUrl);
  const lib = target.protocol === 'http:' ? http : https;
  const reads = new Map();
  let nextId = 0;
  const server = http.createServer((req, res) => {
    const id = Number(new URL(req.url, 'http://127.0.0.1').searchParams.get('rid')) || 0;
    const headers = {};
    if (req.headers.range) headers.Range = req.headers.range;
    const upstream = lib.request(target, { method: 'GET', headers }, (up) => {
      const slot = reads.get(id);
      if (slot) slot.status = up.statusCode;
      if (res.headersSent || res.writableEnded) {
        up.resume();
        res.destroy();
        return;
      }
      res.writeHead(up.statusCode, up.headers);
      up.on('data', (chunk) => {
        const current = reads.get(id);
        if (current) current.bytes += chunk.length;
      });
      up.pipe(res);
    });
    upstream.on('error', (err) => {
      if (res.headersSent || res.writableEnded) {
        res.destroy();
        return;
      }
      res.writeHead(502);
      res.end(String(err.message || err));
    });
    upstream.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        open() {
          const id = ++nextId;
          reads.set(id, { bytes: 0, status: null });
          return {
            url: `http://127.0.0.1:${port}/source.mp4?rid=${id}`,
            bytes: () => reads.get(id)?.bytes || 0,
            status: () => reads.get(id)?.status ?? null,
          };
        },
        close: () => server.close(),
      });
    });
  });
}

async function rangeRead(proxy, start, length, dest) {
  const before = Date.now();
  const slot = proxy.open();
  let firstFrameSec = null;
  let status = null;
  let error = null;
  const args = [
    '-hide_banner', '-nostats', '-y',
    '-reconnect', '1', '-reconnect_on_network_error', '1', '-multiple_requests', '1',
    '-ss', String(start), '-i', slot.url, '-t', String(length),
    '-map', '0:v:0', '-an',
    '-vf', 'showinfo',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p',
    dest,
  ];
  try {
    await new Promise((resolve, reject) => {
      const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      child.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        err += text;
        const http = /HTTP\/\d(?:\.\d)? (\d{3})/.exec(text);
        if (http) status = Number(http[1]);
        if (firstFrameSec == null && /showinfo/.test(text) && /n:\s*0\b/.test(text)) {
          firstFrameSec = (Date.now() - before) / 1000;
        }
      });
      child.on('error', reject);
      child.on('close', (code) => code === 0 ? resolve() : reject(new Error(err.slice(-400) || `range read exited ${code}`)));
    });
  } catch (err) {
    error = err.message || String(err);
  }
  return {
    bytes: slot.bytes(),
    seconds: (Date.now() - before) / 1000,
    firstFrameSec,
    status: status || slot.status(),
    error,
  };
}

/**
 * Per-job timings and peaks for the server's footage stats. `phases` are
 * wall-clock ms per step (stitch and the background source upload overlap, so
 * they do not sum to the job time); `peak` is the container's peak memory and
 * the most ffmpeg processes that ran at once.
 */
let buildInfo = null;
/**
 * `{version, commit, dc, endpoint, volume}` of this worker, computed once. `dc` and `endpoint` are the RunPod
 * datacenter and endpoint ids RunPod sets on every worker (absent outside RunPod); `volume` is whether the cache
 * volume is mounted. Logs them on first use.
 */
export function workerInfo(env = process.env) {
  if (buildInfo) return buildInfo;
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { version, commit } = workerVersion(root);
  buildInfo = { version, commit, ...placeOf(env) };
  log(`worker version ${version}${commit ? ` (commit ${commit})` : ''}, datacenter ${buildInfo.dc || 'unknown'}, endpoint ${buildInfo.endpoint || 'unknown'}, cache volume ${buildInfo.volume ? 'mounted' : 'not mounted'}`);
  return buildInfo;
}

/** Where this worker runs: RunPod datacenter, endpoint, and whether the cache volume is mounted. */
export function placeOf(env = process.env) {
  const place = { volume: Boolean(volumeCacheDir(env)) };
  if (env.RUNPOD_DC_ID) place.dc = String(env.RUNPOD_DC_ID);
  if (env.RUNPOD_ENDPOINT_ID) place.endpoint = String(env.RUNPOD_ENDPOINT_ID);
  return place;
}

export function jobStats(dir) {
  const phases = {};
  const peak = { ffmpeg: 0 };
  uploadRecords.length = 0;
  const watch = startDiskWatch(dir);
  return {
    async timed(name, fn) {
      const started = Date.now();
      try {
        return await fn();
      } finally {
        phases[name] = (phases[name] || 0) + (Date.now() - started);
      }
    },
    add(name, ms) {
      if (Number.isFinite(ms) && ms > 0) phases[name] = (phases[name] || 0) + Math.round(ms);
    },
    ffmpeg(n) {
      if (Number.isFinite(n) && n > peak.ffmpeg) peak.ffmpeg = n;
    },
    /** `{phases, peak}` for the final output line. `download` adds its own phase. */
    report(download = null) {
      watch.note();
      const out = { ...phases };
      if (download && !download.cached && Number.isFinite(download.seconds)) out.download = Math.round(download.seconds * 1000);
      const cache = download?.cache ? { cache: download.cache } : {};
      const memGB = watch.peakMem > 0 ? Number((watch.peakMem / 1024 ** 3).toFixed(2)) : undefined;
      const uploads = uploadRecords.length ? { uploads: uploadRecords.map((u) => ({ ...u })) } : {};
      return { phases: out, peak: { ...(memGB != null ? { memGB } : {}), ffmpeg: peak.ffmpeg }, worker: workerInfo(), ...cache, ...uploads };
    },
    stop() { watch.stop(); },
  };
}

async function main() {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  const {
    task = 'render', source_url, result_url, edl, grid, format, yaws, pitches, rolls = null, fovs = null, projections = null, bulges = null, layout, lenses,
    mode = null,
    preview = false, resolution, watermark, source_is_proxy = false,
    proxy_upload = null, source_upload = null, telemetry_put = null, orientation_put = null,
    stabilization = null, orientation_url = null,
    chunk_range = null, part_upload = null, audio_upload = null, chunk_seconds = null,
    expected_chunks = null, expected_frames = null,
    overlay_url = null, metadata = null, ranges = null,
    part_range = null, matrix_upload = null, include_audio = true, expected_matrix_frames = null,
    stitch_engine = null,
  } = input;
  // The server names the stitch engine per job when it runs a CPU and a GPU
  // endpoint side by side; without it the endpoint's D360_STITCH_ENGINE decides.
  if (stitch_engine != null) {
    if (stitch_engine !== 'cpu' && stitch_engine !== 'gpu') throw new Error(`stitch_engine must be cpu or gpu, got ${JSON.stringify(stitch_engine)}`);
    process.env.D360_STITCH_ENGINE = stitch_engine;
  }
  refreshEndpoint = typeof result_url === 'string' && result_url.includes('/runpod/result/')
    ? result_url.replace('/runpod/result/', '/runpod/upload-urls/') : null;
  if (task === 'bench_range') {
    const bench = await benchRange(input);
    console.log(JSON.stringify(bench));
    return;
  }
  if (task !== 'render' && task !== 'matrix' && task !== 'stitch' && task !== 'stitch_matrix' && task !== 'telemetry' && task !== 'proxy') {
    throw new Error(`unknown task "${task}"`);
  }
  const uploadPartJob = Boolean(part_range);
  if (uploadPartJob && task !== 'matrix' && task !== 'stitch_matrix') {
    throw new Error('part_range is only supported for matrix and stitch_matrix');
  }
  if (uploadPartJob && !Number.isInteger(expected_matrix_frames)) {
    throw new Error('a matrix/stitch_matrix part needs expected_matrix_frames');
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd360-'));
  workerInfo();
  const stats = jobStats(dir);
  let sourceUpload = null;
  let releaseCache = () => {};
  try {
    // Every task downloads its input to local disk first (aria2c, several
    // connections) and processes from there; ffmpeg never reads it over
    // HTTP. A part job keeps the file in this worker's cache, so another
    // part of the same job landing here reuses it.
    const partJob = uploadPartJob || Array.isArray(chunk_range);
    let src;
    let download;
    if (partJob || volumeCacheDir()) {
      const cached = await cachedSource(source_url, { fallback: path.join(dir, 'source.mp4') });
      releaseCache = cached.release;
      ({ path: src, download } = cached);
    } else {
      src = path.join(dir, 'source.mp4');
      download = await fetchSource(source_url, src);
    }
    if (task === 'telemetry') {
      const telemetryResult = await uploadTelemetry(src, telemetry_put, orientation_put);
      console.log(JSON.stringify({ telemetry: telemetryResult, download, ...stats.report(download) }));
      return;
    }
    const { cpus, mem } = containerLimits();
    if (task !== 'render') log(`${cpus} cpus, ${(mem / 1024 ** 3).toFixed(2)} GB memory`);

    if (task === 'proxy') {
      if (!proxy_upload) throw new Error('a proxy job needs proxy_upload');
      const telemetryOut = await uploadTelemetry(src, telemetry_put, orientation_put);
      const proxyFile = path.join(dir, 'proxy.mp4');
      await stats.timed('matrix', () => buildFlatProxy(src, proxyFile, {
        log,
        onProgress: (frac) => report({ phase: 'matrix', progress: Math.round(frac * 100) }),
      }));
      stats.ffmpeg(1);
      log(`preview proxy ${fs.statSync(proxyFile).size} bytes`);
      const proxyUploaded = await stats.timed('upload', () => uploadParts(proxyFile, proxy_upload, 'preview proxy', { cache: true }));
      console.log(JSON.stringify({ proxy: proxyUploaded, telemetry: telemetryOut, download, ...stats.report(download) }));
      return;
    }

    const out = path.join(dir, 'out.mp4');
    let proxyResult = null;
    let sourceResult = null;
    let telemetryResult = null;
    // The stitch maps video and audio only, so the gpmd track has to be read
    // from this download, before stitchGopro replaces it. A part job skips
    // this — GPMF is scattered through the whole stream, so the server
    // extracts it once, itself, decoupled from the parts (see editorServer.js).
    if (!uploadPartJob && (task === 'stitch' || task === 'stitch_matrix' || task === 'matrix')) {
      telemetryResult = await uploadTelemetry(src, telemetry_put, orientation_put);
    }
    if (task === 'stitch' || task === 'stitch_matrix') {
      const stitched = task === 'stitch' ? out : path.join(dir, 'equirect.mp4');
      const audioOut = uploadPartJob ? path.join(dir, 'audio.m4a') : null;
      const stitchRun = await stats.timed('stitch', () => stitchGopro(src, stitched, {
        partRange: uploadPartJob ? part_range : null,
        includeAudio: uploadPartJob ? Boolean(include_audio) : true,
        audioOut,
        onProgress: (frac) => report({ phase: 'stitch', progress: Math.round(frac * 100) }),
        log,
      }));
      stats.add('audio', stitchRun?.audioMs);
      stats.add('concat', stitchRun?.concatMs);
      stats.ffmpeg(stitchRun?.peak);
      log('GoPro .360 stitched to equirectangular');
      // A stitch with source_upload puts the stitched master straight into
      // object storage (the next job, a matrix on another endpoint, reads it
      // from there) and sends nothing back through result_url.
      if (task === 'stitch' && source_upload) {
        sourceResult = await stats.timed('upload', () => uploadParts(stitched, source_upload, 'stitched source', { cache: true }));
        console.log(JSON.stringify({ source: sourceResult, telemetry: telemetryResult, download, ...stats.report(download) }));
        return;
      }
      // The stitched master uploads while the matrix and proxy are still encoding.
      if (task === 'stitch_matrix' && source_upload) {
        let uploadError = null;
        sourceUpload = stats.timed('upload', () => uploadParts(stitched, source_upload, 'stitched source', { cache: !uploadPartJob }))
          .then((result) => { sourceResult = result; });
        sourceUpload.catch((err) => { uploadError = err; });
        sourceUpload.uploadError = () => uploadError;
      }
    }
    if (task === 'matrix' || task === 'stitch_matrix') {
      const proxyPath = proxy_upload ? path.join(dir, 'proxy.mp4') : null;
      const media = task === 'stitch_matrix' ? path.join(dir, 'equirect.mp4') : src;
      // A stitch_matrix part's `media` is already just this part's own,
      // freshly-stitched segment (local frame 0 is this part's startFrame),
      // so its own matrix pass seeks locally from 0 — not the source's
      // global part_range. A matrix-only part reads `media` (the original
      // source) directly, so it uses the global range as-is. The expected
      // frame count is always computed from the global range either way —
      // a whole-second part boundary makes the two identical (see the
      // "Additional design notes" in the upload-fanout plan).
      const matrixPartRange = uploadPartJob
        ? (task === 'stitch_matrix' ? { startFrame: 0, frames: part_range.frames } : part_range)
        : null;
      const started = Date.now();
      const matrixAbort = new AbortController();
      const watchUpload = sourceUpload && setInterval(() => {
        const err = sourceUpload.uploadError?.();
        if (err) matrixAbort.abort();
      }, 500);
      watchUpload?.unref?.();
      try {
        const matrixStabilization = await loadStabilization(stabilization, orientation_url, uploadPartJob && task === 'stitch_matrix' ? part_range.startFrame : 0);
        await stats.timed('matrix', () => buildMatrix(media, out, {
          grid,
          format,
          yaws,
          pitches,
          rolls,
          fovs,
          projections,
          bulges,
          layout,
          lenses,
          // A job from a server that predates the cap counts a part's frames at 12.
          maxFps: Number.isInteger(input.maxFps) ? input.maxFps : LEGACY_MATRIX_FPS,
          proxyOut: proxyPath,
          log,
          partRange: matrixPartRange,
          matrixFrames: uploadPartJob ? expected_matrix_frames : null,
          stabilization: matrixStabilization,
          onProgress: (frac) => report({ phase: 'matrix', progress: Math.round(frac * 100) }),
          signal: matrixAbort.signal,
        }));
        stats.ffmpeg(1);
      } catch (e) {
        if (watchUpload) clearInterval(watchUpload);
        const failed = sourceUpload?.uploadError?.();
        if (failed) throw failed;
        throw e;
      }
      if (watchUpload) clearInterval(watchUpload);
      const uploadError = sourceUpload?.uploadError?.();
      if (uploadError) throw uploadError;
      if (sourceUpload) await sourceUpload;
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      log(`camera matrix built in ${seconds}s`);
      if (uploadPartJob) {
        // The worker refuses a mismatch rather than upload a part that
        // doesn't tile correctly with its neighbors.
        const matrixFrames = (await packetCount(out)).frames;
        if (matrixFrames !== expected_matrix_frames) {
          throw new Error(`matrix part produced ${matrixFrames} frames, expected ${expected_matrix_frames}`);
        }
        if (task === 'stitch_matrix') {
          const stitchFrames = (await packetCount(path.join(dir, 'equirect.mp4'))).frames;
          if (stitchFrames !== part_range.frames) {
            throw new Error(`stitch part produced ${stitchFrames} frames, expected ${part_range.frames}`);
          }
        }
        if (proxyPath) {
          const proxyFrames = (await packetCount(proxyPath)).frames;
          if (proxyFrames !== part_range.frames) {
            throw new Error(`proxy part produced ${proxyFrames} frames, expected ${part_range.frames}`);
          }
        }
        if (!matrix_upload) throw new Error('matrix/stitch_matrix part needs matrix_upload');
        const matrixUploaded = await stats.timed('upload', () => uploadParts(out, matrix_upload, 'matrix part'));
        // The stitched source, when present, already uploaded in the
        // background above (the same `sourceUpload`/`sourceResult` the
        // single-job path uses) — not re-uploaded here.
        const sourceUploaded = sourceResult;
        const proxyUploaded = proxyPath ? await stats.timed('upload', () => uploadParts(proxyPath, proxy_upload, 'proxy part')) : null;
        let audioUploaded = null;
        if (include_audio && audio_upload) {
          const audioPath = task === 'stitch_matrix'
            ? path.join(dir, 'audio.m4a')
            : path.join(dir, 'audio-extract.m4a');
          if (task === 'matrix') await stats.timed('audio', () => extractAudioTrack(src, audioPath, { log }));
          if (fs.existsSync(audioPath)) audioUploaded = await stats.timed('upload', () => uploadParts(audioPath, audio_upload, 'upload audio'));
        }
        log(`upload part frames ${part_range.startFrame}-${part_range.startFrame + part_range.frames - 1} (matrix ${matrixFrames} frames) uploaded`);
        console.log(JSON.stringify({
          part: true,
          matrix: matrixUploaded,
          source: sourceUploaded,
          proxy: proxyUploaded,
          audio: audioUploaded,
          part_range,
          download,
          ...stats.report(download),
        }));
        return;
      }
      if (proxyPath) {
        const proxyBytes = fs.statSync(proxyPath).size;
        log(`preview proxy ${proxyBytes} bytes`);
        proxyResult = await stats.timed('upload', () => uploadParts(proxyPath, proxy_upload, 'preview proxy', { cache: true }));
      }
    } else if (task === 'render') {
      const partJob = Array.isArray(chunk_range);
      if (partJob && (!Number.isInteger(expected_chunks) || !Number.isInteger(expected_frames))) {
        throw new Error('part render needs expected_chunks and expected_frames');
      }
      const audioPath = partJob && audio_upload ? path.join(dir, 'audio.m4a') : null;
      const renderStabilization = await loadStabilization(stabilization, orientation_url);
      let overlay = null;
      if (overlay_url && !preview) {
        try {
          await assertOverlayAvailable();
        } catch (e) {
          log(`${OVERLAY_UNAVAILABLE}: ${e.message}`);
          throw e;
        }
        const assFile = path.join(dir, 'overlay.ass');
        await downloadFile(overlay_url, assFile);
        overlay = { assFile };
      }
      const rendered = await stats.timed('render', () => renderFromEdl(src, out, edl, {
        grid,
        format,
        yaws,
        pitches,
        rolls,
        fovs,
        projections,
        bulges,
        mode,
        preview: Boolean(preview),
        resolution,
        watermark,
        proxySource: Boolean(preview) && Boolean(source_is_proxy),
        chunkRange: partJob ? chunk_range : null,
        chunkSeconds: partJob && Number(chunk_seconds) > 0 ? Number(chunk_seconds) : null,
        expectedChunks: partJob ? expected_chunks : null,
        expectedFrames: partJob ? expected_frames : null,
        includeAudio: partJob ? Boolean(audio_upload) : true,
        audioOut: audioPath,
        stabilization: renderStabilization,
        overlay,
        metadata: partJob ? null : metadata,
        ranges,
        log,
        onSegment: (seg, i, n, completed) => {
          const done = completed ?? i + 1;
          log(`chunk ${i + 1}/${n} (${seg.type}) done`);
          report({ phase: 'render', progress: Math.round((done / n) * 100), segment: i + 1, total: n });
        },
      }));
      stats.add('audio', rendered.audioMs);
      stats.add('concat', rendered.concatMs);
      stats.ffmpeg(rendered.peak);
      if (partJob && (rendered.chunks !== expected_chunks || rendered.totalFrames !== expected_frames)) {
        throw new Error(`part plan mismatch: chunks ${rendered.chunks} frames ${rendered.totalFrames}, expected ${expected_chunks} chunks and ${expected_frames} frames`);
      }
      if (partJob) {
        if (!part_upload) throw new Error('part render needs part_upload');
        const uploaded = await stats.timed('upload', () => uploadParts(out, part_upload, 'render part'));
        let audio = null;
        if (audioPath && fs.existsSync(audioPath)) audio = await stats.timed('upload', () => uploadParts(audioPath, audio_upload, 'render audio'));
        log(`part ${chunk_range[0]}-${chunk_range[1]} uploaded (${rendered.frames} frames)`);
        console.log(JSON.stringify({
          part: true,
          frames: rendered.frames,
          bytes: uploaded.bytes,
          upload: uploaded,
          audio,
          chunk_range,
          download,
          ...stats.report(download),
        }));
        return;
      }
      log(preview ? 'preview render done' : 'final render done');
    }

    const uploadStarted = Date.now();
    report({ phase: 'finalize', progress: 0 });
    const size = fs.statSync(out).size;
    report({ phase: 'finalize', progress: 100 });
    const sent = await uploadFile(out, {
      partSize: CHUNK,
      urlAt: (i) => `${result_url}/${i}`,
      label: 'result',
      requireEtag: false,
      ...uploadConfig(),
      onProgress: (progress) => report({ phase: 'upload', progress }),
      log,
    });
    recordUpload('result', sent);
    const chunks = sent.count;
    log(`result uploaded (${(size / 1e6).toFixed(1)} MB, ${chunks} chunks)`);
    stats.add('upload', Date.now() - uploadStarted);
    const output = { chunks, bytes: size, proxy: proxyResult, source: sourceResult, telemetry: telemetryResult, download, ...stats.report(download) };
    // RunPod's job-done can fail after the result is uploaded: the server also hears it here.
    try {
      await putSmall(`${result_url}/done`, Buffer.from(JSON.stringify(output)), 'done', 'application/json');
    } catch (e) {
      log(`done: not sent (${e.message})`);
    }
    console.log(JSON.stringify(output));
  } finally {
    stats.stop();
    if (sourceUpload) await sourceUpload.catch(() => {});
    releaseCache({ discard: discardsSource(task) });
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    const detail = String(e?.message || e);
    const error = e?.oom || /out of memory/i.test(detail)
      ? (/^out of memory\b/i.test(detail) ? detail : `out of memory: ${detail}`)
      : detail;
    let worker;
    try { worker = workerInfo(); } catch { /* version is best effort */ }
    console.log(JSON.stringify({ error, ...(worker ? { worker } : {}) }));
    process.exit(1);
  });
}
