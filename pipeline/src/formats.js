/**
 * Output formats — the shape of the final video. The camera grid's cells use
 * the same shape, so what you pick from is framed like what you'll get.
 *
 * `grid` is cols×rows. `aims` is row-major: [yaw, pitch] in degrees for a
 * camera, null for a blind cell. Blind cells stay black in the matrix video.
 * Yaw 0 / pitch 0 is the center of the equirect frame (the front lens on a
 * stitched GoPro), so yaws past ±90 look through the back lens. The angles
 * assume the default 100° field of view across the frame's long side.
 *
 * `lenses` names two blind cells that show the whole front and back lens as
 * fisheye circles, so the editor can draw each camera's share of the lens
 * on top of them.
 */
const __ = null;

export const FORMATS = {
  youtube: {
    label: 'YouTube 16:9',
    aspect: [16, 9],
    // `final` is the default download. `resolutions` are the sizes a final
    // render may ask for; 720p uses the same encode as 1080p, just fewer pixels.
    final: [1920, 1080],
    resolutions: [
      { id: '1080', label: '1080p', width: 1920, height: 1080 },
      { id: '720', label: '720p', width: 1280, height: 720 },
    ],
    preview: [480, 270],
    grid: '3x7',
    // The top row holds the two lens circles. Then 3×3 per lens, tilted up,
    // level, and down: front is cameras 1–9 (center 5), back is 10–18
    // (center 14), left to right as seen when facing that way.
    aims: [
      __,         __,         __,
      [-90, 50],  [0, 50],    [90, 50],
      [-90, 0],   [0, 0],     [90, 0],
      [-90, -50], [0, -50],   [90, -50],
      // Same spread as the front, swung around to face backward: 80° left,
      // center, 80° right. 90° would sit on the seam and count as the front.
      [100, 50],  [180, 50],  [-100, 50],
      [100, 0],   [180, 0],   [-100, 0],
      [100, -50], [180, -50], [-100, -50],
    ],
    lenses: { front: 0, back: 2 },
    // One lens, row-major. Applied on its own to the front cameras and again
    // to the back cameras: the level row starts on (cameras 4–6 in front,
    // 13–15 in back, six in all, as on TikTok), the tilted rows start off.
    lensOn: [
      0, 0, 0,
      1, 1, 1,
      0, 0, 0,
    ],
  },
  reels: {
    label: 'TikTok 9:16',
    aspect: [9, 16],
    final: [1080, 1920],
    resolutions: [
      { id: '1080', label: '1080p', width: 1080, height: 1920 },
      { id: '720', label: '720p', width: 720, height: 1280 },
    ],
    preview: [270, 480],
    grid: '3x5',
    // The top row holds the two lens circles. Then 3×2 per lens, level and
    // tilted down: front is 1–6 (center 2), back is 7–12 (center 8), left to
    // right as seen when facing that way.
    aims: [
      __,          __,         __,
      [-50, 0],    [0, 0],     [50, 0],
      [-50, -45],  [0, -45],   [50, -45],
      [130, 0],    [180, 0],   [-130, 0],
      [130, -45],  [180, -45], [-130, -45],
    ],
    lenses: { front: 0, back: 2 },
    // One lens, row-major. Applied on its own to each lens: the level row
    // (cameras 1–3 in front, 7–9 in back) starts on, the tilted row starts off.
    lensOn: [
      1, 1, 1,
      0, 0, 0,
    ],
  },
};

export function getFormat(name) {
  const format = FORMATS[name];
  if (!format) throw new Error(`unknown format "${name}" — use ${Object.keys(FORMATS).join(' or ')}`);
  return format;
}

/**
 * Pixel size for a render. Preview is the fixed scouting size. A download
 * uses `final` unless `resolution` names one of that format's `resolutions`.
 */
