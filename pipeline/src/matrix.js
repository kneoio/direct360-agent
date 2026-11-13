/**
 * "Camera matrix" — reproject one equirectangular clip through N fixed
 * virtual-camera angles at once, tiled into a single grid video with each
 * cell numbered. It's a POC scouting tool: instead of guessing one yaw for
 * `reframe`, watch every candidate angle simultaneously and see which ones
 * are actually worth using (and which sit on the dual-fisheye stitch seam —
 * see README's "Stitch seams" note under reframe).
 *
 * A later, separate tool is meant to let someone scrub this grid's timeline
 * and record which camera number should be "live" at each moment — that
 * recording (an edit decision list) is what would drive a real cut. This
 * module only builds the grid; it doesn't consume or produce an EDL.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, FFMPEG, probe } from './encoder.js';
import { containerLimits } from './edl.js';
import { sendcmdScript, viewAngles } from './stabilize.js';
import { filterPath } from './overlayFilter.js';
import { videoTiming, seekTimestamp, seekOriginSec, reconnectArgs } from './ffmpegTools.js';
import { FORMATS, getFormat, ROLL_LIMIT, FOV_RANGES, BULGE_SIDES, bulgeOf, hasBulge, clampFov, projectedFieldOfView, projectionOf, projectionStage } from './formats.js';
import { flatProxySize } from './flatCameras.js';

/**
 * ffmpeg args for an optional part range: `-ss` (half-frame-early, shared
 * convention) before `-i`, and `-to` after, wide enough to cover every
 * mapped output's frame cap (native-fps proxy/grid frames, plus one frame
 * of slack) — the actual frame-exact stop is the `-frames:v` cap on each
 * mapped output, not this window. `seekOrigin` is the video-stream-minus-
 * container start offset (`seekOriginSec`), already computed by the caller.
 *
 * `-copyts` is required here: without it, ffmpeg rebases output timestamps
 * to start near zero at the seek point, which desyncs the `fps=matrixFps`
 * resampling filter's tick boundaries from where a continuous whole-file
 * decode would place them (verified empirically — frame *count* still
 * matched without it, but frame *content* at nearly every tick did not,
 * since the filter was resampling a different point in time than the
 * matching tick of a continuous decode). With `-copyts`, the seeked
 * stream's timestamps stay absolute, so a boundary already aligned to a
 * whole second (see `splitFrameRange`) lines up with the exact same
 * `fps=` tick the whole-file decode would have produced. `-to` (an
 * absolute end timestamp), not `-t` (a relative duration), is required
 * once `-copyts` is in effect — `-t` is measured from the copied
 * (pre-seek) origin and so cuts off almost immediately.
 */
function partRangeArgs(partRange, seekOrigin, fpsNum, fpsDen) {
  if (!partRange) return { before: [], after: [] };
  const startSec = Math.max(0, (Number(partRange.startFrame) - 0.5) / (fpsNum / fpsDen) + seekOrigin);
  const seek = seekTimestamp(partRange.startFrame, fpsNum, fpsDen, seekOrigin);
  const endSec = startSec + ((Math.max(1, Number(partRange.frames)) + 1) * fpsDen) / fpsNum;
  return { before: ['-copyts', '-ss', seek], after: ['-to', endSec.toFixed(6)] };
}

/** Parse "5x5" / "4x6" into {rows, cols, n}. */
export function parseGrid(spec) {
  const m = /^(\d+)x(\d+)$/i.exec(String(spec).trim());
  if (!m) throw new Error(`--grid must look like "5x5", got "${spec}"`);
  const cols = +m[1], rows = +m[2];
  return { rows, cols, n: rows * cols };
}

/** N yaw angles spread evenly around the full sphere, normalized to (-180, 180]. */
export function evenYaws(n) {
  return Array.from({ length: n }, (_, i) => {
    const raw = (i * 360) / n;
    return ((raw + 180) % 360 + 360) % 360 - 180;
  });
}

const normalizeYaw = (deg) => ((deg + 180) % 360 + 360) % 360 - 180;

/** Same test as the editor: closer to the back lens than the front. The seam stays front. */
export function isRearAim(yaw, pitch) {
  const r = Math.PI / 180;
  const z = Math.cos(pitch * r) * Math.cos(yaw * r);
  return Math.acos(Math.max(-1, Math.min(1, z))) / r > 90;
}

