import { expect, mock, test } from 'claude-code/testing';
import type { On, ToolCallArgs } from 'claude-code';
import { MOD_CONVENTION } from '../hooks/short-convention';

const job = 'j00000000000000a1';
const report = `/state/jobs/${job}/report.md`;
const grep = { tool: 'Grep', path: report, pattern: 'evidence' } as unknown as ToolCallArgs;
const create = 'mcp__hud__hud_create';
const tickets = 'mcp__hud__hud_tickets';
const close = 'mcp__plugin_example_hud__hud_close';
const roster = 'mcp__hud__hud_roster';
const read = 'mcp__hud__hud_read';
const wait = 'mcp__hud__hud_wait';
const passed = 'ran';
const payload = { path: '/install/packages/hud-mcp/hud-convention.md', text: 'Shipped convention.\n'.repeat(320), truncated: false };
const rosterText = `roles: []\nconvention: ${JSON.stringify(payload)}\nhint: Keep working`;

function tools(on: On, raw = passed) {
  const calls: Record<string, unknown>[] = [];
  on('tool.call', (_, e) => { calls.push({ ...e }); return { result: raw, text: raw, ref: 1 }; });
  return calls;
}

test('implementers choose isolation explicitly on single and batch creates; retries inherit', async ($, on) => {
  mock.env(on, {});
  const calls = tools(on);
  for (const role of ['imp', 'frontend-imp']) {
    expect((await $.tool.call({ tool: create, role, task: 'Write a patch' })).deny).toContain('Set isolation explicitly');
    for (const extra of [{ isolation: 'none' }, { isolation: 'worktree' }, { retry_of: job }])
      expect((await $.tool.call({ tool: create, role, task: 'A brief', ...extra })).result).toBe(passed);
  }
  expect((await $.tool.call({ tool: create, jobs: [{ role: 'oracle' }, { role: 'frontend-imp' }] })).deny).toContain('Set isolation explicitly');
  expect(calls.length).toBe(6);
});

test('read-only roles use no worktree in a single create or a mixed batch', async ($, on) => {
  mock.env(on, {});
  const calls = tools(on);
  for (const role of ['sonic', 'oracle', 'architect', 'reviewer', 'pro', 'flow']) {
    await $.tool.call({ tool: create, role, isolation: 'worktree' });
    expect(calls.at(-1)?.isolation).toBe('none');
  }
  const jobs = [{ role: 'reviewer', isolation: 'worktree', task: 'Review' }, { role: 'imp', isolation: 'worktree' }, { role: 'sonic' }];
  await $.tool.call({ tool: create, jobs });
  expect(calls.at(-1)?.jobs).toEqual([{ ...jobs[0], isolation: 'none' }, ...jobs.slice(1)]);
  expect(jobs[0]?.isolation).toBe('worktree');
});

test('Grep is guarded like Read only for job report paths; adds require an explicit owner_try per ticket', async ($, on) => {
  mock.env(on, {});
  tools(on);
  expect((await $.tool.call(grep)).deny).toContain(`hud_read job=${job}`);
  expect((await $.tool.call({ ...grep, path: 'jobs/' + job + '/report.md' } as ToolCallArgs)).deny).toContain(`hud_read job=${job}`);
  expect((await $.tool.call({ ...grep, path: '/project/report.md' } as ToolCallArgs)).deny).toBeUndefined();
  expect((await $.tool.call({ tool: tickets, op: 'add', tickets: [{ owner_try: true }, {}] })).deny).toContain('Set owner_try explicitly');
  for (const args of [{ op: 'add', tickets: [{ owner_try: false }, { owner_try: true }] }, { op: 'update' }])
    expect((await $.tool.call({ tool: tickets, ...args })).result).toBe(passed);
});