export function outputSize(format, { preview = false, resolution } = {}) {
  const spec = getFormat(format);
  if (preview) return { width: spec.preview[0], height: spec.preview[1] };
  if (resolution == null) return { width: spec.final[0], height: spec.final[1] };
  const match = spec.resolutions.find((r) => r.id === resolution);
  if (!match) {
    const ids = spec.resolutions.map((r) => r.id).join(', ');
    throw new Error(`unknown resolution "${resolution}" for ${format} — use ${ids}`);
  }
  return { width: match.width, height: match.height };
}

/** Per-camera roll (degrees) and zoom (field of view across the frame's long side). */
export const ROLL_LIMIT = 180;
export const FOV_MIN = 60;
export const FOV_MAX = 120;
export const FOV_DEFAULT = 100;

/**
 * Per-camera projection: how the camera's view is drawn from the sphere. `flat`
 * is the ordinary rectilinear view; the others are v360 outputs. Each has its
 * own range of zoom, and a camera's fov is always held inside its projection's.
 */
export const PROJECTIONS = ['flat', 'fisheye', 'planet', 'pannini'];
export const PROJECTION_DEFAULT = 'flat';
export const PROJECTION_V360 = { flat: 'flat', fisheye: 'fisheye', planet: 'sg', pannini: 'pannini' };
export const FOV_RANGES = {
  flat: { min: FOV_MIN, max: FOV_MAX, default: FOV_DEFAULT },
  fisheye: { min: 120, max: 200, default: 160 },
  planet: { min: 200, max: 300, default: 260 },
  pannini: { min: 120, max: 170, default: 140 },
};

/** A stored projection name, or "flat" for a missing or unknown one. */
export function projectionOf(value) {
  return PROJECTIONS.includes(value) ? value : PROJECTION_DEFAULT;
}

/** `fov` held inside the range of `projection`. */
export function clampFov(projection, fov) {
  const { min, max } = FOV_RANGES[projectionOf(projection)];
  return Math.min(max, Math.max(min, fov));
}

/**
 * Horizontal/vertical field of view for a flat frame: `fov` degrees across its
 * long side, the short side scaled to match — so a portrait frame gets the
 * same zoom as a landscape one, turned on its side.
 */
export function fieldOfView(width, height, fov = 100) {
  return width >= height
    ? { hfov: fov, vfov: Math.round((fov * height) / width) }
    : { hfov: Math.round((fov * width) / height), vfov: fov };
}

/**
 * v360's pannini output ignores h_fov and v_fov: it always draws about ±84°
 * across a square field, x growing with sin(longitude). Its zoom is made by
 * rendering a larger square and cropping the frame from the middle of it.
 */
const PANNINI_EDGE = Math.sin((84 * Math.PI) / 180);
export const PANNINI_FOV = 150;

/**
 * The square v360 renders for a pannini frame at `fov` degrees across its long side, as every other projection
 * measures it; the frame is cropped from its middle. (Across the width, a tall 9:16 frame never needed a square
 * larger than its height, so its zoom changed nothing.)
 */
export function panniniSide(width, height, fov) {
  const wanted = (Math.max(width, height) * PANNINI_EDGE) / Math.sin((Math.min(fov, 170) * Math.PI) / 360);
  return Math.ceil(Math.max(wanted, width, height) / 2) * 2;
}

/**
 * `fieldOfView` for a projection. Flat keeps today's maths. Fisheye is
 * equidistant, so the angle splits by the plain ratio of the sides. Planet
 * (stereographic) puts the edge at tan(fov / 4), so the short side takes the
 * same share of that tangent. Pannini has no fov in v360: it gets the fixed
 * PANNINI_FOV and `panniniSide` does the zoom.
 */
