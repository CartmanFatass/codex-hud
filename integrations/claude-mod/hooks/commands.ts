import type { EngineInterface, On } from 'claude-code';

// The owner's commands run without a model turn: a plain `command.run` answer is shown, never put in a request.
const SERVER = { plugin: 'hud-mod', key: 'server' } as const;
const JOB = /^j[0-9a-f]{16}$/;
const SETTLED = ['idle_grace', 'closed', 'done', 'failed', 'stopped'];
const COMMANDS = [
  { name: 'council', description: 'Authorize one council and submit its request', argumentHint: '<request>' },
  { name: 'jobs', description: 'HUD jobs, or one job without marking its report read', argumentHint: '[job]' },
  { name: 'answer', description: 'Answer a HUD job question', argumentHint: '<job> <q1> <answer>' },
  { name: 'try', description: 'Accept all slices to try' },
  { name: 'retry', description: 'Record a retry request for a HUD job', argumentHint: '<job>' },
  { name: 'land', description: 'Land a finished worktree job', argumentHint: '<job>' },
  { name: 'stop', description: 'Stop a HUD job', argumentHint: '<job>' },
];
const show = (text: string) => ({ text, isTextDisplayOnly: true as const });
const usage = (name: string) => show(`Usage: /${name} ${COMMANDS.find(c => c.name === name)?.argumentHint ?? ''}`.trim());
type Row = { job: string; role?: string; state?: string; report_unread?: boolean; question_ids?: string[]; reason?: string };
const line = (r: Row) => [r.job, r.role, r.state, r.report_unread && 'report unread', r.question_ids?.length && `asks ${r.question_ids.join(' ')}`, r.reason]
  .filter(Boolean).join(' · ');

/** `hud act …` in the session's project: the one line it printed, or why it could not. */
export async function act($: EngineInterface, ...argv: string[]): Promise<string> {
  const done = await $.process.run(['hud', 'act', ...argv], { cwd: await $.session.cwd(), timeoutMs: 60_000 }).catch(() => undefined);
  return (done && (done.exitCode === 0 ? done.stdout : done.stderr || done.stdout).trim()) || 'hud act failed';
}

/** Control the dock only in herdr; elsewhere `hud panel` would take the terminal. */
async function panel($: EngineInterface, operation?: 'open' | 'hide' | 'close' | 'status'): Promise<string | undefined> {
  if (await $.env.get('HUD_JOB_DIR') !== undefined) return 'panel_worker_forbidden';
  if (!(await $.env.get('HERDR_PANE_ID')) && !(await $.env.get('HERDR_SOCKET_PATH'))) return undefined;
  const done = await $.process.run(['hud', 'panel', ...(operation ? [operation] : [])], { cwd: await $.session.cwd(), timeoutMs: 15_000 }).catch(() => undefined);
  // Don't fall through to a skill after attempting a toggle (the server may have acted without a reply).
  return (done && (done.exitCode === 0 ? done.stdout : done.stderr).trim()) || 'HUD panel request failed';
}
export function openPanel($: EngineInterface) {
  return panel($, 'open');
}

/**
 * HUD answers the main session in compact text (`key: value` per line, nested values as JSON, an optional
 * trailing `changes:` list; src/mcp/mcp/result-text.ts) unless HUD_MCP_JSON=1 asks for JSON. Reads either.
 */
export function parseResult(text: string): any {
  try { return JSON.parse(text); } catch { /* compact text */ }
  const value: Record<string, unknown> = {};
  for (const row of text.split('\n')) {
    if (row === 'changes:') break;
    const m = /^([A-Za-z_][\w-]*): (.*)$/.exec(row);
    if (!m) continue;
    try { value[m[1]!] = JSON.parse(m[2]!); } catch { value[m[1]!] = m[2]; }
  }
  return value;
}

/** One call on the HUD MCP server with the session's own connection: the JSON it answered, or its error text. */
async function hud($: EngineInterface, tool: string, args: Record<string, unknown>): Promise<{ value?: any; error?: string }> {
  const server = (await $.state.get(SERVER).catch(() => undefined))?.value ?? 'hud';
  try {
    const done = await $.mcp.call(server, tool, args);
    const text = done.content.map(block => block.text ?? '').join('');
    if (done.isError) return { error: text || 'failed' };
    const value = parseResult(text);
    return value?.ok === false ? { error: String(value.code ?? 'failed') } : { value };
  } catch (error) { return { error: (error as Error).message || 'HUD is not connected' }; }
}

