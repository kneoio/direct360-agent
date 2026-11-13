/**
 * Stabilization for GoPro 360 footage — pure functions, no I/O besides the
 * orientation file codec.
 *
 * Conventions (verified: test/stabilize.test.mjs and the v360 probe):
 *  - View frame V: x right, y up, z forward (equirect centre).
 *  - v360 with rorder=ypr turns (yaw, pitch, roll) into the matrix
 *      M = Ry(yaw) · Rx(-pitch) · Rz(-roll)
 *    mapping output-view directions to source (camera) directions. +yaw looks
 *    right, +pitch looks up, +roll tilts the image clockwise.
 *  - GoPro GRAV is gravity ("down") in the GPMF body basis; the V basis is
 *    (gx, -gy, gz). CORI conjugated (q* v q) maps camera vectors back to the
 *    start orientation. Both fitted against real MAX footage.
 *  - Quaternions are [w, x, y, z]. Correction C is a quaternion whose matrix
 *    has the world axes (right, up, forward) as columns, expressed in camera
 *    coordinates. Final view = C ∘ aim, matrix M_final = C · M_aim.
 */

// full lock: enable after testing
const FULL_LOCK_ENABLED = false;

export const STAB_MODES = Object.freeze(['off', 'horizon']);

export function stabModeValid(mode) {
  return STAB_MODES.includes(mode) || (FULL_LOCK_ENABLED && mode === 'full');
}

/**
 * The one rule for whether a job is stabilized. `ctx` is a session or anything
 * shaped like one: {orientationKey, mode, stabPref}. Footage with an
 * orientation file that is not flat gets the user's preference, else 'off'.
 * Returns {mode, line} where `line` is the per-job log text.
 */
export function stabilizationDecision(ctx) {
  const stabilizable = Boolean(ctx?.orientationKey) && ctx?.mode !== 'flat';
  if (!stabilizable) return { mode: 'off', line: 'off (not stabilizable)' };
  const pref = stabModeValid(ctx.stabPref) ? ctx.stabPref : 'off';
  return { mode: pref, line: `${pref} (user pref)` };
}

export function effectiveStabilization(ctx) {
  return stabilizationDecision(ctx).mode;
}

export function yawSmoothSec() {
  const n = Number(process.env.DIRECT360_STAB_YAW_SMOOTH_SEC);
  return Number.isFinite(n) && n >= 0 && process.env.DIRECT360_STAB_YAW_SMOOTH_SEC !== undefined && process.env.DIRECT360_STAB_YAW_SMOOTH_SEC !== ''
    ? n : 1.0;
}

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

// ---------------------------------------------------------------- quaternions
export const qmul = (a, b) => [
  a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
  a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
  a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
  a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
];
export const qconj = (q) => [q[0], -q[1], -q[2], -q[3]];
export function qnorm(q) {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}
export function qrot(q, v) {
  const r = qmul(qmul(q, [0, v[0], v[1], v[2]]), qconj(q));
  return [r[1], r[2], r[3]];
}
export function qslerp(a, b, t) {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  if (d < 0) { b = [-b[0], -b[1], -b[2], -b[3]]; d = -d; }
  if (d > 0.9995) return qnorm(a.map((x, i) => x + t * (b[i] - x)));
  const th = Math.acos(d), s = Math.sin(th);
  const wa = Math.sin((1 - t) * th) / s, wb = Math.sin(t * th) / s;
  return a.map((x, i) => wa * x + wb * b[i]);
}
export const qaxis = (axis, deg) => {
  const h = deg * D2R / 2, s = Math.sin(h);
  return [Math.cos(h), axis[0] * s, axis[1] * s, axis[2] * s];
};

/** Rotation matrix (row-major 3x3) of a unit quaternion. */
export function qToMat(q) {
  const [w, x, y, z] = q;
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
    [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
    [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
  ];
}

export function matToQ(m) {
  const t = m[0][0] + m[1][1] + m[2][2];
  let q;
  if (t > 0) {
    const s = Math.sqrt(t + 1) * 2;
    q = [s / 4, (m[2][1] - m[1][2]) / s, (m[0][2] - m[2][0]) / s, (m[1][0] - m[0][1]) / s];
  } else if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) {
    const s = Math.sqrt(1 + m[0][0] - m[1][1] - m[2][2]) * 2;
    q = [(m[2][1] - m[1][2]) / s, s / 4, (m[0][1] + m[1][0]) / s, (m[0][2] + m[2][0]) / s];
  } else if (m[1][1] > m[2][2]) {
    const s = Math.sqrt(1 + m[1][1] - m[0][0] - m[2][2]) * 2;
    q = [(m[0][2] - m[2][0]) / s, (m[0][1] + m[1][0]) / s, s / 4, (m[1][2] + m[2][1]) / s];
  } else {
    const s = Math.sqrt(1 + m[2][2] - m[0][0] - m[1][1]) * 2;
    q = [(m[1][0] - m[0][1]) / s, (m[0][2] + m[2][0]) / s, (m[1][2] + m[2][1]) / s, s / 4];
  }
  return qnorm(q);
}

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const vnorm = (a) => { const n = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / n, a[1] / n, a[2] / n]; };

