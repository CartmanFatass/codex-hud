// Pure helpers of the HUD mod: no engine calls, so register.ts and the tests share them.

/** Job and flow ids, question replies: what a HUD line starts with, so other Monitor output is left alone. */
const HUD_LINE = /^(?:[jf][0-9a-f]{16}(?:-\d+)?\b|\[[^\]\n]+\] QUESTION q\d+:|\[sonic j[0-9a-f]{16}\])/;

/** What this turn already delivered: HUD lines, and the Monitor tasks whose rows were shown. */
export type Turn = { seen: Set<string>; tasks: Set<string> };
export const newTurn = (): Turn => ({ seen: new Set(), tasks: new Set() });
const ALREADY_SHOWN = '(HUD events already shown this turn)';

// hud-mcp renders notifications as a trailing block, separate from the tool's result fields.
const CHANGES = /(?:^|\n)changes:\n(- [^\n]*(?:\n- [^\n]*)*)$/;
export function mergeChanges(text: string, turn: Turn): string | undefined {
  const block = CHANGES.exec(text);
  if (!block) return undefined;
  const lines = block[1].split('\n');
  const fresh = lines.filter((line) => !turn.seen.has(line.slice(2)));
  for (const line of lines) turn.seen.add(line.slice(2));
  if (fresh.length === lines.length) return undefined;
  const body = text.slice(0, block.index);
  return fresh.length ? `${body ? `${body}\n` : ''}changes:\n${fresh.join('\n')}` : body || ALREADY_SHOWN;
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
  const wrapped = text.replace(EVENT, () => `<event>${lines.length ? lines.join('\n') : ALREADY_SHOWN}</event>`);
  return again ? wrapped.replace(TASK, '').replace(SUMMARY, '') : wrapped;
}

// A job id, or a shell variable/glob standing for one: another project's own jobs/ folder is not HUD's.
const REPORT_PATH = /(?:^|\/)jobs\/(j[0-9a-f]{16}|[$*][^/\s]*)\/report\.md\b/;
const READER = /\b(?:cat|head|tail|less|more|bat|nl|tac|sed|awk|grep|rg|cut)\b/;

/** The one-line refusal for a read of a job report file; undefined for any other read. */
export function reportRead(path: string, isShell = false): string | undefined {
  const found = REPORT_PATH.exec(path);
  if (!found || (isShell && !READER.test(path))) return undefined;
  const id = found[1] ?? '';
  const job = /^j[0-9a-f]{16}$/.test(id) ? id : '<job>';
  return `Read HUD job reports with hud_read job=${job} (mode: "full" for the whole report), not from the file.`;
}
