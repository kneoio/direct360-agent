/**
 * Render a flat video from an edit decision list (EDL) against a 360°
 * source — the thing a future timeline-scrubbing tool would produce, and
 * this module's only job is to turn into pixels.
 *
 * An EDL is an array of keyframes, sorted by time:
 *   [{ t: 0, camera: 1 }, { t: 4, camera: 7 }, { t: 9, camera: 14, panSpeed: 30 }]
 * `camera` is a 1-based number into the same grid `matrix` numbers (so the
 * grid video and an EDL referencing it always agree on what "camera 7"
 * means). A plain cut holds the previous camera until `t`, then jumps.
 * `panSpeed: N` instead turns the last stretch before `t` into a smooth yaw
 * sweep from the previous camera to this one (shortest way around the
 * sphere), moving at N degrees/second — a real pan, not a cut. It's a speed,
 * not a fixed duration, on purpose: two cameras 180° apart and two adjacent
 * cameras 14° apart both feel like the same motion at a given panSpeed,
 * where a fixed duration would whip through the far pair and crawl through
 * the near one. The actual time a pan takes is angularDistance / panSpeed,
 * computed per pair of cameras in `planSegments`. An entry with panSpeed may
 * also say how the pan's speed changes over its length (`panCurve`, see
 * DEFAULT_PAN_CURVE) and which way round the yaw turns (`panDirection`: left
 * or right; the short way when absent).
 *
 * Between two cameras of a different picture (projection, pannini zoom or shape) a plain pan is a cut, see below. An
 * entry with panSpeed may then ask for a transition instead (`panKind`): `blend` turns on the same path as a pan while
 * the old picture fades into the new one (any pair), and `planet` (flat to little planet or back) moves in the planet
 * projection, tilting and widening, with only a short fade at the flat end. `transitionKinds` says which a switch
 * allows.
 *
 * An entry may carry its own camera settings, `view`: any of `yaw`, `pitch`, `roll`, `fov`, `projection`, `bulge`. They
 * replace the footage's layout for that camera from that entry on, until the next entry; what `view` leaves out is
 * the layout's. So the same camera cut to twice can be aimed, zoomed and shaped differently each time.
 *
 * Flat footage (mode `flat`) never uses v360. It is one camera, the whole
 * frame, edit list exactly [{t: 0, camera: 1}]: the render scales the frame
 * to fit inside the output and pads the rest black. No crop, no pan.
 *
 * Each camera may also carry a roll and a field of view (the lens editor's
 * `rolls` and `fovs`, default 0° and 100°) and a projection (`projections`:
 * flat, fisheye, planet or pannini, default flat; v360 cannot change its output
 * while it runs, so a pan between cameras of different projections, or between
 * two pannini cameras of different fov, is a cut at the edit time instead). A
 * camera may also bow its sides (`bulges`, see bulgeWarp in formats.js): its
 * v360 draws a larger view and remap warps it into the frame. That warp is
 * fixed for the whole ffmpeg, so a pan between two different shapes is a cut
 * too. A hold is one static v360 with
 * them. A pan interpolates yaw, pitch, roll and fov on the same ease, and its
 * length counts all four (the 4-D distance in degrees, so two cameras that
 * only differ in roll or zoom still get a real pan, not a cut).
 *
 * On a 360 source, holds are one static v360. A pan whose pitch, roll and fov stay put is a horizontal
 * spin of the equirect: the scroll filter shifts each frame (same ease as
 * the old per-frame yaw) and one v360 with a fixed yaw builds its remap
 * once. A pan that also changes pitch is one v360 per chunk: the same
 * scroll carries the yaw, and sendcmd sets pitch at each frame time with
 * `reset_rot=1`. Without that flag v360 zeros the other axis and multiplies
 * the rotation onto the previous quaternion, so the picture walks away from
 * the eased pose. A pan whose roll or fov changes takes the same route, with
 * roll, h_fov and v_fov sent on every frame too (v360 accepts all three as
 * runtime commands). Holds and pans are split into chunks so those encodes run
 * together.
 *
 * Segments are concatenated video-only via the concat demuxer, same as
 * `reframe360`. That's deliberate: concatenating segments that *each already
 * carry their own audio* (`-c copy` stream-copy of both video+audio packets
 * together) reproducibly corrupts timestamps at every segment boundary —
 * confirmed with ffprobe: a clean, evenly-spaced frame sequence right up to
 * a boundary, then a ~1-2s presentation-timestamp jump at the first frame of
 * the next segment, every time, regardless of thread settings. `reframe360`
 * never hit this because its segments are video-only (`-an`) to begin with.
 * Since an EDL's segments are contiguous and never reordered — unlike
 * `reframe360`'s random-angle segments — audio never needs to be cut at all:
 * concatenate video-only (the proven-reliable path). The AAC encode of the
 * whole source starts with the chunks, and the join stream-copies both.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { run, FFMPEG, probe } from './encoder.js';
import { parseGrid, gridAims, isRearAim } from './matrix.js';
import { assertOverlayAvailable, withOverlay, filterPath } from './overlayFilter.js';
import { projectedFieldOfView, projectionOf, projectionStage, outputSize, FORMATS, FOV_DEFAULT, FOV_RANGES, bulgeOf, bulgeReach, hasBulge, sameBulge, BULGE_SUPERSAMPLE } from './formats.js';
import { viewAngles } from './stabilize.js';
import { assertFlatEdl, flatFitFilter } from './flatCameras.js';
import {
  stoppedError, seekTimestamp, seekOriginSec, rateArg, x264Args,
  isRenderOom, withOomRetry, retryChunk, videoTiming, audioOffsetSec, audioExtractArgs,
  concatFaststartArgs, ffmpegRssBytes, startDiskWatch, assertOutputVideo,
  runPass as runChunkPass,
} from './ffmpegTools.js';

export { isRenderOom };

const WATERMARK = fileURLToPath(new URL('../lib/watermark.png', import.meta.url));

/** `D360_RENDER_CRF` overrides the final-render CRF. Unset stays 18. */
export function finalCrf(raw) {
  if (raw == null || raw === '') return 18;
  const crf = Number(raw);
  if (!Number.isFinite(crf)) throw new Error(`D360_RENDER_CRF must be a number, got ${JSON.stringify(raw)}`);
  return crf;
}

/**
 * Pan easing: speed ramps up over the first PAN_RAMP of the pan, holds
 * steady, and ramps down over the last PAN_RAMP. A cubic ease-in-out peaked
 * at 3x the average speed mid-pan, which read as a whip in the middle; this
 * peaks at 1 / (1 - PAN_RAMP) — about 1.4x — and the pan still takes the
 * same total time.
 */
const PAN_RAMP = 0.3;
const easeInOut = (x) => {
  const peak = 1 / (1 - PAN_RAMP);
  if (x < PAN_RAMP) return (peak * x * x) / (2 * PAN_RAMP);
  if (x > 1 - PAN_RAMP) return 1 - (peak * (1 - x) * (1 - x)) / (2 * PAN_RAMP);
  return peak * (x - PAN_RAMP / 2);
};
const normalizeAngle = (deg) => (((deg + 180) % 360 + 360) % 360) - 180;

/**
 * A pan's speed over its length: points `[{at, level}]`, `at` from 0 to 1,
 * `level` 0..100, the speed relative to the peak. The default is the ramp
 * `easeInOut` is made from (mean level 70), so a pan without a curve moves
 * and lasts as it always did; a pan with one lasts 70 / mean(curve) as long.
 */
export const DEFAULT_PAN_CURVE = [{ at: 0, level: 0 }, { at: 0.3, level: 100 }, { at: 0.7, level: 100 }, { at: 1, level: 0 }];
const DEFAULT_PAN_MEAN = 70;
const PAN_CURVE_POINTS = [2, 12];
const PAN_CURVE_MIN_MEAN = 5;

/** The area under the piecewise-linear speed `curve` over 0..1. */
export function panCurveMean(curve) {
  let area = 0;
  for (let i = 1; i < curve.length; i++) area += ((curve[i].level + curve[i - 1].level) / 2) * (curve[i].at - curve[i - 1].at);
  return area;
}

/** `raw` as a usable curve (numbers kept), or null when it is not one: 2 to 12 points in order from 0 to 1, levels 0..100, mean level at least 5. */
export function sanitizePanCurve(raw) {
  if (!Array.isArray(raw) || raw.length < PAN_CURVE_POINTS[0] || raw.length > PAN_CURVE_POINTS[1]) return null;
  const curve = raw.map((point) => ({ at: Number(point?.at), level: Number(point?.level) }));
  if (!curve.every((point) => Number.isFinite(point.at) && Number.isFinite(point.level) && point.level >= 0 && point.level <= 100)) return null;
  if (curve[0].at !== 0 || curve.at(-1).at !== 1) return null;
  if (curve.some((point, i) => i > 0 && point.at < curve[i - 1].at)) return null;
  if (panCurveMean(curve) < PAN_CURVE_MIN_MEAN) return null;
  return curve;
}

/** 'left' or 'right' as given, else null (the short way). */
export function sanitizePanDirection(raw) {
  return raw === 'left' || raw === 'right' ? raw : null;
}

/** The transitions a switch between two different pictures can ask for (`panKind`). */
export const PAN_KINDS = ['blend', 'planet'];
/** Part of a planet transition (at its flat end) that fades between the flat and the planet picture. */
export const PLANET_FADE = 0.25;

/** 'blend' or 'planet' as given, else null (a plain pan). */
export function sanitizePanKind(raw) {
  return PAN_KINDS.includes(raw) ? raw : null;
}

/** The same picture: same projection, the same pannini zoom (it has none at run time) and the same shape. */
export function samePicture(a, b) {
  return a.projection === b.projection && (a.projection !== 'pannini' || a.fov === b.fov) && sameBulge(a.bulge, b.bulge);
}

/**
 * How a switch from pose `a` to pose `b` (each {projection, fov, bulge}) can move: ['pan'] between the same picture,
 * else the transitions: 'blend' always, 'planet' too between a flat camera and a little planet.
 */
export function transitionKinds(a, b) {
  if (samePicture(a, b)) return ['pan'];
  const pair = [projectionOf(a.projection), projectionOf(b.projection)].sort().join('-');
  return pair === 'flat-planet' ? ['blend', 'planet'] : ['blend'];
}

/** How much of the new picture a transition shows at progress `p` (0..1 on the pan's ease). */
export function transitionWeight(kind, fromProjection, p) {
  if (kind !== 'planet') return p;
  return projectionOf(fromProjection) === 'planet'
    ? Math.min(1, Math.max(0, (p - (1 - PLANET_FADE)) / PLANET_FADE))
    : Math.min(1, Math.max(0, p / PLANET_FADE));
}

const RAD = Math.PI / 180;

/**
 * How large a picture of `projection` drawn `fov` wide (across its long side) shows what is in its middle: the frame's
 * half-width per radian there. Flat is tan, fisheye (equidistant) the plain angle, planet (stereographic) 2·tan(θ/2).
 * Pannini has no fov of its own at run time: null.
 */
export function centreScale(projection, fov) {
  const half = (fov * RAD) / 2;
  switch (projectionOf(projection)) {
    case 'flat': return 1 / Math.tan(half);
    case 'fisheye': return 1 / half;
    case 'planet': return 1 / (2 * Math.tan(half / 2));
    default: return null;
  }
}

/** The fov at which a picture of `projection` shows its middle at `scale` (centreScale's inverse). */
export function fovForScale(projection, scale) {
  switch (projectionOf(projection)) {
    case 'flat': return (2 * Math.atan(1 / scale)) / RAD;
    case 'fisheye': return 2 / scale / RAD;
    case 'planet': return (4 * Math.atan(1 / (2 * scale))) / RAD;
    default: return null;
  }
}

