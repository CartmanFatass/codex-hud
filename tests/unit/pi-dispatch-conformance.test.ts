/**
 * Opt-in upstream conformance: the real pi-roles dispatcher and reaper against
 * fake herdr and fake pi. Skipped unless PI_ROLES_DIR names a pi-roles checkout.
 *
 * It never starts a real tab, pane, agent, pi session or model, and it never
 * reads the real ~/.hud, ~/.pi or ~/.local/share/pi-roles. Everything lives in a
 * temporary HOME, HUD_HOME, PI_CODING_AGENT_DIR and PI_ROLES_LEDGER.
 *
 * The composition under test: `dispatchEnv` scrubs HERDR_PANE_ID,
 * PI_ORCHESTRATOR_PANE and PI_ROLE_NOTIFY, the real pi-dispatch publishes the
 * SESSION/STATUS contract without `--orchestrator`, and the real pi-role-reap
 * removes the recorded agent and tab.
 *
 * Scope limits: the fake herdr keeps inventory in one JSON file instead of a
 * real workspace, so herdr's own semantics (focus, workspaces, agent liveness)
 * are not exercised. The fake pi writes the settled STATUS the controller would
 * publish; the real pi extension is not imported.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';
import { REPO_ROOT } from '../fixtures/paths.js';
import { parsePiRoleArgs } from '../../src/roles/launch.js';

const PI_ROLES_DIR = process.env.PI_ROLES_DIR ?? '';
const SKIP = PI_ROLES_DIR ? false : 'set PI_ROLES_DIR to a pi-roles checkout';

/** Fake herdr: JSON inventory, argv log, and `agent start` really runs fake pi. */
const FAKE_HERDR = String.raw`import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const statePath = process.env.HERDR_FAKE_STATE;
const logPath = process.env.HERDR_FAKE_LOG;

function load() {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return { seq: 0, tabs: [], panes: [], agents: [] };
  }
}
function save(state) {
  fs.writeFileSync(statePath, JSON.stringify(state));
}
function out(result) {
  process.stdout.write(JSON.stringify({ result }) + '\n');
}
function fail(message) {
  process.stderr.write('fake herdr: ' + message + '\n');
  process.exit(1);
}
function flag(name, fallback) {
  const index = argv.indexOf('--' + name);
  return index < 0 ? fallback : argv[index + 1];
}
function agentOf(target) {
  return state.agents.find((agent) => agent.name === target || agent.pane_id === target);
}

if (logPath) fs.appendFileSync(logPath, JSON.stringify(argv) + '\n');
const state = load();
const command = (argv[0] || '') + ' ' + (argv[1] || '');

if (command === 'tab create') {
  const label = flag('label', '');
  state.seq += 1;
  const tab = { tab_id: 'tab-' + state.seq, label };
  const pane = { pane_id: 'pane-' + state.seq, tab_id: tab.tab_id, agent: null };
  state.tabs.push(tab);
  state.panes.push(pane);
  save(state);
  out({ tab: { tab_id: tab.tab_id, label }, root_pane: { pane_id: pane.pane_id } });
} else if (command === 'tab list') {
  out({
    tabs: state.tabs.map((tab) => ({
      tab_id: tab.tab_id,
      label: tab.label,
      workspace_id: 'w0',
      agent_status: 'idle',
      focused: false,
      pane_count: 1,
    })),
  });
} else if (command === 'tab close') {
  const id = argv[2];
  state.tabs = state.tabs.filter((tab) => tab.tab_id !== id);
  state.panes = state.panes.filter((pane) => pane.tab_id !== id);
  state.agents = state.agents.filter((agent) => agent.tab_id !== id);
  save(state);
  out({ closed: id });
} else if (command === 'pane split') {
  const source = argv[2];
  const from = state.panes.find((pane) => pane.pane_id === source);
  state.seq += 1;
  const pane = { pane_id: 'pane-' + state.seq, tab_id: from ? from.tab_id : null, agent: null };
  state.panes.push(pane);
  save(state);
  out({ pane: { pane_id: pane.pane_id, tab_id: pane.tab_id } });
} else if (command === 'pane get') {
  const pane = state.panes.find((item) => item.pane_id === argv[2]);
  if (!pane) fail('pane_not_found');
  out({ pane });
} else if (command === 'pane rename') {
  out({});
} else if (command === 'pane list') {
  out({ panes: state.panes.map((pane) => ({ pane_id: pane.pane_id, tab_id: pane.tab_id, agent: pane.agent })) });
} else if (command === 'pane close') {
  const id = argv[2];
  state.panes = state.panes.filter((pane) => pane.pane_id !== id);
  state.agents = state.agents.filter((agent) => agent.pane_id !== id);
  save(state);
  out({ closed: id });
} else if (command === 'pane send-keys') {
  out({});
} else if (command === 'agent start') {
  const name = argv[2];
  const paneId = flag('pane', '');
  const pane = state.panes.find((item) => item.pane_id === paneId);
  const separator = argv.indexOf('--');
  const forwarded = separator < 0 ? [] : argv.slice(separator + 1);
  state.agents.push({ name, pane_id: paneId, tab_id: pane ? pane.tab_id : null, agent_status: 'done' });
  if (pane) pane.agent = name;
  save(state);
  const started = spawnSync('pi', forwarded, { encoding: 'utf8', env: process.env });
  if (started.status !== 0) fail('fake pi failed: ' + (started.error ? started.error.message : started.stderr));
  out({ agent: { name, pane_id: paneId, tab_id: pane ? pane.tab_id : null, agent_status: 'done' } });
} else if (command === 'agent prompt') {
  const target = argv[2];
  const text = argv[3];
  const agent = agentOf(target);
  if (text === '/quit') {
    if (agent) {
      state.agents = state.agents.filter((item) => item !== agent);
      const pane = state.panes.find((item) => item.pane_id === agent.pane_id);
      if (pane) pane.agent = null;
      save(state);
    }
    out({});
  } else {
    if (agent) {
      agent.agent_status = 'done';
      save(state);
    }
    out({ agent: agent ? { name: agent.name, pane_id: agent.pane_id, tab_id: agent.tab_id, agent_status: agent.agent_status } : {} });
  }
} else if (command === 'agent wait') {
  out({ agent: agentOf(argv[2]) || {} });
} else if (command === 'agent get') {
  const agent = agentOf(argv[2]);
  if (!agent) fail('agent_not_found');
  out({ agent });
} else if (command === 'agent list') {
  out({
    agents: state.agents.map((agent) => ({
      name: agent.name,
      pane_id: agent.pane_id,
      tab_id: agent.tab_id,
      agent_status: agent.agent_status,
    })),
  });
} else {
  fail('unsupported ' + argv.join(' '));
}
`;

