/**
 * GoPro MAX `.360` → one equirectangular MP4.
 *
 * A `.360` holds both lenses as two video tracks in GoPro's equi-angular
 * cubemap, not as a 2:1 sphere. Each track is three cube faces; the side
 * faces still contain an overlap strip that has to be blended. The crop
 * sizes follow https://github.com/baasitsharief/gopro-to-mp4 for the original
 * MAX (4096×1344) and the same proportions for MAX 2 (5952×1920, 1920 faces,
 * 384px stored overlap). `v360` then projects the cubemap to a 2:1
 * equirectangular frame so the rest of this server can use it.
 *
 * A file that is already one ~2:1 video is left alone. One other video
 * track is flat footage (crop-window cameras, no stitch). Two tracks that
 * are not a known MAX pair, or a file with no video, is an error: a
 * different dual-lens layout does not match these crop sizes.
 *
 * The ffmpeg map is the stitched video plus audio. The gpmd telemetry track
 * is not copied. Read it from the original file before calling stitchGopro.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FFMPEG, probe, run } from './encoder.js';
import {
  chunkMinSeconds,
  containerLimits,
  createFfmpegLimiter,
  ffmpegMemoryPlan,
  heavyThreadCount,
  planChunks,
} from './edl.js';
import {
  stoppedError, seekTimestamp, seekOriginSec, x264Args, ffmpegRssBytes,
  withOomRetry, retryChunk, videoTiming, audioOffsetSec, audioExtractArgs, concatFaststartArgs,
  requireFreeDisk, startDiskWatch, assertOutputVideo, reconnectArgs,
  runPass as runChunkPass,
} from './ffmpegTools.js';

/**
 * Two known dual-lens layouts. `overlap` is the unblended strip stored in the
 * file; half of it is blended, then scaled by 3/2 so the face lands on `face`.
 * Original MAX: 128 → 64 → 96, face 1344. MAX 2: 384 → 192 → 288, face 1920.
 */
const PROFILES = [
  { width: 4096, height: 1344, face: 1344, overlap: 128 },
  { width: 5952, height: 1920, face: 1920, overlap: 384 },
];

function profileFor(width, height) {
  return PROFILES.find((p) => p.width === width && p.height === height) ?? null;
}

function faceParts(profile) {
  const blend = profile.overlap / 2;
  const scaled = blend * 1.5;
  const slice = (profile.face - scaled) / 2;
  if (!Number.isInteger(blend) || !Number.isInteger(scaled) || !Number.isInteger(slice)) {
    throw new Error(`GoPro layout ${profile.width}x${profile.height} does not divide into whole pixels`);
  }
  return { blend, scaled, slice, face: profile.face, height: profile.height };
}

function geq(blend) {
  const d = blend + 1;
  const expr =
    `if(between(X, 0, ${blend}), (p((X+${blend}),Y)*(((X+1))/${d}))+(p(X,Y)*((${d}-((X+1)))/${d})), p(X,Y))`;
  return `geq=lum='${expr}':cb='${expr}':cr='${expr}':a='${expr}'`;
}

function videoStreams(info) {
  return (info?.streams || []).filter((s) => s.codec_type === 'video');
}

function isEquirect(stream) {
  const aspect = stream.width / stream.height;
  return aspect >= 1.8 && aspect <= 2.2;
}

/** An input stream can be read many times. A filter label cannot, so a trimmed lens is split once per crop. */
function lensSources(index, frames, label) {
  const uses = 7;
  if (!frames) return { head: null, srcs: Array.from({ length: uses }, () => `0:${index}`) };
  const srcs = Array.from({ length: uses }, (_, i) => `${label}${i}`);
  const head = `[0:${index}]trim=end_frame=${frames},setpts=PTS-STARTPTS,split=${uses}${srcs.map((src) => `[${src}]`).join('')}`;
  return { head, srcs };
}

/** Side faces: three slices with the overlap blended down the middle. */
function blendedFace(srcs, name, x, parts) {
  const { slice, blend, scaled, height } = parts;
  const overlap = blend * 2;
  const [left, overlapSrc, right] = srcs;
  return [
    `[${left}]crop=${slice}:${height}:x=${x}:y=0,format=yuvj420p[${name}_l]`,
    `[${overlapSrc}]crop=${overlap}:${height}:x=${x + slice}:y=0,format=yuvj420p,${geq(blend)},crop=${blend}:${height}:x=0:y=0,format=yuvj420p,scale=${scaled}:${height}[${name}_o]`,
    `[${right}]crop=${slice}:${height}:x=${x + slice + overlap}:y=0,format=yuvj420p[${name}_r]`,
    `[${name}_l][${name}_o]hstack[${name}_lo]`,
    `[${name}_lo][${name}_r]hstack[${name}]`,
  ].join(';');
}

