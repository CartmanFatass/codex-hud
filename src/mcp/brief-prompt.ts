import { readFileSync, statSync } from 'node:fs';

export const INLINE_PROMPT_LIMIT = 16 * 1024;

/** Read a UTF-8 file for argv inlining when strictly below the byte limit and NUL-free. */
export function readInlineText(path: string, limit = INLINE_PROMPT_LIMIT): string | null {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size >= limit) return null;
    const buf = readFileSync(path);
    // A NUL is valid file content but cannot travel in herdr's argv.
    if (buf.length >= limit || buf.includes(0)) return null;
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

/** First worker message, using the complete assembled brief (including context references). */
export function briefPrompt(path: string): string {
  const brief = readInlineText(path);
  if (brief !== null) return `Carry out this brief:\n\n${brief}`;
  return `Read ${path} and do exactly what it asks.`;
}
