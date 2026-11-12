/** Paint only changed terminal rows; a resize/first frame invalidates the cache. */
export function frameDiff(previous: readonly string[] | null, next: readonly string[]): string {
  let output = '';
  const rows = Math.max(previous?.length ?? 0, next.length);
  for (let i = 0; i < rows; i++) {
    const line = next[i] ?? '';
    if (previous && i < previous.length && i < next.length && previous[i] === line) continue;
    // Absolute positioning also cancels pending wrap at the rightmost cell. The row is erased before it is written:
    // after a full-width line the cursor still sits on the last cell, so an erase-to-end-of-line afterwards would
    // wipe that cell (a hint ending in "open" showed "ope").
    output += `\x1b[${i + 1};1H\x1b[0m\x1b[K${line}\x1b[0m`;
  }
  return output;
}
