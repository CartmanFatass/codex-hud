/** Compact text for main-session MCP tool results; the JSON-RPC envelope is unchanged. */
const FILES_SHOWN = 5;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Values HUD's compact rows already leave out when they say nothing. */
const quiet = (key: string, v: unknown): boolean =>
  v === undefined ||
  (v === null
    ? key !== 'open_questions'
    : (v === '' && key !== 'report') ||
      (typeof v === 'object' && !Object.keys(v).length) ||
      (v === false && (key === 'blocked' || key === 'report_unread' || key === 'report_truncated')) ||
      (v === 0 && key === 'open_questions'));

/** `["a","b",…,"+4 more"]` -> `10: a, b, c, d, e +5 more`; short lists stay as they are. */
function files(list: string[]): string | string[] {
  const more = /^\+(\d+) more$/.exec(list.at(-1) ?? '');
  const names = more ? list.slice(0, -1) : list;
  const total = names.length + (more ? Number(more[1]) : 0);
  if (total <= FILES_SHOWN) return list;
  return `${total}: ${names.slice(0, FILES_SHOWN).join(', ')} +${total - FILES_SHOWN} more`;
}

function squeezeRecord(value: Record<string, unknown>): Record<string, unknown> {
  if (value.ok === false) return value;
  const kept = Object.entries(value).map(([k, x]) => [k, squeeze(x, k)] as const).filter(([k, x]) => !quiet(k, x));
  const tree = Object.fromEntries(kept);
  // Say it once: a value a sibling already carries.
  const last = Array.isArray(tree.progress) ? tree.progress.at(-1) : undefined;
  if (last !== undefined && JSON.stringify(last) === JSON.stringify(tree.latest_progress)) delete tree.latest_progress;
  if (tree.display_state === tree.state) delete tree.display_state;
  const digest = tree.digest;
  if (isRecord(digest) && digest.ok !== false) {
    if (digest.state === tree.state) delete digest.state;
    if (typeof tree.changed_files === 'string' && tree.changed_files.startsWith(`${digest.changed_files}:`)) delete digest.changed_files;
  }
  return tree;
}

function squeeze(v: unknown, key: string): unknown {
  if (Array.isArray(v)) {
    if (key === 'changed_files' && v.every((item) => typeof item === 'string')) return files(v);
    return v.map((item) => squeeze(item, ''));
  }
  return isRecord(v) ? squeezeRecord(v) : v;
}

/** Keep nested rows in JSON, including report_path, report_bytes and next_offset for paged reads. */
export function compactResult(value: unknown): string {
  if (!isRecord(value) || value.ok === false) return JSON.stringify(value);
  const { changes, ...rest } = value;
  const events = Array.isArray(changes) && changes.every((line) => typeof line === 'string') ? changes : undefined;
  const fields = Object.entries(squeezeRecord(events ? rest : value));
  // An empty answer still needs to say what is empty (e.g. `jobs: []`).
  if (!fields.length && !events?.length) fields.push(...Object.entries(value).filter(([, v]) => v !== undefined));
  const out = fields.map(([k, v]) => `${k}: ${typeof v === 'string' && v && !/[\r\n]/.test(v) ? v : JSON.stringify(v)}`);
  // The Claude mod merges this trailing section with its Monitor/wake lines, without touching other fields.
  if (events?.length) out.push('changes:', ...events.map((line) => `- ${/[\r\n]/.test(line) ? JSON.stringify(line) : line}`));
  return out.length ? out.join('\n') : '{}';
}