export function projectedFieldOfView(width, height, fov, projection = PROJECTION_DEFAULT, bulge = null) {
  const kind = projectionOf(projection);
  if (kind === 'pannini') return fieldOfView(width, height, PANNINI_FOV);
  let view;
  if (kind === 'flat' || kind === 'fisheye') {
    view = fieldOfView(width, height, fov);
  } else {
    const long = Math.max(width, height);
    const short = Math.min(width, height);
    const across = Math.round((4 * Math.atan((short / long) * Math.tan((fov * Math.PI) / 720)) * 180) / Math.PI);
    view = width >= height ? { hfov: fov, vfov: across } : { hfov: across, vfov: fov };
  }
  if (!hasBulge(bulge)) return view;
  // A bowed frame is drawn wider (see projectionStage), so the view widens with it.
  const { ex, ey } = bulgeCanvas(width, height, bulge);
  return { hfov: widenFov(kind, view.hfov, ex), vfov: widenFov(kind, view.vfov, ey) };
}

/**
 * The pieces of a v360 view in `projection`: the `output` name, the `w` and
 * `h` v360 renders, the `crop` filter that follows when that is larger than
 * the frame (pannini only; empty otherwise), and `post`, the text to put
 * straight after the v360 filter (the crop, or for a bowed frame the warp
 * back to `width`×`height`; empty when there is nothing). A bowed frame
 * (`bulge`) is drawn larger and warped by `bulgeWarp` with remap; `tag`
 * keeps the warp's filter labels apart when one graph holds several.
 */
export function projectionStage(projection, width, height, fov, bulge = null, tag = 'w') {
  const kind = projectionOf(projection);
  if (!hasBulge(bulge)) {
    if (kind !== 'pannini') return { output: PROJECTION_V360[kind], w: width, h: height, crop: '', post: '' };
    const side = panniniSide(width, height, fov);
    return { output: 'pannini', w: side, h: side, crop: `crop=${width}:${height}`, post: `,crop=${width}:${height}` };
  }
  const q = BULGE_SUPERSAMPLE;
  let w;
  let h;
  let halfW;
  let halfH;
  if (kind === 'pannini') {
    // Pannini has no fov to widen: the square already holds all it can draw
    // (about ±84° across). The frame sits in its middle; a side bowed past
    // that square takes the square's edge.
    const side = panniniSide(width, height, fov);
    w = even(side * q);
    h = w;
    halfW = (width * w) / (2 * side);
    halfH = (height * w) / (2 * side);
  } else {
    ({ w, h } = bulgeCanvas(width, height, bulge));
    halfW = (width * q) / 2;
    halfH = (height * q) / 2;
  }
  return {
    output: PROJECTION_V360[kind], w, h, crop: '',
    post: bulgeRemap(bulge, { srcW: w, srcH: h, halfW, halfH, outW: width * q, outH: height * q, width, height, tag }),
  };
}

/**
 * The remap that warps a larger v360 view (srcW×srcH, the straight frame's
 * half-size halfW×halfH pixels round its middle) into the bowed frame at
 * outW×outH, then scales it to width×height. The two maps are one frame
 * each, made by geq; remap holds them for every frame. They sit far before
 * any video time so a part that starts late still has them.
 */
function bulgeRemap(bulge, { srcW, srcH, halfW, halfH, outW, outH, width, height, tag }) {
  const n = (v) => +Number(v).toFixed(6);
  const k = (side) => n(BULGE_REACH * (Number(bulge?.[side]) || 0));
  // u right, v up, both -1..1 over the output's pixel centres.
  const u = `((2*X+1)/W-1)`;
  const v = `(1-(2*Y+1)/H)`;
  const su = `${u}*(1+if(gte(${u},0),${k('right')},${k('left')})*(1-${v}*${v}))`;
  const sv = `${v}*(1+if(gte(${v},0),${k('top')},${k('bottom')})*(1-${u}*${u}))`;
  const xmap = `clip(floor(${n(srcW / 2)}+${su}*${n(halfW)}),0,${srcW - 1})`;
  const ymap = `clip(floor(${n(srcH / 2)}-${sv}*${n(halfH)}),0,${srcH - 1})`;
  const map = (expr) => `nullsrc=s=${outW}x${outH}:d=1,format=gray16le,geq=lum='${expr}',trim=end_frame=1,setpts=PTS-1000000/TB`;
  return `[${tag}v];${map(xmap)}[${tag}x];${map(ymap)}[${tag}y];`
    + `[${tag}v][${tag}x][${tag}y]remap=fill=black,scale=${width}:${height}:flags=area`;
}
/**
 * Per-camera shape: each side of the frame can bow out or in. A value per
 * side, -1..1, 0 is today's straight side. At 1 the middle of that side sits
 * BULGE_REACH of the frame's half-size further out (the camera sees more
 * there, squeezed into the same rectangle); at -1 that far in (it sees less,
 * stretched). The corners never move. The output is still a rectangle: the
 * picture is warped, not masked. `bulgeWarp` is the one mapping the editor
 * draws with and the render samples with.
 */
