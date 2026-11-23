// Pure helpers of the HUD mod: no engine calls, so register.ts and the tests share them.

/** Job and flow ids, question replies: what a HUD line starts with, so other Monitor output is left alone. */
const HUD_LINE = /^(?:[jf][0-9a-f]{16}(?:-\d+)?\b|\[[^\]\n]+\] QUESTION q\d+:|\[sonic j[0-9a-f]{16}\])/;
const FILES_SHOWN = 5;

/** What this turn already delivered: HUD lines, and the Monitor tasks whose rows were shown. */
export type Turn = { seen: Set<string>; tasks: Set<string> };
export const newTurn = (): Turn => ({ seen: new Set(), tasks: new Set() });
export const bytes = (text: string): number => new TextEncoder().encode(text).length;

const isTree = (v: unknown): v is Record<string, unknown> | unknown[] => typeof v === 'object' && v !== null;

/** Values HUD's own compact rows already leave out when they say nothing: absent means these. */
const quiet = (key: string, v: unknown): boolean =>
  v === null || v === '' || (isTree(v) && !Object.keys(v).length) ||
  (v === false && (key === 'blocked' || key === 'report_unread' || key === 'report_truncated')) ||
  (v === 0 && key === 'open_questions');

/** `["a","b",…,"+4 more"]` -> `10: a, b, c, d, e +5 more`; short lists stay as they are. */
function files(list: string[]): string | string[] {
  const more = /^\+(\d+) more$/.exec(list.at(-1) ?? '');
  const names = more ? list.slice(0, -1) : list;
  const total = names.length + (more ? Number(more[1]) : 0);
  if (total <= FILES_SHOWN) return list;
  return `${total}: ${names.slice(0, FILES_SHOWN).join(', ')} +${total - FILES_SHOWN} more`;
}

function squeeze(v: unknown, key = ''): unknown {
  if (Array.isArray(v)) {
    const items = v.map((item) => squeeze(item));
    return key === 'changed_files' && items.every((item) => typeof item === 'string') ? files(items as string[]) : items;
  }
  if (!isTree(v)) return v;
  const kept = Object.entries(v).map(([k, x]) => [k, squeeze(x, k)] as const).filter(([k, x]) => !quiet(k, x));
  const tree = Object.fromEntries(kept);
  // Say it once: a value a sibling already carries.
  const last = Array.isArray(tree.progress) ? tree.progress.at(-1) : undefined;
  if (last !== undefined && JSON.stringify(last) === JSON.stringify(tree.latest_progress)) delete tree.latest_progress;
  if (tree.display_state === tree.state) delete tree.display_state;
  const digest = tree.digest;
  if (isTree(digest) && !Array.isArray(digest)) {
    if (digest.state === tree.state) delete digest.state;
    if (typeof tree.changed_files === 'string' && tree.changed_files.startsWith(`${digest.changed_files}:`)) delete digest.changed_files;
  }
  return tree;
}

/**
 * One HUD tool result (the JSON the MCP server sent) as compact text, or undefined when it is not one to touch.
 * `changes` lines this turn already delivered (a Monitor row said them first) are left out.
 * Keep report_path, report_bytes and next_offset so the model can continue a paged read, even from a batch row.
 */
export function compactResult(raw: string, turn: Turn): string | undefined {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return undefined; }
  if (!isTree(value) || Array.isArray(value) || value.ok === false) return undefined;
  const { changes, ...rest } = value;
  const lines = Array.isArray(changes) && changes.every((line) => typeof line === 'string') ? changes as string[] : undefined;
  const body = squeeze(changes !== undefined && !lines ? value : rest) as Record<string, unknown>;
  const out = Object.entries(body).map(([k, v]) => `${k}: ${typeof v === 'string' && v && !v.includes('\n') ? v : JSON.stringify(v)}`);
  const fresh = (lines ?? []).filter((line) => !turn.seen.has(line));
  for (const line of lines ?? []) turn.seen.add(line);
  if (fresh.length) out.push('changes:', ...fresh.map((line) => `- ${line}`));
  return out.length ? out.join('\n') : undefined;
}

const EVENT = /<event>([\s\S]*?)<\/event>/;
const TASK = /<task-id>([^<]*)<\/task-id>\n?/;
const SUMMARY = /<summary>[\s\S]*?<\/summary>\n?/;

/**
 * One Monitor notification row that carries HUD lines, with the lines this turn already delivered left out.
 * A row cannot be dropped, only rewritten: a later row of a task shown before shrinks to what is new, without
 * its task id and summary. Other rows: undefined.
 */
export function mergeNotice(text: string, turn: Turn): string | undefined {
  const event = text.startsWith('<task-notification>') ? EVENT.exec(text) : null;
  const all = (event?.[1] ?? '').split('\n');
  if (!all.some((line) => HUD_LINE.test(line))) return undefined;
  const lines = all.filter((line) => {
    if (!HUD_LINE.test(line)) return true;
    if (turn.seen.has(line)) return false;
    turn.seen.add(line);
    return true;
  });
  const task = TASK.exec(text)?.[1] ?? '';
  const again = turn.tasks.has(task);
  turn.tasks.add(task);
  if (!again && lines.length === all.length) return undefined;
  const wrapped = text.replace(EVENT, () => `<event>${lines.length ? lines.join('\n') : '(HUD events already shown this turn)'}</event>`);
  return again ? wrapped.replace(TASK, '').replace(SUMMARY, '') : wrapped;
}

// A job id, or a shell variable/glob standing for one: another project's own jobs/ folder is not HUD's.
const REPORT_PATH = /\/jobs\/(j[0-9a-f]{16}|[$*][^/\s]*)\/report\.md\b/;
const READER = /\b(?:cat|head|tail|less|more|bat|nl|tac|sed|awk|grep|rg|cut)\b/;

/** The one-line refusal for a read of a job report file; undefined for any other read. */
export function reportRead(path: string, isShell = false): string | undefined {
  const found = REPORT_PATH.exec(path);
  if (!found || (isShell && !READER.test(path))) return undefined;
  const id = found[1] ?? '';
  const job = /^j[0-9a-f]{16}$/.test(id) ? id : '<job>';
  return `Read HUD job reports with hud_read job=${job} (mode: "full" for the whole report), not from the file.`;
}
