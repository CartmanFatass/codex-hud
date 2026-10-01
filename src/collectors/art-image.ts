/**
 * Reads the panel's decoration picture into a small RGBA bitmap.
 *
 * ffmpeg does the decoding, so any format it knows works (PNG, JPEG, WebP,
 * GIF's first frame) without an image library in the package. The picture is
 * scaled down once, here, to at most MAX_SIDE pixels a side: the largest
 * drawing the panel makes is about 112 braille dots across, and the art
 * renderer averages over boxes, so more pixels would only cost memory.
 * No ffmpeg, an unreadable file or anything else: the promise rejects and the
 * panel goes without decoration.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ArtBitmap } from '../render/art.js';

const exec = promisify(execFile);
const MAX_SIDE = 240;
const TIMEOUT_MS = 15_000;

export async function loadArtImage(file: string): Promise<ArtBitmap> {
  const { stdout: probe } = await exec('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', '--', file], { timeout: TIMEOUT_MS });
  const [w, h] = probe.trim().split('x').map(Number);
  if (!(w > 0 && h > 0)) throw new Error('not an image');
  const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
  const width = Math.max(1, Math.round(w * scale));
  const height = Math.max(1, Math.round(h * scale));
  // `file:` keeps a path that looks like a protocol or an option a path.
  const { stdout } = await exec('ffmpeg', ['-v', 'error', '-i', `file:${file}`, '-frames:v', '1',
    '-vf', `scale=${width}:${height}:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'],
  { timeout: TIMEOUT_MS, encoding: 'buffer', maxBuffer: MAX_SIDE * MAX_SIDE * 4 + 1024 });
  if (stdout.length !== width * height * 4) throw new Error('image decode was cut short');
  return { width, height, data: new Uint8Array(stdout.buffer, stdout.byteOffset, stdout.length) };
}
