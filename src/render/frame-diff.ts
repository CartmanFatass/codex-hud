/** Paint only changed terminal rows; a resize/first frame invalidates the cache. */
export function frameDiff(previous: readonly string[] | null, next: readonly string[]): string {
  let output = '';
  const rows = Math.max(previous?.length ?? 0, next.length);
  for (let i = 0; i < rows; i++) {
    const line = next[i] ?? '';
    if (previous && i < previous.length && i < next.length && previous[i] === line) continue;
    // Absolute positioning also cancels pending wrap at the rightmost cell.
    output += `\x1b[${i + 1};1H\x1b[0m${line}\x1b[0m\x1b[K`;
  }
  return output;
}
