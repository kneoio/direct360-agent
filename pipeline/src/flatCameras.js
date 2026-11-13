/**
 * A normal (non-360) video is one camera: the whole frame. The render scales
 * it to fit inside the output, keeps its aspect and pads the rest black
 * (16:9 into 9:16 and vertical into 16:9 both get bars). No crop, no pan.
 * Lens and pole settings do not apply.
 */
import { getFormat, outputSize } from './formats.js';

function sourceSize(srcW, srcH) {
  const w = Math.floor(Number(srcW));
  const h = Math.floor(Number(srcH));
  if (!(w >= 2) || !(h >= 2)) throw new Error(`flat source must be at least 2×2, got ${srcW}×${srcH}`);
  return { w, h };
}

/**
 * The one flat camera. `windows` holds that single full-frame rectangle in
 * source pixels; yaws/pitches/layout keep the shape a 360 grid has so the
 * edit list's camera number (always 1) still addresses a camera.
 */
export function flatAims(srcW, srcH, format) {
  getFormat(format);
  const { w, h } = sourceSize(srcW, srcH);
  return {
    mode: 'flat',
    windows: [{ x: 0, y: 0, w, h }],
    source: { width: w, height: h },
    yaws: [0],
    pitches: [0],
    layout: [1],
    lenses: null,
    cameras: 1,
  };
}

/** The edit list of a flat video: always this, set by the server. */
export function flatEdl() {
  return [{ t: 0, camera: 1 }];
}

/**
 * A flat video has one camera and no cuts, so its edit list is exactly
 * [{t: 0, camera: 1}]. Anything else is refused, never repaired.
 */
export function assertFlatEdl(edl) {
  const ok = Array.isArray(edl) && edl.length === 1
    && edl[0] && typeof edl[0] === 'object'
    && edl[0].camera === 1 && edl[0].t === 0;
  if (!ok) {
    throw new Error(`flat video has one camera: edl must be exactly [{"t":0,"camera":1}], got ${JSON.stringify(edl)}`);
  }
}

function evenDown(n) {
  const v = Math.floor(n);
  return Math.max(2, v - (v % 2));
}

function evenNearest(n) {
  return Math.max(2, Math.round(n / 2) * 2);
}

/**
 * Where the whole source frame lands inside the output: the largest even
 * size with the source aspect that fits, centred on even offsets.
 */
export function flatFit(srcW, srcH, outW, outH) {
  const { w: sw, h: sh } = sourceSize(srcW, srcH);
  if (!(outW >= 2) || !(outH >= 2)) throw new Error(`flat output must be at least 2×2, got ${outW}×${outH}`);
  const scale = Math.min(outW / sw, outH / sh);
  const w = Math.min(evenDown(outW), evenNearest(sw * scale));
  const h = Math.min(evenDown(outH), evenNearest(sh * scale));
  const evenOffset = (gap) => { const v = Math.floor(gap / 2); return v - (v % 2); };
  const x = evenOffset(outW - w);
  const y = evenOffset(outH - h);
  return { w, h, x, y };
}

/** ffmpeg filter chain: scale the whole frame to fit, pad black to the output. */
export function flatFitFilter(srcW, srcH, outW, outH) {
  const { w, h, x, y } = flatFit(srcW, srcH, outW, outH);
  return `scale=${w}:${h}:flags=bilinear,pad=${outW}:${outH}:${x}:${y}:black,setsar=1,setpts=PTS-STARTPTS`;
}

/**
 * True when fitting the frame into the format's final size has to enlarge it
 * (the source is smaller than the picture the output shows).
 */
export function flatLowRes(srcW, srcH, format) {
  const { w, h } = sourceSize(srcW, srcH);
  const { width, height } = outputSize(format);
  return Math.min(width / w, height / h) > 1;
}

/** Preview proxy size: long side at most 2048, aspect kept, even pixels, never upscaled. */
export function flatProxySize(srcW, srcH, maxLong = 2048) {
  const w = Math.max(2, Math.floor(srcW));
  const h = Math.max(2, Math.floor(srcH));
  const long = Math.max(w, h);
  if (long <= maxLong) return { w: w - (w % 2), h: h - (h % 2) };
  const scale = maxLong / long;
  let pw = Math.round(w * scale);
  let ph = Math.round(h * scale);
  pw -= pw % 2;
  ph -= ph % 2;
  if (pw < 2) pw = 2;
  if (ph < 2) ph = 2;
  return { w: pw, h: ph };
}