/** Fake pi: writes the settled STATUS v1 snapshot and the report artifact. */
const FAKE_PI = String.raw`import * as fs from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const logPath = process.env.PI_DISPATCH_LOG;

function option(name) {
  const index = argv.indexOf('--' + name);
  return index < 0 ? null : argv[index + 1];
}

if (logPath) fs.appendFileSync(logPath, JSON.stringify({ bin: 'pi', argv, notify: process.env.PI_ROLE_NOTIFY ?? '', orchestrator: process.env.PI_ORCHESTRATOR_PANE ?? '' }) + '\n');

const taskArg = option('task-dir');
const outputArg = option('role-output');
if (!taskArg || !outputArg) {
  process.stderr.write('fake pi: missing --task-dir/--role-output\n');
  process.exit(1);
}
const task = resolve(taskArg);
const output = resolve(outputArg);
const now = new Date().toISOString();
const status = {
  version: 1,
  task_dir: fs.realpathSync(task),
  slot: option('dispatch-slot') || 'primary',
  role: option('role') || 'implementer',
  model: option('model'),
  thinking: option('thinking'),
  session_id: 'synthetic-conformance-session',
  session_file: null,
  pid: process.pid,
  output_path: output,
  output_written: true,
  state: 'closed',
  helper_pending: null,
  started_at: now,
  settled_at: now,
  idle_deadline_at: null,
  ended_at: now,
  exit_reason: 'settled',
  error: null,
  updated_at: now,
};
fs.mkdirSync(dirname(output), { recursive: true });
fs.writeFileSync(output, 'Verdict: accept\n\nSynthetic report\n', { mode: 0o600 });
const statusFile = status.slot === 'primary' ? join(task, 'STATUS.json') : join(task, '.dispatch', status.slot, 'STATUS.json');
fs.mkdirSync(dirname(statusFile), { recursive: true });
fs.writeFileSync(statusFile, JSON.stringify(status) + '\n', { mode: 0o600 });
`;

