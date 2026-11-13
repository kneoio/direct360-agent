/**
 * Shared ffmpeg planning used by the EDL render and the GoPro stitch.
 * Seeks land half a frame early so a millisecond timestamp cannot repeat
 * the previous frame. Concat, audio, and the faststart mux are one pass.
 */
import fs from 'node:fs';
import path from 'node:path';
import { setMaxListeners } from 'node:events';
import { FFMPEG, FFPROBE, run, probe } from './encoder.js';

const GI = 1024 * 1024 * 1024;

export function stoppedError() {
  const err = new Error('stopped');
  err.name = 'AbortError';
  return err;
}

/** Video stream start minus the container start. Seeks are added to this. */
export function seekOriginSec(videoStream, format) {
  const video = Number(videoStream?.start_time);
  const container = Number(format?.start_time);
  const v = Number.isFinite(video) ? video : 0;
  const c = Number.isFinite(container) ? container : 0;
  return v - c;
}

/**
 * (n − 0.5) / fps, plus the stream-start offset, never negative.
 * Frame 0 with no offset stays at 0.
 */
export function seekTimestamp(frame, num, den, originSec = 0) {
  const fps = Number(num) / (Number(den) || 1);
  if (!(fps > 0)) return '0.000000';
  const origin = Number(originSec) || 0;
  const sec = Math.max(0, (Number(frame) - 0.5) / fps + origin);
  return sec.toFixed(6);
}

export function rateArg(num, den) {
  return `${num}/${den || 1}`;
}

/**
 * `-reconnect`/`-multiple_requests` input args, added right before `-i <src>`
 * whenever `src` is an `http(s)://` URL — a no-op for a local file. Lets a
 * part job read a byte range straight off a presigned URL (ranged HTTP
 * reads via `-ss`/`-t`) the same way `bench_range`'s `rangeRead()` already
 * does, instead of downloading the whole file first.
 */
export function reconnectArgs(src) {
  if (!/^https?:\/\//i.test(String(src || ''))) return [];
  return ['-reconnect', '1', '-reconnect_on_network_error', '1', '-multiple_requests', '1'];
}

/** Identical libx264 settings on every chunk so concat -c copy joins them. */
export function x264Args({ threads, preset, crf, num, den, frames, pixFmt = 'yuv420p' }) {
  return [
    '-an',
    '-threads', String(threads),
    '-filter_threads', String(threads),
    '-r', rateArg(num, den),
    '-fps_mode', 'cfr',
    '-frames:v', String(frames),
    '-c:v', 'libx264',
    '-crf', String(crf),
    '-preset', preset,
    '-pix_fmt', pixFmt,
    '-force_key_frames', 'expr:eq(n,0)',
    '-x264-params', 'rc-lookahead=20:scenecut=0:keyint=9999:min-keyint=1',
  ];
}

export function directoryBytes(root) {
  let total = 0;
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        try { total += fs.statSync(full).size; } catch { /* removed mid-walk */ }
      }
    }
  }
  return total;
}

export function diskError(err) {
  const msg = String(err?.message || '');
  if (/^not enough disk\b/i.test(msg)) return err;
  if (err?.code === 'ENOSPC' || /no space left on device/i.test(msg)) {
    const wrapped = new Error(`not enough disk: ${msg}`);
    wrapped.code = 'ENOSPC';
    return wrapped;
  }
  return null;
}

export function cgroupMemory() {
  const read = (f) => { try { return fs.readFileSync(f, 'utf8').trim(); } catch { return null; } };
  const n = Number(read('/sys/fs/cgroup/memory.current') || read('/sys/fs/cgroup/memory/memory.usage_in_bytes'));
  return Number.isFinite(n) ? n : 0;
}

/** Sum of ffmpeg RSS, from /proc. Field 24 of stat is RSS pages. */
export function ffmpegRssBytes() {
  let total = 0;
  let entries;
  try { entries = fs.readdirSync('/proc'); } catch { return 0; }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    let comm;
    try { comm = fs.readFileSync(`/proc/${name}/comm`, 'utf8'); } catch { continue; }
    if (comm.trim() !== 'ffmpeg') continue;
    let stat;
    try { stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8'); } catch { continue; }
    const end = stat.lastIndexOf(')');
    if (end < 0) continue;
    const rss = Number(stat.slice(end + 2).split(' ')[21]);
    if (Number.isFinite(rss) && rss > 0) total += rss * 4096;
  }
  return total;
}

export function isRenderOom(err) {
  return Boolean(err?.oom) || /out of memory|\bSIGKILL\b/i.test(String(err?.message || ''));
}