// ------------------------------------------------------------- v360 rotation
/** Quaternion of the v360 view for given yaw/pitch/roll (degrees, rorder=ypr). */
export function aimQuat(yaw, pitch, roll = 0) {
  return qmul(qmul(qaxis([0, 1, 0], yaw), qaxis([1, 0, 0], -pitch)), qaxis([0, 0, 1], -roll));
}

/** Inverse of aimQuat: v360 yaw/pitch/roll in degrees. */
export function quatToV360(q) {
  const m = qToMat(q);
  const yaw = Math.atan2(m[0][2], m[2][2]) * R2D;
  const pitch = Math.asin(Math.max(-1, Math.min(1, m[1][2]))) * R2D;
  const roll = Math.atan2(-m[1][0], m[1][1]) * R2D;
  return { yaw, pitch, roll };
}

/**
 * Final v360 angles for aim (yaw/pitch deg) composed with correction quaternion.
 */
export function composeView(correction, yaw, pitch, roll = 0) {
  return quatToV360(qmul(correction, aimQuat(yaw, pitch, roll)));
}

// --------------------------------------------------------------- orientation
/** GPMF body basis -> V basis for gravity. */
const gravV = (g) => [g[0], -g[1], g[2]];
/** Camera->start rotation in V basis from a CORI quaternion (body basis). */
function coriToV(q) {
  const c = qconj(qnorm(q));
  // reflect basis S=diag(1,-1,1): axis (x,y,z) of a rotation -> (-x, y, -z)
  return [c[0], -c[1], c[2], -c[3]];
}

function unwrap(arr) {
  const out = new Float64Array(arr.length);
  let off = 0;
  for (let i = 0; i < arr.length; i++) {
    if (i) {
      const d = arr[i] - arr[i - 1];
      if (d > Math.PI) off -= 2 * Math.PI;
      else if (d < -Math.PI) off += 2 * Math.PI;
    }
    out[i] = arr[i] + off;
  }
  return out;
}

/** Centered moving average (box, shrinking at the ends). */
function smooth(arr, win) {
  const n = arr.length, out = new Float64Array(n);
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + arr[i];
  const h = Math.max(0, Math.floor(win / 2));
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - h), b = Math.min(n - 1, i + h);
    out[i] = (pre[b + 1] - pre[a]) / (b - a + 1);
  }
  return out;
}

/**
 * Per-frame correction quaternions.
 * @param {{quats:number[][], grav:number[][]}} track one entry per video frame
 * @param {{mode:'horizon'|'full', fps:number, yawSmoothSec?:number}} opts
 * @returns {number[][]} correction quaternion per frame
 */
export function computeCorrection(track, { mode, fps, yawSmoothSec: ys = yawSmoothSec() }) {
  if (mode === 'full' && !FULL_LOCK_ENABLED) throw new Error('full lock is disabled');
  if (mode !== 'horizon' && mode !== 'full') throw new Error(`unknown stabilization mode ${mode}`);
  const n = track.quats.length;
  const A = track.quats.map(coriToV); // camera -> start frame

  if (mode === 'full') return A.map((a) => qconj(a));

  // Start tilt: gravity averaged over the first second, in the start frame.
  const k = Math.max(1, Math.min(n, Math.round(fps)));
  const g0 = [0, 0, 0];
  for (let i = 0; i < k; i++) {
    const g = qrot(A[i], gravV(track.grav[i]));
    g0[0] += g[0]; g0[1] += g[1]; g0[2] += g[2];
  }
  const up0 = vnorm([-g0[0], -g0[1], -g0[2]]);
  // World forward = start camera forward projected on the horizontal plane.
  let fw0 = [0, 0, 1];
  fw0 = [fw0[0] - dot(fw0, up0) * up0[0], fw0[1] - dot(fw0, up0) * up0[1], fw0[2] - dot(fw0, up0) * up0[2]];
  if (Math.hypot(...fw0) < 1e-3) fw0 = [1, 0, 0];
  fw0 = vnorm(fw0);
  const rt0 = vnorm(cross(up0, fw0)); // right = up x forward in this handedness (x right,y up,z fwd)

  // Heading of each frame's camera forward around the world up axis.
  const head = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const f = qrot(A[i], [0, 0, 1]);
    head[i] = Math.atan2(dot(f, rt0), dot(f, fw0));
  }
  const un = unwrap(head);
  const sm = smooth(un, Math.round(ys * fps));

  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    // Absolute level from this frame's gravity (camera coordinates).
    const up = vnorm(gravV(track.grav[i]).map((x) => -x));
    let f = [0, 0, 1];
    const d = dot(f, up);
    f = [f[0] - d * up[0], f[1] - d * up[1], f[2] - d * up[2]];
    if (Math.hypot(...f) < 1e-3) f = [1, 0, 0];
    f = vnorm(f);
    const r = vnorm(cross(up, f));
    // Level basis aligned to the camera heading (columns right, up, forward).
    const bc = [[r[0], up[0], f[0]], [r[1], up[1], f[1]], [r[2], up[2], f[2]]];
    const qb = matToQ(bc);
    // Shift heading from the camera's actual yaw to the smoothed one.
    const dy = (sm[i] - un[i]) * R2D;
    out[i] = qnorm(qmul(qb, qaxis([0, 1, 0], dy)));
  }
  return out;
}