export const BULGE_SIDES = ['top', 'right', 'bottom', 'left'];
export const BULGE_REACH = 0.5;
/** A bowed view is drawn this many times larger, warped, then scaled down, so its edges stay smooth. */
export const BULGE_SUPERSAMPLE = 2;

/** A stored shape with every side a number in -1..1 (two decimals); a missing or broken side is 0. */
export function bulgeOf(value) {
  const out = {};
  for (const side of BULGE_SIDES) {
    const v = Number(value?.[side]);
    out[side] = Number.isFinite(v) ? Math.round(Math.min(1, Math.max(-1, v)) * 100) / 100 : 0;
  }
  return out;
}

/** True when some side of `bulge` bows. */
export function hasBulge(bulge) {
  return BULGE_SIDES.some((side) => Boolean(Number(bulge?.[side])));
}

/** True when two shapes are the same (a missing side is 0). */
export function sameBulge(a, b) {
  return BULGE_SIDES.every((side) => (Number(a?.[side]) || 0) === (Number(b?.[side]) || 0));
}

/**
 * The point of the straight frame that the bowed frame shows at (u, v): both
 * -1..1 across the frame, v up. The top side (v = 1) lands on
 * v = 1 + BULGE_REACH * top * (1 - u²), and so on round; the corners stay.
 */
export function bulgeWarp(bulge, u, v) {
  const kx = BULGE_REACH * (Number(u >= 0 ? bulge?.right : bulge?.left) || 0);
  const ky = BULGE_REACH * (Number(v >= 0 ? bulge?.top : bulge?.bottom) || 0);
  return [u * (1 + kx * (1 - v * v)), v * (1 + ky * (1 - u * u))];
}

/** How far out of the straight frame a bowed one reaches, per axis, in frame halves (1 = no further). */
export function bulgeReach(bulge) {
  const out = (...sides) => 1 + BULGE_REACH * Math.max(0, ...sides.map((side) => Number(bulge?.[side]) || 0));
  return { x: out('left', 'right'), y: out('top', 'bottom') };
}

const even = (n) => Math.ceil(n / 2) * 2;

/**
 * The size v360 draws a bowed flat, fisheye or planet frame at: the frame
 * at BULGE_SUPERSAMPLE times, widened to hold the reach. `ex` and `ey` are
 * how much wider and taller that view is than the straight frame (after
 * rounding to even pixels), which is what the field of view grows by.
 */
function bulgeCanvas(width, height, bulge) {
  const q = BULGE_SUPERSAMPLE;
  const reach = bulgeReach(bulge);
  const w = even(width * q * reach.x);
  const h = even(height * q * reach.y);
  return { w, h, ex: w / (width * q), ey: h / (height * q) };
}

/** A field of `fov` degrees whose edge moves `k` times further out in the image plane of `kind` (flat, fisheye or planet). */
function widenFov(kind, fov, k) {
  if (k === 1) return fov;
  const r = Math.PI / 180;
  if (kind === 'flat') return (2 * Math.atan(k * Math.tan((fov * r) / 2))) / r;
  if (kind === 'fisheye') return Math.min(360, fov * k);
  return Math.min(359, (4 * Math.atan(k * Math.tan((Math.min(fov, 359) * r) / 4))) / r);
}
