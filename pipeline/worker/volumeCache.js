// Source cache on a RunPod network volume, shared by every worker that mounts
// it. Layout, per entry id (a hash of object key + size + etag):
//   <id>.mp4              the cached file; its mtime is the last-used time
//   <id>.mp4.part         a download in progress (+ aria2c's .aria2 control file)
//   <id>.lock             the one job downloading it; refreshed while it works
//   <id>.hold.<token>     one per running job using the entry; refreshed too
// Locks and holds are lease files: other workers may be on other machines, so
// a pid check cannot tell if the owner lives. One that is not refreshed for
// `staleMs` is dead and ignored.
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_DIR = '/runpod-volume/d360-cache';
const BEAT_MS = 15000;
const STALE_MS = 90000;
const POLL_MS = 500;

function positive(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** The cache directory, or null when the volume is not mounted (its parent is missing). */
export function volumeCacheDir(env = process.env) {
  const dir = env.D360_CACHE_DIR || DEFAULT_DIR;
  return fs.existsSync(path.dirname(dir)) ? dir : null;
}

export function volumeCacheLimits(env = process.env) {
  return {
    idleMs: positive(env.D360_CACHE_IDLE_HOURS, 24) * 3600 * 1000,
    maxBytes: positive(env.D360_CACHE_MAX_GB, 16) * 1024 ** 3,
  };
}

function normalizeEtag(etag) {
  return String(etag || '').replace(/^W\//, '').replace(/"/g, '');
}

/** Object key + size + etag. The host is part of the key; the presigned query string is not. */
export function cacheKey(url, size, etag) {
  const target = new URL(url);
  return createHash('sha256')
    .update(`${target.host}${target.pathname}|${size}|${normalizeEtag(etag)}`)
    .digest('hex')
    .slice(0, 24);
}

/** The ETag S3 gives a multipart object, from the part ETags each PUT returned. */
export function multipartEtag(parts) {
  const md5s = parts.map((p) => Buffer.from(normalizeEtag(p.etag), 'hex'));
  return `${createHash('md5').update(Buffer.concat(md5s)).digest('hex')}-${parts.length}`;
}

function mtimeMs(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

function fresh(file, staleMs, now = Date.now()) {
  const m = mtimeMs(file);
  return m != null && now - m <= staleMs;
}

/** Keeps a lease file's mtime current until the returned function is called. */
function lease(file, beatMs) {
  const timer = setInterval(() => {
    const now = new Date();
    try { fs.utimesSync(file, now, now); } catch { /* file is gone; nothing to refresh */ }
  }, beatMs);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    fs.rmSync(file, { force: true });
  };
}

/** Marks entry `id` in use by this job, so clean-up leaves it alone. Returns release(). */
function hold(dir, id, beatMs) {
  const file = path.join(dir, `${id}.hold.${randomBytes(6).toString('hex')}`);
  fs.writeFileSync(file, String(process.pid));
  return lease(file, beatMs);
}

/** Takes the download lock for `id`; null while a live job has it. A dead one's lock is replaced. */
function tryLock(dir, id, { beatMs, staleMs }) {
  const file = path.join(dir, `${id}.lock`);
  for (let i = 0; i < 2; i++) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
      return lease(file, beatMs);
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (fresh(file, staleMs)) return null;
      fs.rmSync(file, { force: true });
    }
  }
  return null;
}

/** True while a live job holds or is downloading entry `id`. */
function inUse(dir, id, staleMs) {
  return fs.readdirSync(dir).some((name) => entryId(name) === id
    && /\.(lock|hold\.[0-9a-f]+)$/.test(name) && fresh(path.join(dir, name), staleMs));
}

/** Deletes entry `id` if it was marked `.discard` and no live job uses it any more. */
function sweepDiscarded(dir, id, staleMs) {
  if (!fs.existsSync(path.join(dir, `${id}.discard`)) || inUse(dir, id, staleMs)) return false;
  for (const name of fs.readdirSync(dir)) if (entryId(name) === id) fs.rmSync(path.join(dir, name), { force: true });
  return true;
}

function entryId(name) {
  return name.split('.')[0];
}

/**
 * Deletes entries idle longer than `idleMs`, then the least recently used
 * until the total is under `maxBytes`. An entry with a live hold or lock is
 * never deleted. Dead leases are removed. Returns the ids it deleted.
 */