async function confirm($: EngineInterface, question: string, yes: string) {
  return (await $.ui.ask(question, [yes, 'Cancel']).catch(() => 'Cancel')) === yes;
}

/** Declares the slash commands in an owner's session (a worker, HUD_JOB_DIR set, has none). */
export async function offerCommands($: EngineInterface) {
  if (!(await $.env.get('HUD_JOB_DIR'))) for (const c of COMMANDS) await $.command.register({ ...c, immediate: true }).catch(() => {});
}

export function registerCommands(on: On) {
  on('mcp.connect', { server: /(?:^|[_:])hud$/ }, async ($, e, next) => {
    await $.state.set(SERVER, e.server).catch(() => {});
    return next(e);
  });
  on('command.run', { command: 'hud' }, async ($, e, next) => {
    const verb = e.args.trim();
    if (verb && !['on', 'off', 'close', 'toggle', 'status'].includes(verb)) return next(e);
    const op = verb === 'on' ? 'open' : verb === 'off' ? 'hide' : verb === 'close' ? 'close' : verb === 'status' ? 'status' : undefined;
    const state = await panel($, op);
    return state ? show(state) : next(e);
  });
  // command.register exposes a local command, not a Skill. Only a composer-origin run can grant.
  on('command.run', { command: 'council', origin: { kind: 'composer' } }, async ($, e) => {
    if (await $.env.get('HUD_JOB_DIR') !== undefined) return show('Owner sessions only');
    if (!e.args.trim()) return usage('council');
    const done = await $.process.run(['hud', 'council', 'allow', '--via', 'claude-mod'], { cwd: await $.session.cwd(), timeoutMs: 15_000 }).catch(() => undefined);
    if (done?.exitCode !== 0) return show('Could not authorize council');
    // command.run holds the current turn. Submit on the engine clock after the command returns.
    const text = `Start a HUD council for this request:\n\n${e.args.trim()}`;
    $.clock.after(1, async () => {
      const sent = await $.prompt.submit({ text, asUser: true }).catch(() => undefined);
      if (!sent || 'deny' in sent || 'drop' in sent) await $.ui.toast('Could not submit council request');
    });
    return show('Council request queued');
  });
  on('command.run', { command: 'jobs' }, async ($, e) => {
    const job = e.args.trim();
    if (job && !JOB.test(job)) return usage('jobs');
    const got = await hud($, job ? 'hud_peek' : 'hud_read', job ? { job } : {});
    if (got.error) return show(`Could not read jobs: ${got.error}`);
    if (job) return show([line(got.value.status), got.value.latest_progress?.text].filter(Boolean).join('\n'));
    const rows: Row[] = got.value.jobs ?? [];
    return show(rows.length ? rows.map(line).join('\n') : 'No running jobs or unread reports');
  });
  on('command.run', { command: 'answer' }, async ($, e) => {
    const [, job, qid, text] = /^(\S+)\s+(q\d+)\s+(\S[\s\S]*)$/.exec(e.args.trim()) ?? [];
    return job && JOB.test(job) ? show(await act($, 'answer', job, qid!, text!)) : usage('answer');
  });
  on('command.run', { command: 'try' }, async ($) => show(await act($, 'try')));
  on('command.run', { command: 'retry' }, async ($, e) => {
    const job = e.args.trim();
    return JOB.test(job) ? show(await act($, 'retry', job)) : usage('retry');
  });
  on('command.run', { command: 'stop' }, async ($, e) => {
    const job = e.args.trim();
    if (!JOB.test(job)) return usage('stop');
    const state = (await hud($, 'hud_peek', { job })).value?.status?.state;
    if (!SETTLED.includes(state) && !(await confirm($, `${job} is ${state ?? 'not known to be finished'}. Stop it?`, 'Stop'))) return show('Not stopped');
    return show(await act($, 'stop', job));
  });
  on('command.run', { command: 'land' }, async ($, e) => {
    const job = e.args.trim();
    if (!JOB.test(job)) return usage('land');
    const peek = await hud($, 'hud_peek', { job });
    if (peek.error) return show(`Could not land ${job}: ${peek.error}`);
    if (peek.value.status?.report_unread && !(await confirm($, `${job}'s report is unread. Land it anyway?`, 'Land'))) return show('Not landed');
    const flow = await hud($, 'hud_land', { job });
    return show(flow.error ? `Could not land ${job}: ${flow.error}` : `Land ${flow.value.state}${flow.value.step ? ` (${flow.value.step})` : ''}: ${flow.value.flow}`);
  });
}