/**
 * Cameras that start off. Each lens is classified from its own aim, then the
 * format's `lensOn` mask (one lens, row-major) is applied to that lens alone.
 * Front and back get the same pattern without reading each other's result.
 * The editor can still turn any camera on or off.
 */
export function defaultRemoved(yaws, pitches = [], format) {
  const on = getFormat(format).lensOn;
  if (!on?.length) return [];
  const groups = { front: [], back: [] };
  yaws.forEach((yaw, i) => {
    groups[isRearAim(yaw, pitches[i] ?? 0) ? 'back' : 'front'].push(i);
  });
  const removed = [];
  for (const group of [groups.front, groups.back]) {
    if (group.length !== on.length) continue;
    group.forEach((index, k) => {
      if (!on[k]) removed.push(index + 1);
    });
  }
  return removed;
}

/**
 * Which camera sits in each grid cell: `layout[cell]` is a 0-based camera
 * index, cells in row-major order. Forward (the yaw nearest 0°) takes the
 * center cell; the other cells are ordered by signed distance from it —
 * left of center (plus the middle column above it) negative, right (plus
 * below) positive — and the cameras, sorted by yaw, are laid along that
 * order. So angles radiate out to the left and right (negative yaw turns
 * left in ffmpeg's v360) and the rear lands on the outer edges. An even
 * number of columns puts forward just right of the geometric center. An
 * even number of rows has no center row, so those grids are laid out as a
 * map around the viewer instead (see below). Works for any yaw list; with
 * gridYaws the result is the identity, since those are already in this order.
 */
export function centeredLayout(rows, cols, yaws) {
  const n = rows * cols;
  const cx = (cols - 1) / 2;
  const cy = (rows - 1) / 2;
  let cells;
  let center;
  if (rows % 2 === 0) {
    // No center row to put forward in, so lay it out like a map around the
    // viewer instead: each cell's direction from the grid's center is the
    // direction it looks. Forward is top-middle, the rear bottom-middle —
    // on 3x2 the top row is what's in front, the bottom row what's behind.
    cells = Array.from({ length: n }, (_, i) => {
      const dx = (i % cols) - cx;
      const dy = Math.floor(i / cols) - cy;
      return { i, bearing: Math.atan2(dx, -dy), dist: Math.hypot(dx, dy) };
    });
    cells.sort((a, b) => a.bearing - b.bearing || a.dist - b.dist);
    center = cells.reduce((best, c, k) => (Math.abs(c.bearing) < Math.abs(cells[best].bearing) - 1e-9 ? k : best), 0);
  } else {
    cells = Array.from({ length: n }, (_, i) => {
      const dx = (i % cols) - cx;
      const dy = Math.floor(i / cols) - cy;
      const side = dx !== 0 ? Math.sign(dx) : Math.sign(dy);
      return { i, dy, s: side * Math.hypot(dx, dy) };
    });
    // Same distance, same side: the more horizontal cell is the more directly
    // left/right one, so it gets the angle nearer forward.
    cells.sort((a, b) => a.s - b.s || (Math.abs(a.dy) - Math.abs(b.dy)) * Math.sign(a.s) || a.dy - b.dy);
    center = cells.findIndex((c) => c.s >= 0);
  }

  const byYaw = yaws.map((y, cam) => ({ cam, y: normalizeYaw(y) })).sort((a, b) => a.y - b.y);
  const forward = byYaw.reduce((best, c, k) => (Math.abs(c.y) < Math.abs(byYaw[best].y) ? k : best), 0);
  const layout = new Array(n);
  cells.forEach((c, p) => { layout[c.i] = byYaw[(((p - center + forward) % n) + n) % n].cam; });
  return layout;
}

/**
 * Default camera aims for a format's matrix, read from the format's `aims`
 * table. Cells with an aim become cameras (numbered 1..N in reading order).
 * layout[cell] is that 1-based number, or null for a blind hole.
 */
export function gridAims(rows, cols, format) {
  const { aims, lenses = null } = getFormat(format);
  if (aims.length !== rows * cols) {
    throw new Error(`${format} has ${aims.length} cells, which does not match grid ${cols}x${rows}`);
  }
  const yaws = [];
  const pitches = [];
  const layout = aims.map((aim) => {
    if (!aim) return null;
    yaws.push(aim[0]);
    pitches.push(aim[1]);
    return yaws.length; // 1-based camera number
  });
  return {
    yaws,
    pitches,
    layout,
    mask: aims.map(Boolean),
    cameras: yaws.length,
    lenses,
  };
}

