import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { EXHAUSTED_TTL_MS, parseQuotaResetMs } from '../../dist/roles/exhausted.js';
import { markExhausted, placeKey, readExhausted, roleRegistry } from '../../dist/roles/roster.js';

const entry = resolve('packages/hud-mcp/bin/hud-mcp.mjs');
const bundled = resolve('packages/hud-mcp');

async function fixture(t, { withPi = true } = {}) {
  const root = fs.mkdtempSync(join(tmpdir(), 'role-places-'));
  const bin = join(root, 'bin');
  fs.mkdirSync(bin);
  const log = join(root, 'commands.jsonl');
  const fake = `#!${process.execPath}
import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, join } from 'node:path';
const command = basename(process.argv[1]), args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ command, args }) + '\\n');
if (command === 'pi-role') {
  console.log(JSON.stringify(args.slice(2)));
} else if (command === 'herdr' && args[0] === 'pane' && args[1] === 'get') {
  console.log(JSON.stringify({ result: { pane: { workspace_id: 'w4E' } } }));
} else if (command === 'herdr' && args[0] === 'tab' && args[1] === 'create') {
  console.log(JSON.stringify({ result: { tab: { tab_id: 'w4E:t2' }, root_pane: { pane_id: 'w4E:p2' } } }));
} else if (command === 'herdr' && args[0] === 'pane' && args[1] === 'run') {
  process.exit(spawnSync('/bin/sh', ['-c', args[3]], { stdio: 'inherit' }).status);
} else if (command === 'herdr' && args[0] === 'pane' && args[1] === 'process-info') {
  const line = fs.readFileSync('/proc/self/status', 'utf8').split('\\n').find((row) => row.startsWith('PPid:'));
  const ppid = Number(line.split(':')[1]);
  console.log(JSON.stringify({ result: { type: 'pane_process_info', process_info: { pane_id: args[args.indexOf('--pane') + 1], shell_pid: 1, foreground_processes: [{ pid: ppid, name: 'agy' }] } } }));
} else if (command === 'herdr' && args[0] === 'agent' && args[1] === 'get') {
  console.log(JSON.stringify({ result: { type: 'agent_info', agent: { name: args[2], agent_status: 'working', agent_session: { kind: 'id', value: 'synthetic-cli-session' } } } }));
} else if (command === 'herdr' && args[0] === 'agent' && args[1] === 'wait') {
  const until = [];
  for (let i = 0; i < args.length; i++) if (args[i] === '--until') until.push(args[i + 1]);
  const id = args[2].replace(/-primary$/, '');
  const dir = join(process.env.HUD_HOME, 'jobs', id);
  const matched = (agent_status) => console.log(JSON.stringify({ result: { type: 'wait_matched', event: { event: 'pane_agent_status_changed', data: { agent_status, pane_id: 'w4E:p2', workspace_id: 'w4E' } } } }));
  if (until.includes('done') && until.includes('blocked')) {
    const report = join(dir, 'report.md');
    if (!fs.existsSync(report)) fs.writeFileSync(report, 'Synthetic report.\\n');
    matched('done');
  } else {
    matched('idle');
  }
} else if (command === 'herdr' && args[0] === 'agent' && args[1] === 'prompt') {
  if (args[3]?.startsWith('Read ') && fs.existsSync(join(process.env.HOME, 'pi-quota-fail'))) {
    console.error('HTTP 429 rate limit exceeded');
    process.exit(1);
  }
} else if (command === 'jev-ask' && args[0] === 'key') {
  if (fs.existsSync(join(process.env.HOME, 'bro-quota-fail'))) {
    console.error('quota exceeded for chatgpt');
    process.exit(1);
  }
  console.log(JSON.stringify({ key: 'synthetic-key' }));
} else if (command === 'jev-ask' && args[0] === 'wait') {
  fs.writeFileSync(args[args.indexOf('--answer-file') + 1], 'Synthetic Jev answer.');
} else if (command === 'jev-aistudio') {
  fs.writeFileSync(args[args.indexOf('--out') + 1], 'Synthetic Argon answer.');
} else if (command === 'jev-flow') {
  fs.writeFileSync(join(args[args.indexOf('--out-dir') + 1], 'synthetic-media.mp4'), 'synthetic media');
} else if (command === 'pi-role-reap') {
  console.log('Synthetic reap complete');
}
`;
  const tools = [
    ...(withPi ? ['pi-role'] : []),
    'pi-role-reap',
    'herdr',
    'jev-ask',
    'jev-aistudio',
    'jev-flow',
    'grok',
    'agy',
    'claude',
    'codex',
  ];
  for (const command of tools) {
    fs.writeFileSync(join(bin, command), fake, { mode: 0o700 });
  }
  fs.mkdirSync(join(root, 'roles'));
  fs.writeFileSync(join(root, 'roles', 'implementer.md'), '---\nmodel: gpt-6.1-sol\nthinking: high\n---\n');
  fs.writeFileSync(join(root, 'roles', 'reviewer.md'), '---\nmodel: anthropic/opus\nthinking: high\n---\n');
  const env = {
    ...process.env,
    HUD_MCP_SURFACE: 'roles',
    HUD_WATCH_FAILED_RETENTION_MS: '1000',
    PATH: bin,
    FAKE_LOG: log,
    HERDR_SOCKET_PATH: join(root, 'events.sock'),
    HERDR_PANE_ID: 'w4E:p1',
  };
  for (const name of ['HOME', 'HUD_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'PI_CODING_AGENT_DIR']) {
    env[name] = join(root, name.toLowerCase());
    fs.mkdirSync(env[name]);
  }
  const trusted = fs.realpathSync(root);
  const agyDir = join(env.HOME, '.gemini', 'antigravity-cli');
  fs.mkdirSync(agyDir, { recursive: true });
  fs.writeFileSync(join(agyDir, 'settings.json'), JSON.stringify({ trustedWorkspaces: [trusted] }));
  fs.writeFileSync(join(env.CLAUDE_CONFIG_DIR, '.claude.json'), JSON.stringify({ projects: { [trusted]: { hasTrustDialogAccepted: true } } }));
  const child = spawn(process.execPath, [entry], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  let next = 0,
    stderr = '';
  child.stderr.setEncoding('utf8').on('data', (data) => {
    stderr += data;
  });
  const pending = new Map();
  createInterface({ input: child.stdout }).on('line', (line) => {
    const response = JSON.parse(line);
    const callback = pending.get(response.id);
    if (callback) {
      pending.delete(response.id);
      callback(response);
    }
  });
  t.after(async () => {
    const jobsDir = join(env.HUD_HOME, 'jobs');
    if (fs.existsSync(jobsDir)) {
      for (const id of fs.readdirSync(jobsDir)) {
        const pidFile = join(jobsDir, id, 'supervisor.pid');
        if (!fs.existsSync(pidFile)) continue;
        try {
          process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGTERM');
        } catch {}
      }
    }
    child.stdin.end();
    await exited;
    const watchLog = join(env.HUD_HOME, 'watch.log');
    if (fs.existsSync(watchLog)) {
      for (const match of fs.readFileSync(watchLog, 'utf8').matchAll(/start pid=(\d+)/g)) {
        try {
          process.kill(Number(match[1]), 'SIGTERM');
        } catch {}
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
    assert.equal(stderr, '');
  });
  async function call(name, args = {}) {
    const id = ++next;
    const response = await new Promise((done) => {
      pending.set(id, done);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
    });
    assert.equal(response.error, undefined);
    assert.equal(response.result.isError, undefined, JSON.stringify(response.result));
    return JSON.parse(response.result.content[0].text);
  }
  return {
    root,
    env,
    call,
    commands: () =>
      fs.existsSync(log)
        ? fs
            .readFileSync(log, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
        : [],
  };
}

async function until(check, timeout = 3000) {
  const end = Date.now() + timeout;
  while (!check()) {
    assert.ok(Date.now() < end, 'condition did not settle');
    await new Promise((done) => setTimeout(done, 20));
  }
}

/** The owner's own imp: pi first, agy as fallback. */
function ownImp(f) {
  fs.mkdirSync(join(f.env.HUD_HOME, 'roles'), { recursive: true });
  fs.writeFileSync(join(f.env.HUD_HOME, 'roles', 'imp.json'), JSON.stringify({
    role: 'imp', instructions: 'implementer', can_continue: true, idle_grace_s: 600,
    run: [{ harness: 'pi', pi_role: 'implementer', split: false },
      { harness: 'cli', agent: 'agy', model: 'gemini-4-hydrogen-high', args: [] }],
  }));
}

test('imp falls back to agy when pi-role is missing on PATH', { timeout: 10000 }, async (t) => {
  const f = await fixture(t, { withPi: false });
  ownImp(f);
  const roster = await f.call('hud_roster');
  const imp = roster.roles.find((r) => r.role === 'imp');
  assert.equal(imp.available, true);
  assert.equal(imp.harness, 'cli');
  assert.equal(imp.agent, 'agy');
  assert.equal(imp.model, 'gemini-4-hydrogen-high');
  assert.deepEqual(imp.runs_on, {
    harness: 'cli',
    agent: 'agy',
    model: 'gemini-4-hydrogen-high',
    args: [],
  });

  const job = await f.call('hud_create', { role: 'imp', request_key: 'pi-missing', task: 'Synthetic task.' });
  // Routing only: the supervisor's settling is covered in thin-mcp and cli-judge tests.
  await until(() => f.commands().some((c) => c.command === 'herdr' && c.args[0] === 'agent' && c.args[1] === 'prompt' && String(c.args[2]).startsWith(job.job)));
  const start = f.commands().find((c) => c.command === 'herdr' && c.args[0] === 'agent' && c.args[1] === 'start');
  assert.equal(start.args[3], '--kind');
  assert.equal(start.args[4], 'agy');
  assert.ok(start.args.includes('gemini-4-hydrogen-high'));
  const prompt = f.commands().find((c) => c.command === 'herdr' && c.args[0] === 'agent' && c.args[1] === 'prompt');
  assert.match(prompt.args[3], /packages\/hud-mcp\/instructions\/implementer\.md/);
});

test('quota failure marks pi exhausted for 1h, names next place, and falls back to agy on next dispatch', { timeout: 10000 }, async (t) => {
  const f = await fixture(t, { withPi: true });
  ownImp(f);
  fs.writeFileSync(join(f.env.HOME, 'pi-quota-fail'), '');
  const first = await f.call('hud_create', { role: 'imp', request_key: 'pi-quota-1', task: 'Synthetic task.' });
  const read = await f.call('hud_read', { job: first.job });
  assert.equal(read.state, 'failed');
  assert.match(read.exit_reason, /429/);
  assert.match(read.exit_reason, /next dispatch will use cli\/agy \(gemini-4-hydrogen-high\)/);

  const marks = readExhausted(f.env.HUD_HOME);
  assert.equal(marks.has('pi:gpt-6.1-sol'), true);

  const roster = await f.call('hud_roster');
  const imp = roster.roles.find((r) => r.role === 'imp');
  assert.equal(imp.available, true);
  assert.deepEqual(imp.runs_on, {
    harness: 'cli',
    agent: 'agy',
    model: 'gemini-4-hydrogen-high',
    args: [],
  });
  assert.equal(imp.exhausted.length, 1);
  assert.equal(imp.exhausted[0].key, 'pi:gpt-6.1-sol');

  fs.unlinkSync(join(f.env.HOME, 'pi-quota-fail'));
  const second = await f.call('hud_create', { role: 'imp', request_key: 'pi-quota-2', task: 'Synthetic task 2.' });
  // Routing only: the supervisor's settling is covered in thin-mcp and cli-judge tests.
  await until(() => f.commands().some((c) => c.command === 'herdr' && c.args[0] === 'agent' && c.args[1] === 'prompt' && String(c.args[2]).startsWith(second.job)));
  const agyStart = f.commands().find((c) => c.command === 'herdr' && c.args[2] === `${second.job}-primary`);
  assert.equal(agyStart.args[4], 'agy');

  // Exhausting agy too makes imp unavailable and hud_create returns no_available_place.
  markExhausted(f.env.HUD_HOME, 'cli:agy:gemini-4-hydrogen-high', 'quota exceeded');
  const noPlace = await f.call('hud_create', { role: 'imp', request_key: 'pi-quota-3', task: 'Synthetic task 3.' });
  assert.equal(noPlace.ok, false);
  assert.equal(noPlace.code, 'no_available_place');
  assert.equal(noPlace.exhausted.length, 2);
});

test('parses relative, ISO, epoch and UTC clock quota resets and clamps the resulting delay', () => {
  const now = Date.parse('2026-11-18T14:00:00Z');
  const epoch = Date.parse('2026-11-18T15:30:00Z');
  for (const [reason, expected] of [
    ['try again in 18m', 18 * 60_000],
    ['in 2h 15m', 135 * 60_000],
    ['in 45s', 60_000],
    ['retry after 120 seconds', 120_000],
    ['resets in 1 hour and 30 minutes', 90 * 60_000],
    ['Retry-After: 900', 900_000],
    ['retry-after: 2 days', null],
    ['resets in 48h', 24 * EXHAUSTED_TTL_MS],
    ['resets at 2026-11-18T15:30:00Z', 90 * 60_000],
    ['exhausted until 2026-11-18T16:30:00+01:00', 90 * 60_000],
    [`reset: ${epoch / 1000}`, 90 * 60_000],
    [`x-ratelimit-reset: ${epoch}`, 90 * 60_000],
    ['resets at 14:30 UTC', 30 * 60_000],
    ['resets at 13:30 UTC', 1410 * 60_000],
    ['resets at 14:90 UTC', null],
    ['resets at 2026-11-18T13:30:00Z', null],
    ['retry after 0 seconds', null],
    ['rate limit exceeded (429)', null],
  ]) assert.equal(parseQuotaResetMs(reason, now), expected, reason);
});

test('exhausted marks expire at the parsed reset, or after 1 hour when no reset is named', () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'exhausted-ttl-'));
  try {
    const t0 = Date.parse('2026-11-14T00:00:00Z');
    markExhausted(dir, 'pi:gpt-6.1-sol', 'rate limit', t0);
    markExhausted(dir, 'cli:agy:model', 'rate limit; try again in 18m', t0);
    assert.equal(readExhausted(dir, t0 + 18 * 60_000 - 1).size, 2);
    assert.equal(readExhausted(dir, t0 + 18 * 60_000).has('cli:agy:model'), false);
    assert.equal(readExhausted(dir, t0 + EXHAUSTED_TTL_MS - 1).has('pi:gpt-6.1-sol'), true);
    assert.equal(readExhausted(dir, t0 + EXHAUSTED_TTL_MS).has('pi:gpt-6.1-sol'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hud_roster drops expired exhausted marks when queried through hud-mcp', { timeout: 10000 }, async (t) => {
  const f = await fixture(t, { withPi: true });
  ownImp(f);
  markExhausted(f.env.HUD_HOME, 'pi:gpt-6.1-sol', 'rate limit', Date.now() - 2 * EXHAUSTED_TTL_MS);

  const roster = await f.call('hud_roster');
  const imp = roster.roles.find((r) => r.role === 'imp');
  assert.equal(imp.available, true);
  assert.equal(imp.runs_on.harness, 'pi');
  assert.deepEqual(imp.exhausted, []);
});

test('hud_create on uses harnesses.json (and HUD_HOME override), and model still wins', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const job1 = await f.call('hud_create', { role: 'imp', on: 'agy', request_key: 'on-agy-default', task: 'Task 1.' });
  const rec1 = JSON.parse(fs.readFileSync(join(job1.task_dir, 'job.json'), 'utf8'));
  assert.equal(rec1.model, 'gemini-4-argon-high');
  assert.equal(rec1.model_source, join(bundled, 'harnesses.json'));

  fs.writeFileSync(
    join(f.env.HUD_HOME, 'harnesses.json'),
    JSON.stringify({ agy: { model: 'home-agy-model' } })
  );
  const job2 = await f.call('hud_create', { role: 'imp', on: 'agy', request_key: 'on-agy-home', task: 'Task 2.' });
  const rec2 = JSON.parse(fs.readFileSync(join(job2.task_dir, 'job.json'), 'utf8'));
  assert.equal(rec2.model, 'home-agy-model');
  assert.equal(rec2.model_source, join(f.env.HUD_HOME, 'harnesses.json'));

  const job3 = await f.call('hud_create', {
    role: 'imp',
    on: 'agy',
    model: 'explicit-model',
    request_key: 'on-agy-model',
    task: 'Task 3.',
  });
  const rec3 = JSON.parse(fs.readFileSync(join(job3.task_dir, 'job.json'), 'utf8'));
  assert.equal(rec3.model, 'explicit-model');
  assert.equal(rec3.model_source, 'hud_create');
});

test('pro falls back across chatgpt -> gemini -> argon and flow passes kind', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(join(f.env.HOME, 'bro-quota-fail'), '');
  const fail1 = await f.call('hud_create', { role: 'pro', request_key: 'pro-1', task: 'Ask 1.' });
  const read1 = await f.call('hud_read', { job: fail1.job, wait_ms: 5000 });
  assert.equal(read1.state, 'failed');
  assert.match(read1.exit_reason, /quota exceeded/);
  assert.match(read1.exit_reason, /next dispatch will use bro\/gemini/);

  fs.unlinkSync(join(f.env.HOME, 'bro-quota-fail'));
  const ok2 = await f.call('hud_create', { role: 'pro', request_key: 'pro-2', task: 'Ask 2.' });
  const read2 = await f.call('hud_read', { job: ok2.job, wait_ms: 5000 });
  assert.equal(read2.state, 'closed');
  const gemCmd = f.commands().find((c) => c.command === 'jev-ask' && c.args.includes(ok2.job));
  assert.ok(gemCmd.args.includes('gemini'));

  markExhausted(f.env.HUD_HOME, placeKey({ harness: 'bro', tool: 'jev-ask', provider: 'gemini' }), '429');
  const ok3 = await f.call('hud_create', { role: 'pro', request_key: 'pro-3', task: 'Ask 3.' });
  const read3 = await f.call('hud_read', { job: ok3.job, wait_ms: 5000 });
  assert.equal(read3.state, 'closed');
  const argonCmd = f.commands().find((c) => c.command === 'jev-aistudio' && c.args.includes(ok3.job));
  assert.ok(argonCmd.args.includes('gemini-4-argon'));

  const flowVid = await f.call('hud_create', { role: 'flow', kind: 'video', request_key: 'flow-vid', task: 'Video; cost: 10 credits' });
  const readVid = await f.call('hud_read', { job: flowVid.job, wait_ms: 5000 });
  assert.equal(readVid.state, 'closed');
  const flowCmd = f.commands().find((c) => c.command === 'jev-flow' && c.args.includes(flowVid.job));
  assert.equal(flowCmd.args[flowCmd.args.indexOf('--kind') + 1], 'video');
});

test('oracle runs locally on claude fable with oracle.md and falls back to pi architect', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const roster = await f.call('hud_roster');
  const oracle = roster.roles.find((r) => r.role === 'oracle');
  assert.equal(oracle.instructions, 'oracle');
  assert.equal(oracle.can_continue, false);
  assert.equal(oracle.harness, 'cli');
  assert.equal(oracle.agent, 'claude');
  assert.equal(oracle.model, 'fable');
  assert.deepEqual(oracle.run, [
    { harness: 'cli', agent: 'claude', model: 'fable', thinking: 'high' },
    { harness: 'pi', pi_role: 'architect', split: false },
  ]);
  const pro = roster.roles.find((r) => r.role === 'pro');
  assert.equal(pro.harness, 'bro');
  assert.equal(pro.provider, 'chatgpt');
  assert.equal(pro.model, '6 Pro');
  assert.equal(pro.run.length, 3);

  const job = await f.call('hud_create', { role: 'oracle', request_key: 'ora-cli', task: 'Design question?' });
  // Routing only: the supervisor's settling is covered in thin-mcp and cli-judge tests.
  await until(() => f.commands().some((c) => c.command === 'herdr' && c.args[0] === 'agent' && c.args[1] === 'prompt' && String(c.args[2]).startsWith(job.job)));
  const start = f.commands().find((c) => c.command === 'herdr' && c.args[0] === 'agent' && c.args[1] === 'start');
  assert.equal(start.args[4], 'claude');
  assert.deepEqual(start.args.slice(start.args.indexOf('--model'), start.args.indexOf('--model') + 2), ['--model', 'fable']);
  const prompt = f.commands().find((c) => c.command === 'herdr' && c.args[0] === 'agent' && c.args[1] === 'prompt');
  assert.match(prompt.args[3], /packages\/hud-mcp\/instructions\/oracle\.md/);

  fs.unlinkSync(join(f.env.PATH, 'claude'));
  const fbRoster = (await f.call('hud_roster')).roles.find((r) => r.role === 'oracle');
  assert.deepEqual(fbRoster.runs_on, { harness: 'pi', pi_role: 'architect', split: false });
  const fbJob = await f.call('hud_create', { role: 'oracle', request_key: 'ora-pi', task: 'Fallback design question?' });
  assert.ok(fbJob.job);
  const piCmd = f.commands().find((c) => c.command === 'pi-role' && c.args.includes('architect'));
  assert.ok(piCmd);

  const alias = await f.call('hud_create', { role: 'architect', request_key: 'ora-alias', task: 'Alias question?' });
  assert.ok(alias.job);
  assert.equal((await f.call('hud_read', { job: alias.job })).role, 'oracle');
});

test('reviewer and sonic use their instruction files on CLI; a role without one returns unsupported_harness', { timeout: 10000 }, async (t) => {
  const f = await fixture(t, { withPi: false });
  // Routing only: the supervisor's settling is covered in thin-mcp and cli-judge tests.
  for (const role of ['reviewer', 'sonic']) {
    const job = await f.call('hud_create', { role, on: 'claude', request_key: `${role}-cli`, task: 'Task.' });
    const promptOf = () => f.commands().find((c) => c.command === 'herdr' && c.args[0] === 'agent' && c.args[1] === 'prompt' && String(c.args[2]).startsWith(job.job));
    await until(promptOf);
    assert.match(promptOf().args[3], new RegExp(`packages/hud-mcp/instructions/${role}\\.md`));
  }

  // One role, one text on every harness (WORKER-UNIFY): a role whose instruction file is missing has no CLI place.
  fs.mkdirSync(join(f.env.HUD_HOME, 'roles'), { recursive: true });
  fs.writeFileSync(join(f.env.HUD_HOME, 'roles', 'textless.json'), JSON.stringify({
    role: 'textless', instructions: 'textless', can_continue: true, run: [{ harness: 'pi', pi_role: 'implementer' }],
  }));
  const res = await f.call('hud_create', { role: 'textless', on: 'claude', request_key: 'unsup-textless', task: 'Task.' });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'unsupported_harness');
  assert.match(res.path, /instructions\/textless\.md$/);
});

test('legacy role files including harness: jev load and deleted names are absent', () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'legacy-roles-'));
  try {
    const hud = join(dir, 'hud'),
      cwd = join(dir, 'cwd'),
      bin = join(dir, 'bin');
    fs.mkdirSync(join(hud, 'roles'), { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    for (const cmd of ['pi-role', 'jev-ask']) fs.writeFileSync(join(bin, cmd), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    fs.writeFileSync(
      join(hud, 'roles', 'old-jev.json'),
      JSON.stringify({ role: 'old-jev', harness: 'jev', tool: 'jev-ask', provider: 'gemini' })
    );
    fs.writeFileSync(
      join(hud, 'roles', 'old-pi.json'),
      JSON.stringify({ role: 'old-pi', harness: 'pi', pi_role: 'implementer', split: true, can_continue: true })
    );
    const reg = roleRegistry(hud, cwd, { PATH: bin }, undefined, undefined, bundled);
    const roles = reg.roles();
    for (const deleted of ['architect', 'grok-imp', 'agy-imp', 'claude-imp', 'codex-imp', 'argon', 'gemini', 'flow-video']) {
      assert.equal(roles.has(deleted), false, deleted);
    }
    const oldJev = roles.get('old-jev');
    assert.equal(oldJev.harness, 'bro');
    assert.deepEqual(oldJev.run, [{ harness: 'bro', tool: 'jev-ask', provider: 'gemini' }]);
    const oldPi = roles.get('old-pi');
    assert.equal(oldPi.harness, 'pi');
    assert.deepEqual(oldPi.run, [{ harness: 'pi', pi_role: 'implementer', split: true }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