function plainFace(src, name, parts, x) {
  return `[${src}]crop=${parts.face}:${parts.height}:${x}:0[${name}]`;
}

/**
 * `frames`, when set, keeps that many frames from each lens after an accurate
 * seek and starts their timestamps at 0, so chunk joins do not repeat or drop
 * a frame. Omit it to stitch whatever the input already presents.
 */
export function eacToEquirectFilter(frontIndex, backIndex, profile, frames = null) {
  const parts = faceParts(profile);
  const centerX = parts.slice * 2 + parts.blend * 2;
  const rightX = centerX + parts.face;
  const outW = parts.face * 3;
  const outH = outW / 2;
  const front = lensSources(frontIndex, frames, 'fin');
  const back = lensSources(backIndex, frames, 'bin');
  const take = (bag, n) => bag.splice(0, n);
  return [
    front.head,
    back.head,
    blendedFace(take(front.srcs, 3), 'left', 0, parts),
    plainFace(take(front.srcs, 1)[0], 'center', parts, centerX),
    blendedFace(take(front.srcs, 3), 'right', rightX, parts),
    '[left][center]hstack[lc]',
    '[lc][right]hstack[front]',
    blendedFace(take(back.srcs, 3), 'bottom', 0, parts),
    plainFace(take(back.srcs, 1)[0], 'rear', parts, centerX),
    blendedFace(take(back.srcs, 3), 'top', rightX, parts),
    '[bottom][rear]hstack[br]',
    '[br][top]hstack[back]',
    '[front][back]vstack[eac]',
    `[eac]v360=input=eac:output=equirect:interp=cubic:w=${outW}:h=${outH}:yaw=0:pitch=0:roll=0[out]`,
  ].filter(Boolean).join(';');
}

const STITCH_PRESETS = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'];
/** libx264's own default. Every chunk uses this so a preset change is the only quality knob. */
const STITCH_CRF = 23;

/**
 * x264 preset for the stitched master. `D360_STITCH_PRESET` overrides it.
 * Veryfast is the default: on 60 frames of a 5952×1920 GS010036, x264 medium
 * was 48% of the stitch's CPU, the decode 19%, v360 18% and the blend 16%.
 * Veryfast took 29% less CPU and 24% less time than medium with a 7% smaller
 * file, scoring SSIM 0.975, PSNR 39.4 dB against medium.
 */
export function stitchPreset(env = process.env) {
  const raw = env?.D360_STITCH_PRESET;
  if (raw == null || raw === '') return 'veryfast';
  if (!STITCH_PRESETS.includes(raw)) {
    throw new Error(`D360_STITCH_PRESET must be one of ${STITCH_PRESETS.join(', ')}, got ${JSON.stringify(raw)}`);
  }
  return raw;
}

/** Same x264 settings on every chunk, with an IDR on frame 0, so concat -c copy joins them. */
function stitchVideoArgs({ threads, preset, num, den, frames, filter, src, seek, out }) {
  return [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-threads', String(threads),
    '-filter_threads', String(threads),
    '-accurate_seek',
    ...reconnectArgs(src),
    '-ss', seek,
    '-i', src,
    '-filter_complex_threads', String(threads),
    '-filter_complex', filter,
    '-map', '[out]',
    ...x264Args({ threads, preset, crf: STITCH_CRF, num, den, frames }),
    '-video_track_timescale', String(num),
    out,
  ];
}

/**
 * What an upload is. `{ kind: 'gopro' }` needs a stitch; `{ kind: 'equirect' }`
 * is ready for the 360 camera matrix; `{ kind: 'flat', width, height }` is
 * one ordinary video (crop windows, once the upload allowed it); `{ error }`
 * is a file this server cannot use.
 */
