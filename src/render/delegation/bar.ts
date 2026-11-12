/** The delegation counts the panel's summary row shows. */

import type { GlyphSet } from './glyphs.js';
import type { GlyphCounts } from './projection.js';
import { paint } from './style.js';

/** `3▸ 1· 1⚑ 1? 1⚠ 1✗ 9✓`, only the non-zero kinds (§3.3 "计数"). */
export function countParts(counts: GlyphCounts, g: GlyphSet): string[] {
  const parts: string[] = [];
  const add = (n: number, glyph: string, role: Parameters<typeof paint>[0]) => {
    if (n > 0) parts.push(paint(role, `${n}${glyph}`));
  };
  add(counts.working, g.marker.working, 'info');
  add(counts.starting, g.marker.starting, 'muted');
  add(counts.flag, g.marker.flag, 'alert');
  add(counts.unknown, g.marker.unknown, 'warning');
  add(counts.warn, g.marker.warn, 'warning');
  add(counts.fail, g.barFail, 'danger');
  // Done is `✓` and `■` together: counted by marker, not by fact (§3.2).
  add(counts.done + counts.stop, g.marker.done, 'success');
  return parts;
}
