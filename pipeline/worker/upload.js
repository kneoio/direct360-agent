// Worker uploads: parts of a file PUT in parallel, each with its own stall
// guard and retries, to presigned multipart URLs (or to the server's result
// endpoint). Nothing here knows about jobs; render.js wires in logging and
// the refresh endpoint.
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';

/** Waits before retry 1..4 of a part (so a part is tried up to 5 times). */
export const UPLOAD_BACKOFF_MS = [2000, 5000, 10000, 20000];
/** A presigned URL this close to expiry is swapped for a fresh one before use. */
export const URL_REFRESH_MARGIN_MS = 120 * 1000;
const WRITE_SLICE = 256 * 1024;

function envNumber(env, name, fallback, min = 1) {
  const n = Number(env[name]);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

/** `{concurrency, stallMs, responseMs}` from D360_UPLOAD_CONCURRENCY (6), D360_UPLOAD_STALL_SEC (20) and D360_UPLOAD_RESPONSE_SEC (120). */
export function uploadConfig(env = process.env) {
  return {
    concurrency: Math.floor(envNumber(env, 'D360_UPLOAD_CONCURRENCY', 6)),
    stallMs: envNumber(env, 'D360_UPLOAD_STALL_SEC', 20, 0.05) * 1000,
    responseMs: envNumber(env, 'D360_UPLOAD_RESPONSE_SEC', 120, 0.05) * 1000,
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class UploadHttpError extends Error {
  constructor(status, body) {
    super(`HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

/** When a presigned (SigV4 query) URL stops working, as ms since epoch; null for any other URL. */
export function urlExpiry(url) {
  try {
    const q = new URL(url).searchParams;
    const date = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(q.get('X-Amz-Date') || '');
    const ttl = Number(q.get('X-Amz-Expires'));
    if (!date || !Number.isFinite(ttl)) return null;
    return Date.UTC(date[1], date[2] - 1, date[3], date[4], date[5], date[6]) + ttl * 1000;
  } catch {
    return null;
  }
}

/**
 * One PUT. Rejects with UploadHttpError for a non-2xx answer (body kept, first
 * 300 chars), with a "stalled" error when the body stops moving for `stallMs`
 * while it is being sent, with a "response timeout" error when the whole body
 * went out but no reply came within `responseMs`, or when `signal` aborts.
 * Resolves to the response ETag. Content-Length is the real byte count of `buf`.
 * Part URLs are signed for `host` only: send a Content-Type only if asked.
 *
 * Every listener is added once, and all of them are removed when the request ends.
 */
export function putBuffer(url, buf, { contentType = null, stallMs = 20000, responseMs = 120000, signal = null } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const headers = { 'Content-Length': buf.length };
    if (contentType) headers['Content-Type'] = contentType;
    const lib = target.protocol === 'http:' ? http : https;
    let done = false;
    let sent = 0;
    let bodyDone = false; // every byte is on the wire: from here only the reply is awaited
    let lastBytes = -1;
    let lastChange = Date.now();
    let wake = null; // resolves the writer's wait for 'drain' or 'close'
    let res = null;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearInterval(timer);
      signal?.removeEventListener('abort', onAbort);
      req.off('drain', onDrain);
      req.off('close', onClose);
      req.off('error', onError);
      req.off('finish', onFinish);
      res?.off('data', onData);
      res?.off('error', onError);
      res?.off('end', onEnd);
      // A destroy() still emits its error on the next tick; swallow it (once each).
      req.once('error', () => {});
      res?.once('error', () => {});
      wake?.();
      fn(value);
    };
    const onData = (c) => {
      lastChange = Date.now();
      if (got < 300) chunks.push(c);
      got += c.length;
    };
    const chunks = [];
    let got = 0;
    let etag = '';
    const onEnd = () => {
      if (res.statusCode >= 200 && res.statusCode < 300) finish(resolve, etag);
      else finish(reject, new UploadHttpError(res.statusCode, Buffer.concat(chunks).toString('utf8').slice(0, 300)));
    };
    const onError = (e) => finish(reject, e);
    const onDrain = () => wake?.();
    const onClose = () => {
      wake?.();
      if (!done) finish(reject, new Error(`connection closed before a reply (sent ${sent}/${buf.length})`));
    };
    const onFinish = () => {
      bodyDone = true;
      lastChange = Date.now();
    };
    const onAbort = () => {
      req.destroy();
      finish(reject, new Error('upload aborted'));
    };
    const req = lib.request({
      method: 'PUT',
      hostname: target.hostname,
      port: target.port || (target.protocol === 'http:' ? 80 : 443),
      path: `${target.pathname}${target.search}`,
      headers,
    }, (response) => {
      res = response;
      etag = res.headers.etag || '';
      res.on('data', onData);
      res.on('error', onError);
      res.on('end', onEnd);
    });
    // While the body goes out, progress is what the socket has actually pushed
    // (written minus still-queued); a single big write would count as sent at
    // once, so the body goes out in slices. Once the body is out, the stall
    // clock stops and the reply gets its own timeout.
    const timer = setInterval(() => {
      if (!bodyDone) {
        const now = (req.socket?.bytesWritten || 0) - (req.socket?.writableLength || 0);
        if (now !== lastBytes) {
          lastBytes = now;
          lastChange = Date.now();
        } else if (Date.now() - lastChange >= stallMs) {
          req.destroy();
          finish(reject, new Error(`stalled: no bytes moved for ${(stallMs / 1000).toFixed(0)}s (sent ${sent}/${buf.length})`));
        }
      } else if (Date.now() - lastChange >= responseMs) {
        req.destroy();
        finish(reject, new Error(`response timeout: no reply for ${(responseMs / 1000).toFixed(0)}s after the whole body was sent (sent ${sent}/${buf.length})`));
      }
    }, Math.max(10, Math.min(1000, Math.min(stallMs, responseMs) / 4)));
    timer.unref?.();
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    req.on('error', onError);
    req.on('close', onClose);
    req.on('drain', onDrain);
    req.on('finish', onFinish);
    (async () => {
      for (let at = 0; at < buf.length && !done; at += WRITE_SLICE) {
        const slice = buf.subarray(at, Math.min(buf.length, at + WRITE_SLICE));
        sent = at + slice.length;
        if (!req.write(slice)) await new Promise((r) => { wake = r; });
      }
      if (!done) req.end();
    })().catch((e) => finish(reject, e));
  });
}

/**
 * PUT with retries and fresh-URL handling for one part.
 * `urlFor(force)` returns the URL to use; with force it first asks the server
 * for a new one. Returns {etag, retries}.
 */
async function putWithRetry({ urlFor, buf, label, index, contentType, stallMs, responseMs, signal, backoff, log, canRefresh }) {
  let retries = 0;
  let forceFresh = false;
  for (let attempt = 0; ; attempt++) {
    let url = await urlFor(forceFresh);
    const expiry = urlExpiry(url);
    if (!forceFresh && canRefresh && expiry && expiry - Date.now() < URL_REFRESH_MARGIN_MS) {
      log(`${label} part ${index} URL expires in ${Math.max(0, Math.round((expiry - Date.now()) / 1000))}s, asking for a fresh one`);
      url = await urlFor(true);
    }
    forceFresh = false;
    try {
      const etag = await putBuffer(url, buf, { contentType, stallMs, responseMs, signal });
      return { etag, retries };
    } catch (e) {
      if (signal?.aborted) throw e;
      let why = e.message;
      if (e instanceof UploadHttpError) {
        why = `HTTP ${e.status}${e.body ? `: ${e.body}` : ''}`;
        if ((e.status === 400 || e.status === 403) && canRefresh) {
          const left = (urlExpiry(url) ?? Infinity) - Date.now();
          if (left < URL_REFRESH_MARGIN_MS) forceFresh = true;
        }
      }
      if (attempt >= backoff.length) {
        throw new Error(`${label} part ${index} failed after ${attempt + 1} tries: ${why}`);
      }
      retries++;
      const wait = forceFresh ? 0 : backoff[attempt];
      log(`${label} part ${index} failed (${why}), retry ${retries}/${backoff.length}${forceFresh ? ' with a fresh URL' : ` in ${wait / 1000}s`}`);
      if (wait) await sleep(wait);
    }
  }
}

/**
 * Uploads `file` in `partSize` pieces, `concurrency` at a time. A part that
 * keeps failing fails the whole upload (the others are aborted).
 *
 * `urls` are the presigned part URLs (or `urlAt(i)` for URLs derived per part);
 * `refreshUrls(partNumbers)` may return `{[partNumber]: url}` for fresh ones.
 * Returns {bytes, count, parts:[{partNumber, etag}] sorted, seconds, mbps, retries}.
 */
export async function uploadFile(file, {
  partSize, urls = null, urlAt = null, refreshUrls = null, label = 'upload', contentType = null,
  requireEtag = true, concurrency = 6, stallMs = 20000, responseMs = 120000, backoff = UPLOAD_BACKOFF_MS,
  onProgress = () => {}, log = () => {},
}) {
  if (!partSize || (!urls?.length && !urlAt)) throw new Error(`${label} upload is missing part URLs`);
  const size = fs.statSync(file).size;
  const count = Math.max(1, Math.ceil(size / partSize));
  if (urls && count > urls.length) throw new Error(`${label} needs ${count} parts, only ${urls.length} were presigned`);
  const current = urls ? [...urls] : null;
  const started = Date.now();
  const fd = fs.openSync(file, 'r');
  const aborts = new Set(); // one controller per lane, so a signal never carries more than one listener
  const parts = new Array(count);
  let retries = 0;
  let next = 0;
  let done = 0;
  let failure = null;
  let refreshing = null;

  const refreshAll = () => {
    if (!refreshing) {
      const pending = [];
      for (let i = 0; i < count; i++) if (!parts[i]) pending.push(i + 1);
      refreshing = Promise.resolve(refreshUrls(pending)).then((fresh) => {
        for (const [n, u] of Object.entries(fresh || {})) current[Number(n) - 1] = u;
      }).finally(() => { refreshing = null; });
    }
    return refreshing;
  };
  const urlFor = (i) => async (force) => {
    if (!current) return urlAt(i);
    if (force) await refreshAll();
    return current[i];
  };

  const lane = async () => {
    while (!failure) {
      const i = next++;
      if (i >= count) return;
      const len = Math.min(partSize, size - i * partSize);
      const buf = Buffer.alloc(len);
      const mine = new AbortController();
      aborts.add(mine);
      fs.readSync(fd, buf, 0, len, i * partSize);
      try {
        const got = await putWithRetry({
          urlFor: urlFor(i), buf, label, index: i + 1, contentType, stallMs, responseMs, signal: mine.signal,
          backoff, log, canRefresh: Boolean(current && refreshUrls),
        });
        retries += got.retries;
        if (requireEtag && !got.etag) throw new Error(`${label} part ${i + 1} returned no etag`);
        parts[i] = { partNumber: i + 1, etag: got.etag };
        done++;
        onProgress(Math.round((done / count) * 100));
      } catch (e) {
        if (!failure) {
          failure = e;
          for (const a of aborts) a.abort();
        }
        return;
      } finally {
        aborts.delete(mine);
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, count) }, lane));
  } finally {
    fs.closeSync(fd);
  }
  if (failure) throw failure;
  const seconds = Number(((Date.now() - started) / 1000).toFixed(3));
  const mbps = seconds > 0 ? Number((size / 1e6 / seconds).toFixed(2)) : null;
  log(`${label} uploaded ${size} bytes in ${count} parts, ${seconds.toFixed(1)}s (${mbps == null ? '?' : mbps.toFixed(1)} MB/s, ${retries} retries)`);
  return { bytes: size, count, parts, seconds, mbps, retries };
}

/** Single small body (telemetry, orientation): same stall guard and retries, one part. */
export async function uploadBuffer(url, buf, { label = 'upload', contentType = null, stallMs = 20000, responseMs = 120000, backoff = UPLOAD_BACKOFF_MS, log = () => {} } = {}) {
  const started = Date.now();
  const got = await putWithRetry({
    urlFor: async () => url, buf, label, index: 1, contentType, stallMs, responseMs, signal: null, backoff, log, canRefresh: false,
  });
  const seconds = Number(((Date.now() - started) / 1000).toFixed(3));
  return {
    bytes: buf.length, seconds, mbps: seconds > 0 ? Number((buf.length / 1e6 / seconds).toFixed(2)) : null, retries: got.retries,
  };
}