interface Stage {
  root: string;
  hudHome: string;
  work: string;
  env: NodeJS.ProcessEnv;
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function stage(t: TestContext): Stage {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hud-conformance-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const hudHome = join(root, 'hud');
  const agent = join(root, 'agent');
  const bin = join(root, 'bin');
  const fakes = join(root, 'fakes');
  const work = join(root, 'work');
  for (const directory of [home, hudHome, agent, bin, fakes, work])
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  const install = (name: string, source: string) => {
    const script = join(fakes, `${name}.mjs`);
    writeFileSync(script, source, { mode: 0o600 });
    const wrapper = join(bin, name);
    writeFileSync(wrapper, `#!/bin/bash\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`, { mode: 0o755 });
    chmodSync(wrapper, 0o755);
  };
  install('herdr', FAKE_HERDR);
  install('pi', FAKE_PI);
  // pi-role runs `node` for its argv validation. Node is not in /usr/bin here,
  // so the isolated PATH gets an explicit wrapper.
  const node = join(bin, 'node');
  writeFileSync(node, `#!/bin/bash\nexec ${quote(process.execPath)} "$@"\n`, { mode: 0o755 });
  chmodSync(node, 0o755);
  return {
    root,
    hudHome,
    work,
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: home,
      HUD_HOME: hudHome,
      PI_CODING_AGENT_DIR: agent,
      PI_ROLES_LEDGER: join(root, 'ledger', 'runs.jsonl'),
      TMPDIR: root,
      HERDR_FAKE_STATE: join(root, 'herdr-state.json'),
      HERDR_FAKE_LOG: join(root, 'herdr.log'),
      PI_DISPATCH_LOG: join(root, 'pi.log'),
      HERDR_PANE_ID: 'w0:p99',
      PI_ORCHESTRATOR_PANE: 'w0:p99',
      PI_ROLE_NOTIFY: 'herdr agent prompt w0:p99',
    },
  };
}

function parseSession(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const index = line.indexOf('=');
    if (index > 0) result[line.slice(0, index)] = line.slice(index + 1);
  }
  return result;
}

interface Logged {
  bin: string;
  argv: string[];
  notify?: string;
  orchestrator?: string;
}

function readLog(file: string): Logged[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Logged);
}