export function describeFootage(info) {
  const videos = videoStreams(info);
  if (!videos.length) return { error: 'uploaded file has no video stream' };
  const lenses = videos.filter((s) => profileFor(s.width, s.height));
  const profile = lenses.length >= 2 ? profileFor(lenses[0].width, lenses[0].height) : null;
  const paired = profile && lenses.filter((s) => s.width === profile.width && s.height === profile.height);
  if (paired && paired.length >= 2) return { kind: 'gopro', lenses: paired.slice(0, 2), profile };
  const main = videos[0];
  if (isEquirect(main)) return { kind: 'equirect' };
  if (videos.length >= 2) {
    const sizes = videos.map((v) => `${v.width}x${v.height}`).join(', ');
    const known = PROFILES.map((p) => `${p.width}x${p.height}`).join(' or ');
    return {
      error:
        `this file has ${videos.length} video tracks (${sizes}). ` +
        `A GoPro .360 needs two tracks of ${known}; an equirectangular mp4 is one ~2:1 video`,
    };
  }
  if (!(main.width > 0) || !(main.height > 0)) {
    return { error: 'uploaded file has no video size' };
  }
  return { kind: 'flat', width: main.width, height: main.height };
}

/** Bytes the stitch needs free: about 2.5× the stitched master, the audio file, and 1 GB. */
export function stitchWorkBytes({ stitchedBytes, audioBytes = 0 }) {
  const master = Math.max(0, Number(stitchedBytes) || 0);
  const audio = Math.max(0, Number(audioBytes) || 0);
  return Math.ceil(master * 2.5) + audio + 1024 ** 3;
}

function mediaBytes(stream, duration) {
  const rate = Number(stream?.bit_rate);
  if (rate > 0 && duration > 0) return Math.ceil((rate / 8) * duration);
  return 0;
}

/** `D360_STITCH_ENGINE`: `cpu` (default) or `gpu`, which needs an NVIDIA worker and the gpu-stitch binary. */
export function stitchEngine(env = process.env) {
  const raw = env?.D360_STITCH_ENGINE;
  if (raw == null || raw === '') return 'cpu';
  if (raw !== 'cpu' && raw !== 'gpu') {
    throw new Error(`D360_STITCH_ENGINE must be cpu or gpu, got ${JSON.stringify(raw)}`);
  }
  return raw;
}

/** NVENC quality for the GPU stitch. 24 scored about what x264 veryfast crf 23 does, at a similar size. */
export function gpuStitchCq(env = process.env) {
  const raw = env?.D360_STITCH_GPU_CQ;
  if (raw == null || raw === '') return 24;
  const cq = Number(raw);
  if (!Number.isInteger(cq) || cq < 1 || cq > 51) {
    throw new Error(`D360_STITCH_GPU_CQ must be a whole number from 1 to 51, got ${JSON.stringify(raw)}`);
  }
  return cq;
}

function runGpuStitch(src, out, cq, frames, { signal, onProgress }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(stoppedError()); return; }
    const child = spawn(process.env.D360_GPU_STITCH || 'gpu-stitch', [src, out, '0', String(cq)], {
      stdio: ['ignore', 'ignore', 'pipe'],
      // See gpu-stitch/nvenc_one_gpu.c.
      env: { ...process.env, LD_PRELOAD: '/usr/local/lib/libnvenc_one_gpu.so' },
    });
    const stop = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', stop, { once: true });
    let tail = '';
    let partial = '';
    child.stderr.on('data', (chunk) => {
      partial += chunk;
      const lines = partial.split('\n');
      partial = lines.pop();
      for (const line of lines) {
        const done = /^frame (\d+)$/.exec(line);
        if (done) onProgress?.(Math.min(1, Number(done[1]) / frames));
        else tail = `${tail}${line}\n`.slice(-2000);
      }
    });
    child.on('error', reject);
    child.on('close', (code) => {
      signal?.removeEventListener('abort', stop);
      if (signal?.aborted) reject(stoppedError());
      else if (code === 0) resolve();
      else reject(new Error(`gpu-stitch exited with ${code}: ${tail.trim()}`));
    });
  });
}

