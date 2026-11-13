/**
 * The ffmpeg side of the info overlay: is libass here, and how an ASS file is
 * burned into a chunk's filter chain. Kept apart from the ASS builder because
 * the render code (edl.js) needs this and the builder needs edl.js.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FFMPEG, run } from './encoder.js';

export const OVERLAY_FONT = fileURLToPath(new URL('../lib/fonts/DejaVuSansMono.ttf', import.meta.url));
export const OVERLAY_FONT_DIR = path.dirname(OVERLAY_FONT);
export const OVERLAY_FONT_FAMILY = 'DejaVu Sans Mono';
/** The speed reads like a dashboard. In the same folder, so the burn's `fontsdir` finds it. */
export const SPEED_FONT = fileURLToPath(new URL('../lib/fonts/Digital Play Italic St.ttf', import.meta.url));
export const SPEED_FONT_FAMILY = 'Digital Play Italic St';
export const OVERLAY_UNAVAILABLE = 'overlay_unavailable';
export function overlayUnavailable(detail) {
  return Object.assign(new Error(`${OVERLAY_UNAVAILABLE}: ${detail}`), { code: OVERLAY_UNAVAILABLE });
}

/** True when this ffmpeg has the `ass` filter (libass). Never throws. */
export async function libassAvailable(bin = FFMPEG) {
  try {
    const out = await run(bin, ['-hide_banner', '-filters']);
    return /^\s*\S+\s+ass\s+V->V/m.test(String(out));
  } catch {
    return false;
  }
}

/**
 * Throws `overlay_unavailable` unless the overlay can be burned here: libass in
 * ffmpeg and the bundled fonts on disk. Callers log the error and fail the
 * render; a requested overlay is never silently dropped.
 */
export async function assertOverlayAvailable({ bin = FFMPEG, font = OVERLAY_FONT, speedFont = SPEED_FONT, available = libassAvailable } = {}) {
  if (!(await available(bin))) throw overlayUnavailable('this ffmpeg was built without libass');
  for (const file of [font, speedFont]) {
    if (!fs.existsSync(file)) throw overlayUnavailable(`the bundled font is missing (${file})`);
  }
}

/**
 * Path escaped for use inside a single-quoted ffmpeg filter option. Windows separators become `/` (ffmpeg takes them
 * there too), so `C:\\Users\\x.cmd` is `C\\:/Users/x.cmd`: a drive colon and backslashes would otherwise break the
 * filter text.
 */
export function filterPath(file) {
  return String(file).replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\\\\\'");
}

/**
 * Appends the `ass` burn-in to a filter chain that ends with its own
 * `setpts=PTS-STARTPTS`. The file's times are those of the whole part; a chunk
 * starts `offsetSec` into it, so its timestamps are moved there for the burn
 * and back after.
 */
export function withOverlay(chain, overlay) {
  if (!overlay?.assFile) return chain;
  const offset = Number(overlay.offsetSec) || 0;
  const dir = overlay.fontsDir || OVERLAY_FONT_DIR;
  return `${chain},setpts=PTS+${offset.toFixed(6)}/TB,ass=filename='${filterPath(overlay.assFile)}':fontsdir='${filterPath(dir)}',setpts=PTS-STARTPTS`;
}