export function oomError(err) {
  if (err?.oom && /^out of memory\b/i.test(String(err.message || ''))) {
    err.oom = true;
    return err;
  }
  const wrapped = new Error(`out of memory: ${err?.message || err}`);
  wrapped.oom = true;
  return wrapped;
}

/**
 * One retry at half the concurrency. A second kill is reported as out of memory.
 * Already-finished chunks stay on disk; the next pass skips them.
 */
export async function withOomRetry({ slots, log, run }) {
  const first = Math.max(1, slots);
  try {
    return await run(first);
  } catch (err) {
    const full = diskError(err);
    if (full) throw full;
    if (!isRenderOom(err)) throw err;
    const next = Math.max(1, Math.floor(first / 2));
    if (next >= first) throw oomError(err);
    log?.(`ffmpeg was killed (out of memory); retrying with ${next} ${next === 1 ? 'process' : 'processes'}`);
    try {
      return await run(next);
    } catch (err2) {
      const full2 = diskError(err2);
      if (full2) throw full2;
      if (isRenderOom(err2)) throw oomError(err2);
      throw err2;
    }
  }
}

/** A failed chunk is tried once more. Out of memory and disk full stay with the pass. */
export async function retryChunk(fn, log) {
  try {
    return await fn();
  } catch (err) {
    if (err?.name === 'AbortError' || isRenderOom(err) || diskError(err)) throw err;
    log?.(`chunk failed (${err.message}); retrying once`);
    return await fn();
  }
}

/**
 * Disk, cgroup, and ffmpeg RSS while chunks are on disk.
 * `stop` takes one last sample.
 */
export function startDiskWatch(dir) {
  let peakDisk = 0;
  let peakMem = 0;
  let peakRss = 0;
  const note = () => {
    const used = directoryBytes(dir);
    if (used > peakDisk) peakDisk = used;
    const mem = cgroupMemory();
    if (mem > peakMem) peakMem = mem;
    const rss = ffmpegRssBytes();
    if (rss > peakRss) peakRss = rss;
  };
  const timer = setInterval(note, 1000);
  timer.unref?.();
  note();
  return {
    note,
    stop() {
      clearInterval(timer);
      note();
    },
    get peakDisk() { return peakDisk; },
    get peakMem() { return peakMem; },
    get peakRss() { return peakRss; },
  };
}

/**
 * Abort controller for the chunk pass and the concat that follows it.
 * `release` drops the external listener. Call it after concat, not before.
 */
export function openEncodePass(signal) {
  const abort = new AbortController();
  setMaxListeners(0, abort.signal);
  const onAbort = () => abort.abort();
  if (signal?.aborted) abort.abort();
  else signal?.addEventListener('abort', onAbort);
  return {
    abort,
    signal: abort.signal,
    release() { signal?.removeEventListener('abort', onAbort); },
  };
}

/**
 * One chunk pass shared by the EDL render and the GoPro stitch.
 * `releasePrevious` drops the pass a retry is replacing. The returned pass
 * stays wired so concat can still be cancelled. `done[i]` skips a chunk
 * that already succeeded. The first real failure aborts the rest.
 */
export async function runPass({
  signal,
  releasePrevious,
  onPass,
  slotCount,
  maxParallel,
  audioLive = false,
  onPeak,
  items,
  done,
  openLimiter,
  runOne,
}) {
  releasePrevious?.();
  const pass = openEncodePass(signal);
  onPass?.(pass);
  const slots = Math.max(1, Math.min(slotCount, maxParallel));
  const limiter = openLimiter(slots, pass);
  let peak = 0;
  try {
    const settled = await Promise.allSettled(items.map(async (item, index) => {
      if (done?.[index]) return;
      try {
        await runOne({ item, index, slots, pass, limiter });
      } catch (err) {
        if (err?.name !== 'AbortError') pass.abort.abort();
        throw err;
      }
    }));
    const failure = settled.find((row) => row.status === 'rejected' && row.reason?.name !== 'AbortError')
      || settled.find((row) => row.status === 'rejected');
    if (failure) throw failure.reason;
  } finally {
    const extra = (typeof audioLive === 'function' ? audioLive() : audioLive) ? 1 : 0;
    peak = (limiter.peak?.() || 0) + extra;
    onPeak?.(peak);
  }
  return { pass, slots, peak };
}

