import { expect, mock, test } from 'claude-code/testing';
import type { Engine } from 'claude-code/testing';
import type { On } from 'claude-code';

const JOB = 'j00000000000000a1';
const start = { cwd: '/demo', surface: 'terminal' as const, isInteractive: true };
/** What HUD's MCP server sends the main session: compact `key: value` rows (src/mcp/mcp/result-text.ts), JSON for refusals. */
const compact = (value: unknown) => {
  const v = value as Record<string, unknown>;
  if (!v || typeof v !== 'object' || v.ok === false) return JSON.stringify(value);
  return Object.entries(v).map(([k, x]) => `${k}: ${typeof x === 'string' && x && !/[\r\n]/.test(x) ? x : JSON.stringify(x)}`).join('\n');
};
const text = (value: unknown) => ({ content: [{ type: 'text', text: compact(value) }], isError: false });

/** A session whose `hud` answers `mcp` per tool and `act` per verb; `choice` is what the owner picks when asked. */
function session(on: On, mcp: Record<string, unknown>, env: Record<string, string> = { HERDR_PANE_ID: 'w4E:p1' }, choice = 'Cancel') {
  const registered: string[] = [], calls: unknown[][] = [], runs: string[][] = [], asked: string[] = [];
  mock.env(on, { HUD_HOME: '/state', ...env });
  on('env.set', () => ({ value: {} }));
  on('session.start', (_, e) => ({ cwd: e.cwd }));
  on('session.root', () => ({ value: '/demo' }));
  on('session.cwd', () => ({ value: '/demo' }));
  on('fs.exists', () => ({ value: false }));
  let held: unknown = null;
  on('state.get', () => ({ value: { value: held, version: held === null ? 0 : 1 } }));
  on('state.set', (_, e) => { held = e.value; return { value: { version: 1 } } as never; });
  on('command.register', (_, e) => { registered.push(e.name); return { value: { command: e.name } }; });
  on('command.run', () => ({ text: 'the skill ran' }));
  on('mcp.call', (_, e) => {
    calls.push([e.server, e.tool, e.args]);
    const answer = mcp[e.tool] as { isError?: boolean } | undefined;
    return { value: answer?.isError ? answer as never : text(answer ?? { ok: false, code: 'job_not_found' }) };
  });
  on('process.run', (_, e) => {
    runs.push([...e.argv]);
    const panelState = e.argv[2] === 'status' ? 'open' : e.argv[2] === 'close' ? 'closed' : 'opened';
    return { value: { exitCode: 0, stdout: e.argv[1] === 'panel' ? `HUD panel ${panelState}\n` : `done: ${e.argv.slice(2).join(' ')}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } };
  });
  on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
    asked.push((e as unknown as { questions: { question: string }[] }).questions[0]!.question);
    return { result: { questions: [], answers: { [asked.at(-1)!]: choice } } as never };
  });
  return { registered, calls, runs, asked };
}
const run = ($: Engine, command: string, args = '') =>
  $.command.run({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } });

test('an owner session gets the commands; a worker session gets none', async ($, on) => {
  const f = session(on, {});
  await $.session.start(start);
  expect(f.registered).toEqual(['council', 'jobs', 'answer', 'try', 'retry', 'land', 'stop']);
});

test('/council is a composer-only command and passes the owner request after granting', async ($, on) => {
  const f = session(on, {}), clock = mock.clock(on), prompts: string[] = [];
  on('prompt.submit', (_, e) => { prompts.push(e.text); return { text: e.text }; });
  await $.session.start(start);
  await $.command.run({ command: 'council', args: 'Not typed', origin: { kind: 'plugin', name: 'synthetic' }, presentation: { isFullscreen: false, columns: 80 } });
  expect((await run($, 'council')).text).toBe('Usage: /council <request>');
  expect(f.runs).toEqual([]);
  expect((await run($, 'council', 'Compare A and B.')).text).toBe('Council request queued');
  expect(f.runs).toEqual([['hud', 'council', 'allow', '--via', 'claude-mod']]);
  await clock.advance(1);
  expect(prompts).toEqual(['Start a HUD council for this request:\n\nCompare A and B.']);
});

test('a worker session registers no command', async ($, on) => {
  const f = session(on, {}, { HUD_JOB_DIR: '/state/jobs/j1' });
  await $.session.start(start);
  expect(f.registered).toEqual([]);
  expect(await run($, 'hud')).toMatchObject({ text: 'panel_worker_forbidden', isTextDisplayOnly: true });
  expect(f.runs).toEqual([]);
});

test('every answer is for the owner to see and joins no model request', async ($, on) => {
  const f = session(on, { hud_read: { jobs: [] } });
  await $.session.start(start);
  for (const [command, args] of [['jobs', ''], ['try', ''], ['retry', JOB], ['answer', `${JOB} q1 keep it`], ['stop', 'nope']] as const)
    expect(await run($, command, args)).toMatchObject({ isTextDisplayOnly: true });
  expect(f.runs.length).toBe(3);
});

test('/hud controls the shared dock and reports its state without a model turn', async ($, on) => {
  const f = session(on, {});
  await $.session.start(start);
  expect(await run($, 'hud')).toMatchObject({ text: 'HUD panel opened', isTextDisplayOnly: true });
  expect(await run($, 'hud', 'status')).toMatchObject({ text: 'HUD panel open', isTextDisplayOnly: true });
  expect(await run($, 'hud', 'off')).toMatchObject({ text: 'HUD panel closed', isTextDisplayOnly: true });
  expect(f.runs).toEqual([['hud', 'panel'], ['hud', 'panel', 'status'], ['hud', 'panel', 'close']]);
  expect(await run($, 'hud', 'footer reset')).toEqual({ text: 'the skill ran' });
});

test('/hud outside a herdr pane is the skill\'s', async ($, on) => {
  const f = session(on, {}, {});
  await $.session.start(start);
  expect(await run($, 'hud')).toEqual({ text: 'the skill ran' });
  expect(f.runs).toEqual([]);
});

test('/jobs lists what is running or unread, and /jobs <id> peeks; neither reads a report', async ($, on) => {
  const f = session(on, {
    hud_read: { jobs: [{ job: JOB, role: 'imp', state: 'working', question_ids: ['q1'] }, { job: 'j00000000000000a2', role: 'sonic', state: 'closed', report_unread: true }] },
    hud_peek: { status: { job: JOB, role: 'imp', state: 'working' }, latest_progress: { at: 'x', text: 'wrote the parser' } },
  });
  await $.session.start(start);
  expect((await run($, 'jobs')).text).toBe(`${JOB} · imp · working · asks q1\nj00000000000000a2 · sonic · closed · report unread`);
  expect((await run($, 'jobs', JOB)).text).toBe(`${JOB} · imp · working\nwrote the parser`);
  expect(f.calls).toEqual([['hud', 'hud_read', {}], ['hud', 'hud_peek', { job: JOB }]]);
  expect((await run($, 'jobs', '../x')).text).toBe('Usage: /jobs [job]');
});

test('/answer, /try and /retry run hud act with no shell and no model; bad arguments say the usage', async ($, on) => {
  const f = session(on, {});
  await $.session.start(start);
  expect((await run($, 'answer', `${JOB} q2 keep it, then  rename`)).text).toBe(`done: answer ${JOB} q2 keep it, then  rename`);
  expect((await run($, 'try')).text).toBe('done: try');
  expect((await run($, 'retry', JOB)).text).toBe(`done: retry ${JOB}`);
  expect(f.runs).toEqual([['hud', 'act', 'answer', JOB, 'q2', 'keep it, then  rename'], ['hud', 'act', 'try'], ['hud', 'act', 'retry', JOB]]);
  expect((await run($, 'answer', `${JOB} keep it`)).text).toBe('Usage: /answer <job> <q1> <answer>');
  expect((await run($, 'retry', 'nope')).text).toBe('Usage: /retry <job>');
  expect(f.runs.length).toBe(3);
});

test('/stop asks first for a running job and stops a settled one at once', async ($, on) => {
  const peek = { status: { job: JOB, role: 'imp', state: 'working' } };
  const f = session(on, { hud_peek: peek });
  await $.session.start(start);
  expect((await run($, 'stop', JOB)).text).toBe('Not stopped');
  expect(f.asked).toEqual([`${JOB} is working. Stop it?`]);
  expect(f.runs).toEqual([]);
  peek.status.state = 'closed';
  expect((await run($, 'stop', JOB)).text).toBe(`done: stop ${JOB}`);
  expect(f.asked.length).toBe(1);
});

test('/stop asks too when the HUD cannot say whether the job is finished', async ($, on) => {
  const f = session(on, {});
  await $.session.start(start);
  expect((await run($, 'stop', JOB)).text).toBe('Not stopped');
  expect(f.asked).toEqual([`${JOB} is not known to be finished. Stop it?`]);
});

test('/stop stops a running job the owner confirms', async ($, on) => {
  const f = session(on, { hud_peek: { status: { job: JOB, state: 'working' } } }, undefined, 'Stop');
  await $.session.start(start);
  expect((await run($, 'stop', JOB)).text).toBe(`done: stop ${JOB}`);
});

test('/land starts the land flow directly; an unread report is confirmed first', async ($, on) => {
  const landed = { flow: 'f00000000000000b1', job: JOB, state: 'queued', step: 'main-checkout lease' };
  const read = session(on, { hud_peek: { status: { job: JOB, state: 'closed', report_unread: true } }, hud_land: landed }, undefined, 'Land');
  await $.session.start(start);
  expect((await run($, 'land', JOB)).text).toBe('Land queued (main-checkout lease): f00000000000000b1');
  expect(read.asked).toEqual([`${JOB}'s report is unread. Land it anyway?`]);
  expect(read.calls.map(call => call[1])).toEqual(['hud_peek', 'hud_land']);
  expect(read.calls[1]).toEqual(['hud', 'hud_land', { job: JOB }]);
});

test('/land of a report already read asks nothing', async ($, on) => {
  const f = session(on, { hud_peek: { status: { job: JOB, state: 'closed' } }, hud_land: { flow: 'f1', state: 'queued' } });
  await $.session.start(start);
  expect((await run($, 'land', JOB)).text).toBe('Land queued: f1');
  expect(f.asked).toEqual([]);
});

test('/land of an unread report the owner declines lands nothing', async ($, on) => {
  const f = session(on, { hud_peek: { status: { job: JOB, state: 'closed', report_unread: true } } });
  await $.session.start(start);
  expect((await run($, 'land', JOB)).text).toBe('Not landed');
  expect(f.calls.map(call => call[1])).toEqual(['hud_peek']);
});

test('/land of a job the HUD refuses, or does not know, says why', async ($, on) => {
  const refused = { content: [{ type: 'text', text: `Cannot land ${JOB}: job state is working` }], isError: true };
  session(on, { hud_peek: { status: { job: JOB, state: 'working' } }, hud_land: refused });
  await $.session.start(start);
  expect((await run($, 'land', JOB)).text).toBe(`Could not land ${JOB}: Cannot land ${JOB}: job state is working`);
});

test('/land of a job the HUD does not know says so', async ($, on) => {
  session(on, {});
  await $.session.start(start);
  expect((await run($, 'land', 'j00000000000000ff')).text).toBe('Could not land j00000000000000ff: job_not_found');
});
