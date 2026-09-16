/**
 * Tiny trend rendering.
 *
 * The scale is fixed to 0-100 rather than auto-fitted to the data, so a flat
 * line means flat and a rise means a rise. An auto-scaled sparkline turns
 * noise into drama, which is the opposite of what a status panel is for.
 */

const TICKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

export function sparkline(values: number[], width: number): string {
  if (width <= 0 || values.length === 0) {
    return '';
  }

  // Keep the most recent `width` samples; older ones fall off the left.
  const slice = values.slice(-width);
  return slice
    .map((value) => {
      const clamped = Math.max(0, Math.min(100, value));
      const index = Math.min(TICKS.length - 1, Math.floor((clamped / 100) * TICKS.length));
      return TICKS[index];
    })
    .join('');
}