test('model close peeks the effective state and requires explicit authorization only for unsettled jobs', async ($, on) => {
  mock.env(on, {});
  let state = 'working', choice = 'Cancel';
  const asked: string[] = [], peeks: unknown[] = [];
  on('mcp.call', (_, e) => {
    peeks.push([e.server, e.tool, e.args]);
    return { value: { isError: false, content: [{ type: 'text', text: `status: ${JSON.stringify({ job, state })}` }] } };
  });
  on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
    const question = e.questions[0]!.question;
    asked.push(question);
    return choice === 'Dismiss' ? { deny: 'dismissed' } : { result: { questions: [], answers: { [question]: choice } } as never };
  });
  tools(on);
  expect((await $.tool.call({ tool: close, job })).deny).toContain('requires owner approval');
  expect(peeks).toEqual([['plugin_example_hud', 'hud_peek', { job }]]);
  expect(asked[0]).toContain(job);
  state = 'queued'; choice = 'Dismiss';
  expect((await $.tool.call({ tool: close, job })).deny).toContain('requires owner approval');
  choice = 'Allow close';
  expect((await $.tool.call({ tool: close, job })).result).toBe(passed);
  for (const settled of ['idle_grace', 'closed', 'done', 'stopped', 'failed']) {
    state = settled;
    expect((await $.tool.call({ tool: close, job })).result).toBe(passed);
  }
  expect(asked.length).toBe(3);
});

test('manual watch and waits are refused only while the mod child is ready and live', async ($, on) => {
  const clock = mock.clock(on);
  mock.env(on, { HUD_HOME: '/state', HERDR_PANE_ID: 'w4E:p1' });
  tools(on);
  on('env.set', () => ({ value: {} }));
  on('session.start', (_, e) => ({ cwd: e.cwd }));
  on('session.root', () => ({ value: '/project' }));
  on('fs.exists', () => ({ value: true }));
  let spawns = 0;
  on('process.spawn', async function* () {
    spawns++;
    yield { stream: 'stdout', text: '{"type":"ready"}\n' };
    await clock.sleep(10);
    yield { stream: 'stdout', text: '{"type":"sleep","cursor":"0:0","sizes":[0,0]}\n' };
    return { value: { code: 0, signal: null } };
  });
  const fallbacks = [
    { tool: 'Bash', command: 'hud watch --all' },
    { tool: 'Monitor', command: 'cd /project && /bin/hud watch', description: 'Events', timeout_ms: 500 },
    { tool: wait, wait_ms: 0 }, { tool: read, job, wait_ms: 20 },
  ] as const;
  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true });
  for (const args of fallbacks) expect((await $.tool.call(args)).deny).toContain('watch is live');
  for (const args of [{ tool: 'Bash', command: 'hud watch --help' }, { tool: 'Bash', command: 'echo "hud watch"' }, { tool: read, job, wait_ms: 0 }] as const)
    expect((await $.tool.call(args)).deny).toBeUndefined();
  await clock.advance(10);
  for (const args of fallbacks) expect((await $.tool.call(args)).deny).toBeUndefined();
  expect(spawns).toBe(1);
});

test('the roster swaps only bundled text and preserves override responses byte for byte', async ($, on) => {
  mock.env(on, {});
  let raw = rosterText;
  on('tool.call', () => ({ result: raw, text: raw, ref: 1 }));
  expect((await $.tool.call({ tool: roster })).result).toBe(raw.replace(JSON.stringify(payload), JSON.stringify({ ...payload, text: MOD_CONVENTION })));
  for (const path of ['/project/.hud/hud-convention.md', '/project/hud-convention.md', '/state/hud-convention.md']) {
    raw = `roles: []\nconvention: ${JSON.stringify({ ...payload, path })}\nhint: Keep working`;
    expect((await $.tool.call({ tool: roster })).result).toBe(raw);
  }
});

test('worker sessions bypass all convention hooks', async ($, on) => {
  mock.env(on, { HUD_JOB_DIR: `/state/jobs/${job}` });
  const calls = tools(on, rosterText);
  for (const args of [grep, { tool: create, role: 'imp' }, { tool: create, role: 'sonic', isolation: 'worktree' },
    { tool: tickets, op: 'add', tickets: [{}] }, { tool: close, job }, { tool: roster }, { tool: wait }] as const)
    expect((await $.tool.call(args)).result).toBe(rosterText);
  expect(calls[2]?.isolation).toBe('worktree');
});

test('unexpected env failures pass calls through; malformed roster output is replayed without a second call', async ($, on) => {
  let refuseEnv = true;
  on('env.get', () => refuseEnv ? { deny: 'engine env unavailable' } : { value: undefined });
  const raw = 'convention: {malformed';
  const calls = tools(on, raw);
  expect((await $.tool.call(grep)).result).toBe(raw);
  expect((await $.tool.call({ tool: create, role: 'imp' })).result).toBe(raw);
  refuseEnv = false;
  expect((await $.tool.call({ tool: roster })).result).toBe(raw);
  expect(calls.length).toBe(3);
});
