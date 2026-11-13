/**
 * Compact 10 Hz timeline from gpmf2json.
 *
 * The C tool is asked only for the streams this timeline uses, with ACCL
 * averaged to 50 Hz. What we keep is one sample every tenth of a second,
 * plus a short summary. GPS latitude and longitude are present only while
 * the fix is at least 2D and the precision is DOP 5 or better.
 *
 * accelG is total acceleration in g, gravity included, so a camera at rest
 * is about 1. tiltDeg is camera roll from GRAV (0° upright), not vehicle lean.
 * headingDeg prefers GPS course; the magnetometer is only a fallback.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTrack, encodeOrientation } from './stabilize.js';
import { probeHeader } from './encoder.js';

const HZ = 10;
const G = 9.80665;
const ACCEL_TAU_SEC = 0.3;
/** GoPro GPSP is DOP×100. Worse than 500, or a GPS9 DOP above 5, is dropped. */
const MAX_GPSP = 500;
const MAX_DOP = 5;
export const RAW_STDOUT_LIMIT = 50 * 1024 * 1024;
export const GPMF_EXTRACT_ARGS = [
  '--streams', 'GPS5,GPS9,GPSF,GPSP,GRAV,MAGN,ACCL',
  '--decimate', 'ACCL=50',
  '--decimate', 'GRAV=10',
  '--decimate', 'MAGN=10',
];
/**
 * The same read with camera and image orientation added, not decimated. Only
 * the CORI/IORI sample counts are kept; a dump too big with them is retried
 * without them so the timeline never depends on orientation.
 */
export const GPMF_ORIENTATION_ARGS = [
  '--streams', 'GPS5,GPS9,GPSF,GPSP,GRAV,MAGN,ACCL,CORI,IORI',
  ...GPMF_EXTRACT_ARGS.slice(2),
];
const TOO_BIG = 'gpmf2json output exceeded 50 MB';

const localBin = path.join(path.dirname(fileURLToPath(import.meta.url)), '../worker/gpmf/gpmf2json');

export function gpmfBin() {
  if (process.env.GPMF2JSON) return process.env.GPMF2JSON;
  if (fs.existsSync(localBin)) return localBin;
  return 'gpmf2json';
}

/** Raw gpmf2json document, or null when the file has no GPMF track. A missing binary is an error. */
export function readGpmf(file, bin = gpmfBin(), args = GPMF_EXTRACT_ARGS) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [...args, file], { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    let received = 0;
    let tooBig = false;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    child.stdout.on('data', (chunk) => {
      if (tooBig) return;
      received += chunk.length;
      if (received > RAW_STDOUT_LIMIT) {
        tooBig = true;
        out.length = 0;
        try { child.kill('SIGKILL'); } catch { /* the close handler still rejects */ }
        return;
      }
      out.push(chunk);
    });
    child.stderr.on('data', (chunk) => err.push(chunk));
    child.on('error', (error) => {
      if (error.code === 'ENOENT') finish(reject, new Error('gpmf2json is not installed'));
      else finish(reject, error);
    });
    child.on('close', (code) => {
      if (tooBig) {
        finish(reject, new Error(TOO_BIG));
        return;
      }
      const text = Buffer.concat(out).toString('utf8').trim();
      if (!text) {
        if (code === 0 || code === null) finish(resolve, null);
        else finish(reject, new Error(Buffer.concat(err).toString('utf8').trim() || `gpmf2json exited ${code}`));
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        finish(reject, new Error('gpmf2json output was not JSON'));
        return;
      }
      if (code !== 0) {
        finish(reject, new Error(Buffer.concat(err).toString('utf8').trim() || `gpmf2json exited ${code}`));
        return;
      }
      if (!parsed.streams || !Object.keys(parsed.streams).length) finish(resolve, null);
      else finish(resolve, parsed);
    });
  });
}

function round(value, digits) {
  if (value == null || !Number.isFinite(value)) return null;
  const p = 10 ** digits;
  return Math.round(value * p) / p;
}

function stream(raw, key) {
  const found = raw?.streams?.[key];
  return found?.samples?.length ? found : null;
}