/**
 * The fov each picture of a transition is drawn at, `p` of the way (on the pan's ease) from `from` to `to` (each
 * {projection, fov}). Both show the middle of the frame at the same size, which goes from the first picture's to the
 * second's evenly (in log), so the two pictures lie on each other in the middle and only part towards the edges; at
 * p 0 the first is exactly its camera, at p 1 the second. Pannini keeps its own zoom (it has none at run time): with
 * pannini on either side each picture moves from its own fov to the other's, flat held inside its range.
 */
export function transitionFovs(from, to, p) {
  const a = centreScale(from.projection, from.fov);
  const b = centreScale(to.projection, to.fov);
  if (a != null && b != null) {
    const scale = Math.exp(Math.log(a) + (Math.log(b) - Math.log(a)) * p);
    return { from: p <= 0 ? from.fov : fovForScale(from.projection, scale), to: p >= 1 ? to.fov : fovForScale(to.projection, scale) };
  }
  const path = from.fov + (to.fov - from.fov) * p;
  const own = (pic) => {
    const kind = projectionOf(pic.projection);
    if (kind === 'pannini') return pic.fov;
    if (kind === 'flat') return Math.min(FOV_RANGES.flat.max, Math.max(FOV_RANGES.flat.min, path));
    return path;
  };
  return { from: own(from), to: own(to) };
}

const progressCache = new WeakMap();

/**
 * How far along the yaw (and everything else) a pan is at `x` of its length:
 * the area under the speed curve up to x over its whole area. Without a curve
 * that is `easeInOut`.
 */
export function panProgress(curve, x) {
  if (!curve) return easeInOut(x);
  let sums = progressCache.get(curve);
  if (!sums) {
    sums = [0];
    for (let i = 1; i < curve.length; i++) sums.push(sums[i - 1] + ((curve[i].level + curve[i - 1].level) / 2) * (curve[i].at - curve[i - 1].at));
    progressCache.set(curve, sums);
  }
  const total = sums.at(-1);
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  let i = 1;
  while (i < curve.length - 1 && curve[i].at <= x) i++;
  const a = curve[i - 1];
  const b = curve[i];
  const width = b.at - a.at;
  const d = x - a.at;
  const slope = width > 0 ? (b.level - a.level) / width : 0;
  return (sums[i - 1] + a.level * d + (slope * d * d) / 2) / total;
}

/**
 * The yaw change of a pan in degrees: the short way, or forced to the left
 * (negative) or right (positive). Two different yaws turn a full 360° when
 * they only differ by the wrap and a side is forced.
 */
export function panYawDelta(fromYaw, toYaw, direction = null) {
  const delta = normalizeAngle(toYaw - fromYaw);
  if (direction === 'left') return delta > 0 ? delta - 360 : (delta === 0 && fromYaw !== toYaw ? -360 : delta);
  if (direction === 'right') return delta < 0 ? delta + 360 : (delta === 0 && fromYaw !== toYaw ? 360 : delta);
  return delta;
}

/** Shortest-path angular distance between two yaws, in degrees (0-180). */
function angularDistance(a, b) {
  return Math.abs(normalizeAngle(b - a));
}

const MB = 1024 * 1024;
const GI = 1024 * MB;
/** Left for node, the page cache, and ffmpeg's own allocations past the estimate. */
const MEM_HEADROOM = Math.round(1.5 * GI);
/** One per-frame v360 (seek + decode one frame + project + PNG). */
const LIGHT_DEFAULT = Math.round(0.8 * GI);
/**
 * Peak RSS of one hold or yaw-pan ffmpeg, measured on a 5760×2880 source
 * with libx264 medium, 2 threads, and a lookahead of 20. Rows are
 * [output pixels, KiB]. 10-bit sources sit higher because the decoder does.
 * A 1.5× margin on top of the 720p 10-bit row (449 MiB) is what leaves 16
 * of them inside a 32 GB container after the 1.5 GB headroom.
 */
const HEAVY_MARGIN = 1.5;
const HEAVY_RSS_KIB = {
  narrow: [
    [1280 * 720, 360136],
    [1920 * 1080, 547632],
    [3840 * 2160, 1481356],
  ],
  wide: [
    [1280 * 720, 460072],
    [1920 * 1080, 650724],
    [3840 * 2160, 1599884],
  ],
};
/**
 * Peak RSS of one pitch-pan ffmpeg (v360 with sendcmd, libx264 medium,
 * 2 threads, lookahead 20). Measured on a 3840×1920 source.
 * Rows are [output pixels, KiB]. 10-bit sources sit higher because the
 * decoder does. A larger source is scaled by the pixel ratio.
 */
const PITCH_SOURCE_PIXELS = 3840 * 1920;
const PITCH_RSS_KIB = {
  narrow: [
    [480 * 270, 138972],
    [1280 * 720, 263224],
    [1920 * 1080, 449856],
  ],
  wide: [
    [480 * 270, 277216],
    [1280 * 720, 403808],
    [1920 * 1080, 593040],
  ],
};

/**
 * CPUs and memory this process may actually use. Inside a container,
 * os.cpus() and os.totalmem() report the whole host. The cgroup limits are
 * the real numbers (v2 first, then v1).
 */
export function containerLimits() {
  const read = (f) => { try { return fs.readFileSync(f, 'utf8').trim(); } catch { return null; } };
  let mem = Number(read('/sys/fs/cgroup/memory.max')) || Number(read('/sys/fs/cgroup/memory/memory.limit_in_bytes')) || os.totalmem();
  mem = Math.min(mem, os.totalmem());
  let cpus = os.availableParallelism?.() ?? os.cpus().length;
  const v2 = read('/sys/fs/cgroup/cpu.max')?.split(' ');
  const quota = v2 ? Number(v2[0]) : Number(read('/sys/fs/cgroup/cpu/cpu.cfs_quota_us'));
  const period = v2 ? Number(v2[1]) : Number(read('/sys/fs/cgroup/cpu/cpu.cfs_period_us'));
  if (quota > 0 && period > 0) cpus = Math.min(cpus, Math.max(1, Math.floor(quota / period)));
  return { cpus, mem };
}

