/**
 * A picture drawn in text, for the empty stretch of the tree panel.
 *
 * Decoration only: it goes where nothing else wants the rows and leaves as
 * soon as something does. The picture is kept as a small RGBA bitmap and
 * redrawn to whatever room there is, in one of three styles:
 *
 *   dots   braille cells, 2×4 dots each: a dot wherever the picture is dark,
 *          the dot-matrix look, in the panel's muted colour
 *   color  the same dots, each cell in the colour of the picture under it
 *   ascii  one character per cell from a density ramp, " .:-=+*#%@"
 *
 * Dark means darker than a threshold chosen per picture (from Otsu's split), so
 * a light background and a light face drop out while hair and outlines stay.
 * Transparent pixels count as background.
 */
import { colors } from './colors.js';

export type ArtStyle = 'off' | 'dots' | 'color' | 'ascii';

export interface ArtBitmap {
  width: number;
  height: number;
  /** RGBA, row by row. */
  data: Uint8Array;
}

/** Smallest art worth drawing; under this it reads as noise, not a picture. */
export const MIN_ART_ROWS = 6;
const MAX_ART_ROWS = 28;
const RAMP = ' .:-=+*#%@';
const BRAILLE_BITS = [[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]];

interface Prepared { lum: Float32Array; alpha: Float32Array; threshold: number }
const prepared = new WeakMap<ArtBitmap, Prepared>();
const drawn = new WeakMap<ArtBitmap, Map<string, string[]>>();

function prepare(bitmap: ArtBitmap): Prepared {
  const cached = prepared.get(bitmap);
  if (cached) return cached;
  const n = bitmap.width * bitmap.height;
  const lum = new Float32Array(n);
  const alpha = new Float32Array(n);
  const histogram = new Array<number>(256).fill(0);
  for (let i = 0; i < n; i++) {
    const [r, g, b, a] = bitmap.data.subarray(i * 4, i * 4 + 4);
    alpha[i] = a / 255;
    // Transparent reads as white: background.
    lum[i] = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 * alpha[i] + (1 - alpha[i]);
    if (alpha[i] > 0.5) histogram[Math.round(lum[i] * 255)]++;
  }
  // Halfway between the dark population's mean and the split, rather than at
  // the split: highlights inside dark areas (strands of hair, the shine on a
  // sleeve) drop out and show as texture, where the split fills them solid.
  // Outlines are far darker and stay.
  const { split, meanBelow } = otsu(histogram);
  const result = { lum, alpha, threshold: (meanBelow + split + 1) / 2 / 255 };
  prepared.set(bitmap, result);
  return result;
}

/** The split of a luminance histogram that best separates two populations. */
function otsu(histogram: number[]): { split: number; meanBelow: number } {
  const total = histogram.reduce((a, b) => a + b, 0);
  if (!total) return { split: 127, meanBelow: 127 };
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * histogram[i];
  let below = 0, sumBelow = 0, best = -1, split = 127, splitMean = 127;
  for (let i = 0; i < 256; i++) {
    below += histogram[i];
    if (!below || below === total) continue;
    sumBelow += i * histogram[i];
    const meanBelow = sumBelow / below;
    const meanAbove = (sum - sumBelow) / (total - below);
    const between = below * (total - below) * (meanBelow - meanAbove) ** 2;
    if (between > best) { best = between; split = i; splitMean = meanBelow; }
  }
  return { split, meanBelow: splitMean };
}

/**
 * The largest drawing of the picture that fits, keeping its proportions.
 * A terminal cell is about twice as tall as it is wide, so a picture `a`
 * times as wide as it is tall takes 2·a columns per row in every style.
 */
export function artSize(bitmap: ArtBitmap, maxCols: number, maxRows: number): { cols: number; rows: number } | null {
  const aspect = bitmap.width / bitmap.height;
  let rows = Math.min(MAX_ART_ROWS, maxRows, Math.floor(maxCols / (2 * aspect)));
  if (rows < MIN_ART_ROWS) return null;
  const cols = Math.max(1, Math.round(2 * aspect * rows));
  return cols <= maxCols ? { cols, rows } : null;
}