function vec(sample) {
  if (!sample) return null;
  if (Array.isArray(sample.v)) return sample.v;
  if (typeof sample.v === 'number' && Number.isFinite(sample.v)) return [sample.v];
  return null;
}

function holdIndex(samples, t) {
  let lo = 0;
  let hi = samples.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].t <= t + 1e-4) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

function hold(samples, t, maxAge = Infinity) {
  const i = holdIndex(samples, t);
  if (i < 0) return null;
  const point = samples[i];
  if (t - point.t > maxAge) return null;
  return point;
}

function unitAt(units, index) {
  if (!units) return '';
  const parts = String(units).split(',');
  return (parts[index] || parts[0] || '').trim().toLowerCase();
}

function toKmh(value, unit) {
  if (!Number.isFinite(value)) return null;
  if (unit.includes('km/h') || unit === 'kmh') return value;
  if (unit.includes('mph')) return value * 1.609344;
  if (unit.includes('km/s')) return value * 3600;
  return value * 3.6;
}

function toMeters(value, unit) {
  if (!Number.isFinite(value)) return null;
  if (unit.includes('ft')) return value * 0.3048;
  return value;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const p1 = lat1 * Math.PI / 180;
  const p2 = lat2 * Math.PI / 180;
  const dp = (lat2 - lat1) * Math.PI / 180;
  const dl = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function bearingDeg(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * Math.PI / 180;
  const p2 = lat2 * Math.PI / 180;
  const dl = (lon2 - lon1) * Math.PI / 180;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

/**
 * A GPS sample is usable when the fix is 2D or 3D. GPS5 keeps the fix in GPSF;
 * GPS9 carries it on the sample. With neither, coordinates still count when they
 * sit on the Earth and the altitude is in range (a missing fix channel, not a bad one).
 */
function precisionOf(gpsKey, sample, gpsp) {
  const v = vec(sample);
  const dop = gpsKey === 'GPS9' && v && v.length >= 8 && Number.isFinite(v[7]) ? v[7] : null;
  const raw = Number.isFinite(gpsp) ? gpsp : (dop != null ? dop * 100 : null);
  if (raw == null && dop == null) return null;
  return { raw, dop };
}

function precisionOk(precision) {
  if (!precision) return true;
  if (precision.raw != null && precision.raw > MAX_GPSP) return false;
  if (precision.dop != null && precision.dop > MAX_DOP) return false;
  return true;
}

function gpsReading(sample, units, fixSample, precision) {
  const v = vec(sample);
  if (!v || v.length < 4) return null;
  const lat = v[0];
  const lon = v[1];
  const alt = toMeters(v[2], unitAt(units, 2));
  const speed = toKmh(v[3], unitAt(units, 3));
  let fix = fixSample;
  if ((fix == null || !Number.isFinite(fix)) && v.length >= 9 && Number.isFinite(v[8])) fix = v[8];
  const fixKnown = Number.isFinite(fix);
  const coordsOk = Number.isFinite(lat) && Number.isFinite(lon)
    && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
    && !(lat === 0 && lon === 0);
  // A missing fix channel still has to look like a place on Earth. Unlocked
  // GoPro samples often report an altitude of several kilometres.
  const altOk = alt == null || (alt > -500 && alt < 5000);
  const locked = fixKnown ? fix >= 2 && coordsOk : coordsOk && altOk;
  if (!locked || !precisionOk(precision)) return { lat: null, lon: null, alt: null, speed: null };
  return { lat, lon, alt, speed };
}

/** Replace each speed with the median of speeds inside a 1 second window. */
function medianSpeeds(points) {
  const half = 0.5;
  let lo = 0;
  return points.map((point, i) => {
    if (point.speed == null) return point;
    while (lo < i && points[lo].t < point.t - half - 1e-6) lo++;
    let hi = i;
    while (hi + 1 < points.length && points[hi + 1].t <= point.t + half + 1e-6) hi++;
    const values = [];
    for (let j = lo; j <= hi; j++) {
      if (points[j].speed != null) values.push(points[j].speed);
    }
    values.sort((a, b) => a - b);
    const mid = values.length >> 1;
    const speed = values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
    return { ...point, speed };
  });
}

function accelScale(accel) {
  const unit = (accel.units || '').toLowerCase();
  if (unit.includes('m/s')) return 1 / G;
  const mags = [];
  for (const sample of accel.samples.slice(0, 40)) {
    const v = vec(sample);
    if (v && v.length >= 3) mags.push(Math.hypot(v[0], v[1], v[2]));
  }
  if (!mags.length) return 1;
  mags.sort((a, b) => a - b);
  return mags[mags.length >> 1] > 4 ? 1 / G : 1;
}

function smoothedAccel(accel) {
  if (!accel) return [];
  const scale = accelScale(accel);
  const series = [];
  for (const sample of accel.samples) {
    const v = vec(sample);
    if (!v || v.length < 3) continue;
    const mag = Math.hypot(v[0], v[1], v[2]) * scale;
    if (Number.isFinite(mag)) series.push({ t: sample.t, x: mag });
  }
  if (!series.length) return [];
  let y = series[0].x;
  let prev = series[0].t;
  const out = [{ t: prev, x: y }];
  for (let i = 1; i < series.length; i++) {
    const dt = Math.max(0, series[i].t - prev);
    const a = 1 - Math.exp(-dt / ACCEL_TAU_SEC);
    y += a * (series[i].x - y);
    prev = series[i].t;
    out.push({ t: prev, x: y });
  }
  return out;
}

/** Camera roll from the gravity vector. Upright (Y down, X right) is 0°. */
function tiltDeg(sample) {
  const v = vec(sample);
  if (!v || v.length < 2) return null;
  const [x, y] = v;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  // Pitched straight up or down, the roll axis is the noise in X and Y.
  if (Math.hypot(x, y) < 0.2) return null;
  return Math.atan2(x, y) * 180 / Math.PI;
}

/** Magnetometer heading in degrees, 0–360. Uses the first three axes (X right, Z forward). */
function magnHeading(sample) {
  const v = vec(sample);
  if (!v || v.length < 3) return null;
  const [x, , z] = v;
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  if (Math.hypot(x, z) < 1e-3) return null;
  return (Math.atan2(x, z) * 180 / Math.PI + 360) % 360;
}

function gpsCourse(points) {
  const out = [];
  let prev = null;
  for (const point of points) {
    if (point.lat == null) continue;
    if (!prev) {
      prev = point;
      continue;
    }
    const meters = haversineKm(prev.lat, prev.lon, point.lat, point.lon) * 1000;
    const dt = point.t - prev.t;
    if (meters >= 1 && dt > 0 && meters / dt < 70) {
      out.push({ t: point.t, x: bearingDeg(prev.lat, prev.lon, point.lat, point.lon) });
      prev = point;
    }
  }
  return out;
}

function mean(values) {
  if (!values.length) return null;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

function extreme(values, high) {
  let found = null;
  for (const value of values) {
    if (value == null || !Number.isFinite(value)) continue;
    if (found == null || (high ? value > found : value < found)) found = value;
  }
  return found;
}

/**
 * @returns {{version: number, samples: object[], summary: object}|null}
 */
export function normalizeTelemetry(raw) {
  if (!raw?.streams || !Object.keys(raw.streams).length) return null;
  const gpsKey = stream(raw, 'GPS5') ? 'GPS5' : (stream(raw, 'GPS9') ? 'GPS9' : null);
  const gps = gpsKey ? stream(raw, gpsKey) : null;
  const gpsFix = stream(raw, 'GPSF');
  const gpsp = stream(raw, 'GPSP');
  const grav = stream(raw, 'GRAV');
  const magn = stream(raw, 'MAGN');
  const accel = smoothedAccel(stream(raw, 'ACCL'));
  const units = gps?.units || '';

  let end = Number(raw.durationSec);
  if (!Number.isFinite(end) || end <= 0) {
    end = 0;
    for (const name of Object.keys(raw.streams)) {
      const last = raw.streams[name].samples?.at?.(-1);
      if (last && last.t > end) end = last.t;
    }
  }
  if (!(end > 0)) return null;

  const nativeGps = [];
  if (gps) {
    for (const sample of gps.samples) {
      const fixSample = gpsFix ? vec(hold(gpsFix.samples, sample.t, 2))?.[0] : null;
      const gpspSample = gpsp ? vec(hold(gpsp.samples, sample.t, 2))?.[0] : null;
      const reading = gpsReading(sample, units, fixSample, precisionOf(gpsKey, sample, gpspSample));
      if (reading) nativeGps.push({ t: sample.t, ...reading });
    }
  }
  const filteredGps = medianSpeeds(nativeGps);
  const course = gpsCourse(filteredGps);

  const samples = [];
  let usedGpsHeading = false;
  let usedMagnHeading = false;
  const count = Math.floor(end * HZ + 1e-6) + 1;
  for (let i = 0; i < count && i < 200000; i++) {
    const t = i / HZ;
    if (t > end + 1e-6) break;
    const native = gps ? hold(filteredGps, t, 1) : null;
    const speed = native?.speed ?? null;
    const alt = native?.alt ?? null;
    const lat = native?.lat ?? null;
    const lon = native?.lon ?? null;
    const accelPoint = hold(accel, t, 0.5);
    const gravPoint = grav ? hold(grav.samples, t, 0.5) : null;
    const coursePoint = lat != null ? hold(course, t, 5) : null;
    const magnPoint = !coursePoint && magn ? hold(magn.samples, t, 0.5) : null;
    let heading = null;
    if (coursePoint) {
      heading = coursePoint.x;
      usedGpsHeading = true;
    } else if (magnPoint) {
      heading = magnHeading(magnPoint);
      if (heading != null) usedMagnHeading = true;
    }
    samples.push({
      t: round(t, 1),
      speedKmh: round(speed, 1),
      altM: round(alt, 1),
      lat: round(lat, 6),
      lon: round(lon, 6),
      accelG: round(accelPoint?.x ?? null, 3),
      tiltDeg: round(gravPoint ? tiltDeg(gravPoint) : null, 1),
      headingDeg: round(heading, 1),
    });
  }
  if (!samples.length) return null;

  const speeds = samples.map((s) => s.speedKmh).filter((n) => n != null);
  const tilts = samples.map((s) => s.tiltDeg).filter((n) => n != null).map((n) => Math.abs(n));
  const alts = samples.map((s) => s.altM).filter((n) => n != null);
  let distance = 0;
  let prevGps = null;
  let hasGps = false;
  for (const point of filteredGps) {
    if (point.lat == null || point.lon == null) {
      prevGps = null;
      continue;
    }
    hasGps = true;
    if (prevGps) {
      const step = haversineKm(prevGps.lat, prevGps.lon, point.lat, point.lon);
      const dt = point.t - prevGps.t;
      // 0.07 km/s is 250 km/h. A larger step is a GPS jump, not motion.
      if (dt > 0 && step / dt < 0.07) distance += step;
    }
    prevGps = point;
  }

  return {
    version: 1,
    samples,
    summary: {
      maxSpeedKmh: round(extreme(speeds, true), 1),
      avgSpeedKmh: round(mean(speeds), 1),
      distanceKm: hasGps ? round(distance, 3) : null,
      maxTiltDeg: round(extreme(tilts, true), 1),
      altMin: round(extreme(alts, false), 1),
      altMax: round(extreme(alts, true), 1),
      hasGps,
      headingSource: usedGpsHeading ? 'gps' : (usedMagnHeading ? 'magnetometer' : null),
    },
  };
}

/**
 * The shape GET /telemetry returns. Stored files from before tiltDeg still
 * carry leanDeg; those values are renamed here and version is always 1.
 */
export function presentTelemetry(doc) {
  if (!doc || !Array.isArray(doc.samples)) return null;
  const samples = doc.samples.map((sample) => {
    if (!sample || typeof sample !== 'object') return sample;
    const tilt = sample.tiltDeg != null ? sample.tiltDeg : (sample.leanDeg != null ? sample.leanDeg : null);
    const next = { ...sample, tiltDeg: tilt };
    delete next.leanDeg;
    return next;
  });
  const summary = { ...(doc.summary || {}) };
  if (summary.maxTiltDeg == null && summary.maxLeanDeg != null) summary.maxTiltDeg = summary.maxLeanDeg;
  delete summary.maxLeanDeg;
  if (!Object.prototype.hasOwnProperty.call(summary, 'headingSource')) summary.headingSource = null;
  return { version: 1, samples, summary };
}

/** CORI/IORI sample counts from a raw dump; null when orientation was not requested. */
export function orientationCounts(raw, requested = true) {
  if (!requested) return null;
  const count = (key) => raw?.streams?.[key]?.samples?.length || 0;
  return { cori: count('CORI'), iori: count('IORI') };
}

/**
 * Compact timeline plus the device and stream names for the upload log, and
 * the CORI/IORI counts (null when they could not be read). Null when there is
 * nothing to keep. Orientation samples are counted, never stored.
 */
export async function captureTelemetry(file, bin = gpmfBin()) {
  let raw;
  let requested = true;
  try {
    raw = await readGpmf(file, bin, GPMF_ORIENTATION_ARGS);
  } catch (e) {
    if (e.message !== TOO_BIG) throw e;
    requested = false;
    raw = await readGpmf(file, bin, GPMF_EXTRACT_ARGS);
  }
  if (!raw) return null;
  const doc = normalizeTelemetry(raw);
  if (!doc) return null;
  const orientation = orientationCounts(raw, requested);
  const streams = Object.keys(raw.streams).filter((k) => k !== 'CORI' && k !== 'IORI');
  return { doc, device: raw.device || null, streams, orientation };
}

/** Undecimated CORI + GRAV only: about 60 bytes of JSON per frame, well under the stdout cap. */
export const GPMF_CORI_ARGS = ['--streams', 'CORI,GRAV'];

/**
 * Per-frame orientation file (see encodeOrientation) from the original GPMF
 * data, or null when the file has no CORI. Sample i belongs to video frame i;
 * when the CORI count differs from the video frame count the track is
 * resampled by timestamp and `resampled` is set.
 * @param {{frames?:number, fps?:number, durationSec?:number}} [video] overrides the probe
 */
export async function captureOrientation(file, video = {}, bin = gpmfBin()) {
  const raw = await readGpmf(file, bin, GPMF_CORI_ARGS);
  const cori = raw?.streams?.CORI?.samples;
  if (!cori || cori.length < 2) return null;
  let { frames, fps, durationSec } = video;
  if (!(frames > 0) || !(fps > 0)) {
    try {
      const info = await probeHeader(file);
      const v = info.streams?.find((s) => s.codec_type === 'video');
      const [a, b] = String(v?.avg_frame_rate || v?.r_frame_rate || '0/1').split('/').map(Number);
      const rate = b ? a / b : 0;
      const dur = Number(v?.duration) || Number(info.format?.duration) || 0;
      if (rate > 0) fps = fps > 0 ? fps : rate;
      if (!(durationSec > 0) && dur > 0) durationSec = dur;
      if (!(frames > 0)) frames = Number(v?.nb_frames) || (dur > 0 && rate > 0 ? Math.round(dur * rate) : 0);
    } catch { /* fall back to the CORI timeline below */ }
  }
  if (!(durationSec > 0)) durationSec = Number(raw.durationSec) || 0;
  if (!(frames > 0)) frames = cori.length;
  if (!(fps > 0)) fps = durationSec > 0 ? frames / durationSec : 30;
  const track = buildTrack(cori, raw.streams.GRAV?.samples, { frames, fps, durationSec });
  return {
    buffer: encodeOrientation({ quats: track.quats, grav: track.grav, fps }),
    frames,
    fps,
    srcCount: track.srcCount,
    resampled: track.resampled,
    hasGrav: track.hasGrav,
  };
}

export function orientationLogLine(o) {
  if (!o) return 'orientation: skipped (no CORI)';
  const note = o.resampled ? ` (CORI ${o.srcCount} samples resampled to ${o.frames} frames)` : '';
  return `orientation: stored ${o.buffer.length} bytes, ${o.frames} frames @ ${o.fps.toFixed(3)} fps${note}`;
}