async function loadDispatchEnv(): Promise<(env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv> {
  const file = join(REPO_ROOT, 'dist', 'roles', 'pi-dispatch.js');
  if (!existsSync(file)) assert.fail(`build dist first: missing ${file}`);
  const module = (await import(pathToFileURL(file).href)) as { dispatchEnv?: unknown };
  if (typeof module.dispatchEnv !== 'function') assert.fail('dist/roles/pi-dispatch.js must export dispatchEnv(env)');
  return module.dispatchEnv as (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
}

test('real pi-dispatch and pi-role-reap conform with fake herdr and fake pi', { skip: SKIP }, async (t) => {
  const piRoles = realpathSync(PI_ROLES_DIR);
  const dispatchBin = join(piRoles, 'bin', 'pi-dispatch');
  const reapBin = join(piRoles, 'bin', 'pi-role-reap');
  assert.ok(existsSync(dispatchBin), `missing ${dispatchBin}`);
  assert.ok(existsSync(reapBin), `missing ${reapBin}`);
  const dispatchEnv = await loadDispatchEnv();

  const s = stage(t);
  const job = 'j0123456789abcdef';
  const task = join(s.hudHome, 'jobs', job);
  mkdirSync(join(task, 'qa'), { recursive: true, mode: 0o700 });
  mkdirSync(join(task, 'sessions'), { recursive: true, mode: 0o700 });
  writeFileSync(join(task, 'brief.md'), '# synthetic brief\n\nDo the thing.\n', { mode: 0o600 });
  writeFileSync(join(task, 'receipt.json'), JSON.stringify({ schema: 1, job }) + '\n', { mode: 0o600 });
  mkdirSync(join(s.hudHome, 'jobs', 'index', 'root'), { recursive: true, mode: 0o700 });
  writeFileSync(join(s.hudHome, 'jobs', 'index', 'root', 'key.json'), JSON.stringify({ schema: 1, job }) + '\n', {
    mode: 0o600,
  });
  mkdirSync(join(s.hudHome, 'assoc'), { recursive: true, mode: 0o700 });
  writeFileSync(join(s.hudHome, 'assoc', `${job}.json`), JSON.stringify({ schema: 1, job }) + '\n', { mode: 0o600 });

  const output = join(task, 'report.md');
  // Accept both a returned copy and an in-place scrub.
  const env = dispatchEnv(s.env) ?? s.env;
  assert.equal(env.HERDR_PANE_ID, undefined, 'dispatchEnv must remove HERDR_PANE_ID');
  assert.equal(env.PI_ORCHESTRATOR_PANE, undefined, 'dispatchEnv must remove PI_ORCHESTRATOR_PANE');
  assert.equal(env.PI_ROLE_NOTIFY, undefined, 'dispatchEnv must remove PI_ROLE_NOTIFY');

  const dispatch = spawnSync(
    process.execPath,
    [
      dispatchBin,
      'implementer',
      '--task-dir',
      task,
      '--workdir',
      s.work,
      '--output',
      output,
      '--split',
      '--model',
      'synthetic-model',
      '--thinking',
      'high',
    ],
    { cwd: s.work, env, encoding: 'utf8', timeout: 120_000 }
  );
  assert.equal(dispatch.status, 0, `${dispatch.stdout}\n${dispatch.stderr}`);

  const session = parseSession(readFileSync(join(task, 'SESSION.txt'), 'utf8'));
  assert.deepEqual(Object.keys(session).sort(), [
    'BASE',
    'LEFT',
    'ORCH',
    'PRIMARY',
    'RIGHT',
    'TAB',
    'TAB_NAME',
    'TASK',
  ]);
  assert.equal(session.TASK, job);
  assert.equal(session.ORCH, '', 'a scrubbed environment leaves ORCH empty');
  assert.match(session.TAB, /^tab-\d+$/);
  assert.match(session.LEFT, /^pane-\d+$/);
  assert.match(session.RIGHT, /^pane-\d+$/);
  assert.notEqual(session.LEFT, session.RIGHT);
  assert.match(session.PRIMARY, /^[a-z0-9_-]+-primary$/);
  assert.match(session.BASE, /^(HEAD|[0-9a-f]{40})$/);

  const status = JSON.parse(readFileSync(join(task, 'STATUS.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(status.version, 1);
  assert.equal(status.task_dir, realpathSync(task));
  assert.equal(status.slot, 'primary');
  assert.equal(status.role, 'implementer');
  assert.equal(status.model, 'synthetic-model');
  assert.equal(status.thinking, 'high');
  assert.equal(typeof status.session_id, 'string');
  assert.equal(status.output_path, output);
  assert.equal(status.output_written, true);
  assert.equal(status.state, 'closed');
  assert.equal(status.helper_pending, null);
  for (const key of ['started_at', 'settled_at', 'ended_at', 'updated_at'])
    assert.equal(typeof status[key], 'string', key);
  assert.ok(existsSync(output));
  assert.ok(readFileSync(output, 'utf8').trim().length > 0);

  const entries = readLog(join(s.root, 'pi.log'));
  const starts = entries.filter((entry) => entry.bin === 'pi');
  assert.equal(starts.length, 1, 'fake herdr starts fake pi exactly once');
  const piArgs = starts[0].argv;
  const value = (name: string) => piArgs[piArgs.indexOf(`--${name}`) + 1];
  assert.equal(value('role'), 'implementer');
  assert.equal(value('task-dir'), realpathSync(task));
  assert.equal(value('role-output'), output);
  assert.equal(value('dispatch-slot'), 'primary');
  assert.equal(value('model'), 'synthetic-model');
  assert.equal(value('thinking'), 'high');
  assert.equal(value('allow-write'), output, 'readonly output permission is the report path');
  assert.ok(!piArgs.includes('--orchestrator'), 'a scrubbed environment adds no --orchestrator');
  assert.ok(!piArgs.includes('--notify'));

  // Real helper CLI, fake transport/runtime. Herdr gives a primary its own pane
  // id, not the original caller's; SESSION ORCH remains empty throughout.
  const helperEnv = { ...env, HERDR_PANE_ID: session.LEFT, PI_SESSION_ID: String(status.session_id) };
  const request = join(task, 'sonic-q-1.md');
  writeFileSync(request, 'Synthetic helper subtask.');
  for (const kind of ['sonic', 'review']) {
    const argv = [join(piRoles, 'bin/pi-role-call'), kind, task, ...(kind === 'sonic' ? [request] : [])];
    const helper = spawnSync('/bin/bash', argv, { cwd: s.work, env: helperEnv, encoding: 'utf8', timeout: 60_000 });
    assert.equal(helper.status, 0, `${helper.stdout}\n${helper.stderr}`);
    const helperStatus = JSON.parse(readFileSync(join(task, '.dispatch', `${kind}-1`, 'STATUS.json'), 'utf8'));
    assert.equal(helperStatus.state, 'closed');
    assert.equal(helperStatus.output_written, true);
  }
  const allStarts = readLog(join(s.root, 'pi.log'));
  assert.equal(allStarts.length, 3);
  for (const start of allStarts) {
    assert.ok(!start.argv.includes('--notify'));
    assert.ok(!start.argv.includes('--orchestrator'));
    assert.equal(start.notify, '');
    assert.equal(start.orchestrator, '');
  }
  // Use the actual Pi-free QA protocol, not a duplicated HUD approximation.
  const qa = await import(pathToFileURL(join(piRoles, 'extensions/qa.ts')).href);
  assert.equal(qa.notifyCommand(undefined, undefined), undefined);
  const question = qa.publishQuestion(join(task, 'qa'), 0, {
    tag: 'synthetic@task',
    question: 'Choose?',
    default: 'context only',
  });
  assert.equal(qa.readQuestionAnswer(question), undefined);
  writeFileSync(question.afile, 'Synthetic answer.');
  assert.equal(qa.readQuestionAnswer(question), 'Synthetic answer.');

  const reap = spawnSync(process.execPath, [reapBin, task], { env, encoding: 'utf8', timeout: 120_000 });
  assert.equal(reap.status, 0, `${reap.stdout}\n${reap.stderr}`);
  assert.match(reap.stdout, /reaped/);
  const inventory = JSON.parse(readFileSync(join(s.root, 'herdr-state.json'), 'utf8')) as {
    tabs: unknown[];
    panes: unknown[];
    agents: unknown[];
  };
  assert.deepEqual(inventory.agents, []);
  assert.deepEqual(inventory.panes, []);
  assert.deepEqual(inventory.tabs, []);
});

// The R2 direct path runs `pi-role --args-json` and feeds the output through
// parsePiRoleArgs. pi-roles must keep that value inside the BARE charset; a JSON
// role bundle there is rejected as unsafe_launch. One test per pi role so a
// regression names the role.
for (const role of ['implementer', 'sonic', 'reviewer', 'architect'] as const) {
  test(`real pi-role --args-json for ${role} is accepted by parsePiRoleArgs`, { skip: SKIP }, (t) => {
    const piRoles = realpathSync(PI_ROLES_DIR);
    const bin = join(piRoles, 'bin', 'pi-role');
    assert.ok(existsSync(bin), `missing ${bin}`);
    const s = stage(t);
    // Same scrubbed environment as the HUD direct path: fixture-only HOME,
    // HUD_HOME, PI_CODING_AGENT_DIR and PI_ROLES_LEDGER, HERDR_ENV=1, and no
    // inherited notify or orchestrator pane.
    const env: NodeJS.ProcessEnv = { ...s.env, HERDR_ENV: '1' };
    delete env.PI_ROLE_NOTIFY;
    delete env.PI_ORCHESTRATOR_PANE;
    const qaDir = join(s.root, 'qa', role);
    const printed = spawnSync('/bin/bash', [bin, '--args-json', role, '--qa-dir', qaDir], {
      cwd: s.work,
      env,
      encoding: 'utf8',
      timeout: 60_000,
    });
    assert.equal(printed.status, 0, `${printed.stdout}\n${printed.stderr}`);
    const argv = parsePiRoleArgs(printed.stdout);
    assert.ok(argv.length > 0, 'parsePiRoleArgs accepts a nonempty argv');
  });
}

test('real pi-role-reap refuses a tab whose label changed', { skip: SKIP }, (t) => {
  const piRoles = realpathSync(PI_ROLES_DIR);
  const reapBin = join(piRoles, 'bin', 'pi-role-reap');
  assert.ok(existsSync(reapBin), `missing ${reapBin}`);
  const s = stage(t);
  const task = join(s.hudHome, 'jobs', 'jfedcba9876543210');
  mkdirSync(task, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(task, 'SESSION.txt'),
    [
      'TASK=jfedcba9876543210',
      'TAB=tab-9',
      'TAB_NAME=expected-label',
      'LEFT=pane-9',
      'RIGHT=',
      'ORCH=',
      'BASE=HEAD',
      'PRIMARY=synthetic-primary',
      '',
    ].join('\n'),
    { mode: 0o600 }
  );
  writeFileSync(
    join(s.root, 'herdr-state.json'),
    JSON.stringify({
      seq: 9,
      tabs: [{ tab_id: 'tab-9', label: 'renamed-by-someone-else' }],
      panes: [{ pane_id: 'pane-9', tab_id: 'tab-9', agent: null }],
      agents: [],
    }),
    { mode: 0o600 }
  );
  const reap = spawnSync(process.execPath, [reapBin, task], { env: s.env, encoding: 'utf8', timeout: 60_000 });
  assert.notEqual(reap.status, 0, reap.stdout);
  assert.match(reap.stderr, /name changed or missing/);
  const inventory = JSON.parse(readFileSync(join(s.root, 'herdr-state.json'), 'utf8')) as {
    tabs: { tab_id: string }[];
  };
  assert.deepEqual(
    inventory.tabs.map((tab) => tab.tab_id),
    ['tab-9'],
    'a renamed tab is left alone'
  );
});
