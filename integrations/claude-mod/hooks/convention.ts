import type { EngineInterface, On, ToolCallInput } from 'claude-code';
import { reportRead } from './compact';
import { field, record, slimRoster } from './short-convention';

const HUD = /^mcp__((?:\w*_)?hud)__hud_(create|tickets|close|roster|wait|read)$/;
const JOB = /^j[0-9a-f]{16}$/;
const IMPLEMENTERS = ['imp', 'frontend-imp'];
const READ_ONLY = ['sonic', 'oracle', 'architect', 'reviewer', 'pro', 'flow'];
const SETTLED = ['idle_grace', 'closed', 'done', 'failed', 'stopped'];
const WATCH_HINT = 'The HUD mod watch is live and wakes this session on events. Keep working until notified; use hud_read without wait_ms.';
// Match a command, not prose mentioning it. `hud watch --help` does not start a watcher.
const WATCH_COMMAND = /(?:^|[;\n&|()])\s*(?:[^\s;&|()]+\s*=\s*[^\s;&|()]*\s+)*(?:(?:exec|env|command|timeout\s+\S+)\s+)?(?:[^\s;&|()]*\/)?hud\s+watch\b(?![ \t]+--help[ \t]*(?:$|[;\n&|()]))/;

export function waitRequest(e: ToolCallInput): boolean {
  const name = HUD.exec(e.tool)?.[2];
  const wait = record(e)?.wait_ms;
  return name === 'wait' || (name === 'read' && typeof wait === 'number' && Number.isFinite(wait) && wait > 0);
}

function missingIsolation(item: unknown) {
  const args = record(item);
  return args && typeof args.role === 'string' && IMPLEMENTERS.includes(args.role) && args.isolation === undefined && args.retry_of === undefined;
}
function readOnlyWorktree(item: unknown) {
  const args = record(item);
  return args && typeof args.role === 'string' && READ_ONLY.includes(args.role) && args.isolation === 'worktree';
}

async function mayClose($: EngineInterface, server: string, job: string): Promise<boolean> {
  // Peek derives the effective state, including queued jobs with no STATUS.json, without reading a report.
  const peek = await $.mcp.call(server, 'hud_peek', { job });
  if (peek.isError) return true; // Let hud_close handle job_not_found (or an unexpected server response).
  const text = peek.content.map(block => block.text ?? '').join('');
  const state = record(text.trimStart().startsWith('{') ? record(JSON.parse(text))?.status
    : JSON.parse(field(text, 'status')?.slice('status: '.length) ?? 'null'))?.state;
  if (typeof state !== 'string' || SETTLED.includes(state)) return true;
  // Dismissal or no interactive surface is not authorization. Other hook failures go through .catch.
  return (await $.ui.ask(`The model wants to close ${job} (${state}). Allow it?`, ['Allow close', 'Cancel']).catch(() => 'Cancel')) === 'Allow close';
}

export function registerConvention(on: On, watchLive: () => boolean) {
  on('tool.call', { tool: /^(?:Read|Grep|Bash|Monitor)$/ }, async ($, e, next) => {
    const args = record(e);
    const command = args?.command;
    const path = e.tool === 'Read' ? args?.file_path : args?.path;
    const hint = typeof path === 'string' ? reportRead(path)
      : typeof command === 'string' ? reportRead(command, true) : undefined;
    const deny = hint ?? (typeof command === 'string' && watchLive() && WATCH_COMMAND.test(command) ? WATCH_HINT : undefined);
    return deny && await $.env.get('HUD_JOB_DIR') === undefined ? { deny } : next(e);
  }).catch((_, e, next) => next(e));

  on('tool.call', { tool: HUD }, async ($, e, next) => {
    const match = HUD.exec(e.tool);
    if (!match || await $.env.get('HUD_JOB_DIR') !== undefined) return next(e);
    const [, server, name] = match;
    const args = record(e)!;
    if (watchLive() && waitRequest(e)) return { deny: WATCH_HINT };
    if (name === 'create') {
      const batch = Array.isArray(args.jobs) ? args.jobs : undefined;
      if ((batch ?? [args]).some(missingIsolation))
        return { deny: 'Set isolation explicitly for imp and frontend-imp: "worktree" for code/build/test, "none" for docs/design samples.' };
      const mcp = e as Extract<ToolCallInput, { tool: `mcp__${string}__${string}` }>;
      if (batch?.some(readOnlyWorktree))
        return next({ ...mcp, jobs: batch.map(item => readOnlyWorktree(item) ? { ...record(item), isolation: 'none' } : item) });
      if (args.jobs === undefined && readOnlyWorktree(args)) return next({ ...mcp, isolation: 'none' });
    }
    if (name === 'tickets' && args.op === 'add' && Array.isArray(args.tickets) &&
        args.tickets.some(item => record(item) && record(item)?.owner_try === undefined))
      return { deny: 'Set owner_try explicitly on each new ticket: false when automated checks suffice, true when the owner must try it.' };
    if (name === 'close' && typeof args.job === 'string' && JOB.test(args.job) &&
        !(await mayClose($, server!, args.job)))
      return { deny: 'Closing a running worker requires owner approval; use hud_send to steer it instead.' };
    const ran = await next(e);
    if (name !== 'roster' || ran.deny !== undefined || ran.isError) return ran;
    const raw = ran.text ?? (typeof ran.result === 'string' ? ran.result : undefined);
    const text = raw === undefined ? undefined : slimRoster(raw);
    return text === undefined ? ran : { result: text };
  }).catch((_, e, next) => next(e));
}