/** Packet count and stream duration of a finished chunk join. */
export async function assertOutputVideo(file, { frames, duration, fps, chunks = 0, what = 'output', durationName = 'source duration' }) {
  const out = await run(FFPROBE, [
    '-v', 'error', '-count_packets', '-select_streams', 'v:0',
    '-show_entries', 'stream=nb_read_packets,duration',
    '-of', 'json',
    file,
  ]);
  const info = JSON.parse(out);
  const gotFrames = Number(info.streams?.[0]?.nb_read_packets);
  const gotDuration = Number(info.streams?.[0]?.duration);
  if (gotFrames !== frames) {
    throw new Error(`${what} produced ${gotFrames} frames, expected ${frames}`);
  }
  const slack = (1.5 + Math.floor(Math.max(0, Number(chunks) || 0) / 50)) / Math.max(fps, 1);
  if (!Number.isFinite(gotDuration) || Math.abs(gotDuration - duration) > slack) {
    throw new Error(`${what} duration ${gotDuration}s is not the ${durationName} ${duration}s`);
  }
}

function integerRateMultiple(rawFps, avgFps) {
  if (!(rawFps > 0) || !(avgFps > 0)) return false;
  const ratio = rawFps / avgFps;
  const nearest = Math.round(ratio);
  if (nearest < 1) return false;
  return Math.abs(ratio - nearest) <= 0.01 * nearest;
}

function parseRate(raw) {
  const [numRaw, denRaw] = String(raw || '').split('/');
  const num = Number(numRaw);
  const den = Number(denRaw) || 1;
  if (!(num > 0) || !(den > 0)) return null;
  return { num, den, fps: num / den };
}

/**
 * Frame count and duration from the video stream. avg_frame_rate is the
 * rate. A real gap between avg and r is variable frame rate and is rejected.
 */
export function videoTiming(stream) {
  if (!stream) throw new Error('could not read the video stream');
  const avg = parseRate(stream.avg_frame_rate);
  const raw = parseRate(stream.r_frame_rate);
  // A doubled (or other integer) r_frame_rate is how some containers label
  // a constant picture rate. Anything else that disagrees with the average is VFR.
  if (avg && raw && !integerRateMultiple(raw.fps, avg.fps)) {
    throw new Error('variable frame rate sources are not supported');
  }
  const counted = Number(stream.nb_frames);
  const streamDur = Number(stream.duration);
  // avg_frame_rate is frames over duration, so a file whose last frame lingers (a joined stitch) reads a little slow:
  // 29.96 for a real 29.97. r_frame_rate is the true one only if it accounts for the duration to within two frames; a
  // real 29.97 labelled 30 would not, and would put cuts over half a second off in ten minutes.
  const rawFits = raw && Number.isInteger(counted) && counted > 0 && streamDur > 0
    && Math.abs(counted / raw.fps - streamDur) <= 2 / raw.fps;
  const rate = avg && !rawFits ? avg : raw;
  if (!rate) throw new Error('could not read the video frame rate');
  let frames;
  if (Number.isInteger(counted) && counted > 0) frames = counted;
  else if (streamDur > 0) frames = Math.max(1, Math.round(streamDur * rate.fps));
  else throw new Error('could not read the video frame count');
  const duration = streamDur > 0 ? streamDur : frames / rate.fps;
  return { num: rate.num, den: rate.den, fps: rate.fps, frames, duration };
}

/** Seconds to shift audio so it lines up with the video stream start. */
export function audioOffsetSec(videoStream, audioStream) {
  const video = Number(videoStream?.start_time) || 0;
  const audio = Number(audioStream?.start_time) || 0;
  return audio - video;
}

/**
 * Extract the whole clip's audio while chunks encode. A later audio start
 * is delayed; an earlier one is trimmed. Copy stays only when no shift is needed.
 */
export const AUDIO_JOIN_FADE_SEC = 0.025;

function audioCutsGraph(cuts, offset) {
  const n = cuts.length;
  const fade = AUDIO_JOIN_FADE_SEC;
  const align = offset > 0.0005 ? `asetpts=PTS-STARTPTS,adelay=${Math.round(offset * 1000)}:all=1,` : '';
  const graph = [`[0:a:0]${align}asplit=${n}${cuts.map((_, i) => `[s${i}]`).join('')}`];
  cuts.forEach((cut, i) => {
    const chain = [`atrim=start=${cut.start.toFixed(6)}:end=${cut.end.toFixed(6)}`, 'asetpts=PTS-STARTPTS'];
    if (i > 0) chain.push(`afade=t=in:st=0:d=${fade}`);
    if (i < n - 1) chain.push(`afade=t=out:st=${(cut.end - cut.start - fade).toFixed(6)}:d=${fade}`);
    graph.push(`[s${i}]${chain.join(',')}[c${i}]`);
  });
  graph.push(`${cuts.map((_, i) => `[c${i}]`).join('')}concat=n=${n}:v=0:a=1[aout]`);
  return graph.join(';');
}

