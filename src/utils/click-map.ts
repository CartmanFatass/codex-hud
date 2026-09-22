/**
 * What a click on the status bar means.
 *
 * The bar is one line of separate fields, so a click on it is not one gesture
 * but several. Clicking the alert or the agent counts is a request to go and
 * look, which wants the keyboard in the panel; clicking a meter is a request
 * to see more of it, which does not, because taking focus out of Codex
 * mid-sentence is worse than the extra keypress. Anything else — a separator,
 * the padding, a field with no panel behind it — keeps the old meaning, which
 * is that the bar is a toggle.
 */

export interface ClickSegment {
  id: string;
  x: number;
  width: number;
}

export type ClickAction = 'toggle' | 'open' | 'open-focus';

/** Fields you click because you intend to read and drive the panel. */
const FOCUS_FIELDS = new Set(['attention', 'agents', 'hint']);
/** Fields the panel elaborates on, but that you are only glancing at. */
const OPEN_FIELDS = new Set(['context', 'quota', 'tokens', 'tasks']);

export function segmentAt(segments: ClickSegment[], x: number): ClickSegment | undefined {
  if (!Number.isFinite(x)) {
    return undefined;
  }
  return segments.find((segment) => x >= segment.x && x < segment.x + segment.width);
}

export function clickAction(segments: ClickSegment[], x: number): ClickAction {
  const segment = segmentAt(segments, x);
  if (!segment) {
    return 'toggle';
  }
  if (FOCUS_FIELDS.has(segment.id)) {
    return 'open-focus';
  }
  if (OPEN_FIELDS.has(segment.id)) {
    return 'open';
  }
  return 'toggle';
}

/**
 * Entry point for `node -e`-free use from the shell: given the snapshot's JSON
 * and a column, print the action. Unreadable input is not an error worth
 * reporting to someone who just clicked; it is a plain toggle, as before.
 */
export function clickActionFromSnapshot(json: string, x: number): ClickAction {
  try {
    const parsed = JSON.parse(json) as { bar?: { segments?: ClickSegment[] } };
    const segments = parsed?.bar?.segments;
    if (!Array.isArray(segments)) {
      return 'toggle';
    }
    return clickAction(
      segments.filter(
        (segment): segment is ClickSegment =>
          typeof segment?.id === 'string' &&
          Number.isFinite(segment?.x) &&
          Number.isFinite(segment?.width)
      ),
      x
    );
  } catch {
    return 'toggle';
  }
}