/**
 * A user's camera aims per format, as sent by the editor's lens editor:
 * {youtube: {yaws, pitches, rolls?, fovs?, removed}, reels: {...}}. Each
 * list has one value per camera of that format; `removed` lists camera
 * numbers the user turned off. `rolls` (degrees, wrapped into -180..180)
 * and `fovs` (field of view across the frame's long side, clamped to the
 * range of the camera's projection, 60..120 for flat) are optional: a missing
 * array means every camera at 0° and its projection's default fov, and an
 * array of only those defaults is dropped, so a layout saved before these
 * existed compares equal to the same layout saved now. `projections` (flat,
 * fisheye, planet or pannini per camera; anything else is flat) is kept only
 * when some camera is not flat. `bulges` (per camera {top, right, bottom,
 * left}, each -1..1, see bulgeWarp) is kept only when some side bows; a
 * missing one is the straight frame. `names` (per camera a name the user
 * gave it, or null for its number; trimmed, at most CAMERA_NAME_MAX
 * characters) is kept only when some camera has one; `colors` (per camera a
 * colour the user gave it, '#rrggbb', or null for its own) likewise. Throws a
 * 400 error on anything else.
 */
export const CAMERA_NAME_MAX = 16;

/** A camera name as kept: control characters gone, spaces trimmed, at most CAMERA_NAME_MAX characters; null when empty. */
export function cameraNameOf(raw) {
  if (typeof raw !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const clean = [...raw.replace(/[\u0000-\u001f\u007f]/g, '').trim()].slice(0, CAMERA_NAME_MAX).join('').trim();
  return clean || null;
}

/** A camera colour as kept: '#rrggbb' in lower case, or null. */
export function cameraColorOf(raw) {
  return typeof raw === 'string' && /^#[0-9a-f]{6}$/i.test(raw.trim()) ? raw.trim().toLowerCase() : null;
}

export function sanitizeLayouts(raw) {
  if (raw == null) return {};
  const bad = (message) => Object.assign(new Error(message), { status: 400 });
  if (typeof raw !== 'object' || Array.isArray(raw)) throw bad('layouts must be an object');
  const out = {};
  for (const [format, layout] of Object.entries(raw)) {
    const spec = FORMATS[format];
    if (!spec) throw bad(`unknown layout format "${format}"`);
    const cameras = spec.aims.filter(Boolean).length;
    const { yaws, pitches } = layout || {};
    if (!Array.isArray(yaws) || !Array.isArray(pitches) || yaws.length !== cameras || pitches.length !== cameras) {
      throw bad(`${format} layout needs ${cameras} yaws and ${cameras} pitches`);
    }
    if (![...yaws, ...pitches].every((v) => typeof v === 'number' && Number.isFinite(v))) {
      throw bad(`${format} layout angles must be numbers`);
    }
    const extras = {};
    if (layout.projections != null) {
      if (!Array.isArray(layout.projections) || layout.projections.length !== cameras) throw bad(`${format} layout needs ${cameras} projections`);
      const clean = layout.projections.map(projectionOf);
      if (clean.some((v) => v !== 'flat')) extras.projections = clean;
    }
    if (layout.bulges != null) {
      if (!Array.isArray(layout.bulges) || layout.bulges.length !== cameras) throw bad(`${format} layout needs ${cameras} bulges`);
      const ok = (b) => b == null || (typeof b === 'object' && !Array.isArray(b)
        && Object.keys(b).every((side) => BULGE_SIDES.includes(side))
        && BULGE_SIDES.every((side) => b[side] == null || (typeof b[side] === 'number' && Number.isFinite(b[side]))));
      if (!layout.bulges.every(ok)) throw bad(`${format} bulges must be {top, right, bottom, left} numbers`);
      const clean = layout.bulges.map(bulgeOf);
      if (clean.some(hasBulge)) extras.bulges = clean;
    }
    if (layout.names != null) {
      if (!Array.isArray(layout.names) || layout.names.length !== cameras) throw bad(`${format} layout needs ${cameras} names`);
      if (!layout.names.every((n) => n == null || typeof n === 'string')) throw bad(`${format} names must be text or null`);
      const clean = layout.names.map(cameraNameOf);
      if (clean.some(Boolean)) extras.names = clean;
    }
    if (layout.colors != null) {
      if (!Array.isArray(layout.colors) || layout.colors.length !== cameras) throw bad(`${format} layout needs ${cameras} colors`);
      if (!layout.colors.every((c) => c == null || typeof c === 'string')) throw bad(`${format} colors must be text or null`);
      const clean = layout.colors.map(cameraColorOf);
      if (clean.some(Boolean)) extras.colors = clean;
    }
    const kinds = layoutProjections(extras, cameras);
    for (const key of ['rolls', 'fovs']) {
      const list = layout[key];
      if (list == null) continue;
      if (!Array.isArray(list) || list.length !== cameras) throw bad(`${format} layout needs ${cameras} ${key}`);
      if (!list.every((v) => typeof v === 'number' && Number.isFinite(v))) throw bad(`${format} ${key} must be numbers`);
      const clean = list.map((v, i) => {
        const value = key === 'rolls'
          ? Math.min(ROLL_LIMIT, Math.max(-ROLL_LIMIT, v - 360 * Math.round(v / 360)))
          : clampFov(kinds[i], v);
        return Math.round(value * 100) / 100;
      });
      const fallbackAt = (i) => (key === 'rolls' ? 0 : FOV_RANGES[kinds[i]].default);
      if (clean.some((v, i) => v !== fallbackAt(i))) extras[key] = clean;
    }
    const removed = layout.removed ?? [];
    if (!Array.isArray(removed) || !removed.every((c) => Number.isInteger(c) && c >= 1 && c <= cameras)) {
      throw bad(`${format} removed cameras must be numbers from 1 to ${cameras}`);
    }
    const off = [...new Set(removed)].sort((a, b) => a - b);
    if (off.length >= cameras) throw bad(`${format} layout needs at least one camera`);
    out[format] = {
      yaws: yaws.map((y) => Math.round(normalizeYaw(y) * 100) / 100),
      pitches: pitches.map((p) => Math.round(Math.max(-90, Math.min(90, p)) * 100) / 100),
      ...extras,
      removed: off,
    };
  }
  return out;
}

/** A layout's per-camera rolls and fovs with the defaults filled in for `cameras` cameras. */
export function layoutRolls(layout, cameras) {
  const list = layout?.rolls;
  return Array.from({ length: cameras }, (_, i) => (Number.isFinite(list?.[i]) ? list[i] : 0));
}

/** Each camera's fov; one without a value takes the default of its projection (100° for flat). */
export function layoutFovs(layout, cameras) {
  const list = layout?.fovs;
  const kinds = layoutProjections(layout, cameras);
  return Array.from({ length: cameras }, (_, i) => (Number.isFinite(list?.[i]) ? list[i] : FOV_RANGES[kinds[i]].default));
}

/** Each camera's projection, "flat" where the layout names none or an unknown one. */
export function layoutProjections(layout, cameras) {
  const list = layout?.projections;
  return Array.from({ length: cameras }, (_, i) => projectionOf(list?.[i]));
}

/** Each camera's shape, every side 0 where the layout has none. */
export function layoutBulges(layout, cameras) {
  const list = layout?.bulges;
  return Array.from({ length: cameras }, (_, i) => bulgeOf(list?.[i]));
}

/** Yaw half of gridAims, for callers that only store headings. */
export function gridYaws(rows, cols, format = 'youtube') {
  return gridAims(rows, cols, format).yaws;
}

/**
 * Cell size for the scouting grid. This video is only played in the browser
 * (final renders read the original source; previews read the stored proxy
 * when the footage has one), so a cell's long side stays within 320px and
 * the whole grid within 1280px — enough to tell cameras apart, small enough
 * to scrub. Even dimensions throughout, as yuv420p requires.
 */
export function matrixCellSize(rows, cols, format) {
  const [aw, ah] = getFormat(format).aspect;
  let scale = Math.floor(Math.min(320 / Math.max(aw, ah), 1280 / (cols * aw), 1280 / (rows * ah)));
  scale -= scale % 2;
  if (scale < 2) scale = 2;
  return { cw: aw * scale, ch: ah * scale };
}

// Cells carry no burned-in number: the editor draws each camera's name over its cell, so it can follow the cut
// (an adjusted shot is 6·1) and a name the user gave the camera.

/**
 * The camera matrix plays at the source's own frame rate up to this cap. At 12 it looked choppy on phones; the source's
 * 25 fps cost 6% more bytes and about 1% more upload processing on a 31 s GoPro clip.
 */
export const MATRIX_FPS = 30;
/**
 * What a worker builds when the job does not name a cap (`maxFps`): a job from a server older than the 30 cap, which
 * counts a part's frames at 12.
 */
export const LEGACY_MATRIX_FPS = 12;
export const MATRIX_PROXY_WIDTH = 2048;

/**
 * How the 360° preview proxy is encoded. The editor draws the camera on screen (pans, a bar's own camera settings) live
 * from it while the video plays, so it must stream on an ordinary line: CRF 30 capped at 2.5 Mbit/s (it was CRF 24,
 * about 10 Mbit/s, which a 2 Mbit/s line could never keep up with). Softer on fast motion, still clearly readable; final
 * renders read the original source, never the proxy.
 */
export const PROXY_MAX_KBPS = 2500;
export function proxyVideoArgs(gop, fps) {
  return [
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30',
    '-maxrate', `${PROXY_MAX_KBPS}k`, '-bufsize', `${PROXY_MAX_KBPS * 2}k`, '-pix_fmt', 'yuv420p',
    '-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0',
    '-x264-params', 'rc-lookahead=20:scenecut=0',
    '-r', fps,
  ];
}

/**
 * The matrix grid's actual output frame rate for a source at `srcFps` —
 * never above `MATRIX_FPS`. The upload fan-out orchestrator (editorServer.js)
 * and the worker both need this exact value (not just the `MATRIX_FPS`
 * constant) to compute a part's expected matrix frame count via
 * `matrixFrameCount` (src/edl.js) the same way `buildMatrix` derives it
 * internally.
 */
export function effectiveMatrixFps(srcFps) {
  return Math.min(Math.round(Number(srcFps) || MATRIX_FPS), MATRIX_FPS);
}

/**
 * Build the grid video. Returns {file, grid, yaws, pitches, layout, width, height}.
 *
 * A browser proxy, not a master: the equirect is scaled down before the
 * cameras are projected, frames are capped at `MATRIX_FPS`, and a keyframe lands
 * every half second so timeline seeks and playhead drags don't decode a long GOP. Blind cells
 * (layout null) are solid black, except the two named in `lenses`
 * ({front, back} cell indexes): those show that whole lens as a 180° fisheye
 * square centered in the cell.
 *
 * `proxyOut`, when set, is a 2048×1024 H.264 equirect (see proxyVideoArgs) written from the same
 * decode as the grid (the decoded frames are split). It keeps the source
 * frame rate as an exact fraction so preview pans and holds share a
 * time_base. One proxy per footage: callers skip `proxyOut` when that file
 * is already stored. Time-chunking this pass was slower than one ffmpeg
 * (the grid is already a short encode), so matrix and proxy stay one graph.
 */
/**
 * A normal (non-360) video has no camera matrix: one camera, the whole
 * frame. Only the preview proxy is built — the source scaled to
 * `flatProxySize`, aspect kept, source frame rate kept as an exact fraction
 * so previews share its time_base, audio copied (or encoded to AAC).
 */
export async function buildFlatProxy(src, proxyOut, { onProgress, signal, log } = {}) {
  if (!proxyOut) throw new Error('a flat proxy needs an output path');
  const info = await probe(src);
  const videoStream = info.streams.find((s) => s.codec_type === 'video');
  if (!videoStream) throw new Error(`${src} has no video stream`);
  const timing = videoTiming(videoStream);
  const audio = info.streams.find((s) => s.codec_type === 'audio');
  const proxy = flatProxySize(videoStream.width, videoStream.height);
  const graph = `[0:v]scale=${proxy.w}:${proxy.h}:flags=bilinear,format=yuv420p[proxy]`;
  if (graph.includes('v360')) throw new Error('flat proxy must not use v360');
  fs.mkdirSync(path.dirname(proxyOut), { recursive: true });
  const gop = Math.max(1, Math.round(timing.num / timing.den));
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    ...reconnectArgs(src),
    '-i', src,
    '-filter_complex_threads', String(Math.max(1, containerLimits().cpus)),
    '-filter_complex', graph,
  ];
  if (onProgress && timing.duration) args.push('-progress', 'pipe:1');
  args.push('-map', '[proxy]');
  if (audio) args.push('-map', '0:a:0');
  args.push(
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-pix_fmt', 'yuv420p',
    '-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0',
    '-x264-params', 'rc-lookahead=20:scenecut=0',
    '-r', `${timing.num}/${timing.den}`,
  );
  if (audio) args.push(...(audio.codec_name === 'aac' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '160k']));
  args.push('-movflags', '+faststart', proxyOut);
  const started = Date.now();
  await run(FFMPEG, args, {
    signal,
    onProgress: onProgress && timing.duration
      ? (secs) => onProgress(Math.min(1, Math.max(0, secs / timing.duration)))
      : undefined,
  });
  log?.(`flat preview proxy ${proxy.w}x${proxy.h}, ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return { proxy: proxyOut, width: proxy.w, height: proxy.h, duration: timing.duration };
}

export async function buildMatrix(src, out, {
  grid = '3x2',
  format = 'youtube',
  yaws,
  pitches,
  rolls,
  fovs,
  projections,
  bulges,
  layout: layoutOpt,
  lenses,
  pitch = 0,
  fov = 100,
  fps,
  maxFps = MATRIX_FPS,
  proxyOut,
  onProgress,
  signal,
  log,
  partRange = null,
  matrixFrames = null,
  stabilization = null,
} = {}) {
  if (partRange && !(Number(matrixFrames) > 0)) throw new Error('a part range needs matrixFrames');
  const { rows, cols, n } = parseGrid(grid);
  let angles;
  let cellPitches;
  let layout; // per cell: 1-based camera number, or null for blind

  if (yaws && yaws.length) {
    if (layoutOpt && layoutOpt.length === n) {
      layout = layoutOpt;
      angles = yaws;
      cellPitches = pitches && pitches.length === yaws.length ? pitches : yaws.map(() => pitch);
    } else if (yaws.length === n) {
      layout = Array.from({ length: n }, (_, i) => i + 1);
      angles = yaws;
      cellPitches = pitches && pitches.length === n ? pitches : yaws.map(() => pitch);
    } else {
      throw new Error(`--grid ${grid} needs ${n} yaws or a matching layout, got ${yaws.length} yaws`);
    }
  } else {
    const aims = gridAims(rows, cols, format);
    layout = aims.layout;
    angles = aims.yaws;
    cellPitches = aims.pitches;
    lenses ??= aims.lenses;
  }
  // Cell index -> yaw of the lens shown there. Only blind cells can hold one.
  const lensYaw = new Map();
  for (const [cell, yaw] of [[lenses?.front, 0], [lenses?.back, 180]]) {
    if (Number.isInteger(cell) && cell >= 0 && cell < n && layout[cell] == null) lensYaw.set(cell, yaw);
  }
  if (angles.length !== cellPitches.length) {
    throw new Error(`yaw/pitch length mismatch: ${angles.length} vs ${cellPitches.length}`);
  }
  const active = layout
    .map((cam, cell) => (cam == null ? null : { cell, cam: cam - 1 }))
    .filter(Boolean);
  // A camera the user removed has no cell, so fewer cells than angles is
  // fine; a cell naming a camera with no angle is not.
  if (!active.length || active.some(({ cam }) => cam < 0 || cam >= angles.length)) {
    throw new Error(`layout has ${active.length} cameras but ${angles.length} yaw angles`);
  }

  const info = await probe(src);
  const videoStream = info.streams.find((s) => s.codec_type === 'video');
  if (!videoStream) throw new Error(`${src} has no video stream`);
  const timing = videoTiming(videoStream);
  const fpsNum = timing.num;
  const fpsDen = timing.den;
  const srcFps = Math.round(timing.fps);
  const matrixFps = Math.min(fps || srcFps, maxFps);
  const duration = timing.duration;
  const audio = !partRange && info.streams.find((s) => s.codec_type === 'audio');

  const { cw, ch } = matrixCellSize(rows, cols, format);
  // Per camera, by camera index. A missing entry is the unrolled default view.
  const rollOf = (cam) => (Number.isFinite(rolls?.[cam]) ? rolls[cam] : 0);
  const projectionAt = (cam) => projectionOf(projections?.[cam]);
  const fovValue = (cam) => (Number.isFinite(fovs?.[cam]) ? fovs[cam] : (projectionAt(cam) === 'flat' ? fov : FOV_RANGES[projectionAt(cam)].default));
  const bulgeAt = (cam) => bulgeOf(bulges?.[cam]);
  const fovOf = (cam) => projectedFieldOfView(cw, ch, fovValue(cam), projectionAt(cam), bulgeAt(cam));
  const stageOf = (cam, i) => projectionStage(projectionAt(cam), cw, ch, fovValue(cam), bulgeAt(cam), `w${i}`);

  // v360 samples the whole frame for every camera. A 320px cell only needs
  // about 2K of equirect, so shrink first when the upload is larger.
  // The stored preview proxy is that same 2048×1024 frame at the source
  // frame rate. When both need the scale, it happens once and the decoded
  // frames are split — the proxy is not a second pass over the file.
  const proxyW = MATRIX_PROXY_WIDTH;
  const proxyH = MATRIX_PROXY_WIDTH / 2;
  const colorDur = Math.max(duration, 0.1);
  const filters = [];
  let gridInput = '[0:v]';
  let shrink = videoStream.width > MATRIX_PROXY_WIDTH
    ? `,scale=${proxyW}:${proxyH}:flags=bilinear`
    : '';
  if (proxyOut && videoStream.width > MATRIX_PROXY_WIDTH) {
    filters.push(`[0:v]scale=${proxyW}:${proxyH}:flags=bilinear,format=yuv420p,split=2[proxy][vgrid]`);
    gridInput = '[vgrid]';
    shrink = '';
  } else if (proxyOut) {
    filters.push('[0:v]split=2[vproxy][vgrid]');
    filters.push(`[vproxy]scale=${proxyW}:${proxyH}:flags=bilinear,format=yuv420p[proxy]`);
    gridInput = '[vgrid]';
  }
  let stabDir = null;
  const stabCells = new Map();
  if (stabilization?.corrections?.length) {
    // Matrix frame m shows the source frame nearest m / matrixFps; a part's
    // first matrix frame is aligned to a whole source second.
    const firstFrame = (partRange ? Number(partRange.startFrame) : 0) + (Number(stabilization.frameOffset) || 0);
    const index0 = Math.round((firstFrame / (fpsNum / fpsDen)) * matrixFps);
    const count = partRange ? Math.trunc(matrixFrames) : Math.ceil(duration * matrixFps) + 2;
    stabDir = fs.mkdtempSync(path.join(os.tmpdir(), 'd360-mstab-'));
    active.forEach(({ cam }, i) => {
      const per = viewAngles(stabilization.corrections, { yaw: angles[cam], pitch: cellPitches[cam], roll: rollOf(cam) });
      const picked = Array.from({ length: count }, (_, j) => {
        const f = Math.round(((index0 + j) / matrixFps) * (fpsNum / fpsDen));
        return per[Math.max(0, Math.min(per.length - 1, f))];
      });
      const file = path.join(stabDir, `cell-${i}.cmd`);
      fs.writeFileSync(file, sendcmdScript(picked, { fps: matrixFps, target: `v360@c${i}` }));
      stabCells.set(i, { file, first: picked[0] });
    });
  }
  const lensCells = [...lensYaw.keys()];
  const lensSide = Math.min(cw, ch);
  const splits = [...active.map((_, i) => `[s${i}]`), ...lensCells.map((cell) => `[l${cell}]`)];
  if (splits.length) {
    filters.push(`${gridInput}fps=${matrixFps}${shrink},split=${splits.length}${splits.join('')}`);
    for (const cell of lensCells) {
      filters.push(
        `[l${cell}]v360=input=e:output=fisheye:yaw=${lensYaw.get(cell)}:pitch=0:roll=0:h_fov=180:v_fov=180:w=${lensSide}:h=${lensSide},`
        + `pad=${cw}:${ch}:(ow-iw)/2:(oh-ih)/2:black[e${cell}]`
      );
    }
    active.forEach(({ cam }, i) => {
      const { hfov, vfov } = fovOf(cam);
      const stage = stageOf(cam, i);
      const crop = stage.post;
      let v360 = `v360=input=e:output=${stage.output}:yaw=${angles[cam].toFixed(2)}:pitch=${cellPitches[cam].toFixed(2)}:roll=${rollOf(cam).toFixed(2)}:h_fov=${hfov}:v_fov=${vfov}:w=${stage.w}:h=${stage.h}${crop}`;
      if (stabCells.has(i)) {
        const { file, first } = stabCells.get(i);
        v360 = `setpts=PTS-STARTPTS,sendcmd=f='${filterPath(file)}',v360@c${i}=input=e:output=${stage.output}:yaw=${first.yaw.toFixed(4)}:pitch=${first.pitch.toFixed(4)}:roll=${first.roll.toFixed(4)}:reset_rot=1:h_fov=${hfov}:v_fov=${vfov}:w=${stage.w}:h=${stage.h}${crop}`;
      }
      filters.push(`[s${i}]${v360}[a${i}]`);
    });
  }

  const stackInputs = [];
  let blind = 0;
  for (let cell = 0; cell < n; cell++) {
    if (lensYaw.has(cell)) {
      stackInputs.push(`[e${cell}]`);
    } else if (layout[cell] == null) {
      filters.push(`color=c=black:s=${cw}x${ch}:r=${matrixFps}:d=${colorDur}[b${blind}]`);
      stackInputs.push(`[b${blind}]`);
      blind++;
    } else {
      const ai = active.findIndex((a) => a.cell === cell);
      stackInputs.push(`[a${ai}]`);
    }
  }
  const positions = Array.from({ length: n }, (_, cell) => `${(cell % cols) * cw}_${Math.floor(cell / cols) * ch}`).join('|');
  filters.push(`${stackInputs.join('')}xstack=inputs=${n}:layout=${positions}[grid]`);

  fs.mkdirSync(path.dirname(out), { recursive: true });
  if (proxyOut) fs.mkdirSync(path.dirname(proxyOut), { recursive: true });
  const proxyGop = Math.max(1, Math.round(fpsNum / fpsDen));
  const filterThreads = Math.max(1, containerLimits().cpus);
  const seekOrigin = seekOriginSec(videoStream, info.format);
  const partArgs = partRangeArgs(partRange, seekOrigin, fpsNum, fpsDen);
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    ...reconnectArgs(src),
    ...partArgs.before,
    '-i', src,
    ...partArgs.after,
    '-filter_complex_threads', String(filterThreads),
    '-filter_complex', filters.join(';'),
  ];
  if (onProgress && duration) args.push('-progress', 'pipe:1');
  if (proxyOut) {
    args.push('-map', '[proxy]');
    if (audio) args.push('-map', '0:a:0');
    args.push(...proxyVideoArgs(proxyGop, `${fpsNum}/${fpsDen}`));
    if (audio) args.push(...(audio.codec_name === 'aac' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '160k']));
    if (partRange) args.push('-frames:v', String(Math.trunc(partRange.frames)));
    args.push('-movflags', '+faststart', proxyOut);
  }
  args.push(
    '-map', '[grid]', '-an',
    '-c:v', 'libx264', '-crf', '35', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    // A keyframe every half second: a drag on the phone lands on a frame twice as fast as with one a second.
    '-g', String(Math.round(matrixFps / 2)), '-keyint_min', String(Math.round(matrixFps / 2)),
    '-x264-params', 'rc-lookahead=20:scenecut=0',
    ...(partRange ? ['-frames:v', String(Math.trunc(matrixFrames))] : []),
    '-movflags', '+faststart',
    out,
  );
  const partStartSec = partRange ? partRange.startFrame / (fpsNum / fpsDen) : 0;
  const partDurationSec = partRange ? partRange.frames / (fpsNum / fpsDen) : duration;
  const started = Date.now();
  try {
  await run(FFMPEG, args, {
    signal,
    // `-copyts` keeps a part's reported `secs` absolute (it's not
    // re-zeroed at the seek point), so progress is normalized against the
    // part's own [start, start+duration) window rather than 0..duration.
    onProgress: onProgress && partDurationSec
      ? (secs) => onProgress(Math.min(1, Math.max(0, (secs - partStartSec) / partDurationSec)))
      : undefined,
  });
  } finally {
    if (stabDir) fs.rmSync(stabDir, { recursive: true, force: true });
  }
  log?.(`matrix and proxy in one ffmpeg, ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return {
    file: out,
    proxy: proxyOut || null,
    grid: { rows, cols, n, cameras: angles.length },
    yaws: angles,
    pitches: cellPitches,
    rolls: angles.map((_, cam) => rollOf(cam)),
    fovs: angles.map((_, cam) => fovValue(cam)),
    ...(angles.some((_, cam) => projectionAt(cam) !== 'flat') ? { projections: angles.map((_, cam) => projectionAt(cam)) } : {}),
    ...(angles.some((_, cam) => hasBulge(bulgeAt(cam))) ? { bulges: angles.map((_, cam) => bulgeAt(cam)) } : {}),
    layout,
    lenses: lensYaw.size ? lenses : null,
    width: cols * cw,
    height: rows * ch,
  };
}