const wrap180 = (a) => a - 360 * Math.round(a / 360);

/** Convert corrections + aim to per-frame v360 angles (all within v360's +-180 range). */
export function viewAngles(corrections, aimAt) {
  return corrections.map((c, i) => {
    const a = typeof aimAt === 'function' ? aimAt(i) : aimAt;
    const v = composeView(c, a.yaw, a.pitch, a.roll || 0);
    return { yaw: wrap180(v.yaw), pitch: v.pitch, roll: wrap180(v.roll) };
  });
}

// ----------------------------------------------------------- track resampling
/**
 * Resample CORI/GRAV samples to exactly `frames` entries at t=(i+0.5)/fps.
 * Samples are {t, v}; if the count already equals `frames` they are used 1:1.
 * @returns {{quats, grav, resampled:boolean, srcCount:number}}
 */
export function buildTrack(coriSamples, gravSamples, { frames, fps, durationSec }) {
  const resample = (samples, slerp) => {
    const n = samples.length;
    if (n === frames) return { v: samples.map((s) => s.v), resampled: false };
    const dur = durationSec || n / fps;
    const t = (i) => samples[i].t ?? (i + 0.5) * dur / n;
    const out = new Array(frames);
    let j = 0;
    for (let i = 0; i < frames; i++) {
      const ti = (i + 0.5) / fps;
      while (j < n - 2 && t(j + 1) <= ti) j++;
      const a = samples[Math.min(j, n - 1)], b = samples[Math.min(j + 1, n - 1)];
      const ta = t(Math.min(j, n - 1)), tb = t(Math.min(j + 1, n - 1));
      const u = tb > ta ? Math.max(0, Math.min(1, (ti - ta) / (tb - ta))) : 0;
      out[i] = slerp ? qslerp(qnorm(a.v), qnorm(b.v), u) : a.v.map((x, k) => x + u * (b.v[k] - x));
    }
    return { v: out, resampled: true };
  };
  const q = resample(coriSamples, true);
  const g = gravSamples && gravSamples.length ? resample(gravSamples, false) : null;
  const quats = q.v.map(qnorm);
  const grav = g ? g.v.map((v) => vnorm(v)) : quats.map(() => [0, 0, 0]);
  return { quats, grav, resampled: q.resampled || !!(g && g.resampled), srcCount: coriSamples.length, hasGrav: !!g };
}

// --------------------------------------------------------------- file codec
const MAGIC = 'D360ORI1';
const FLOATS = 7;

export function encodeOrientation({ quats, grav, fps }) {
  const n = quats.length;
  const buf = Buffer.alloc(16 + n * FLOATS * 4);
  buf.write(MAGIC, 0, 'ascii');
  buf.writeUInt32LE(n, 8);
  buf.writeFloatLE(fps, 12);
  let o = 16;
  for (let i = 0; i < n; i++) {
    for (const x of quats[i]) { buf.writeFloatLE(x, o); o += 4; }
    for (const x of grav[i]) { buf.writeFloatLE(x, o); o += 4; }
  }
  return buf;
}

export function decodeOrientation(buf) {
  if (!buf || buf.length < 16 || buf.toString('ascii', 0, 8) !== MAGIC) throw new Error('not an orientation file');
  const n = buf.readUInt32LE(8), fps = buf.readFloatLE(12);
  if (buf.length < 16 + n * FLOATS * 4) throw new Error('orientation file truncated');
  const quats = new Array(n), grav = new Array(n);
  let o = 16;
  for (let i = 0; i < n; i++) {
    const v = [];
    for (let k = 0; k < FLOATS; k++) { v.push(buf.readFloatLE(o)); o += 4; }
    quats[i] = qnorm(v.slice(0, 4));
    grav[i] = v.slice(4);
  }
  return { quats, grav, fps, frames: n };
}

// ------------------------------------------------------- sendcmd / slicing
/**
 * sendcmd script setting v360 yaw/pitch/roll at each frame's timestamp.
 * `frames` is {first, count}: global frame numbers; time is the output
 * timeline (t0 = timestamp of the first output frame, in seconds).
 * Commands fire at the frame's start; `step` > 1 updates every Nth frame.
 */
export function sendcmdScript(angles, { first = 0, fps, t0 = 0, target = 'v360@s', step = 1 }) {
  const lines = [];
  for (let i = 0; i < angles.length; i += step) {
    const a = angles[i];
    const t = t0 + i / fps;
    lines.push(`${t.toFixed(5)} ${target} yaw ${a.yaw.toFixed(4)}, ${target} pitch ${a.pitch.toFixed(4)}, ${target} roll ${a.roll.toFixed(4)};`);
  }
  return lines.join('\n') + '\n';
}
