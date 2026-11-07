// Ported from the owner's jev-ask (jev_send.py mask_label, mask_account, public).
// Account-shaped fragments stay out of logs, records that get printed, and tool results.

/**
 * Python `re` `\s` for a `str` pattern: the same 29 characters as `str.isspace`,
 * which is not JavaScript's `\s` (that one includes U+FEFF and omits U+0085 and U+001C–U+001F).
 */
const PY_SPACE_CLASS =
  '\\t\\n\\u000b\\f\\r\\u001c\\u001d\\u001e\\u001f \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const ACCOUNT_FRAGMENT = new RegExp(`[^${PY_SPACE_CLASS},;'"()\\[\\]{}]*@[^${PY_SPACE_CLASS},;'"()\\[\\]{}]*`, 'gu');

export function maskLabel(label: string | null | undefined): string | null {
  if (label == null) return null;
  return label.includes('@') ? '<account>' : label;
}

export function maskAccount<T>(value: T): T {
  if (typeof value === 'string') return value.replace(ACCOUNT_FRAGMENT, '<account>') as T;
  if (Array.isArray(value)) return value.map((item) => maskAccount(item)) as T;
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = maskAccount(item);
    return out as T;
  }
  return value;
}

/**
 * Printed send/wait/reconcile results. Conversation addresses and the sidebar
 * digest stay in the operation file unless the caller passed show-url.
 */
export function publicResult(result: unknown, showUrl: boolean): unknown {
  if (!isPlainObject(result)) return maskAccount(result);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(result)) {
    if (showUrl && key === 'conversation_url') out[key] = value;
    else if (!showUrl && (key === 'conversation_url' || key === 'sidebar_before') && pyTruthy(value))
      out[key] = 'recorded locally';
    else out[key] = maskAccount(value);
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Python truthiness: 0, '', [], and {} are false. NaN is true, as in CPython. */
function pyTruthy(value: unknown): boolean {
  if (value == null || value === false || value === '') return false;
  if (typeof value === 'number') return value !== 0;
  if (Array.isArray(value)) return value.length > 0;
  if (isPlainObject(value)) return Object.keys(value).length > 0;
  return true;
}
