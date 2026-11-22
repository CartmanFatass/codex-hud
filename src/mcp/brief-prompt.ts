import { readFileSync, statSync } from 'node:fs';

/** First worker message, using the complete assembled brief (including context references). */
export function briefPrompt(path: string): string {
  if (statSync(path).size < 16 * 1024) {
    const brief = readFileSync(path, 'utf8');
    // A NUL is valid file content but cannot travel in herdr's argv.
    if (!brief.includes('\0')) return `Carry out this brief:\n\n${brief}`;
  }
  return `Read ${path} and do exactly what it asks.`;
}