function envMb(name, env) {
  const raw = env?.[name];
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number of megabytes, got ${JSON.stringify(raw)}`);
  return Math.round(n * MB);
}

function envCount(name, env) {
  const raw = env?.[name];
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  return n;
}

function widePixels(pixFmt) {
  return /10|12|16/.test(String(pixFmt || ''));
}

/** Linear between the measured sizes; the same slope outside that range. */
function sampleRssKib(pixels, table) {
  for (const [px, kib] of table) {
    if (px === pixels) return kib;
  }
  const slope = (x0, y0, x1, y1) => (y1 - y0) / (x1 - x0);
  if (pixels <= table[0][0]) {
    const m = slope(table[0][0], table[0][1], table[1][0], table[1][1]);
    return table[0][1] + m * (pixels - table[0][0]);
  }
  for (let i = 1; i < table.length; i++) {
    if (pixels <= table[i][0]) {
      const m = slope(table[i - 1][0], table[i - 1][1], table[i][0], table[i][1]);
      return table[i - 1][1] + m * (pixels - table[i - 1][0]);
    }
  }
  const last = table.length - 1;
  const m = slope(table[last - 1][0], table[last - 1][1], table[last][0], table[last][1]);
  return table[last][1] + m * (pixels - table[last][0]);
}

function rssBytes(kib) {
  return Math.round(kib * 1024 * HEAVY_MARGIN);
}

/**
 * One output encode (hold, yaw pan, or the x264 pass after a pitch pan),
 * from the output frame size. `D360_MEM_HEAVY_MB` replaces the measurement.
 */
export function heavyEncodeBytes(width, height, pixFmt, env = process.env, sourcePixels = 0) {
  const override = envMb('D360_MEM_HEAVY_MB', env);
  if (override != null) return override;
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  const table = widePixels(pixFmt) ? HEAVY_RSS_KIB.wide : HEAVY_RSS_KIB.narrow;
  let bytes = w < 2 || h < 2
    ? rssBytes(table[table.length - 1][1])
    : rssBytes(sampleRssKib(w * h, table));
  // Measured on a 5760×2880 source. An 8K decode is larger by the pixel ratio.
  const ref = 5760 * 2880;
  const src = Number(sourcePixels) || 0;
  if (src > ref) bytes = Math.round(bytes * (src / ref));
  return bytes;
}

/**
 * One pitch-pan ffmpeg, from the output frame size. `D360_MEM_PITCH_MB`
 * replaces the measurement. Sources larger than the measured 3840×1920
 * are scaled up so the reservation stays above the real RSS.
 */
export function pitchPanBytes(width, height, pixFmt, env = process.env, sourcePixels = 0) {
  const override = envMb('D360_MEM_PITCH_MB', env);
  if (override != null) return override;
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  const table = widePixels(pixFmt) ? PITCH_RSS_KIB.wide : PITCH_RSS_KIB.narrow;
  let bytes = w < 2 || h < 2
    ? rssBytes(table[table.length - 1][1])
    : rssBytes(sampleRssKib(w * h, table));
  const src = Number(sourcePixels) || 0;
  if (src > PITCH_SOURCE_PIXELS) bytes = Math.round(bytes * (src / PITCH_SOURCE_PIXELS));
  return bytes;
}

/**
 * Live RSS is close to the budget. Another ffmpeg has to wait until one
 * exits. 10% of the budget is the gap that still counts as approaching it.
 */
export function rssBlocksLaunch(rss, budget) {
  if (!(rss > 0) || !(budget > 0)) return false;
  return rss >= budget * 0.9;
}

/** Per-frame v360 call, in bytes. */
export function lightEncodeBytes(env = process.env) {
  const override = envMb('D360_MEM_LIGHT_MB', env);
  if (override != null) return override;
  return LIGHT_DEFAULT;
}

function concurrentSlots(budget, cost, cap) {
  const fit = cost > 0 ? Math.floor(budget / cost) : 1;
  let n = Math.max(1, fit);
  if (cap != null) n = Math.min(n, cap);
  return Math.max(1, n);
}

/**
 * Memory budget for one render. `D360_MEM_BUDGET_MB`, `D360_MEM_HEAVY_MB`,
 * `D360_MEM_LIGHT_MB`, and `D360_MAX_PARALLEL` replace the computed numbers.
 * `maxParallel` is a hard cap when the env var is unset.
 */
export function ffmpegMemoryPlan({ cpus = 1, mem = 0, width, height, pixFmt, env = process.env, maxParallel = null, sourcePixels = 0 } = {}) {
  const budgetOverride = envMb('D360_MEM_BUDGET_MB', env);
  const budget = budgetOverride != null ? budgetOverride : Math.max(MB, mem - MEM_HEADROOM);
  const heavyOverride = envMb('D360_MEM_HEAVY_MB', env);
  const heavy = heavyEncodeBytes(width, height, pixFmt, env, sourcePixels);
  const pitch = pitchPanBytes(width, height, pixFmt, env, sourcePixels);
  const light = lightEncodeBytes(env);
  const heavyDetail = heavyOverride != null
    ? 'D360_MEM_HEAVY_MB'
    : `${width || 0}x${height || 0} ${pixFmt || 'yuv420p'}, ${HEAVY_MARGIN}× measured RSS`;
  const fromEnv = envCount('D360_MAX_PARALLEL', env);
  const fromArg = Number.isInteger(maxParallel) && maxParallel > 0 ? maxParallel : null;
  const cap = fromEnv ?? fromArg;
  // The per-frame pan pool used to take every light slot that fit in RAM, so
  // an 8-core box and a 16-core box with the same memory both peaked at the
  // same process count. The cap is the core count unless D360_MAX_PARALLEL
  // (or the caller) asks for fewer.
  const cpuCap = Math.max(1, Math.floor(Number(cpus)) || 1);
  const processCap = cap != null ? Math.min(cap, cpuCap) : cpuCap;
  const heavySlots = concurrentSlots(budget, heavy, processCap);
  const lightSlots = concurrentSlots(budget, light, processCap);
  const heavyThreads = Math.max(2, Math.floor(cpus / heavySlots));
  return {
    cpus, mem, budget, heavy, heavyDetail, pitch, light, maxParallel: cap, processCap, heavySlots, lightSlots, heavyThreads,
  };
}

/** Threads for a heavy ffmpeg when at most `slots` of them run at once. */
export function heavyThreadCount(cpus, slots) {
  return Math.max(2, Math.floor((cpus || 1) / Math.max(1, slots)));
}

export function freeDiskBytes(dir) {
  const stat = fs.statfsSync(dir);
  return Number(stat.bavail) * Number(stat.bsize);
}

/**
 * Run `fn(i)` for i in [0, count) in batches of `pool` concurrent calls.
 * The shared limiter is what actually keeps memory inside the budget; the
 * batch only caps how many calls sit in that queue.
 */
async function runPooled(count, pool, fn) {
  const width = Math.max(1, pool || 1);
  for (let i = 0; i < count; i += width) {
    const batch = [];
    for (let k = 0; k < width && i + k < count; k++) batch.push(fn(i + k));
    // Wait for the whole batch. Promise.all would leave the other ffmpeg
    // running after the first failure, and those writes still need the temp dir.
    const settled = await Promise.allSettled(batch);
    const failure = settled.find((r) => r.status === 'rejected' && r.reason?.name !== 'AbortError')
      || settled.find((r) => r.status === 'rejected');
    if (failure) throw failure.reason;
  }
}

/**
 * Shared ffmpeg gate. Each call reserves `costs.heavy` or `costs.light`
 * bytes and starts only when that fits in the remaining budget. The first
 * process always starts, even if its cost is larger than the budget, so a
 * single oversized encode cannot deadlock the queue. `maxParallel` is an
 * optional hard cap on the number of processes.
 */
export function createFfmpegLimiter({ budget, costs, maxParallel = null, signal, exec, measureRss } = {}) {
  const start = exec || ((args) => run(FFMPEG, args, { signal }));
  const readRss = measureRss || (() => 0);
  let used = 0;
  let active = 0;
  let peak = 0;
  const waiters = [];

  function fits(cost) {
    if (active === 0) return true;
    if (maxParallel != null && active >= maxParallel) return false;
    if (rssBlocksLaunch(readRss(), budget)) return false;
    return used + cost <= budget;
  }

  function grant(cost) {
    used += cost;
    active += 1;
    if (active > peak) peak = active;
  }

  function pump() {
    let i = 0;
    while (i < waiters.length) {
      const waiter = waiters[i];
      if (!fits(waiter.cost)) { i += 1; continue; }
      waiters.splice(i, 1);
      signal?.removeEventListener('abort', waiter.onAbort);
      if (signal?.aborted) {
        waiter.reject(stoppedError());
        continue;
      }
      grant(waiter.cost);
      waiter.resolve();
    }
  }

  function acquire(cost) {
    if (signal?.aborted) return Promise.reject(stoppedError());
    if (fits(cost)) {
      grant(cost);
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const waiter = { cost, resolve, reject };
      const onAbort = () => {
        const idx = waiters.indexOf(waiter);
        if (idx !== -1) waiters.splice(idx, 1);
        reject(stoppedError());
      };
      waiter.onAbort = onAbort;
      waiters.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  function release(cost) {
    used = Math.max(0, used - cost);
    active = Math.max(0, active - 1);
    pump();
  }

  return {
    run(args, weight = 'light') {
      const cost = costs[weight] ?? costs.light;
      return acquire(cost).then(() => start(args).finally(() => release(cost)));
    },
    peak() { return peak; },
    active() { return active; },
  };
}

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * An entry's own camera settings (`view`), cleaned: only the parts that are usable, aims in range, the zoom inside the
 * projection's range. Null when nothing is left.
 */
export function sanitizeView(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const view = {};
  const yaw = Number(raw.yaw);
  if (raw.yaw != null && Number.isFinite(yaw)) view.yaw = round2(normalizeAngle(yaw));
  const pitch = Number(raw.pitch);
  if (raw.pitch != null && Number.isFinite(pitch)) view.pitch = round2(Math.min(90, Math.max(-90, pitch)));
  const roll = Number(raw.roll);
  if (raw.roll != null && Number.isFinite(roll)) view.roll = round2(normalizeAngle(roll));
  if (raw.projection != null && FOV_RANGES[raw.projection]) view.projection = raw.projection;
  const fov = Number(raw.fov);
  if (raw.fov != null && Number.isFinite(fov)) {
    const range = FOV_RANGES[view.projection ?? 'flat'];
    // Without its own projection the zoom is held to the widest range that exists; the layout's projection decides at render time.
    view.fov = round2(view.projection ? Math.min(range.max, Math.max(range.min, fov)) : Math.min(300, Math.max(FOV_RANGES.flat.min, fov)));
  }
  if (raw.bulge != null && typeof raw.bulge === 'object') view.bulge = bulgeOf(raw.bulge);
  return Object.keys(view).length ? view : null;
}

/** Drop unusable keyframes and keep a strictly increasing `t`. Empty is allowed. */
export function sanitizeEdl(edl, cameraCount) {
  if (!Array.isArray(edl)) return [];
  const cleaned = [];
  for (const raw of edl) {
    const t = Number(raw?.t);
    const camera = Number(raw?.camera);
    if (!Number.isFinite(t) || t < 0) continue;
    if (!Number.isInteger(camera) || camera < 1) continue;
    if (cameraCount != null && camera > cameraCount) continue;
    const entry = { t, camera };
    const pan = Number(raw?.panSpeed);
    if (Number.isFinite(pan) && pan > 0) {
      entry.panSpeed = pan;
      const curve = sanitizePanCurve(raw?.panCurve);
      if (curve) entry.panCurve = curve;
      const direction = sanitizePanDirection(raw?.panDirection);
      if (direction) entry.panDirection = direction;
      const kind = sanitizePanKind(raw?.panKind);
      if (kind) entry.panKind = kind;
    }
    const view = sanitizeView(raw?.view);
    if (view) entry.view = view;
    cleaned.push(entry);
  }
  cleaned.sort((a, b) => a.t - b.t);
  const out = [];
  for (const e of cleaned) {
    if (out.length && e.t <= out[out.length - 1].t) continue;
    out.push(e);
  }
  return out;
}

/** Cuts stored on the footage `aims` jsonb: `edls[format]`, or legacy `edl`. */
export function edlFromAims(aims, format, cameraCount) {
  const bag = aims && typeof aims === 'object' ? aims : {};
  const byFormat = bag.edls && typeof bag.edls === 'object' ? bag.edls[format] : null;
  return sanitizeEdl(byFormat ?? bag.edl, cameraCount);
}

/** `edl` must already be sorted by `t` — this also catches two entries at the
 * same instant, which planSegments would otherwise turn into a zero-duration
 * hold and silently drop rather than erroring on. */
function validateEdl(edl, cameraCount) {
  if (!Array.isArray(edl) || !edl.length) throw new Error('edl must be a non-empty array of {t, camera} keyframes');
  for (let i = 0; i < edl.length; i++) {
    const e = edl[i];
    if (typeof e.t !== 'number' || e.t < 0) throw new Error(`edl entry has a bad "t": ${JSON.stringify(e)}`);
    if (!Number.isInteger(e.camera) || e.camera < 1 || e.camera > cameraCount) {
      throw new Error(`edl entry references camera ${e.camera}, which is out of range (1-${cameraCount})`);
    }
    if (i > 0 && e.t <= edl[i - 1].t) {
      throw new Error(`edl entries must have strictly increasing "t" — ${edl[i - 1].t} then ${e.t}`);
    }
  }
}

/**
 * Expand a sorted EDL into a gapless list of {type: 'hold'|'pan', start, dur, ...}
 * segments spanning [0, duration).
 */
function aimDistance(yawA, pitchA, yawB, pitchB, rollA = 0, rollB = 0, fovA = FOV_DEFAULT, fovB = FOV_DEFAULT, direction = null) {
  return Math.hypot(Math.abs(panYawDelta(yawA, yawB, direction)), pitchB - pitchA, angularDistance(rollA, rollB), fovB - fovA);
}

/**
 * The last moment up to `t` that the output shows, given the kept `ranges` ({ start, end } in source seconds; null:
 * all of it): `t` itself when the moment just before it is kept, else the end of the last kept range before it (a cut
 * right after a skip). With nothing kept before `t`, `t`.
 */
export function visibleEnd(t, ranges) {
  if (!Array.isArray(ranges) || !ranges.length) return t;
  const eps = 1e-3;
  if (ranges.some((r) => Number(r.start) < t - eps && Number(r.end) >= t - eps)) return t;
  const ends = ranges.map((r) => Number(r.end)).filter((end) => Number.isFinite(end) && end <= t + eps);
  return ends.length ? Math.max(...ends) : t;
}

/**
 * `ranges` (the kept stretches, as the render keeps them) moves a pan into a cut that comes right after a skip: it
 * ends where the skip starts, the last moment the output shows, instead of inside the skip, where the render would
 * drop it and leave a hard cut.
 */
export function planSegments(edl, cameras, pitches, duration, flat = false, rolls = null, fovs = null, { withCameras = false, projections = null, bulges = null, ranges = null } = {}) {
  if (flat) {
    assertFlatEdl(edl);
    if (cameras.length !== 1) throw new Error(`flat render has ${cameras.length} cameras, expected 1`);
    return [{
      type: 'hold', start: 0, dur: duration, yaw: 0, pitch: 0, roll: 0, fov: FOV_DEFAULT, flat: true,
      ...(withCameras ? { camera: 1 } : {}),
    }];
  }
  const segments = [];
  let cursor = 0;
  const rollOf = (index) => (Number.isFinite(rolls?.[index]) ? rolls[index] : 0);
  const projectionAt = (index) => projectionOf(projections?.[index]);
  const fovOf = (index) => (Number.isFinite(fovs?.[index]) ? fovs[index] : FOV_RANGES[projectionAt(index)].default);
  const bulgeAt = (index) => bulgeOf(bulges?.[index]);
  // How an entry's camera is set: the footage's layout for it, with the entry's own `view` laid over.
  const poseOf = (entry) => {
    const index = entry.camera - 1;
    const v = entry.view || {};
    const projection = v.projection ?? projectionAt(index);
    return {
      index,
      yaw: Number.isFinite(v.yaw) ? v.yaw : cameras[index],
      pitch: Number.isFinite(v.pitch) ? v.pitch : (pitches[index] ?? 0),
      roll: Number.isFinite(v.roll) ? v.roll : rollOf(index),
      fov: Number.isFinite(v.fov) ? v.fov : (v.projection ? FOV_RANGES[projection].default : fovOf(index)),
      projection,
      bulge: v.bulge ? bulgeOf(v.bulge) : bulgeAt(index),
    };
  };
  let cur = poseOf(edl[0]);
  for (let i = 1; i <= edl.length; i++) {
    const entry = edl[i]; // undefined on the final pass — that's the trailing hold to `duration`
    const nextT = entry ? entry.t : duration;
    const to = entry ? poseOf(entry) : null;
    // v360's output cannot change while it runs, and pannini has no runtime zoom: those moves are cuts, unless the
    // entry asks for a transition this pair allows. The warp of a bowed frame is fixed too.
    const same = !entry || samePicture(cur, to);
    const kind = same ? null : sanitizePanKind(entry.panKind);
    const allowed = same || (kind && transitionKinds(cur, to).includes(kind));
    const speed = allowed ? (entry?.panSpeed || 0) : 0;
    const panCurve = speed > 0 ? sanitizePanCurve(entry.panCurve) : null;
    const panDirection = speed > 0 ? sanitizePanDirection(entry.panDirection) : null;
    const apart = speed > 0
      ? aimDistance(cur.yaw, cur.pitch, to.yaw, to.pitch, cur.roll, to.roll, cur.fov, to.fov, panDirection)
      : 0;
    // A curve dragged lower is a slower pan, so a longer one; the default curve is 70 / 70 = exactly 1.
    const desiredPan = (apart / (speed || 1)) * (panCurve ? DEFAULT_PAN_MEAN / panCurveMean(panCurve) : 1);
    // A pan can use at most the time since the previous pick — it can eat the
    // whole preceding hold, but never run past its start (which would mean
    // seeking to a negative timestamp). If the requested speed doesn't fit,
    // the pan is shorter than asked for rather than corrupting the timeline.
    // It ends at the last moment the output shows before the cut (the cut itself, or where a skip before it starts).
    const panEnd = entry && speed > 0 ? visibleEnd(nextT, ranges) : nextT;
    const room = Math.max(0, panEnd - cursor);
    const pan = Math.min(desiredPan, room);
    const holdEnd = pan > 0 ? panEnd - pan : nextT;
    if (holdEnd > cursor) {
      segments.push({
        type: 'hold', start: cursor, dur: holdEnd - cursor, yaw: cur.yaw, pitch: cur.pitch, roll: cur.roll, fov: cur.fov, projection: cur.projection,
        ...(hasBulge(cur.bulge) ? { bulge: cur.bulge } : {}),
        ...(withCameras ? { camera: cur.index + 1 } : {}),
      });
    }
    cursor = holdEnd;
    if (entry && pan > 0) {
      segments.push({
        type: 'pan', start: cursor, dur: pan, fromYaw: cur.yaw, toYaw: to.yaw, fromPitch: cur.pitch, toPitch: to.pitch,
        fromRoll: cur.roll, toRoll: to.roll, fromFov: cur.fov, toFov: to.fov, projection: cur.projection,
        ...(hasBulge(cur.bulge) ? { bulge: cur.bulge } : {}),
        ...(panCurve ? { panCurve } : {}),
        ...(panDirection ? { panDirection } : {}),
        ...(kind ? { blend: kind, toProjection: to.projection, ...(hasBulge(to.bulge) ? { toBulge: to.bulge } : {}) } : {}),
        // The pan the speed asked for did not fit before the cut: it is this long instead.
        ...(desiredPan > room + 1e-9 ? { capped: true, desiredSec: desiredPan } : {}),
        ...(withCameras ? { fromCamera: cur.index + 1, toCamera: to.index + 1 } : {}),
      });
      cursor += pan;
    }
    if (entry) cur = to;
  }
  return segments;
}

/**
 * Camera text for each stretch of the output: `{start, end, text}` in output
 * seconds. A hold is "CAM 7 · FRONT" (no lens for flat footage), a pan is
 * "CAM 3 → CAM 7".
 */
export function cameraTimeline({ edl, cameras, pitches, duration, flat = false, rolls = null, fovs = null, projections = null, bulges = null, ranges = null }) {
  const sorted = [...edl].sort((a, b) => a.t - b.t);
  const segments = planSegments(sorted, cameras, pitches, duration, flat, rolls, fovs, { withCameras: true, projections, bulges, ranges });
  return segments.map((seg) => {
    let text;
    if (seg.type === 'pan') {
      text = `CAM ${seg.fromCamera} → CAM ${seg.toCamera}`;
    } else if (flat) {
      text = `CAM ${seg.camera}`;
    } else {
      const rear = isRearAim(seg.yaw ?? cameras[seg.camera - 1], seg.pitch ?? pitches[seg.camera - 1] ?? 0);
      text = `CAM ${seg.camera} · ${rear ? 'BACK' : 'FRONT'}`;
    }
    return { start: seg.start, end: seg.start + seg.dur, text, pan: seg.type === 'pan' };
  });
}

/**
 * Chunk length for one render. At least `D360_CHUNK_MIN_SEC` (default 4),
 * and otherwise the clip divided across two waves of cores, so a long clip
 * produces at least as many chunks as there are cores.
 */
export function chunkMinSeconds(clipDuration, cores, env = process.env) {
  const raw = env?.D360_CHUNK_MIN_SEC;
  let min = 4;
  if (raw != null && raw !== '') {
    min = Number(raw);
    if (!Number.isFinite(min) || min <= 0) {
      throw new Error(`D360_CHUNK_MIN_SEC must be a positive number of seconds, got ${JSON.stringify(raw)}`);
    }
  }
  const n = Math.max(1, Number(cores) || 1);
  const dur = Math.max(0, Number(clipDuration) || 0);
  return Math.max(min, dur / (2 * n));
}

/**
 * Yaw, pitch, roll and fov on the same ease the per-frame pan uses.
 * `unwrapped` does not fold at ±180. Roll takes the short way round like yaw.
 * `extra` carries the other two channels: {fromRoll, toRoll, fromFov, toFov};
 * left out they stay at 0° and the default fov.
 */
export function panPose(fromYaw, toYaw, fromPitch, toPitch, index, panFrames, extra = {}) {
  const denom = Math.max(1, panFrames - 1);
  const p = panFrames <= 1 ? 0 : panProgress(extra.curve, index / denom);
  const delta = panYawDelta(fromYaw, toYaw, extra.direction);
  const unwrapped = fromYaw + delta * p;
  const pitch0 = fromPitch ?? 0;
  const pitch1 = toPitch ?? pitch0;
  const roll0 = extra.fromRoll ?? 0;
  const roll1 = extra.toRoll ?? roll0;
  const fov0 = extra.fromFov ?? FOV_DEFAULT;
  const fov1 = extra.toFov ?? fov0;
  return {
    p,
    unwrapped,
    yaw: normalizeAngle(unwrapped),
    pitch: pitch0 + (pitch1 - pitch0) * p,
    roll: normalizeAngle(roll0 + normalizeAngle(roll1 - roll0) * p),
    fov: fov0 + (fov1 - fov0) * p,
  };
}

/** The roll/fov part of a pan chunk or segment, in the shape `panPose` takes. */
const panExtra = (seg) => ({ fromRoll: seg.fromRoll, toRoll: seg.toRoll, fromFov: seg.fromFov, toFov: seg.toFov, curve: seg.panCurve, direction: seg.panDirection });

/**
 * v360's h_fov/v_fov at `fov` degrees for the output size, and at a pose
 * `p` of the way between two fovs: both ends use `fieldOfView` (so a pan
 * starts and ends exactly on its holds) and the pair moves linearly.
 */
export function panFieldOfView(width, height, fromFov, toFov, p, projection = 'flat', bulge = null) {
  const a = projectedFieldOfView(width, height, fromFov, projection, bulge);
  const b = projectedFieldOfView(width, height, toFov, projection, bulge);
  return { hfov: a.hfov + (b.hfov - a.hfov) * p, vfov: a.vfov + (b.vfov - a.vfov) * p };
}

const SAME = 1e-3;

/**
 * Split any hold or pan longer than `chunkSeconds` into back-to-back frame
 * ranges. Chunks tile the kept `ranges` (`[{ fromFrame, toFrame }]`, the whole
 * video unless the edit is trimmed or has skips) and never cross a range
 * boundary, so a later concat neither repeats nor drops a frame. A pan
 * chunk's `index0` is its first frame inside the pan, which is what the ease
 * is evaluated at; a range that starts inside a pan keeps the pan's own ease.
 * `outFrame` is the chunk's first frame in the output.
 */
export function planChunks(segments, { totalFrames, fps, chunkSeconds, ranges = [{ fromFrame: 0, toFrame: totalFrames }] }) {
  const chunkFrames = Math.max(1, Math.round(chunkSeconds * fps));
  const chunks = [];
  const outBase = [];
  let kept = 0;
  for (const range of ranges) {
    outBase.push(kept);
    kept += range.toFrame - range.fromFrame;
  }
  let frame = 0;
  segments.forEach((seg, segIndex) => {
    const end = segIndex === segments.length - 1
      ? totalFrames
      : Math.min(totalFrames, Math.max(frame + 1, Math.round((seg.start + seg.dur) * fps)));
    const segFrames = Math.max(0, end - frame);
    ranges.forEach((range, rangeIndex) => {
      let offset = Math.max(0, range.fromFrame - frame);
      let left = Math.max(0, Math.min(end, range.toFrame) - frame - offset);
      while (left > 0) {
        const n = Math.min(chunkFrames, left);
        chunks.push({
          type: seg.type,
          yaw: seg.yaw,
          pitch: seg.pitch,
          fromYaw: seg.fromYaw,
          toYaw: seg.toYaw,
          fromPitch: seg.fromPitch,
          toPitch: seg.toPitch,
          roll: seg.roll,
          fov: seg.fov,
          fromRoll: seg.fromRoll,
          toRoll: seg.toRoll,
          fromFov: seg.fromFov,
          toFov: seg.toFov,
          panCurve: seg.panCurve,
          panDirection: seg.panDirection,
          ...(seg.blend ? { blend: seg.blend, toProjection: seg.toProjection, ...(seg.toBulge ? { toBulge: seg.toBulge } : {}) } : {}),
          yawOnly: Boolean(seg.flat) || (seg.type === 'pan' && !seg.blend
            && Math.abs((seg.toPitch ?? 0) - (seg.fromPitch ?? 0)) <= SAME
            && Math.abs(normalizeAngle((seg.toRoll ?? 0) - (seg.fromRoll ?? 0))) <= SAME
            && Math.abs((seg.toFov ?? FOV_DEFAULT) - (seg.fromFov ?? FOV_DEFAULT)) <= SAME),
          flat: Boolean(seg.flat),
          projection: seg.projection,
          ...(seg.bulge ? { bulge: seg.bulge } : {}),
          segIndex,
          index0: offset,
          panFrames: segFrames,
          seekFrame: frame + offset,
          outFrame: outBase[rangeIndex] + frame + offset - range.fromFrame,
          frames: n,
        });
        offset += n;
        left -= n;
      }
    });
    frame = end;
  });
  return chunks;
}

/**
 * The kept frame ranges `[{ fromFrame, toFrame }]` of an edit. `ranges` is
 * `[{ start, end }]` in source seconds, or null for the whole video. Throws
 * when the ranges keep nothing.
 */
export function keptFrameRanges(ranges, fps, totalFrames) {
  if (!ranges) return [{ fromFrame: 0, toFrame: totalFrames }];
  const frames = [];
  for (const range of ranges) {
    const fromFrame = Math.max(0, Math.min(totalFrames, Math.round(Number(range.start) * fps)));
    const toFrame = Math.max(0, Math.min(totalFrames, Math.round(Number(range.end) * fps)));
    if (Number.isFinite(fromFrame) && Number.isFinite(toFrame) && toFrame > fromFrame) frames.push({ fromFrame, toFrame });
  }
  if (!frames.length) throw new Error(`ranges ${JSON.stringify(ranges)} keep no frames of ${totalFrames}`);
  return frames;
}

/**
 * Yaws and pitches the matrix grid and the render both use.
 * A caller-supplied yaw list wins. Otherwise the format grid supplies aims.
 */
export function resolveView({ grid, format, yaws, pitches, rolls, fovs, projections, bulges, pitch = 0, fov = FOV_DEFAULT } = {}) {
  const { rows, cols } = parseGrid(grid || FORMATS[format]?.grid || '3x7');
  const aims = yaws && yaws.length ? null : gridAims(rows, cols, format);
  const cameras = aims ? aims.yaws : yaws;
  const cellPitches = pitches && cameras && pitches.length === cameras.length
    ? pitches
    : (aims ? aims.pitches : (cameras || []).map(() => pitch));
  // A list that does not fit the cameras is not a layout for them: defaults.
  const fit = (list, fallback) => (Array.isArray(list) && cameras && list.length === cameras.length
    ? cameras.map((_, i) => (Number.isFinite(list[i]) ? list[i] : fallback))
    : (cameras || []).map(() => fallback));
  const kinds = (cameras || []).map((_, i) => (Array.isArray(projections) && projections.length === cameras.length ? projectionOf(projections[i]) : 'flat'));
  const fits = Array.isArray(fovs) && cameras && fovs.length === cameras.length;
  return {
    cameras,
    pitches: cellPitches,
    rolls: fit(rolls, 0),
    fovs: (cameras || []).map((_, i) => (fits && Number.isFinite(fovs[i]) ? fovs[i] : (kinds[i] === 'flat' ? fov : FOV_RANGES[kinds[i]].default))),
    projections: kinds,
    bulges: (cameras || []).map((_, i) => (Array.isArray(bulges) && bulges.length === cameras.length ? bulgeOf(bulges[i]) : bulgeOf(null))),
  };
}

/**
 * v360 remap rebuilds per frame of a pan chunk: pitch alone is sent every
 * other frame (0.5), but once roll or fov moves everything that moves is sent
 * on every frame, and a fov change is two commands (h_fov and v_fov).
 */
function rebuildsPerFrame(chunk) {
  const rollMoves = Math.abs(normalizeAngle((chunk.toRoll ?? 0) - (chunk.fromRoll ?? 0))) > SAME;
  const fovMoves = Math.abs((chunk.toFov ?? FOV_DEFAULT) - (chunk.fromFov ?? FOV_DEFAULT)) > SAME;
  const pitchMoves = Math.abs((chunk.toPitch ?? 0) - (chunk.fromPitch ?? 0)) > SAME;
  if (!rollMoves && !fovMoves) return 0.5;
  return (pitchMoves ? 1 : 0) + (rollMoves ? 1 : 0) + (fovMoves ? 2 : 0);
}

/**
 * Work units for one chunk. At 1080p and above, a pitch pan rebuilds the
 * v360 remap often enough to cost about three hold chunks of the same length;
 * a pan that also rolls or zooms rebuilds it more often still, and costs
 * `1 + 4 × rebuilds per frame` (so 3 for pitch alone, 5 for a roll, 9 for a
 * zoom). A 720p roll or zoom pan carries half that surcharge.
 */
export function chunkCost(chunk, { width = 0, height = 0 } = {}) {
  const frames = Number(chunk?.frames) || 0;
  const pixels = (Number(width) || 0) * (Number(height) || 0);
  const pitchPan = chunk?.type === 'pan' && !chunk.yawOnly;
  if (!pitchPan) return frames;
  const rebuilds = rebuildsPerFrame(chunk);
  if (pixels >= 1920 * 1080) return frames * (1 + 4 * rebuilds);
  if (pixels >= 1280 * 720 && rebuilds > 0.5) return frames * (1 + 2 * rebuilds);
  return frames;
}

/**
 * Contiguous chunk-index ranges, one per worker, balanced by estimated cost.
 * Each range is inclusive [from, to]. Fewer chunks than workers means fewer parts.
 */
export function splitChunkRanges(chunks, workerCount, size = {}) {
  const n = chunks.length;
  const workers = Math.max(1, Math.min(Math.trunc(Number(workerCount)) || 1, Math.max(1, n)));
  if (!n) return [];
  if (workers === 1) return [[0, n - 1]];
  const frames = chunks.map((chunk) => chunkCost(chunk, size));
  const total = frames.reduce((sum, count) => sum + count, 0);
  const ranges = [];
  let start = 0;
  let used = 0;
  for (let part = 0; part < workers; part++) {
    const remaining = workers - part;
    if (part === workers - 1) {
      ranges.push([start, n - 1]);
      break;
    }
    const target = (total - used) / remaining;
    const maxEnd = n - remaining;
    let end = start;
    let sum = frames[start];
    while (end < maxEnd) {
      const next = sum + frames[end + 1];
      if (sum >= target) break;
      if (next <= target || Math.abs(next - target) <= Math.abs(sum - target)) {
        end += 1;
        sum = next;
      } else break;
    }
    ranges.push([start, end]);
    used += sum;
    start = end + 1;
  }
  return ranges;
}

/**
 * Whole-clip time split for upload fan-out (stitch + matrix + proxy), not
 * the EDL/chunk-index split above (that one is render-specific, with
 * pitch-pan cost weighting that doesn't apply to a plain time-range split).
 *
 * Boundary `i` snaps to the nearest whole second first, then to the nearest
 * source frame — not a single direct frame-rounding — so every part start
 * lands exactly on a whole second (within half a frame of rounding slop).
 * That's what the matrix's one-keyframe-per-second GOP and a `concat -c
 * copy` join both depend on. Returns `workers` parts tiling [0,
 * totalFrames) with no gap or overlap; fewer whole seconds than `workers`
 * yields fewer, larger parts (never a zero-frame part).
 */
export function splitFrameRange(totalFrames, fps, workers) {
  const n = Math.max(0, Math.trunc(Number(totalFrames)) || 0);
  const rate = Number(fps) > 0 ? Number(fps) : 30;
  if (!n) return [];
  const totalSeconds = n / rate;
  // More parts than whole seconds would force two boundaries onto the same
  // second (or worse, non-whole-second splits) — cap at one part per second.
  const maxWholeSecondParts = Math.max(1, Math.floor(totalSeconds));
  const w = Math.max(1, Math.min(Math.trunc(Number(workers)) || 1, n, maxWholeSecondParts));
  if (w === 1) return [{ startFrame: 0, frames: n }];
  const bounds = [0];
  for (let i = 1; i < w; i++) {
    const atSecond = Math.round((totalSeconds * i) / w);
    const frame = Math.max(bounds[i - 1] + 1, Math.min(n - (w - i), Math.round(atSecond * rate)));
    bounds.push(frame);
  }
  bounds.push(n);
  return bounds.slice(0, -1).map((start, i) => ({ startFrame: start, frames: bounds[i + 1] - start }));
}

/**
 * The matrix output's own frame count for a part, given the part's
 * source-frame range. `fps=matrixFps` resamples to the nearest tick; this
 * computes that same nearest-tick count once, here, so the server (telling
 * the worker what to expect) and the worker (verifying what it produced via
 * `-frames:v`) always agree exactly — never left for ffmpeg to discover on
 * its own. Summing this over every part from `splitFrameRange` equals
 * calling it once over the whole clip (0, totalFrames).
 */
export function matrixFrameCount(startFrame, frames, fps, matrixFps) {
  const rate = Number(fps) > 0 ? Number(fps) : 30;
  const from = Math.round((Number(startFrame) / rate) * matrixFps);
  const to = Math.round(((Number(startFrame) + Number(frames)) / rate) * matrixFps);
  return Math.max(1, to - from);
}

/** Same mark the old full-file pass used: 22% of the width, 3% margin, 60% opacity, bottom-right. */
function watermarkOverlay(width, height, base) {
  const wmW = Math.max(2, Math.round(width * 0.22) & ~1);
  const margin = Math.max(4, Math.round(Math.min(width, height) * 0.03));
  const filter = `[1:v]scale=${wmW}:-1,format=rgba,colorchannelmixer=aa=0.6[wm];`
    + `${base}[wm]overlay=W-w-${margin}:H-h-${margin}`;
  return filter;
}

/**
 * The v360 view of one camera; `fov` (across the long side) only matters to pannini, which crops a larger square.
 * `hfov`/`vfov` come from projectedFieldOfView with the same `bulge`.
 */
function v360Filter(yaw, pitch, hfov, vfov, width, height, { resetRot = false, interp = null, roll = 0, projection = 'flat', fov = FOV_DEFAULT, bulge = null, tag = 'w' } = {}) {
  const rot = resetRot ? ':reset_rot=1' : '';
  const sample = interp ? `:interp=${interp}` : '';
  const tilt = Number(roll) ? Number(roll).toFixed(3) : '0';
  const stage = projectionStage(projection, width, height, fov, bulge, tag);
  return `v360=input=e:output=${stage.output}:yaw=${Number(yaw).toFixed(3)}:pitch=${Number(pitch).toFixed(3)}:roll=${tilt}:h_fov=${+Number(hfov).toFixed(4)}:v_fov=${+Number(vfov).toFixed(4)}:w=${stage.w}:h=${stage.h}${sample}${rot}${stage.post}`;
}

async function renderFlatHold(src, out, { start, srcW, srcH, width, height, preset, crf, threads = 2, watermark = false, overlay = null, frames, num, den, ff = (args) => run(FFMPEG, args) }) {
  const chain = withOverlay(flatFitFilter(srcW, srcH, width, height), overlay);
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-threads', String(threads),
    '-filter_threads', String(threads),
    '-ss', String(start), '-i', src,
  ];
  if (watermark) {
    args.push('-i', WATERMARK, '-filter_complex_threads', String(threads), '-filter_complex', watermarkOverlay(width, height, `[0:v]${chain}[base];[base]`));
  } else {
    args.push('-vf', chain);
  }
  args.push(...x264Args({ threads, preset, crf, num, den, frames }), out);
  await ff(args, 'heavy');
}

async function renderHold(src, out, { start, yaw, pitch, roll = 0, hfov, vfov, projection, fov, bulge = null, width, height, preset, crf, threads = 2, watermark = false, overlay = null, frames, num, den, ff = (args) => run(FFMPEG, args) }) {
  const chain = withOverlay(`${v360Filter(yaw, pitch, hfov, vfov, width, height, { roll, projection, fov, bulge })},setpts=PTS-STARTPTS`, overlay);
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-threads', String(threads),
    '-filter_threads', String(threads),
    '-ss', String(start), '-i', src,
  ];
  if (watermark) {
    args.push('-i', WATERMARK, '-filter_complex_threads', String(threads), '-filter_complex', watermarkOverlay(width, height, `[0:v]${chain}[base];[base]`));
  } else {
    args.push('-vf', chain);
  }
  args.push(...x264Args({ threads, preset, crf, num, den, frames }), out);
  await ff(args, 'heavy');
}

/**
 * Yaw-only pan. Positive yaw is a positive scroll (the equirect moves left,
 * which is the direction v360 looks). Speed is applied after each frame, so
 * the command at frame n is the step from n to n+1 and frame 0 stays put.
 * The fractional pixel accumulates inside scroll and lands on the next
 * integer when it crosses one, so a slow pan does not drift.
 */
async function renderYawPan(src, out, {
  start, frames, index0, panFrames, fromYaw, toYaw, pitch, roll = 0, hfov, vfov, projection, fov, bulge = null, width, height,
  preset, crf, threads = 2, watermark = false, overlay = null, num, den, ff, tmp, chunkIndex, panCurve, panDirection,
}) {
  const extra = { curve: panCurve, direction: panDirection };
  const pose0 = panPose(fromYaw, toYaw, pitch, pitch, index0, panFrames, extra);
  const cmdFile = path.join(tmp, `scroll-${chunkIndex}.cmd`);
  let shift = '';
  if (frames > 1) {
    const lines = [];
    for (let n = 0; n < frames - 1; n++) {
      const a = panPose(fromYaw, toYaw, pitch, pitch, index0 + n, panFrames, extra);
      const b = panPose(fromYaw, toYaw, pitch, pitch, index0 + n + 1, panFrames, extra);
      const step = (b.unwrapped - a.unwrapped) / 360;
      lines.push(`${seekTimestamp(n, num, den)} scroll horizontal ${step.toFixed(8)};`);
    }
    fs.writeFileSync(cmdFile, `${lines.join('\n')}\n`);
    // Native pixel format: a yuv444 detour changes the samples v360 sees.
    // scroll keeps a fractional-pixel accumulator and emits it when it
    // crosses an integer, so the pan does not drift; the picture steps by
    // at most one source pixel.
    shift = `sendcmd=f='${filterPath(cmdFile)}',scroll=horizontal=0:hpos=0,`;
  }
  const chain = withOverlay(`setpts=PTS-STARTPTS,${shift}${v360Filter(pose0.yaw, pose0.pitch, hfov, vfov, width, height, { roll, projection, fov, bulge })},setpts=PTS-STARTPTS`, overlay);
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-threads', String(threads),
    '-filter_threads', String(threads),
    '-ss', String(start), '-i', src,
  ];
  if (watermark) {
    args.push('-i', WATERMARK, '-filter_complex_threads', String(threads), '-filter_complex', watermarkOverlay(width, height, `[0:v]${chain}[base];[base]`));
  } else {
    args.push('-vf', chain);
  }
  args.push(...x264Args({ threads, preset, crf, num, den, frames }), out);
  await ff(args, 'heavy');
}

/**
 * Pitch-, roll- or fov-changing pan: one ffmpeg for the chunk. Yaw uses the
 * same scroll steps as a yaw-only pan (a spin of the equirect is the same
 * for any roll and fov, which sit inside the v360). Pitch, roll and fov are
 * absolute sendcmd values (`reset_rot=1`, so v360 does not accumulate them).
 * v360 rebuilds its remap on every such command. A pitch-only pan sends
 * pitch on every other frame, which halves those rebuilds. Once roll or fov
 * moves too, every frame gets its own pose so the tilt and the zoom are
 * smooth; only the channels that actually move are sent. interp=linear is the
 * cheaper sampler. Output size is the v360 size. The seek is the same
 * half-frame timestamp as a hold.
 */
async function renderPitchPan(src, out, {
  start, frames, index0, panFrames, fromYaw, toYaw, fromPitch, toPitch,
  fromRoll = 0, toRoll = 0, fromFov = FOV_DEFAULT, toFov = FOV_DEFAULT, projection = 'flat', bulge = null,
  width, height, preset, crf, threads = 2, watermark = false, overlay = null,
  num, den, ff, tmp, chunkIndex, panCurve, panDirection,
}) {
  const extra = { fromRoll, toRoll, fromFov, toFov, curve: panCurve, direction: panDirection };
  const pitchMoves = Math.abs((toPitch ?? 0) - (fromPitch ?? 0)) > SAME;
  const rollMoves = Math.abs(normalizeAngle(toRoll - fromRoll)) > SAME;
  const fovMoves = Math.abs(toFov - fromFov) > SAME;
  const everyFrame = rollMoves || fovMoves;
  const poseAt = (n) => panPose(fromYaw, toYaw, fromPitch, toPitch, index0 + n, panFrames, extra);
  const viewAt = (pose) => panFieldOfView(width, height, fromFov, toFov, pose.p, projection, bulge);
  const pose0 = poseAt(0);
  const view0 = viewAt(pose0);
  const cmdFile = path.join(tmp, `pitch-${chunkIndex}.cmd`);
  const lines = [];
  for (let n = 0; n < frames; n++) {
    const pose = poseAt(n);
    const parts = [];
    if (everyFrame || n % 2 === 0 || n === frames - 1) {
      if (pitchMoves) parts.push(`v360 pitch ${pose.pitch.toFixed(6)}`);
      if (rollMoves) parts.push(`v360 roll ${pose.roll.toFixed(6)}`);
      if (fovMoves) {
        const view = viewAt(pose);
        parts.push(`v360 h_fov ${view.hfov.toFixed(6)}`, `v360 v_fov ${view.vfov.toFixed(6)}`);
      }
    }
    if (n < frames - 1) {
      const next = poseAt(n + 1);
      const step = (next.unwrapped - pose.unwrapped) / 360;
      parts.unshift(`scroll horizontal ${step.toFixed(8)}`);
    }
    if (parts.length) lines.push(`${seekTimestamp(n, num, den)} ${parts.join(', ')};`);
  }
  fs.writeFileSync(cmdFile, `${lines.join('\n')}\n`);
  const shift = frames > 1 ? `sendcmd=f='${filterPath(cmdFile)}',scroll=horizontal=0:hpos=0,` : `sendcmd=f='${filterPath(cmdFile)}',`;
  const chain = withOverlay(`setpts=PTS-STARTPTS,${shift}${v360Filter(pose0.yaw, pose0.pitch, view0.hfov, view0.vfov, width, height, { resetRot: true, interp: 'linear', roll: pose0.roll, projection, fov: fromFov, bulge })},setpts=PTS-STARTPTS`, overlay);
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-threads', String(threads),
    '-filter_threads', String(threads),
    '-ss', String(start), '-i', src,
  ];
  if (watermark) {
    args.push('-i', WATERMARK, '-filter_complex_threads', String(threads), '-filter_complex', watermarkOverlay(width, height, `[0:v]${chain}[base];[base]`));
  } else {
    args.push('-vf', chain);
  }
  args.push(...x264Args({ threads, preset, crf, num, den, frames }), out);
  await ff(args, 'pitch');
}

/**
 * A transition between two pictures (`blend` or `planet`, see planSegments): one ffmpeg that draws the chunk twice,
 * each picture by its own v360 on the same per-frame aim (`angles`, absolute, so stabilized chunks use it too), and
 * mixes them frame by frame. `fovs` is each picture's fov per frame ({from, to}, see transitionFovs), `weights` how much
 * of the new picture each frame shows.
 */
export function transitionCommands(angles, fovs, weights, { num, den, width, height, from, to }) {
  const lines = [];
  for (let n = 0; n < angles.length; n++) {
    const a = angles[n];
    const parts = [];
    for (const [tag, pic, side] of [['a', from, 'from'], ['b', to, 'to']]) {
      parts.push(`v360@${tag} yaw ${a.yaw.toFixed(4)}`, `v360@${tag} pitch ${a.pitch.toFixed(4)}`, `v360@${tag} roll ${a.roll.toFixed(4)}`);
      if (projectionOf(pic.projection) !== 'pannini') {
        const view = projectedFieldOfView(width, height, fovs[n][side], pic.projection, pic.bulge);
        parts.push(`v360@${tag} h_fov ${view.hfov.toFixed(4)}`, `v360@${tag} v_fov ${view.vfov.toFixed(4)}`);
      }
    }
    parts.push(`blend@m all_opacity ${(1 - weights[n]).toFixed(4)}`);
    lines.push(`${seekTimestamp(n, num, den)} ${parts.join(', ')};`);
  }
  return `${lines.join('\n')}\n`;
}

async function renderTransition(src, out, {
  start, frames, angles, fovs, weights, from, to, width, height, preset, crf, threads = 2, watermark = false, overlay = null,
  num, den, ff, tmp, chunkIndex,
}) {
  const cmdFile = path.join(tmp, `blend-${chunkIndex}.cmd`);
  fs.writeFileSync(cmdFile, transitionCommands(angles, fovs, weights, { num, den, width, height, from, to }));
  const a0 = angles[0];
  const picture = (tag, pic, side) => {
    const fov = fovs[0][side];
    const view = projectedFieldOfView(width, height, fov, pic.projection, pic.bulge);
    return v360Filter(a0.yaw, a0.pitch, view.hfov, view.vfov, width, height, { resetRot: true, interp: 'linear', roll: a0.roll, projection: pic.projection, fov, bulge: pic.bulge, tag })
      .replace(/^v360=/, `v360@${tag}=`);
  };
  const graph = `[0:v]setpts=PTS-STARTPTS,sendcmd=f='${filterPath(cmdFile)}',split=2[ta][tb];`
    + `[ta]${picture('a', from, 'from')}[pa];[tb]${picture('b', to, 'to')}[pb];`
    + `[pa][pb]blend@m=all_mode=normal:all_opacity=${(1 - weights[0]).toFixed(4)}`;
  const chain = withOverlay(`${graph},setpts=PTS-STARTPTS`, overlay);
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-threads', String(threads),
    '-filter_threads', String(threads),
    '-ss', String(start), '-i', src,
    '-filter_complex_threads', String(threads),
  ];
  if (watermark) {
    args.push('-i', WATERMARK, '-filter_complex', watermarkOverlay(width, height, `${chain}[base];[base]`));
  } else {
    args.push('-filter_complex', chain);
  }
  args.push(...x264Args({ threads, preset, crf, num, den, frames }), out);
  await ff(args, 'pitch');
}

/**
 * Stabilized chunk (hold, cut or pan): one ffmpeg, per-frame v360. `angles` is
 * this chunk's slice of the correction composed with the aim, one {yaw, pitch,
 * roll} per output frame. They are absolute (`reset_rot=1`), so the chunk
 * needs no horizontal-shift shortcut and every part can start anywhere.
 * `rotStep` > 1 sends a new rotation every Nth frame.
 */
export function stabilizedCommands(angles, { num, den, rotStep = 1, target = 'v360@s', views = null }) {
  const lines = [];
  for (let n = 0; n < angles.length; n++) {
    if (n % rotStep !== 0) continue;
    const a = angles[n];
    // `views` is one {hfov, vfov} per frame, only given when the zoom moves.
    const zoom = views ? `, ${target} h_fov ${views[n].hfov.toFixed(4)}, ${target} v_fov ${views[n].vfov.toFixed(4)}` : '';
    lines.push(`${seekTimestamp(n, num, den)} ${target} yaw ${a.yaw.toFixed(4)}, ${target} pitch ${a.pitch.toFixed(4)}, ${target} roll ${a.roll.toFixed(4)}${zoom};`);
  }
  return `${lines.join('\n')}\n`;
}

async function renderStabilized(src, out, {
  start, frames, angles, hfov, vfov, views = null, projection = 'flat', fov = FOV_DEFAULT, bulge = null, width, height, preset, crf, threads = 2, watermark = false, overlay = null,
  num, den, ff, tmp, chunkIndex, rotStep = 1,
}) {
  const cmdFile = path.join(tmp, `stab-${chunkIndex}.cmd`);
  fs.writeFileSync(cmdFile, stabilizedCommands(angles, { num, den, rotStep, views }));
  const a0 = angles[0];
  if (views) ({ hfov, vfov } = views[0]);
  const stage = projectionStage(projection, width, height, fov, bulge);
  const v360 = `v360@s=input=e:output=${stage.output}:yaw=${a0.yaw.toFixed(4)}:pitch=${a0.pitch.toFixed(4)}:roll=${a0.roll.toFixed(4)}:h_fov=${hfov}:v_fov=${vfov}:w=${stage.w}:h=${stage.h}:reset_rot=1${stage.post}`;
  const chain = withOverlay(`setpts=PTS-STARTPTS,sendcmd=f='${filterPath(cmdFile)}',${v360},setpts=PTS-STARTPTS`, overlay);
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-threads', String(threads),
    '-filter_threads', String(threads),
    '-ss', String(start), '-i', src,
  ];
  if (watermark) {
    args.push('-i', WATERMARK, '-filter_complex_threads', String(threads), '-filter_complex', watermarkOverlay(width, height, `[0:v]${chain}[base];[base]`));
  } else {
    args.push('-vf', chain);
  }
  args.push(...x264Args({ threads, preset, crf, num, den, frames }), out);
  await ff(args, 'pitch');
}

/**
 * Preview pan: two speedups over `renderPan`, both aimed at the same bottleneck
 * (repeated expensive seeks into the big source).
 *  1. Decode+downscale the pan's own time window ONCE into a small proxy —
 *     every subsequent seek is against that (cheap), not the source (slow).
 *  2. Only render `sampleCount` distinct angles (not one per output frame),
 *     then repeat each rendered frame to fill out the full native frame
 *     count. The output frame rate and frame count still match the hold
 *     segments, so the concat time base does not change. This only skips
 *     angles nobody will tell apart at preview size.
 */
async function renderPanPreview(src, out, {
  start, fromYaw, toYaw, fromPitch, toPitch, pitch = 0, roll = 0, hfov, vfov, projection, fov, bulge = null, width, height,
  num, den, tmp, preset, crf, sampleFps, parallel, direct = false,
  frames, index0 = 0, panFrames, seekFrame = 0, seekOrigin = 0, ff = (args) => run(FFMPEG, args), disk, panCurve, panDirection,
}) {
  fromPitch = fromPitch ?? pitch;
  toPitch = toPitch ?? pitch;
  const outputFrames = frames;
  const parentFrames = panFrames ?? outputFrames;
  const chunkDur = outputFrames * (den || 1) / num;
  // The stored 2K proxy is already small enough to seek. A full source still
  // gets a per-pan window so those seeks don't land in the original file.
  let input = src;
  let framesDir;
  const proxy = !direct;
  try {
    if (proxy) {
      input = path.join(tmp, `${path.basename(out)}.proxy.mp4`);
      await ff([
        '-hide_banner', '-loglevel', 'error', '-y',
        '-threads', '2', '-filter_threads', '2',
        '-ss', String(start), '-i', src,
        '-frames:v', String(outputFrames),
        '-vf', 'scale=960:-2',
        '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p',
        input,
      ]);
      disk?.note();
    }

    let sampleCount = Math.round(chunkDur * sampleFps);
    sampleCount = Math.max(outputFrames >= 2 ? 2 : 1, sampleCount);
    sampleCount = Math.min(outputFrames, sampleCount);
    framesDir = fs.mkdtempSync(path.join(tmp, 'pan-'));

    const samples = Array.from({ length: sampleCount }, (_, i) => path.join(framesDir, `s${String(i).padStart(4, '0')}.png`));
    const denom = Math.max(1, parentFrames - 1);
    await runPooled(sampleCount, parallel, (i) => {
      const along = sampleCount <= 1 ? 0 : Math.round((i * (outputFrames - 1)) / (sampleCount - 1));
      const global = index0 + along;
      const p = parentFrames <= 1 ? 0 : panProgress(panCurve, global / denom);
      const yaw = normalizeAngle(fromYaw + panYawDelta(fromYaw, toYaw, panDirection) * p);
      const framePitch = fromPitch + (toPitch - fromPitch) * p;
      const t = direct ? seekTimestamp(seekFrame + along, num, den, seekOrigin) : seekTimestamp(along, num, den);
      return ff([
        '-hide_banner', '-loglevel', 'error', '-y', '-threads', '1', '-filter_threads', '1',
        '-ss', t, '-i', input, '-frames:v', '1',
        '-vf', v360Filter(yaw, framePitch, hfov, vfov, width, height, { roll, projection, fov, bulge }),
        samples[i],
      ]);
    });
    if (proxy) {
      disk?.note();
      fs.rmSync(input, { force: true });
    }
    for (let i = 0; i < outputFrames; i++) {
      const sampleIdx = Math.min(sampleCount - 1, Math.floor((i / outputFrames) * sampleCount));
      fs.copyFileSync(samples[sampleIdx], path.join(framesDir, `f${String(i).padStart(6, '0')}.png`));
    }
    await ff([
      '-hide_banner', '-loglevel', 'error', '-y',
      '-framerate', rateArg(num, den), '-i', path.join(framesDir, 'f%06d.png'),
      ...x264Args({ threads: 2, preset, crf, num, den, frames: outputFrames }),
      out,
    ], 'heavy');
    disk?.note();
  } finally {
    if (proxy && input !== src) fs.rmSync(input, { force: true });
    if (framesDir) fs.rmSync(framesDir, { recursive: true, force: true });
  }
}

/**
 * Render `src` through the EDL. Returns {file, cameras, segments}.
 */
export async function renderFromEdl(src, out, edl, {
  grid,
  format = 'youtube',
  yaws,
  pitches,
  rolls,
  fovs,
  projections,
  bulges,
  pitch = 0,
  fov = 100,
  width,
  height,
  preview = false,
  resolution,
  watermark,
  previewSampleFps = 4,
  proxySource = false,
  parallel = null,
  onSegment,
  signal: externalSignal,
  log,
  chunkRange = null,
  chunkSeconds = null,
  expectedChunks = null,
  expectedFrames = null,
  includeAudio = true,
  audioOut = null,
  mode = null,
  trace = null,
  stabilization = null,
  overlay = null,
  metadata = null,
  ranges = null,
} = {}) {
  // A requested overlay is never dropped: without libass the render fails.
  const burnOverlay = !preview && overlay?.assFile ? overlay : null;
  if (burnOverlay) await assertOverlayAvailable();
  const size = outputSize(format, { preview, resolution });
  width ??= size.width;
  height ??= size.height;
  // Final encodes only. Preview stays ultrafast / CRF 30. Defaults stay
  // medium / 18 until a size-and-time comparison says otherwise.
  const preset = preview ? 'ultrafast' : (process.env.D360_RENDER_PRESET || 'medium');
  const crf = preview ? 30 : finalCrf(process.env.D360_RENDER_CRF);
  // Preview never watermarks. Finals stamp only when the plan says so.
  const applyWatermark = preview ? false : watermark === true;
  if (mode !== null && mode !== '360' && mode !== 'flat') throw new Error(`unknown render mode "${mode}"`);
  const flat = mode === 'flat';
  const view = flat
    ? { cameras: [0], pitches: [0], rolls: [0], fovs: [fov], projections: ['flat'], bulges: [bulgeOf(null)] }
    : resolveView({ grid, format, yaws, pitches, rolls, fovs, projections, bulges, pitch, fov });
  const cameras = view.cameras;
  const cellPitches = view.pitches;
  const sorted = [...edl].sort((a, b) => a.t - b.t);
  validateEdl(sorted, cameras.length);

  const info = await probe(src);
  const videoStream = info.streams.find((s) => s.codec_type === 'video');
  if (!videoStream) throw new Error(`${src} has no video stream`);
  const timing = videoTiming(videoStream);
  const { num, den, frames: totalFrames, duration } = timing;
  const seekOrigin = seekOriginSec(videoStream, info.format);
  const pixFmt = videoStream.pix_fmt || 'yuv420p';
  const audioStream = info.streams.find((s) => s.codec_type === 'audio');
  const noteArgs = (args) => { if (trace) trace.push(args); };

  const segments = planSegments(sorted, cameras, cellPitches, duration, flat, view.rolls, view.fovs, { projections: view.projections, bulges: view.bulges, ranges });

  const limits = containerLimits();
  // A bowed camera's v360 draws a larger view: budget each ffmpeg for that size.
  const drawn = segments.reduce((most, seg) => {
    if (!seg.bulge) return most;
    const reach = bulgeReach(seg.bulge);
    return Math.max(most, BULGE_SUPERSAMPLE * BULGE_SUPERSAMPLE * reach.x * reach.y);
  }, 1);
  const plan = ffmpegMemoryPlan({
    cpus: limits.cpus,
    mem: limits.mem,
    width: Math.round(width * Math.sqrt(drawn)),
    height: Math.round(height * Math.sqrt(drawn)),
    pixFmt,
    maxParallel: parallel,
    sourcePixels: Number(videoStream.width) * Number(videoStream.height),
  });
  const frameRanges = keptFrameRanges(ranges, num / (den || 1), totalFrames);
  const keptFrames = frameRanges.reduce((sum, r) => sum + r.toFrame - r.fromFrame, 0);
  const keptDuration = ranges ? keptFrames * (den || 1) / num : duration;
  const chunkSec = chunkSeconds > 0 ? chunkSeconds : chunkMinSeconds(keptDuration, plan.cpus);
  const allChunks = planChunks(segments, { totalFrames, fps: num / (den || 1), chunkSeconds: chunkSec, ranges: frameRanges });
  if (expectedChunks != null && allChunks.length !== Number(expectedChunks)) {
    throw new Error(`chunk count ${allChunks.length} does not match expected ${expectedChunks}`);
  }
  if (expectedFrames != null && totalFrames !== Number(expectedFrames)) {
    throw new Error(`frame count ${totalFrames} does not match expected ${expectedFrames}`);
  }
  let rangeFrom = 0;
  let rangeTo = allChunks.length - 1;
  if (chunkRange) {
    rangeFrom = Math.trunc(Number(chunkRange[0]));
    rangeTo = Math.trunc(Number(chunkRange[1]));
    if (!Number.isInteger(rangeFrom) || !Number.isInteger(rangeTo) || rangeFrom < 0 || rangeTo >= allChunks.length || rangeFrom > rangeTo) {
      throw new Error(`chunk_range [${chunkRange}] is outside 0..${allChunks.length - 1}`);
    }
  }
  const partRender = Boolean(chunkRange);
  const withAudio = Boolean(audioStream) && includeAudio !== false && (!partRender || includeAudio === true);
  const chunks = allChunks.slice(rangeFrom, rangeTo + 1);
  const gb = (n) => (n / GI).toFixed(2);
  log?.(`${plan.cpus} cpus, ${gb(plan.mem)} GB memory, budget ${gb(plan.budget)} GB, heavy ${gb(plan.heavy)} GB (${plan.heavyDetail}) → ${plan.heavySlots} ffmpeg, light ${gb(plan.light)} GB`);
  log?.(`chunk length ${chunkSec.toFixed(2)}s, ${chunks.length} chunks across ${segments.length} segments`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'd360-edl-'));
  const files = new Array(chunks.length);
  let completed = 0;
  let peak = 0;
  const watch = startDiskWatch(tmp);
  const disk = { note: watch.note };

  if (stabilization) {
    if (stabilization.corrections.length !== totalFrames) {
      log?.(`stabilization: ${stabilization.corrections.length} orientation frames vs ${totalFrames} video frames (last value is held past the end)`);
    }
  }
  const pitchChunks = stabilization ? chunks.length > 0 : chunks.some((seg) => seg.type === 'pan' && !seg.yawOnly);
  if (pitchChunks) log?.(`pitch-pan per process ${gb(plan.pitch)} GB`);
  // The chunk pass and the concat that follows share this. A retry replaces
  // it. The external cancel stays wired until concat has finished.
  let encodePass = null;
  // AAC for the whole edit, started now so it overlaps the chunks. The join
  // then stream-copies it. Aborting a chunk pass does not cancel this.
  let audioAbort = null;
  let audioFile = null;
  let audioError = null;
  let audioDone = null;
  let audioLive = false;
  let audioMs = 0;
  if (withAudio) {
    audioAbort = new AbortController();
    if (externalSignal?.aborted) audioAbort.abort();
    else externalSignal?.addEventListener('abort', () => audioAbort.abort(), { once: true });
    audioFile = path.join(tmp, 'audio.m4a');
    const audioStarted = Date.now();
    audioLive = true;
    const audioCuts = frameRanges.length > 1
      ? frameRanges.map((r) => ({ start: (r.fromFrame * (den || 1)) / num, end: (r.toFrame * (den || 1)) / num }))
      : null;
    const audioArgs = audioExtractArgs({
      src,
      out: audioFile,
      offsetSec: audioOffsetSec(videoStream, audioStream) - (audioCuts ? 0 : (frameRanges[0].fromFrame * (den || 1)) / num),
      duration: keptDuration,
      copy: false,
      cuts: audioCuts,
    });
    noteArgs(audioArgs);
    audioDone = run(FFMPEG, audioArgs, { signal: audioAbort.signal }).then(() => {
      audioLive = false;
      audioMs = Date.now() - audioStarted;
      log?.(`audio encode in ${((Date.now() - audioStarted) / 1000).toFixed(1)}s`);
    }).catch((err) => {
      audioLive = false;
      audioError = err;
    });
  }

  async function renderOne(seg, i, ff, threads) {
    const file = path.join(tmp, `seg-${String(i).padStart(3, '0')}.mp4`);
    const started = Date.now();
    const seek = seekTimestamp(seg.seekFrame, num, den, seekOrigin);
    const shared = {
      start: seek,
      seekFrame: seg.seekFrame,
      seekOrigin,
      frames: seg.frames,
      index0: seg.index0,
      panFrames: seg.panFrames,
      num,
      den,
      ...projectedFieldOfView(width, height, seg.type === 'hold' ? seg.fov : seg.fromFov, seg.projection, seg.bulge),
      projection: seg.projection,
      bulge: seg.bulge ?? null,
      fov: seg.type === 'hold' ? seg.fov : seg.fromFov,
      panCurve: seg.panCurve,
      panDirection: seg.panDirection,
      width,
      height,
      preset,
      crf,
      threads,
      watermark: applyWatermark,
      // The ASS file covers this part; a chunk starts that far into it.
      overlay: burnOverlay
        ? { ...burnOverlay, offsetSec: ((seg.outFrame - chunks[0].outFrame) * (den || 1)) / num }
        : null,
      ff,
    };
    if (seg.blend) {
      const pose = (n) => panPose(seg.fromYaw, seg.toYaw, seg.fromPitch ?? 0, seg.toPitch ?? seg.fromPitch ?? 0, seg.index0 + n, seg.panFrames, panExtra(seg));
      const poses = Array.from({ length: seg.frames }, (_, n) => pose(n));
      const corr = stabilization?.corrections;
      const angles = corr
        ? viewAngles(Array.from({ length: seg.frames }, (_, n) => corr[Math.min(corr.length - 1, seg.seekFrame + n)]), (n) => poses[n])
        : poses.map((p) => ({ yaw: p.yaw, pitch: p.pitch, roll: p.roll }));
      await renderTransition(src, file, {
        ...shared,
        angles,
        fovs: poses.map((p) => transitionFovs({ projection: seg.projection, fov: seg.fromFov ?? FOV_DEFAULT }, { projection: seg.toProjection, fov: seg.toFov ?? FOV_DEFAULT }, p.p)),
        weights: poses.map((p) => transitionWeight(seg.blend, seg.projection, p.p)),
        from: { projection: seg.projection, fov: seg.fromFov ?? FOV_DEFAULT, bulge: seg.bulge ?? null },
        to: { projection: seg.toProjection, fov: seg.toFov ?? FOV_DEFAULT, bulge: seg.toBulge ?? null },
        tmp,
        chunkIndex: i,
      });
    } else if (stabilization && !seg.flat) {
      const pose = (n) => panPose(seg.fromYaw, seg.toYaw, seg.fromPitch ?? 0, seg.toPitch ?? seg.fromPitch ?? 0, seg.index0 + n, seg.panFrames, panExtra(seg));
      const aimAt = seg.type === 'hold'
        ? () => ({ yaw: seg.yaw, pitch: seg.pitch, roll: seg.roll })
        : pose;
      const zoomMoves = seg.type === 'pan' && Math.abs((seg.toFov ?? FOV_DEFAULT) - (seg.fromFov ?? FOV_DEFAULT)) > SAME;
      const corr = stabilization.corrections;
      const slice = Array.from({ length: seg.frames }, (_, n) => corr[Math.min(corr.length - 1, seg.seekFrame + n)]);
      await renderStabilized(src, file, {
        ...shared,
        angles: viewAngles(slice, aimAt),
        views: zoomMoves
          ? Array.from({ length: seg.frames }, (_, n) => panFieldOfView(width, height, seg.fromFov, seg.toFov, pose(n).p, seg.projection, seg.bulge))
          : null,
        rotStep: zoomMoves ? 1 : (stabilization.rotStep || 1),
        tmp,
        chunkIndex: i,
      });
    } else if (seg.flat && seg.type === 'hold') {
      await renderFlatHold(src, file, { ...shared, srcW: videoStream.width, srcH: videoStream.height });
    } else if (seg.type === 'hold') {
      await renderHold(src, file, { ...shared, yaw: seg.yaw, pitch: seg.pitch, roll: seg.roll });
    } else if (seg.yawOnly && !preview) {
      await renderYawPan(src, file, {
        ...shared,
        fromYaw: seg.fromYaw,
        toYaw: seg.toYaw,
        pitch: seg.fromPitch ?? 0,
        roll: seg.fromRoll ?? 0,
        tmp,
        chunkIndex: i,
      });
    } else if (seg.yawOnly && preview) {
      await renderPanPreview(src, file, {
        ...shared,
        fromYaw: seg.fromYaw,
        toYaw: seg.toYaw,
        fromPitch: seg.fromPitch,
        toPitch: seg.toPitch,
        roll: seg.fromRoll ?? 0,
        tmp,
        sampleFps: previewSampleFps,
        parallel: plan.lightSlots,
        direct: proxySource,
        disk,
      });
    } else {
      await renderPitchPan(src, file, {
        ...shared,
        fromYaw: seg.fromYaw,
        toYaw: seg.toYaw,
        fromPitch: seg.fromPitch ?? 0,
        toPitch: seg.toPitch ?? 0,
        fromRoll: seg.fromRoll ?? 0,
        toRoll: seg.toRoll ?? 0,
        fromFov: seg.fromFov ?? FOV_DEFAULT,
        toFov: seg.toFov ?? FOV_DEFAULT,
        tmp,
        chunkIndex: i,
      });
    }
    files[i] = file;
    completed += 1;
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const kind = seg.blend ? `${seg.blend}${stabilization ? ' stab' : ''}` : stabilization && !seg.flat ? `${seg.type} stab` : seg.flat ? 'hold fit' : (seg.type === 'pan' ? (seg.yawOnly ? 'pan yaw' : 'pan pitch') : seg.type);
    const absolute = rangeFrom + i;
    log?.(`chunk ${absolute + 1}/${allChunks.length} ${kind} ${seg.frames}f in ${seconds}s`);
    onSegment?.(seg, i, chunks.length, completed);
  }

  async function runPass(maxParallel) {
    // Halve heavySlots on an out-of-memory retry. That is the memory-budget
    // slot count, not the raw core cap.
    await runChunkPass({
      signal: externalSignal,
      releasePrevious: () => encodePass?.release(),
      onPass: (pass) => { encodePass = pass; },
      slotCount: plan.heavySlots,
      maxParallel,
      audioLive: () => audioLive,
      onPeak: (n) => { peak = Math.max(peak, n); },
      items: chunks,
      done: files,
      openLimiter: (slots, pass) => createFfmpegLimiter({
        budget: plan.budget,
        costs: { heavy: plan.heavy, light: plan.light, pitch: plan.pitch },
        maxParallel: slots,
        signal: pass.signal,
        measureRss: ffmpegRssBytes,
        exec: (args) => {
          noteArgs(args);
          if (flat && args.some((arg) => String(arg).includes('v360'))) {
            throw new Error('flat render must not use v360');
          }
          return run(FFMPEG, args, { signal: pass.signal });
        },
      }),
      runOne: async ({ item, index, slots, limiter }) => {
        const threads = heavyThreadCount(plan.cpus, slots);
        await retryChunk(() => renderOne(item, index, limiter.run.bind(limiter), threads), log);
      },
    });
  }

  try {
    await withOomRetry({ slots: plan.heavySlots, log, run: runPass });

    const listFile = path.join(tmp, 'list.txt');
    fs.writeFileSync(listFile, files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n') + '\n');
    fs.mkdirSync(path.dirname(out), { recursive: true });

    if (withAudio) {
      const step = Date.now();
      await audioDone;
      const waited = (Date.now() - step) / 1000;
      if (audioError) throw audioError;
      if (waited >= 0.05) log?.(`waited ${waited.toFixed(1)}s for audio`);
    }
    let step = Date.now();
    peak = Math.max(peak, 1);
    const muxAudio = partRender ? null : audioFile;
    const concatArgs = concatFaststartArgs({ listFile, audioFile: muxAudio, out, metadata: partRender || preview ? null : metadata });
    noteArgs(concatArgs);
    await run(FFMPEG, concatArgs, { signal: encodePass?.signal });
    encodePass?.release();
    encodePass = null;
    const concatMs = Date.now() - step;
    log?.(`concat + faststart in ${(concatMs / 1000).toFixed(1)}s`);
    step = Date.now();
    const partFrames = chunks.reduce((sum, chunk) => sum + chunk.frames, 0);
    const expectFrames = partRender ? partFrames : keptFrames;
    const expectDuration = partRender ? partFrames * (den || 1) / num : keptDuration;
    await assertOutputVideo(out, {
      frames: expectFrames,
      duration: expectDuration,
      fps: num / (den || 1),
      chunks: chunks.length,
      what: partRender ? 'render part' : 'render',
      durationName: partRender ? 'part duration' : 'edit duration',
    });
    log?.(`frame check in ${((Date.now() - step) / 1000).toFixed(1)}s`);
    if (audioOut && audioFile && fs.existsSync(audioFile)) fs.copyFileSync(audioFile, audioOut);
    watch.note();
    for (const file of files) fs.rmSync(file, { force: true });
    fs.rmSync(listFile, { force: true });

    return {
      file: out,
      cameras,
      segments,
      chunkSeconds: chunkSec,
      chunks: allChunks.length,
      partChunks: chunks.length,
      frames: expectFrames,
      totalFrames,
      chunkRange: [rangeFrom, rangeTo],
      peak,
      peakDisk: watch.peakDisk,
      peakMem: watch.peakMem,
      audioMs,
      concatMs,
    };
  } finally {
    encodePass?.release();
    watch.stop();
    audioAbort?.abort();
    await audioDone;
    log?.(`peak concurrent ffmpeg: ${peak}`);
    if (watch.peakMem) log?.(`peak memory ${(watch.peakMem / GI).toFixed(2)} GB`);
    log?.(`peak disk ${(watch.peakDisk / GI).toFixed(2)} GB`);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * A part built with -copyts keeps its place in the clip as its start time, and
 * concat can turn that into a gap. Copies such a part to start at zero; a part
 * that already does is returned as it is. Also gives the part's length from
 * its frames at `fps`, or null when it does not say how many it has.
 */
async function zeroStartPart(file, dir, index, fps, signal) {
  const info = await probe(file);
  const video = info.streams?.find((stream) => stream.codec_type === 'video');
  const counted = Number(video?.nb_frames);
  const seconds = Number.isInteger(counted) && counted > 0 && fps > 0 ? counted / fps : null;
  const start = Number(video?.start_time ?? info.format?.start_time);
  if (!(Math.abs(start) > 0.001)) return { file, seconds };
  const zeroed = path.join(dir, `part-${index}.mp4`);
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-map', '0:v:0', '-c', 'copy', zeroed], { signal });
  return { file: zeroed, seconds };
}

/**
 * Stream-copy part files, mux audio once, faststart, and check the edit. Each
 * part's length goes in the concat list: left to the container's own figure,
 * a part a little over its frames pushes every later part late. A failed check
 * is `finalCheck`: the same parts would fail it again.
 */
export async function joinRenderParts(partFiles, out, { audioFile = null, frames, duration, fps, chunks = 0, signal, log, metadata = null } = {}) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = fs.mkdtempSync(path.join(path.dirname(out), '.d360-join-'));
  const started = Date.now();
  try {
    const listFile = path.join(tmp, 'list.txt');
    const parts = await Promise.all(partFiles.map((file, index) => zeroStartPart(file, tmp, index, fps, signal)));
    fs.writeFileSync(listFile, parts.map(({ file, seconds }) => `file '${file.replace(/'/g, "'\\''")}'${seconds ? `\nduration ${seconds.toFixed(6)}` : ''}`).join('\n') + '\n');
    await run(FFMPEG, concatFaststartArgs({ listFile, audioFile, out, metadata }), { signal });
    await assertOutputVideo(out, { frames, duration, fps, chunks, what: 'joined render', durationName: 'edit duration' }).catch((e) => {
      e.finalCheck = true;
      throw e;
    });
    log?.(`join in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    return { file: out, frames };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