/** The whole clip on the GPU, then the audio muxed in. It has no part ranges, so the upload fan-out must be off. */
async function stitchGoproGpu(src, out, { info, front, audio, clipFrames, clipDuration, fps, onProgress, signal, log }) {
  const cq = gpuStitchCq();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'd360-stitch-'));
  const watch = startDiskWatch(tmp);
  try {
    const video = path.join(tmp, 'video.mp4');
    const started = Date.now();
    await runGpuStitch(src, video, cq, clipFrames, { signal, onProgress });
    log?.(`gpu stitch cq ${cq}, ${clipFrames} frames in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    let audioFile = null;
    let audioMs = 0;
    if (audio) {
      const audioStarted = Date.now();
      audioFile = path.join(tmp, 'audio.m4a');
      await run(FFMPEG, audioExtractArgs({
        src,
        out: audioFile,
        offsetSec: audioOffsetSec(front, audio),
        duration: info.duration,
        copy: audio.codec_name === 'aac',
      }), { signal });
      audioMs = Date.now() - audioStarted;
    }
    const listFile = path.join(tmp, 'list.txt');
    fs.writeFileSync(listFile, `file '${video.replace(/'/g, "'\\''")}'\n`);
    const concatStarted = Date.now();
    await run(FFMPEG, concatFaststartArgs({ listFile, audioFile, out }), { signal });
    const concatMs = Date.now() - concatStarted;
    await assertOutputVideo(out, { frames: clipFrames, duration: clipDuration, fps, what: 'stitch' });
    watch.note();
    return { file: out, frames: clipFrames, chunks: 1, preset: 'gpu', crf: cq, peak: 1, peakDisk: watch.peakDisk, peakMem: watch.peakMem, peakRss: watch.peakRss, audioMs, concatMs };
  } finally {
    watch.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Stitch a GoPro `.360` into one 2:1 equirectangular MP4, or one `partRange`
 * of it (a contiguous `{startFrame, frames}` slice, used by the upload
 * fan-out — see `src/edl.js`'s `splitFrameRange`). A part's own seeks are
 * shifted by `partRange.startFrame`; the intra-clip chunking below (its own,
 * finer-grained, multi-core parallelism) is otherwise unaware a part range
 * exists, since it is handed `partFrames` as if that were the whole clip.
 *
 * The clip (or part) is split into time chunks (same planner as a render:
 * `D360_CHUNK_MIN_SEC`, at least one wave of cores). Each chunk seeks both
 * lenses, runs the same filter for the same frame count, and starts on an
 * IDR. The join is `concat -c copy`. `+faststart` is applied on that final
 * file only.
 *
 * `includeAudio` (default true) copies or encodes the **full original
 * clip's** audio once, regardless of `partRange` — the upload fan-out only
 * asks for this on one part, and reuses that one file when joining both the
 * stitched source and the proxy, muxing it in at join time rather than
 * per-part. When `partRange` is set, that full-clip audio is deliberately
 * **not** muxed into this part's own `out` (its video only covers this
 * part's own, shorter, frame range — muxing in the whole clip's audio would
 * desync them); it's written to `audioOut` instead, for the caller to
 * upload as its own standalone artifact. A whole-file call (`partRange`
 * null) ignores `audioOut` and keeps today's behavior: audio muxed directly
 * into `out`.
 */
export async function stitchGopro(src, out, { onProgress, signal, log, partRange = null, includeAudio = true, audioOut = null } = {}) {
  const info = await probe(src);
  const footage = describeFootage(info);
  if (footage.kind !== 'gopro') throw new Error(footage.error || 'not a GoPro MAX .360 file');
  const [front, back] = footage.lenses;
  const frontTiming = videoTiming(front);
  const backTiming = videoTiming(back);
  const { num, den, frames: totalFrames, duration } = frontTiming;
  if (backTiming.frames !== totalFrames) {
    throw new Error(`GoPro lenses have ${totalFrames} and ${backTiming.frames} frames`);
  }
  const partStart = partRange ? Math.max(0, Math.trunc(partRange.startFrame)) : 0;
  const clipFrames = partRange ? Math.max(1, Math.trunc(partRange.frames)) : totalFrames;
  const clipDuration = partRange ? (clipFrames * den) / num : duration;
  const audio = includeAudio && (info.streams || []).find((s) => s.codec_type === 'audio');
  const seekOrigin = seekOriginSec(front, info.format);
  // A ranged part job's `src` is a remote URL (no local file to stat) — the
  // disk-space estimate below falls back to the `lensBytes` (bit_rate-based)
  // estimate in that case, same as when probing a local file's bit_rate works.
  const srcBytes = /^https?:\/\//i.test(String(src)) ? 0 : fs.statSync(src).size;
  const framesFraction = clipFrames / totalFrames;
  const lensBytes = Math.max(mediaBytes(front, clipDuration), mediaBytes(back, clipDuration));
  const stitchedBytes = lensBytes > 0 ? lensBytes : srcBytes * framesFraction;
  const audioBytes = audio ? (mediaBytes(audio, duration) || Math.ceil((192000 / 8) * duration)) : 0;
  requireFreeDisk(os.tmpdir(), stitchWorkBytes({ stitchedBytes, audioBytes }));
  if (stitchEngine() === 'gpu') {
    if (partRange) throw new Error('the GPU stitch has no part ranges: set DIRECT360_STITCH_FANOUT_MIN_SEC above the longest clip');
    return stitchGoproGpu(src, out, {
      info: { duration }, front, audio, clipFrames, clipDuration, fps: num / den, onProgress, signal, log,
    });
  }
  const preset = stitchPreset();
  const outW = footage.profile.face * 3;
  const outH = outW / 2;
  const limits = containerLimits();
  const plan = ffmpegMemoryPlan({
    cpus: limits.cpus,
    mem: limits.mem,
    width: outW,
    height: outH,
    pixFmt: front.pix_fmt || 'yuv420p10le',
  });
  // The flat-encode estimate is for one v360. This graph also decodes two
  // 10-bit lenses and blends six faces. A 16-thread medium chunk of
  // GS010019 peaked at 9.0 GB RSS, a bit over twice that estimate. Charge
  // it so a 32 GB container starts two copies, not seven.
  const stitchHeavy = Math.round(plan.heavy * 2.5);
  const stitchSlots = Math.max(1, Math.min(plan.processCap, Math.floor(plan.budget / stitchHeavy) || 1));
  const chunkSec = chunkMinSeconds(clipDuration, plan.cpus);
  const chunks = planChunks(
    [{ type: 'hold', start: 0, dur: clipDuration }],
    { totalFrames: clipFrames, fps: num / den, chunkSeconds: chunkSec },
  );
  const gb = (n) => (n / 1024 ** 3).toFixed(2);
  log?.(`${plan.cpus} cpus, ${gb(plan.mem)} GB memory, budget ${gb(plan.budget)} GB, heavy ${gb(stitchHeavy)} GB → ${stitchSlots} ffmpeg`);
  log?.(`stitch preset ${preset} crf ${STITCH_CRF}, chunk length ${chunkSec.toFixed(2)}s, ${chunks.length} chunks, ${clipFrames} frames${partRange ? ` (part at frame ${partStart})` : ''}`);

  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'd360-stitch-'));
  const files = new Array(chunks.length);
  const fraction = new Array(chunks.length).fill(0);
  let peak = 0;
  const watch = startDiskWatch(tmp);
  // Kept through concat so a cancel during the join still reaches ffmpeg.
  let encodePass = null;
  let audioAbort = null;
  let audioFile = null;
  let audioError = null;
  let audioDone = null;
  let audioLive = false;
  let audioMs = 0;
  if (audio) {
    audioAbort = new AbortController();
    if (signal?.aborted) audioAbort.abort();
    else signal?.addEventListener('abort', () => audioAbort.abort(), { once: true });
    audioFile = path.join(tmp, 'audio.m4a');
    const copy = audio.codec_name === 'aac';
    const audioStarted = Date.now();
    audioLive = true;
    audioDone = run(FFMPEG, audioExtractArgs({
      src,
      out: audioFile,
      offsetSec: audioOffsetSec(front, audio),
      duration,
      copy,
    }), { signal: audioAbort.signal }).then(() => {
      audioLive = false;
      audioMs = Date.now() - audioStarted;
      log?.(`audio ${copy ? 'copy' : 'encode'} in ${((Date.now() - audioStarted) / 1000).toFixed(1)}s`);
    }).catch((err) => {
      audioLive = false;
      audioError = err;
    });
  }

  function reportProgress() {
    if (!onProgress) return;
    const sum = fraction.reduce((total, value) => total + value, 0);
    onProgress(Math.min(1, sum / chunks.length));
  }

  async function runPass(maxParallel) {
    const progressOf = new Map();
    const startedAt = new Map();
    await runChunkPass({
      signal,
      releasePrevious: () => encodePass?.release(),
      onPass: (pass) => { encodePass = pass; },
      slotCount: stitchSlots,
      maxParallel,
      audioLive: () => audioLive,
      onPeak: (n) => { peak = Math.max(peak, n); },
      items: chunks,
      done: files,
      openLimiter: (slots, pass) => createFfmpegLimiter({
        budget: plan.budget,
        costs: { heavy: stitchHeavy, light: plan.light, pitch: plan.pitch },
        maxParallel: slots,
        signal: pass.signal,
        measureRss: ffmpegRssBytes,
        exec: (args) => {
          startedAt.set(args, Date.now());
          return run(FFMPEG, args, { signal: pass.signal, onProgress: progressOf.get(args) });
        },
      }),
      runOne: async ({ item: seg, index: i, slots, pass, limiter }) => {
        if (pass.signal.aborted) throw stoppedError();
        const threads = heavyThreadCount(plan.cpus, slots);
        const file = path.join(tmp, `chunk-${String(i).padStart(3, '0')}.mp4`);
        const seek = seekTimestamp(partStart + seg.seekFrame, num, den, seekOrigin);
        const filter = eacToEquirectFilter(front.index, back.index, footage.profile, seg.frames);
        const args = stitchVideoArgs({
          threads, preset, num, den, frames: seg.frames, filter, src, seek, out: file,
        });
        if (onProgress) {
          args.splice(args.length - 1, 0, '-progress', 'pipe:1', '-nostats');
          const chunkDur = seg.frames * den / num;
          progressOf.set(args, (sec) => {
            fraction[i] = Math.min(1, chunkDur > 0 ? sec / chunkDur : 1);
            reportProgress();
          });
        }
        await retryChunk(() => limiter.run(args, 'heavy'), log);
        files[i] = file;
        fraction[i] = 1;
        reportProgress();
        const started = startedAt.get(args) || Date.now();
        log?.(`chunk ${i + 1}/${chunks.length} ${seg.frames}f in ${((Date.now() - started) / 1000).toFixed(1)}s`);
      },
    });
  }

  try {
    await withOomRetry({ slots: stitchSlots, log, run: runPass });

    const listFile = path.join(tmp, 'list.txt');
    fs.writeFileSync(listFile, files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n') + '\n');
    if (audio) {
      const waitedAt = Date.now();
      await audioDone;
      const waited = (Date.now() - waitedAt) / 1000;
      if (audioError) throw audioError;
      if (waited >= 0.05) log?.(`waited ${waited.toFixed(1)}s for audio`);
    }
    let step = Date.now();
    peak = Math.max(peak, 1);
    // A part's own output never gets the full-clip audio muxed in directly
    // (see the doc comment above) — it goes to `audioOut` instead.
    const muxAudioFile = partRange ? null : audioFile;
    await run(FFMPEG, concatFaststartArgs({ listFile, audioFile: muxAudioFile, out }), { signal: encodePass?.signal });
    encodePass?.release();
    encodePass = null;
    if (partRange && audioFile && audioOut) fs.copyFileSync(audioFile, audioOut);
    const concatMs = Date.now() - step;
    log?.(`concat + faststart in ${(concatMs / 1000).toFixed(1)}s`);
    step = Date.now();
    await assertOutputVideo(out, { frames: clipFrames, duration: clipDuration, fps: num / den, what: partRange ? 'stitch part' : 'stitch' });
    log?.(`frame check in ${((Date.now() - step) / 1000).toFixed(1)}s`);
    watch.note();
    for (const file of files) fs.rmSync(file, { force: true });
    fs.rmSync(listFile, { force: true });
    return {
      file: out,
      frames: clipFrames,
      chunks: chunks.length,
      preset,
      crf: STITCH_CRF,
      peak,
      peakDisk: watch.peakDisk,
      peakMem: watch.peakMem,
      peakRss: watch.peakRss,
      audioMs,
      concatMs,
    };
  } finally {
    encodePass?.release();
    watch.stop();
    audioAbort?.abort();
    await audioDone;
    log?.(`peak concurrent ffmpeg: ${peak}`);
    if (watch.peakRss) log?.(`peak ffmpeg rss ${(watch.peakRss / 1024 ** 3).toFixed(2)} GB`);
    if (watch.peakMem) log?.(`peak memory ${(watch.peakMem / 1024 ** 3).toFixed(2)} GB`);
    log?.(`peak disk ${(watch.peakDisk / 1024 ** 3).toFixed(2)} GB`);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