export function cleanupCache(dir, { idleMs, maxBytes, staleMs = STALE_MS, now = Date.now() } = {}) {
  const limits = { ...volumeCacheLimits(), ...(idleMs != null ? { idleMs } : {}), ...(maxBytes != null ? { maxBytes } : {}) };
  const entries = new Map();
  for (const name of fs.readdirSync(dir)) {
    const id = entryId(name);
    const file = path.join(dir, name);
    let e = entries.get(id);
    if (!e) entries.set(id, e = { id, bytes: 0, used: 0, busy: false, files: [] });
    const m = mtimeMs(file);
    if (m == null) continue;
    if (/\.(lock|hold\.[0-9a-f]+)$/.test(name)) {
      if (now - m <= staleMs) e.busy = true;
      else fs.rmSync(file, { force: true });
      continue;
    }
    e.files.push(file);
    e.bytes += fs.statSync(file).size;
    e.used = Math.max(e.used, m);
  }
  const removed = [];
  const drop = (e) => {
    for (const f of e.files) fs.rmSync(f, { force: true });
    removed.push(e.id);
    e.bytes = 0;
    e.files = [];
  };
  for (const e of entries.values()) {
    if (e.files.length && !e.busy && now - e.used > limits.idleMs) drop(e);
  }
  let total = 0;
  for (const e of entries.values()) total += e.bytes;
  const lru = [...entries.values()].filter((e) => e.files.length && !e.busy).sort((a, b) => a.used - b.used);
  for (const e of lru) {
    if (total <= limits.maxBytes) break;
    total -= e.bytes;
    drop(e);
  }
  return removed;
}

/**
 * The file for entry `id` in the cache: reused if it is there, otherwise one
 * job downloads it (`download(partialPath)`, then an atomic rename) while
 * the others wait on the lock and reuse the result. Holds the entry until
 * `release()`. Returns {path, hit, download, waitedMs, release}; `download` is the
 * download function's result on a miss, `waitedMs` the time spent waiting on
 * another job's lock.
 */
export async function cacheFile(dir, id, size, download, { beatMs = BEAT_MS, staleMs = STALE_MS, pollMs = POLL_MS, limits } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.mp4`);
  const releaseHold = hold(dir, id, beatMs);
  // `release({discard: true})` is for inputs that must not outlive their job
  // (the original upload before stitching). The entry goes once the last job
  // using it lets go, whichever job that is.
  const release = ({ discard = false } = {}) => {
    if (discard) fs.writeFileSync(path.join(dir, `${id}.discard`), '');
    releaseHold();
    sweepDiscarded(dir, id, staleMs);
  };
  try {
    cleanupCache(dir, { ...limits, staleMs });
    let waitedMs = 0;
    for (;;) {
      if (mtimeMs(file) != null && fs.statSync(file).size === size) {
        const now = new Date();
        fs.utimesSync(file, now, now);
        return { path: file, hit: true, download: null, waitedMs, release };
      }
      const unlock = tryLock(dir, id, { beatMs, staleMs });
      if (!unlock) {
        const waitStarted = Date.now();
        await new Promise((resolve) => setTimeout(resolve, pollMs));
        waitedMs += Date.now() - waitStarted;
        continue;
      }
      try {
        // Another job may have finished between the check above and the lock.
        if (mtimeMs(file) != null && fs.statSync(file).size === size) continue;
        const partial = `${file}.part`;
        const result = await download(partial);
        fs.renameSync(partial, file);
        fs.rmSync(`${partial}.aria2`, { force: true });
        return { path: file, hit: false, download: result, waitedMs, release };
      } finally {
        unlock();
      }
    }
  } catch (e) {
    releaseHold();
    throw e;
  }
}

/**
 * Copies a file this worker uploaded into the cache under the object's key,
 * so the next job needing that object finds it. No-op if the entry exists or
 * another job is writing it. Returns true when stored.
 */
export function storeProduced(dir, file, url, parts, { beatMs = BEAT_MS, staleMs = STALE_MS, limits } = {}) {
  const size = fs.statSync(file).size;
  const { maxBytes } = { ...volumeCacheLimits(), ...limits };
  if (size > maxBytes) return false;
  fs.mkdirSync(dir, { recursive: true });
  const id = cacheKey(url, size, multipartEtag(parts));
  const target = path.join(dir, `${id}.mp4`);
  const release = hold(dir, id, beatMs);
  try {
    const unlock = tryLock(dir, id, { beatMs, staleMs });
    if (!unlock) return false;
    try {
      if (mtimeMs(target) != null) return false;
      const temp = `${target}.part`;
      fs.copyFileSync(file, temp);
      fs.renameSync(temp, target);
    } finally {
      unlock();
    }
    cleanupCache(dir, { ...limits, staleMs });
    return true;
  } finally {
    release();
  }
}