/** Average of the bitmap over a box in its own pixels, with the dark pixels' colour. */
function sample(bitmap: ArtBitmap, p: Prepared, x0: number, y0: number, x1: number, y1: number): { lum: number; dark: number; rgb: [number, number, number] | null } {
  const xa = Math.max(0, Math.floor(x0)), xb = Math.min(bitmap.width, Math.max(xa + 1, Math.ceil(x1)));
  const ya = Math.max(0, Math.floor(y0)), yb = Math.min(bitmap.height, Math.max(ya + 1, Math.ceil(y1)));
  let lum = 0, count = 0, dark = 0, r = 0, g = 0, b = 0;
  for (let y = ya; y < yb; y++) for (let x = xa; x < xb; x++) {
    const i = y * bitmap.width + x;
    lum += p.lum[i]; count++;
    if (p.lum[i] < p.threshold && p.alpha[i] > 0.5) {
      dark++;
      r += bitmap.data[i * 4]; g += bitmap.data[i * 4 + 1]; b += bitmap.data[i * 4 + 2];
    }
  }
  return { lum: count ? lum / count : 1, dark: count ? dark / count : 0, rgb: dark ? [r / dark, g / dark, b / dark] : null };
}

/**
 * Lift a colour until it shows on a dark background: black outlines would
 * otherwise draw dots nobody can see. Hue is kept; only lightness moves.
 */
function visible([r, g, b]: [number, number, number]): string {
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const floor = 110;
  const lift = lum >= floor ? 0 : (floor - lum) / (255 - lum);
  const mix = (c: number) => Math.round(c + (255 - c) * lift);
  return `\x1b[38;2;${mix(r)};${mix(g)};${mix(b)}m`;
}

export function renderArt(bitmap: ArtBitmap, style: Exclude<ArtStyle, 'off'>, cols: number, rows: number): string[] {
  const key = `${style}:${cols}x${rows}`;
  let cache = drawn.get(bitmap);
  if (!cache) { cache = new Map(); drawn.set(bitmap, cache); }
  const hit = cache.get(key);
  if (hit) return hit;
  const p = prepare(bitmap);
  const lines: string[] = [];
  if (style === 'ascii') {
    const cw = bitmap.width / cols, ch = bitmap.height / rows;
    for (let row = 0; row < rows; row++) {
      let line = '';
      for (let col = 0; col < cols; col++) {
        // The share of the cell that is ink picks the character, the same
        // rule the dots follow: a solid area is '@', an edge is lighter.
        const { dark } = sample(bitmap, p, col * cw, row * ch, (col + 1) * cw, (row + 1) * ch);
        line += RAMP[Math.round(dark * (RAMP.length - 1))];
      }
      lines.push(colors.dim(line.replace(/\s+$/, '')));
    }
  } else {
    const dw = bitmap.width / (cols * 2), dh = bitmap.height / (rows * 4);
    for (let row = 0; row < rows; row++) {
      let line = '';
      let pending = '';
      for (let col = 0; col < cols; col++) {
        let bits = 0;
        for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 2; dx++) {
          const x = col * 2 + dx, y = row * 4 + dy;
          if (sample(bitmap, p, x * dw, y * dh, (x + 1) * dw, (y + 1) * dh).dark >= 0.5) bits |= BRAILLE_BITS[dy][dx];
        }
        // A blank braille cell is drawn as a space, so a terminal that lacks
        // the glyph shows nothing there rather than a box.
        const glyph = bits ? String.fromCharCode(0x2800 + bits) : ' ';
        if (style === 'color' && bits) {
          const { rgb } = sample(bitmap, p, col * 2 * dw, row * 4 * dh, (col + 1) * 2 * dw, (row + 1) * 4 * dh);
          line += pending + (rgb ? `${visible(rgb)}${glyph}\x1b[39m` : glyph);
          pending = '';
        } else if (bits) { line += pending + glyph; pending = ''; } else pending += ' ';
      }
      lines.push(style === 'color' ? line : colors.dim(line));
    }
  }
  cache.set(key, lines);
  return lines;
}