export function audioExtractArgs({ src, out, offsetSec = 0, duration = null, copy = false, cuts = null }) {
  const offset = Number(offsetSec) || 0;
  const args = ['-hide_banner', '-loglevel', 'error', '-y', ...reconnectArgs(src)];
  if (offset < -0.0005) args.push('-ss', (-offset).toFixed(6));
  if (cuts?.length > 1) {
    args.push('-i', src, '-vn', '-filter_complex', audioCutsGraph(cuts, offset), '-map', '[aout]', '-c:a', 'aac', '-b:a', '192k', out);
    return args;
  }
  args.push('-i', src, '-vn', '-map', '0:a:0');
  if (duration > 0) args.push('-t', String(duration));
  if (offset > 0.0005) {
    // PTS-STARTPTS first. adelay on a stream that already starts late
    // pushes the tail past -t and the end of the clip is dropped.
    const ms = Math.round(offset * 1000);
    args.push('-af', `asetpts=PTS-STARTPTS,adelay=${ms}:all=1`, '-c:a', 'aac', '-b:a', '192k');
  } else if (copy && offset >= -0.0005) {
    args.push('-c:a', 'copy');
  } else {
    args.push('-c:a', 'aac', '-b:a', '192k');
  }
  args.push(out);
  return args;
}

/**
 * Copy or encode a source's whole audio track to `out`, for a caller that
 * has no video decode of its own to piggyback the extraction onto (unlike
 * `stitchGopro`'s own inline audio block, which runs this same logic
 * alongside its chunk encodes). Used by the upload fan-out's part 0 when
 * the source doesn't need a GoPro stitch (`task: 'matrix'`) but a proxy
 * still needs the full-clip audio muxed in at join time. Returns `null`
 * when the source has no audio stream.
 */
export async function extractAudioTrack(src, out, { signal, log } = {}) {
  const info = await probe(src);
  const video = info.streams?.find((s) => s.codec_type === 'video');
  const audio = info.streams?.find((s) => s.codec_type === 'audio');
  if (!audio) return null;
  const timing = videoTiming(video);
  const copy = audio.codec_name === 'aac';
  const started = Date.now();
  await run(FFMPEG, audioExtractArgs({
    src, out, offsetSec: audioOffsetSec(video, audio), duration: timing.duration, copy,
  }), { signal });
  log?.(`audio ${copy ? 'copy' : 'encode'} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return { file: out };
}

/**
 * `-metadata key=value` pairs for an mp4. Empty or missing values are left out:
 * a tag is either known or absent. The mp4 muxer always rewrites the
 * format-level `encoder` to "Lavf…", so the encoder lives in two places that
 * survive: a custom `software` tag and the video stream's `encoder`.
 */
export function metadataArgs(metadata) {
  const args = [];
  for (const [key, value] of Object.entries(metadata || {})) {
    if (value == null || String(value).trim() === '') continue;
    const text = String(value).replace(/[\r\n]+/g, ' ');
    if (key === 'encoder') {
      args.push('-metadata', `software=${text}`, '-metadata:s:v:0', `encoder=${text}`);
    } else {
      args.push('-metadata', `${key}=${text}`);
    }
  }
  return args;
}

/** Concat the chunk list, mux audio when present, and move the moov atom once. */
export function concatFaststartArgs({ listFile, audioFile, out, metadata = null }) {
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'concat', '-safe', '0', '-i', listFile,
  ];
  if (audioFile) {
    args.push('-i', audioFile, '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy');
  } else {
    args.push('-c', 'copy');
  }
  const tags = metadataArgs(metadata);
  // bitexact keeps the muxer from adding its own "Lavf" encoder tag.
  if (tags.length) args.push('-fflags', '+bitexact');
  args.push('-movflags', tags.length ? '+faststart+use_metadata_tags' : '+faststart', ...tags, out);
  return args;
}

export function requireFreeDisk(dir, needBytes) {
  const stat = fs.statfsSync(dir);
  const free = Number(stat.bavail) * Number(stat.bsize);
  if (free < needBytes) {
    const err = new Error(`not enough disk: ${needBytes} bytes needed, ${free} free`);
    err.code = 'ENOSPC';
    throw err;
  }
  return free;
}

/** Uncompressed RGB bytes. 10-bit and deeper frames are 6 bytes per pixel. */
export function panFrameBytes(width, height, frames, pixFmt) {
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  const n = Number(frames) || 0;
  if (w < 1 || h < 1 || n < 1) return 0;
  const bpp = /10|12|16/.test(String(pixFmt || '')) ? 6 : 3;
  return w * h * bpp * n;
}

export { GI };
