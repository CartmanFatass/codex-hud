import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { main } from '../../src/cli/hud.js';
import { canonicalJson } from '../../src/core/canonical.js';
import {
  createRoleJevExecutor,
  hudClose,
  hudCreate,
  hudRead,
  hudRespond,
  hudRoster,
  hudSend,
  type FacadeContext,
  type JevExecutor,
} from '../../src/roles/facade.js';
import { JevRuntime } from '../../src/jev/runtime/executor.js';
import type { JevCreateRequest, JevJob } from '../../src/jev/runtime/types.js';
import { listedAgents } from '../../src/roles/herdr-run.js';
import { LOCK_WAIT_MS, withLock } from '../../src/roles/job-store.js';
import { codexShell, RENAME_BACKOFF_MS } from '../../src/roles/launch.js';
import { envProfileVars, parseRouting, RoutingError } from '../../src/roles/routing.js';
import { formatRosterRoot } from '../../src/roles/selection.js';
import { ROLES } from '../../src/roles/roles.js';
import { parseRosterRoot, type RosterRoot } from '../../src/roles/selection.js';
import { JEV_TOOLS } from '../../packages/hud-mcp/src/jev-tools.js';
import { MANAGED_TOOLS } from '../../packages/hud-mcp/src/managed-tools.js';
import { RoleFacadeTools } from '../../packages/hud-mcp/src/role-extension.js';
import { selectMcpEntry } from '../../packages/hud-mcp/src/surface.js';
import { ROLE_TOOLS } from '../../src/roles/role-tools.js';
import { validateToolArguments, type ToolDefinition } from '../../packages/hud-mcp/src/tools.js';
import { REPO_ROOT } from '../fixtures/paths.js';

const FAKE = join(REPO_ROOT, 'tests/fakes/herdr.mjs');

const ROUTING = `schema = 1
default_preset = "daily"

[backends.web]
executor = "jev"
target = "chatgpt-pro"
mode = "pro"

[backends.pi-a]
executor = "herdr"
harness = "pi"
model = "synthetic-flash"
effort = "max"
recipe = "pi-role"

[backends.pi-b]
executor = "herdr"
harness = "pi"
model = "synthetic-other"
effort = "max"
recipe = "pi-role"

[backends.claude-a]
executor = "herdr"
harness = "claude"
model = "synthetic-claude"
effort = "high"
recipe = "claude"

[backends.page]
executor = "jev"
target = "browser"

[backends.codex-a]
executor = "herdr"
harness = "codex"
model = "synthetic-codex"
effort = "medium"
recipe = "codex-zsh"
wrapper = "codex2"

[backends.codex-a.args]
service_tier = "default"

[backends.codex-missing]
executor = "herdr"
harness = "codex"
model = "synthetic-codex"
effort = "medium"
recipe = "codex-zsh"
wrapper = "codex"
env_profile = "missing-name"

[backends.grok-a]
executor = "herdr"
harness = "grok"
model = "synthetic-grok"
effort = "high"
recipe = "grok"

[env_profiles.codex2]
CODEX_HOME = "/tmp/synthetic-codex-account2"

[jev_decisions.typesafe-default]
provider = "typesafe"

[presets.daily]
description = "Synthetic daily preset."
jev_decisions = "typesafe-default"

[presets.daily.roles]
"oracle.propose" = "web"
"oracle.converge" = "pi-a"
imp = "pi-a"
reviewer = "claude-a"
sonic = "pi-a"
jev = "page"

[presets.other]
description = "Synthetic other preset."
jev_decisions = "typesafe-default"

[presets.other.roles]
"oracle.propose" = "web"
"oracle.converge" = "pi-b"
imp = "pi-b"
reviewer = "claude-a"
sonic = "pi-b"
jev = "page"
`;

interface Logged {
  bin?: string;
  argv: string[];
  receipt_before?: boolean | null;
  notify?: string;
  herdrEnv?: string;
}

interface Stage {
  home: string;
  work: string;
  env: NodeJS.ProcessEnv;
  root: RosterRoot;
  other: RosterRoot;
  ctx(root?: RosterRoot, jev?: JevExecutor | null): FacadeContext;
  log(): Logged[];
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function stage(t: TestContext, mode = 'ok', delayMs = 0): Stage {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'hud-r2-')));
  chmodSync(home, 0o700);
  const work = join(home, 'work');
  mkdirSync(work, { mode: 0o700 });
  // Generic transaction tests retain the unchanged Claude transport. Pi's
  // execution/QA lifecycle now runs through the real owned fixture in pi-dispatch-facade.
  writeFileSync(
    join(home, 'routing.toml'),
    ROUTING.replaceAll('harness = "pi"', 'harness = "claude"').replaceAll('recipe = "pi-role"', 'recipe = "claude"'),
    { mode: 0o600 }
  );
  const bin = join(home, 'bin');
  mkdirSync(bin, { mode: 0o700 });
  const wrapper = join(bin, 'herdr');
  writeFileSync(wrapper, `#!/bin/bash\nexec ${quote(process.execPath)} ${quote(FAKE)} "$@"\n`);
  chmodSync(wrapper, 0o755);
  const env: NodeJS.ProcessEnv = {
    PATH: bin,
    HOME: home,
    HUD_HOME: home,
    TMPDIR: home,
    HERDR_FAKE_LOG: join(home, 'herdr.log'),
    HERDR_FAKE_STATE: join(home, 'herdr-state.json'),
    HERDR_FAKE_MODE: mode,
    HERDR_FAKE_DELAY_MS: String(delayMs),
    HERDR_FAKE_ASSERT_HOME: home,
  };
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return {
    home,
    work: realpathSync(work),
    env,
    root: parseRosterRoot('synthetic-namespace/synthetic-session'),
    other: parseRosterRoot('synthetic-namespace/other-session'),
    ctx(root = parseRosterRoot('synthetic-namespace/synthetic-session'), jev = null) {
      return { home, root, env, jev };
    },
    log() {
      const file = join(home, 'herdr.log');
      if (!existsSync(file)) return [];
      const text = readFileSync(file, 'utf8').trim();
      return text ? text.split('\n').map((line) => JSON.parse(line) as Logged) : [];
    },
  };
}

function calls(entries: Logged[], name: string): Logged[] {
  return entries.filter((entry) => !entry.bin && `${entry.argv[0]} ${entry.argv[1]}` === name);
}

function herdrLog(entries: Logged[]): Logged[] {
  return entries.filter((entry) => !entry.bin);
}

function receipts(home: string): string[] {
  const jobs = join(home, 'jobs');
  if (!existsSync(jobs)) return [];
  return readdirSync(jobs).flatMap((name) => {
    const file = join(jobs, name, 'receipt.json');
    return /^j[a-f0-9]{16}$/.test(name) && existsSync(file) ? [file] : [];
  });
}

function imp(work: string, key: string, task = 'Implement the synthetic task.\nKeep the change local.') {
  return { role: 'imp', request_key: key, task, cwd: work };
}

test('env profile table maps names and does not invent a home', () => {
  const routing = parseRouting(ROUTING);
  assert.equal(envProfileVars(routing, 'codex2')?.CODEX_HOME, '/tmp/synthetic-codex-account2');
  assert.deepEqual({ ...(envProfileVars(routing, null) ?? {}) }, {});
  assert.equal(envProfileVars(routing, 'missing-name'), null);
  assert.throws(
    () => parseRouting(`${ROUTING}\n[env_profiles.bad]\nHOME = "/tmp/synthetic"\n`),
    (error) => error instanceof RoutingError && error.code === 'unknown_key' && error.field === 'env_profiles.bad.HOME'
  );
  assert.throws(
    () => parseRouting(`${ROUTING}\n[env_profiles.bad]\nCODEX_HOME = "synthetic"\n`),
    (error) =>
      error instanceof RoutingError && error.code === 'invalid_value' && error.field === 'env_profiles.bad.CODEX_HOME'
  );
  assert.throws(
    () => parseRouting(`${ROUTING}\n[env_profiles.bad]\nCODEX_HOME = "/tmp/synthetic/../account"\n`),
    (error) =>
      error instanceof RoutingError && error.code === 'invalid_value' && error.field === 'env_profiles.bad.CODEX_HOME'
  );
  assert.throws(
    () => parseRouting(ROUTING.replace('recipe = "pi-role"', 'recipe = "pi-implementer"')),
    (error) => error instanceof RoutingError && error.code === 'invalid_value' && error.field === 'backends.pi-a.recipe'
  );
  const source = ['herdr-run.ts', 'facade.ts', 'launch.ts', 'adapters.ts']
    .map((name) => readFileSync(join(REPO_ROOT, 'src/roles', name), 'utf8'))
    .join('\n');
  assert.doesNotMatch(source, /~\/\.codex|\/home\/|CODEX_HOME\s*=/);
  const launch = readFileSync(join(REPO_ROOT, 'src/roles/launch.ts'), 'utf8');
  assert.match(launch, /danger-full-access/);
  assert.match(launch, /pi-role/);
});

test('role tool schemas are the six static tools', () => {
  assert.deepEqual(
    ROLE_TOOLS.map((tool) => tool.name),
    ['hud_roster', 'hud_create', 'hud_read', 'hud_send', 'hud_respond', 'hud_close']
  );
  const create = ROLE_TOOLS.find((tool) => tool.name === 'hud_create') as ToolDefinition;
  const role = create.inputSchema.properties as { role: { enum: string[] } };
  assert.deepEqual(role.role.enum, [...ROLES]);
  assert.deepEqual(create.inputSchema.required, ['role', 'request_key']);
  assert.equal(validateToolArguments(create, { role: 'imp', request_key: 'synthetic-key' }), true);
  assert.equal(validateToolArguments(create, { role: 'oracle', request_key: 'synthetic-key', phase: 'propose' }), true);
  assert.equal(validateToolArguments(create, { role: 'wizard', request_key: 'synthetic-key' }), false);
  assert.equal(validateToolArguments(create, { role: 'imp', request_key: 'synthetic-key', extra: true }), false);
  assert.equal(validateToolArguments(create, { request_key: 'synthetic-key' }), false);
  const respond = ROLE_TOOLS.find((tool) => tool.name === 'hud_respond') as ToolDefinition;
  assert.equal(
    validateToolArguments(respond, { job: 'j0123456789abcdef', request_id: 'q1', answer: 'synthetic' }),
    true
  );
  const roleMain = readFileSync(join(REPO_ROOT, 'packages/hud-mcp/src/role-main.ts'), 'utf8');
  const extension = readFileSync(join(REPO_ROOT, 'packages/hud-mcp/src/role-extension.ts'), 'utf8');
  assert.doesNotMatch(`${roleMain}\n${extension}`, /NativeHostClient/);
  const bin = readFileSync(join(REPO_ROOT, 'packages/hud-mcp/bin/hud-mcp.mjs'), 'utf8');
  assert.match(bin, /selectMcpEntry/);
  assert.equal(selectMcpEntry(undefined), '../dist/packages/hud-mcp/src/main.js');
  assert.equal(selectMcpEntry('roles'), '../dist/packages/hud-mcp/src/role-main.js');
  assert.throws(() => selectMcpEntry('bogus'), /unknown_surface: "bogus"/);
  assert.throws(() => selectMcpEntry(''), /unknown_surface: ""/);
  const roleTools = new RoleFacadeTools('/tmp/synthetic-hud').tools.map((tool) => tool.name);
  assert.deepEqual(
    roleTools,
    ROLE_TOOLS.map((tool) => tool.name)
  );
  const managed = [...MANAGED_TOOLS, ...JEV_TOOLS].map((tool) => tool.name);
  assert.ok(managed.length > roleTools.length);
  assert.equal(managed.includes('hud_create'), false);
  assert.equal(roleTools.includes('managed_create'), false);
  assert.ok(managed.some((name) => name.startsWith('managed_')));
  assert.ok(managed.some((name) => name.startsWith('jev_')));
  const mainSrc = readFileSync(join(REPO_ROOT, 'packages/hud-mcp/src/main.ts'), 'utf8');
  assert.match(mainSrc, /new NativeManagedTools/);
  assert.match(mainSrc, /new JevTools/);
  assert.doesNotMatch(mainSrc, /RoleFacadeTools/);
  assert.match(roleMain, /new RoleFacadeTools/);
  assert.match(roleMain, /createRoleJevExecutor\(home\)/);
  assert.doesNotMatch(roleMain, /NativeHostClient/);
  const bogus = spawnSync(process.execPath, [join(REPO_ROOT, 'packages/hud-mcp/bin/hud-mcp.mjs')], {
    env: { ...process.env, HUD_MCP_SURFACE: 'bogus' },
    encoding: 'utf8',
  });
  assert.equal(bogus.status, 1);
  assert.match(bogus.stderr, /unknown_surface: "bogus"/);
  assert.doesNotMatch(bogus.stderr, /HUD_HOME/);
});

test('create read send respond close against the fake herdr', async (t) => {
  const s = stage(t);
  const created = await hudCreate(s.ctx(), imp(s.work, 'lifecycle'));
  assert.equal(created.ok, true);
  const job = created.job as string;
  assert.match(job, /^j[a-f0-9]{16}$/);
  const directory = join(s.home, 'jobs', job);
  const receipt = JSON.parse(readFileSync(join(directory, 'receipt.json'), 'utf8')) as {
    task?: string;
    parent: string;
    request_key: string;
    fingerprint: string;
    role: string;
    phase: null;
    routing_revision: string;
    preset: string;
    binding: { id: string; model: string; harness: string; env_profile: null };
    cwd: string;
    executor: { kind: string; agent: string; tab_id: string; pane_id: string };
    state: string;
    prompted: boolean;
  };
  assert.equal(receipt.task, undefined);
  assert.equal(receipt.parent, 'synthetic-namespace/synthetic-session');
  assert.equal(receipt.request_key, 'lifecycle');
  assert.equal(receipt.role, 'imp');
  assert.equal(receipt.phase, null);
  assert.equal(receipt.preset, 'daily');
  assert.equal(receipt.routing_revision, sha256(readFileSync(join(s.home, 'routing.toml'), 'utf8')));
  assert.equal(
    receipt.fingerprint,
    sha256(
      canonicalJson({
        role: 'imp',
        phase: null,
        task: 'Implement the synthetic task.\nKeep the change local.',
        cwd: s.work,
        preset: null,
        profile: null,
        input: null,
      })
    )
  );
  assert.equal(receipt.binding.id, 'pi-a');
  assert.equal(receipt.binding.model, 'synthetic-flash');
  assert.equal(receipt.binding.harness, 'claude');
  assert.equal(receipt.binding.env_profile, null);
  assert.equal(receipt.cwd, s.work);
  assert.equal(receipt.state, 'open');
  assert.equal(receipt.prompted, true);
  assert.equal(receipt.executor.kind, 'herdr');
  assert.equal(receipt.executor.agent, `hud-${job}`);
  assert.equal(receipt.executor.tab_id, 'tab1');
  assert.equal(receipt.executor.pane_id, 'pane1');
  const association = JSON.parse(readFileSync(join(s.home, 'assoc', `${job}.json`), 'utf8')) as {
    schema: number;
    preset: string;
    herdr: { tab_id: string; agent: string };
    report_path: string;
    closed: boolean;
  };
  const observation = association as typeof association & { created_at: string; native?: unknown };
  assert.ok(Number.isFinite(Date.parse(observation.created_at)));
  assert.equal(observation.native, undefined, 'no complete source-qualified evidence exists at launch');
  assert.equal(association.schema, 1);
  assert.equal(association.preset, 'daily');
  assert.equal(association.herdr.tab_id, 'tab1');
  assert.equal(association.herdr.agent, `hud-${job}`);
  assert.equal(association.report_path, join(directory, 'report.md'));
  assert.equal(association.closed, false);
  assert.equal(created.acceptance, undefined);
  const wait = created.wait as { command: string; argv: string[] };
  assert.deepEqual(wait.argv, [join(REPO_ROOT, 'bin/hud'), 'wait', '--job', job, '--timeout-ms', '3600000']);
  assert.equal(wait.command, wait.argv.map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(' '));

  const launched = herdrLog(s.log());
  assert.equal(launched[0]?.receipt_before, true);
  assert.deepEqual(
    launched.map((entry) => `${entry.argv[0]} ${entry.argv[1]}`),
    ['tab create', 'agent start', 'agent prompt']
  );
  const pi = s.log().filter((entry) => entry.bin === 'pi-role');
  assert.equal(pi.length, 0);
  const createArgs = launched[0]!.argv;
  assert.ok(createArgs.includes('--no-focus'));
  assert.ok(createArgs.includes('--label'));
  assert.match(createArgs[createArgs.indexOf('--label') + 1]!, /^imp:[a-f0-9]{8}$/);
  assert.equal(createArgs.includes('--workspace'), false);
  const start = launched[1]!.argv;
  assert.deepEqual(start.slice(0, 8), [
    'agent',
    'start',
    `hud-${job}`,
    '--kind',
    'claude',
    '--pane',
    'pane1',
    '--timeout',
  ]);
  assert.ok(start.includes('--'));
  assert.ok(start.includes('--model') && start.includes('synthetic-flash'));
  assert.ok(start.includes('--effort') && start.includes('max'));
  const brief = readFileSync(join(directory, 'brief.md'), 'utf8');
  assert.match(brief, /Implement the synthetic task\.\nKeep the change local\./);
  assert.equal(launched[2]!.argv[3], `Read ${join(directory, 'brief.md')} and do exactly what it asks.`);
  assert.equal(launched[2]!.argv[3]!.includes('\n'), false);

  const early = await hudRespond(s.ctx(), { job, request_id: 'q1', answer: 'not yet' });
  assert.equal(early.ok, false);
  assert.equal(early.code, 'handoff');
  writeFileSync(join(directory, 'qa', 'q1.md'), 'Which file?\n', { mode: 0o600 });
  const reading = await hudRead(s.ctx(), { job, wait_ms: 50 });
  assert.equal(reading.ok, true);
  assert.equal(reading.acceptance, null);
  assert.equal(reading.status, 'idle');
  const pending = reading.pending as { id: string }[];
  assert.deepEqual(
    pending.map((item) => item.id),
    ['q1']
  );

  const answered = await hudRespond(s.ctx(), { job, request_id: 'q1', answer: 'Use the synthetic file.' });
  assert.equal(answered.code, 'handoff');
  assert.equal(existsSync(join(directory, 'qa', 'q1.answer.md')), false);
  const again = await hudRespond(s.ctx(), { job, request_id: 'q1', answer: 'Use the synthetic file.' });
  assert.equal(again.code, 'handoff');
  const clash = await hudRespond(s.ctx(), { job, request_id: 'q1', answer: 'A different answer.' });
  assert.equal(clash.ok, false);
  assert.equal(clash.code, 'handoff');
  const after = await hudRead(s.ctx(), { job });
  assert.deepEqual(after.pending, [{ id: 'q1', path: join(directory, 'qa/q1.md') }]);
  assert.equal(after.acceptance, null);

  const sent = await hudSend(s.ctx(), { job, message_key: 'note-1', text: 'Look at the synthetic diff.' });
  assert.equal(sent.ok, true);
  assert.equal(sent.idempotent, false);
  const replay = await hudSend(s.ctx(), { job, message_key: 'note-1', text: 'Look at the synthetic diff.' });
  assert.equal(replay.ok, true);
  assert.equal(replay.idempotent, true);
  const changed = await hudSend(s.ctx(), { job, message_key: 'note-1', text: 'Different follow-up.' });
  assert.equal(changed.ok, false);
  assert.equal(changed.code, 'conflict');
  const prompts = calls(s.log(), 'agent prompt').map((entry) => entry.argv[3]);
  assert.deepEqual(
    prompts.filter((text) => text === 'Look at the synthetic diff.'),
    ['Look at the synthetic diff.']
  );

  writeFileSync(join(directory, 'report.md'), 'synthetic result\n', { mode: 0o600 });
  const beforeClose = s.log().length;
  const closed = await hudClose(s.ctx(), { job });
  assert.equal(closed.ok, true);
  assert.equal(closed.idempotent, false);
  assert.equal(closed.observation, 'quit_and_closed');
  assert.equal(existsSync(join(directory, 'brief.md')), true);
  assert.equal(existsSync(join(directory, 'receipt.json')), true);
  assert.equal(existsSync(join(directory, 'report.md')), true);
  assert.equal(existsSync(join(directory, 'qa', 'q1.answer.md')), false);
  const afterClose = JSON.parse(readFileSync(join(s.home, 'assoc', `${job}.json`), 'utf8')) as { closed: boolean };
  assert.equal(afterClose.closed, true);
  const closedMetadata = JSON.parse(readFileSync(join(s.home, 'assoc', `${job}.json`), 'utf8'));
  assert.ok(Number.isFinite(Date.parse(closedMetadata.closed_at)));
  assert.ok(Date.parse(closedMetadata.closed_at) >= Date.parse(closedMetadata.created_at));
  const second = await hudClose(s.ctx(), { job });
  assert.equal(second.ok, true);
  assert.equal(second.idempotent, true);
  assert.equal(s.log().length, beforeClose + 2);
  assert.equal(calls(s.log(), 'tab close').length, 1);
  assert.equal(calls(s.log(), 'agent prompt').filter((entry) => entry.argv[3] === '/quit').length, 1);
});

test('same key replays one job and a changed request conflicts', async (t) => {
  const s = stage(t, 'ok', 250);
  const firstArgs = imp(s.work, 'same-key', 'one synthetic task');
  const [first, second] = await Promise.all([hudCreate(s.ctx(), firstArgs), hudCreate(s.ctx(), { ...firstArgs })]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.job, second.job);
  assert.equal(second.idempotent, true);
  assert.equal(calls(s.log(), 'tab create').length, 1);
  const conflict = await hudCreate(s.ctx(), imp(s.work, 'same-key', 'a different synthetic task'));
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, 'conflict');
  assert.equal(conflict.job, first.job);
  assert.equal(calls(s.log(), 'tab create').length, 1);
});

test('a lost tab acknowledgement is launch_unknown and is not relaunched', async (t) => {
  const s = stage(t, 'lose-create');
  const args = imp(s.work, 'lost-ack');
  const first = await hudCreate(s.ctx(), args);
  assert.equal(first.ok, false);
  assert.equal(first.code, 'launch_unknown');
  const job = first.job as string;
  const stored = JSON.parse(readFileSync(join(s.home, 'jobs', job, 'receipt.json'), 'utf8')) as { state: string };
  assert.equal(stored.state, 'launch_unknown');
  const second = await hudCreate(s.ctx(), args);
  assert.equal(second.ok, false);
  assert.equal(second.code, 'launch_unknown');
  assert.equal(second.job, job);
  assert.equal(calls(s.log(), 'tab create').length, 1);
  assert.equal(calls(s.log(), 'agent start').length, 0);
  assert.equal(calls(s.log(), 'agent list').length, 0);
  assert.ok(calls(s.log(), 'tab list').length >= 2);
});

test('a missing herdr binary is backend_unavailable and does not keep the key', async (t) => {
  const s = stage(t);
  const empty = join(s.home, 'empty-path');
  mkdirSync(empty, { mode: 0o700 });
  const missing: FacadeContext = {
    home: s.home,
    root: s.root,
    env: { PATH: empty, HOME: s.home, HUD_HOME: s.home, TMPDIR: s.home },
  };
  const failed = await hudCreate(missing, imp(s.work, 'missing-herdr'));
  assert.deepEqual(failed, { ok: false, code: 'backend_unavailable', executor: 'herdr', reason: 'herdr_missing' });
  assert.deepEqual(receipts(s.home), []);
  const assoc = join(s.home, 'assoc');
  assert.deepEqual(existsSync(assoc) ? readdirSync(assoc) : [], []);
  const retried = await hudCreate(s.ctx(), imp(s.work, 'missing-herdr'));
  assert.equal(retried.ok, true);
  assert.equal(calls(s.log(), 'tab create').length, 1);
});

test('a preset switch changes only the next job', async (t) => {
  const s = stage(t);
  const first = await hudCreate(s.ctx(), imp(s.work, 'before-switch', 'before'));
  assert.equal(first.ok, true);
  const selected = await hudRoster(s.ctx(), { action: 'select', preset: 'other' });
  assert.equal(selected.ok, true);
  assert.equal(selected.preset, 'other');
  const second = await hudCreate(s.ctx(), imp(s.work, 'after-switch', 'after'));
  assert.equal(second.ok, true);
  assert.notEqual(first.job, second.job);
  const before = JSON.parse(readFileSync(join(s.home, 'jobs', String(first.job), 'receipt.json'), 'utf8')) as {
    preset: string;
    binding: { id: string; model: string };
  };
  const after = JSON.parse(readFileSync(join(s.home, 'jobs', String(second.job), 'receipt.json'), 'utf8')) as {
    preset: string;
    binding: { model: string };
  };
  assert.equal(before.preset, 'daily');
  assert.equal(before.binding.model, 'synthetic-flash');
  assert.equal(after.preset, 'other');
  assert.equal(after.binding.model, 'synthetic-other');
  const frozen = JSON.parse(readFileSync(join(s.home, 'assoc', `${String(first.job)}.json`), 'utf8')) as {
    preset: string;
    backend: { model: string };
  };
  assert.equal(frozen.preset, 'daily');
  assert.equal(frozen.backend.model, 'synthetic-flash');
});

test('two roots do not see each other’s jobs', async (t) => {
  const s = stage(t);
  const created = await hudCreate(s.ctx(s.root), imp(s.work, 'shared-key', 'root a'));
  assert.equal(created.ok, true);
  const hidden = await hudRead(s.ctx(s.other), { job: created.job });
  assert.equal(hidden.ok, false);
  assert.equal(hidden.code, 'not_found');
  const foreign = await hudRead(s.ctx(s.other), {});
  assert.deepEqual(foreign.jobs, []);
  const own = await hudRead(s.ctx(s.root), {});
  const jobs = own.jobs as { job: string }[];
  assert.deepEqual(
    jobs.map((item) => item.job),
    [created.job]
  );
  const other = await hudCreate(s.ctx(s.other), imp(s.work, 'shared-key', 'root a'));
  assert.equal(other.ok, true);
  assert.notEqual(other.job, created.job);
});

test('returned wait resolves the running package with spaces/quotes, works off PATH, and marks a missing bin', async (t) => {
  const s = stage(t);
  const args = imp(s.work, 'relocated-wait');
  const created = await hudCreate(s.ctx(), args);
  assert.equal(created.ok, true);
  const receiptFile = join(s.home, 'jobs', String(created.job), 'receipt.json');
  const stored = JSON.parse(readFileSync(receiptFile, 'utf8'));
  writeFileSync(receiptFile, JSON.stringify({ ...stored, state: 'closed' }), { mode: 0o600 });
  const root = join(s.home, "package space ' quote");
  mkdirSync(join(root, 'bin'), { recursive: true });
  cpSync(join(REPO_ROOT, 'dist'), join(root, 'dist'), { recursive: true });
  symlinkSync(join(REPO_ROOT, 'node_modules'), join(root, 'node_modules'), 'dir');
  writeFileSync(join(root, 'package.json'), '{"name":"synthetic-package","type":"module"}');
  for (const name of ['hud', 'hud-run']) cpSync(join(REPO_ROOT, 'bin', name), join(root, 'bin', name));
  const node = join(s.home, 'bin/node');
  writeFileSync(node, `#!/bin/sh\nexec ${quote(process.execPath)} "$@"\n`, { mode: 0o755 });
  const source = `const {hudCreate}=await import(${JSON.stringify(pathToFileURL(join(root, 'dist/roles/facade.js')).href)}); console.log(JSON.stringify(await hudCreate(JSON.parse(process.argv[1]),JSON.parse(process.argv[2]))));`;
  const make = () => {
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        source,
        JSON.stringify({ home: s.home, env: s.env, root: s.root }),
        JSON.stringify(args),
      ],
      { env: s.env, encoding: 'utf8', timeout: 10000 }
    );
    assert.equal(result.status, 0, result.stderr);
    const made = JSON.parse(result.stdout);
    assert.equal(made.ok, true, result.stdout);
    return made.wait;
  };
  const wait = make();
  assert.deepEqual(wait.argv, [join(root, 'bin/hud'), 'wait', '--job', created.job, '--timeout-ms', '3600000']);
  assert.equal(wait.wait_path, undefined);
  const waited = spawnSync('/bin/bash', ['-c', wait.command], { env: s.env, encoding: 'utf8', timeout: 10000 });
  assert.equal(waited.status, 0, waited.stderr);
  assert.equal(JSON.parse(waited.stdout).status, 'closed');
  rmSync(join(root, 'bin/hud'));
  const missing = make();
  assert.equal(missing.argv[0], 'hud');
  assert.equal(missing.wait_path, 'unresolved');
  assert.equal(missing.command, missing.argv.map(quote).join(' '));
});

test('codex wrapper selects the account and a missing row does not launch', { timeout: 20_000 }, async (t) => {
  const s = stage(t);
  const created = await hudCreate(s.ctx(), {
    role: 'imp',
    request_key: 'codex-account',
    task: 'synthetic codex task',
    cwd: s.work,
    profile: 'codex-a',
  });
  assert.equal(created.ok, true);
  const createArgs = calls(s.log(), 'tab create')[0]!.argv;
  assert.equal(createArgs.includes('--env'), false);
  assert.equal(
    createArgs.some((item) => item.includes('CODEX_HOME')),
    false
  );
  assert.equal(calls(s.log(), 'agent start').length, 0);
  const ran = calls(s.log(), 'pane run')[0]!.argv;
  assert.equal(ran[0], 'pane');
  assert.equal(ran[1], 'run');
  assert.match(ran[3] ?? '', /'codex2'/);
  assert.match(ran[3] ?? '', /'synthetic-codex'/);
  assert.match(ran[3] ?? '', /model_reasoning_effort=medium/);
  assert.match(ran[3] ?? '', /service_tier=default/);
  assert.match(ran[3] ?? '', /danger-full-access/);
  assert.match(ran[3] ?? '', /'-a' 'never'/);
  const renamed = calls(s.log(), 'agent rename')[0]!.argv;
  assert.equal(renamed[3], `hud-${String(created.job)}`);
  const unresolved = await hudCreate(s.ctx(), {
    role: 'imp',
    request_key: 'codex-missing',
    task: 'synthetic codex task',
    cwd: s.work,
    profile: 'codex-missing',
  });
  assert.equal(unresolved.ok, false);
  assert.equal(unresolved.code, 'env_profile_unresolved');
  assert.equal(calls(s.log(), 'tab create').length, 1);
});

test('jev bindings stay unavailable until R3 plugs in', async (t) => {
  const s = stage(t);
  const jev = await hudCreate(s.ctx(), {
    role: 'jev',
    request_key: 'page-job',
    input: { kind: 'ask', text: 'synthetic question' },
  });
  assert.deepEqual(jev, { ok: false, code: 'backend_unavailable', executor: 'jev', reason: 'pending R3' });
  const oracle = await hudCreate(s.ctx(), {
    role: 'oracle',
    phase: 'propose',
    request_key: 'oracle-web',
    task: 'synthetic proposal',
    cwd: s.work,
  });
  assert.deepEqual(oracle, { ok: false, code: 'backend_unavailable', executor: 'jev', reason: 'pending R3' });
  const bare = await hudCreate(s.ctx(), { role: 'oracle', request_key: 'oracle-bare', task: 'x', cwd: s.work });
  assert.equal(bare.ok, false);
  assert.equal(bare.code, 'invalid_arguments');
  assert.equal(bare.field, 'phase');
  const untagged = await hudCreate(s.ctx(), { role: 'jev', request_key: 'untagged' });
  assert.equal(untagged.ok, false);
  assert.equal(untagged.code, 'invalid_arguments');
  assert.equal(untagged.field, 'input');
  assert.deepEqual(receipts(s.home), []);
  assert.equal(s.log().length, 0);

  const plugged: JevExecutor = {
    id: 'jev',
    async launch(_ctx, request) {
      return { ok: true, plugged: true, request_key: request.requestKey, wrote_receipt: false };
    },
  };
  const delegated = await hudCreate(s.ctx(s.root, plugged), {
    role: 'jev',
    request_key: 'plugged',
    input: { kind: 'ask', text: 'synthetic question' },
  });
  assert.equal(delegated.ok, true);
  assert.equal(delegated.plugged, true);
  assert.deepEqual(receipts(s.home), []);
  assert.equal(s.log().length, 0);
});

test('a non-pi harness returns a herdr handoff instead of an answer file', async (t) => {
  const s = stage(t);
  const created = await hudCreate(s.ctx(), {
    role: 'reviewer',
    request_key: 'review-1',
    task: 'Review the synthetic diff.',
    cwd: s.work,
  });
  assert.equal(created.ok, true);
  const start = calls(s.log(), 'agent start')[0]!.argv;
  assert.equal(start[start.indexOf('--kind') + 1], 'claude');
  assert.ok(start.includes('--model') && start.includes('synthetic-claude'));
  assert.ok(start.includes('--effort') && start.includes('high'));
  const response = await hudRespond(s.ctx(), { job: created.job, request_id: 'q1', answer: 'synthetic' });
  assert.equal(response.ok, false);
  assert.equal(response.code, 'handoff');
  const location = response.location as { kind: string; agent: string; tab_id: string; pane_id: string };
  assert.equal(location.kind, 'herdr');
  assert.equal(location.agent, `hud-${String(created.job)}`);
  assert.equal(location.tab_id, 'tab1');
  assert.equal(existsSync(join(s.home, 'jobs', String(created.job), 'qa', 'q1.answer.md')), false);
});

test('hud wait prints one herdr wait and does not accept the job', async (t) => {
  const s = stage(t);
  const created = await hudCreate(s.ctx(), imp(s.work, 'wait-job', 'wait for this'));
  assert.equal(created.ok, true);
  const job = created.job as string;
  let stdout = '';
  let stderr = '';
  const io = {
    env: s.env,
    stdout: (chunk: string) => {
      stdout += chunk;
    },
    stderr: (chunk: string) => {
      stderr += chunk;
    },
  };
  const code = await main(['wait', '--job', job, '--timeout-ms', '1000'], io);
  assert.equal(code, 0, stderr);
  const parsed = JSON.parse(stdout) as { ok: boolean; job: string; status: string; acceptance: null };
  assert.equal(parsed.ok, true);
  assert.equal(parsed.job, job);
  assert.equal(parsed.status, 'idle');
  assert.equal(parsed.acceptance, null);
  const waited = calls(s.log(), 'agent wait')[0]!.argv;
  assert.ok(waited.includes('--until') && waited.includes('idle'));
  assert.ok(waited.includes('--timeout') && waited.includes('1000'));
  stdout = '';
  const help = await main(['wait', '--help'], io);
  assert.equal(help, 0);
  assert.match(stdout, /hud wait --job <id>/);
  assert.match(stdout, /1800000/);
  assert.match(stdout, /3600000/);
  assert.match(stdout, /6  The wait timed out/);
  const bad = await main(['wait'], io);
  assert.equal(bad, 2);
});

test('unnamed agents are skipped and the Codex recipe retains its checked shell arguments', () => {
  const agents = listedAgents(
    JSON.stringify({
      id: 'cli:agent:list',
      result: {
        type: 'agent_list',
        agents: [
          { agent_status: 'idle', pane_id: 'w1:p1', tab_id: 'w1:t1' },
          { name: 'hud-j0123456789abcdef', agent_status: 'idle', pane_id: 'pane1', tab_id: 'tab1' },
        ],
      },
    })
  );
  assert.equal(agents?.length, 1);
  assert.equal(agents?.[0]?.name, 'hud-j0123456789abcdef');
  assert.equal(listedAgents('{"result":{"agents":[null]}}'), null);
  const shell = codexShell(parseRouting(ROUTING).backends['codex-a']!);
  assert.match(shell, /^'codex2'/);
  assert.match(shell, /danger-full-access/);
});

test('a lost tab reply is recovered from the tab list and is not created twice', async (t) => {
  const s = stage(t, 'lose-create-keep');
  const created = await hudCreate(s.ctx(), imp(s.work, 'recovered'));
  assert.equal(created.ok, true);
  assert.equal(created.prompted, true);
  assert.equal(created.state, 'open');
  assert.equal(calls(s.log(), 'tab create').length, 1);
  assert.ok(calls(s.log(), 'tab list').length >= 1);
  assert.equal(calls(s.log(), 'pane list').length, 1);
  assert.equal(calls(s.log(), 'agent start').length, 1);
  const receipt = JSON.parse(readFileSync(join(s.home, 'jobs', String(created.job), 'receipt.json'), 'utf8')) as {
    executor: { tab_id: string; pane_id: string };
  };
  assert.equal(receipt.executor.tab_id, 'tab1');
  assert.equal(receipt.executor.pane_id, 'pane1');
});

test('a crash between send intent and the prompt is not resent', async (t) => {
  const s = stage(t);
  const created = await hudCreate(s.ctx(), imp(s.work, 'send-crash'));
  assert.equal(created.ok, true);
  const job = String(created.job);
  const directory = join(s.home, 'jobs', job, 'messages');
  mkdirSync(directory, { mode: 0o700 });
  writeFileSync(
    join(directory, `${sha256('note-crash')}.json`),
    `${JSON.stringify({ schema: 1, message_key: 'note-crash', text: 'Look at the synthetic diff.', state: 'sending' })}\n`
  );
  const before = calls(s.log(), 'agent prompt').length;
  const sent = await hudSend(s.ctx(), { job, message_key: 'note-crash', text: 'Look at the synthetic diff.' });
  assert.equal(sent.ok, false);
  assert.equal(sent.code, 'send_unknown');
  assert.equal(calls(s.log(), 'agent prompt').length, before);
});

test('a definite pre-send rejection can be retried', async (t) => {
  const s = stage(t, 'fail-prompt');
  const created = await hudCreate(s.ctx(), imp(s.work, 'send-retry'));
  assert.equal(created.ok, true);
  const job = String(created.job);
  const denied = await hudSend(s.ctx(), { job, message_key: 'note-retry', text: 'Look again.' });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'send_failed');
  assert.equal(existsSync(join(s.home, 'jobs', job, 'messages', `${sha256('note-retry')}.json`)), false);
  s.env.HERDR_FAKE_MODE = 'ok';
  const sent = await hudSend(s.ctx(), { job, message_key: 'note-retry', text: 'Look again.' });
  assert.equal(sent.ok, true);
  assert.equal(sent.idempotent, false);
});

test('close finds a tab by label and treats a gone tab as already gone', async (t) => {
  const s = stage(t);
  const created = await hudCreate(s.ctx(), imp(s.work, 'close-label'));
  assert.equal(created.ok, true);
  const job = String(created.job);
  const file = join(s.home, 'jobs', job, 'receipt.json');
  const stored = JSON.parse(readFileSync(file, 'utf8')) as { executor: { tab_id: string | null } };
  stored.executor.tab_id = null;
  writeFileSync(file, JSON.stringify(stored));
  const closed = await hudClose(s.ctx(), { job });
  assert.equal(closed.ok, true);
  assert.equal(closed.observation, 'quit_and_closed');
  assert.ok(calls(s.log(), 'tab list').length >= 1);
  assert.equal(calls(s.log(), 'tab close').length, 1);

  const gone = stage(t, 'close-missing');
  const opened = await hudCreate(gone.ctx(), imp(gone.work, 'close-gone'));
  assert.equal(opened.ok, true);
  const finished = await hudClose(gone.ctx(), { job: opened.job });
  assert.equal(finished.ok, true);
  assert.equal(finished.observation, 'already_gone');
  const again = await hudClose(gone.ctx(), { job: opened.job });
  assert.equal(again.ok, true);
  assert.equal(again.idempotent, true);
  assert.equal(again.observation, 'already_gone');
});

test('a failed launch records that the tab was closed', async (t) => {
  const s = stage(t, 'fail-start');
  const created = await hudCreate(s.ctx(), imp(s.work, 'start-failed'));
  assert.equal(created.ok, false);
  assert.equal(created.code, 'launch_failed');
  assert.equal(calls(s.log(), 'tab close').length, 1);
  const closed = await hudClose(s.ctx(), { job: created.job });
  assert.equal(closed.ok, true);
  assert.equal(closed.observation, 'already_gone');
  assert.equal(calls(s.log(), 'tab close').length, 1);
});

test('grok and claude adapters pass the flags from each CLI help', async (t) => {
  const s = stage(t);
  const grok = await hudCreate(s.ctx(), {
    role: 'imp',
    request_key: 'grok-job',
    task: 'synthetic grok task',
    cwd: s.work,
    profile: 'grok-a',
  });
  assert.equal(grok.ok, true);
  const start = calls(s.log(), 'agent start')[0]!.argv;
  assert.equal(start[start.indexOf('--kind') + 1], 'grok');
  assert.ok(start.includes('-m') && start.includes('synthetic-grok'));
  assert.ok(start.includes('--reasoning-effort') && start.includes('high'));
  assert.ok(start.includes('--permission-mode') && start.includes('bypassPermissions'));
  assert.equal(start.filter((item) => item === '--model' || item === '--effort').length, 0);
  const claude = await hudCreate(s.ctx(), {
    role: 'reviewer',
    request_key: 'claude-job',
    task: 'synthetic claude task',
    cwd: s.work,
  });
  assert.equal(claude.ok, true);
  const claudeStart = calls(s.log(), 'agent start')[1]!.argv;
  assert.equal(claudeStart[claudeStart.indexOf('--kind') + 1], 'claude');
  assert.ok(claudeStart.includes('--model') && claudeStart.includes('synthetic-claude'));
  assert.ok(claudeStart.includes('--effort') && claudeStart.includes('high'));
});

test('an oracle on the pi adapter refuses an uninstalled checkout', async (t) => {
  const s = stage(t);
  writeFileSync(join(s.home, 'routing.toml'), ROUTING);
  const created = await hudCreate(s.ctx(), {
    role: 'oracle',
    phase: 'converge',
    request_key: 'oracle-pi',
    task: 'synthetic oracle task',
    cwd: s.work,
  });
  assert.equal(created.ok, false);
  assert.equal(created.code, 'pi_owned_release_unverified');
  assert.equal(s.log().length, 0);
});

test('a live lock returns busy without launching', async (t) => {
  const s = stage(t);
  const key = 'busy-key';
  const root = formatRosterRoot(s.root);
  const lock = join(s.home, 'jobs', 'locks', `key-${sha256(canonicalJson([root, key]))}`);
  mkdirSync(join(lock, '..'), { recursive: true, mode: 0o700 });
  writeFileSync(lock, `${process.pid}:${Date.now()}:synthetic`);
  const index = join(s.home, 'jobs', 'index', sha256(root), `${sha256(key)}.json`);
  mkdirSync(join(index, '..'), { recursive: true, mode: 0o700 });
  writeFileSync(
    index,
    `${JSON.stringify({ schema: 1, job: 'j0123456789abcdef', fingerprint: 'abc', parent: root })}\n`
  );
  const started = Date.now();
  const result = await hudCreate({ ...s.ctx(), lockWaitMs: 200 }, imp(s.work, key, 'busy task'));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'busy');
  assert.equal(result.job, 'j0123456789abcdef');
  assert.ok(Date.now() - started < 5000);
  assert.equal(s.log().length, 0);
});

test('a hung herdr call returns herdr_timeout', { timeout: 15_000 }, async (t) => {
  const s = stage(t, 'hang');
  const started = Date.now();
  const result = await hudCreate({ ...s.ctx(), herdrBudgetMs: 200 }, imp(s.work, 'hang-key'));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'herdr_timeout');
  assert.ok(Date.now() - started < 5000);
  assert.equal(calls(s.log(), 'agent start').length, 0);
});

test('a new question ends hud_read before wait_ms', { timeout: 10_000 }, async (t) => {
  const s = stage(t);
  const created = await hudCreate(s.ctx(), imp(s.work, 'qa-wait'));
  assert.equal(created.ok, true);
  s.env.HERDR_FAKE_WAIT_SLEEP = 'timeout';
  s.env.HERDR_FAKE_STATUS = 'working';
  s.env.HERDR_FAKE_QA = join(s.home, 'jobs', String(created.job), 'qa');
  const started = Date.now();
  const reading = await hudRead(s.ctx(), { job: created.job, wait_ms: 5000 });
  assert.ok(Date.now() - started < 2500);
  assert.equal(reading.ok, true);
  const pending = reading.pending as { id: string }[];
  assert.deepEqual(
    pending.map((item) => item.id),
    ['q1']
  );
});

function storedReceipt(
  home: string,
  job: string
): { executor: { tab_id: string | null }; state: string; steps: { tab_closed: boolean } } {
  return JSON.parse(readFileSync(join(home, 'jobs', job, 'receipt.json'), 'utf8')) as {
    executor: { tab_id: string | null };
    state: string;
    steps: { tab_closed: boolean };
  };
}

function clearTabId(home: string, job: string): void {
  const file = join(home, 'jobs', job, 'receipt.json');
  const stored = JSON.parse(readFileSync(file, 'utf8')) as { executor: { tab_id: string | null } };
  stored.executor.tab_id = null;
  writeFileSync(file, JSON.stringify(stored));
}

test('close is unresolved unless the label lookup is conclusive', async (t) => {
  const failed = stage(t, 'close-unreadable');
  const opened = await hudCreate(failed.ctx(), imp(failed.work, 'list-down'));
  assert.equal(opened.ok, true);
  const unresolved = await hudClose(failed.ctx(), { job: opened.job });
  assert.equal(unresolved.ok, false);
  assert.equal(unresolved.code, 'close_unresolved');
  const pending = storedReceipt(failed.home, String(opened.job));
  assert.equal(pending.state, 'open');
  assert.equal(pending.steps.tab_closed, false);
  failed.env.HERDR_FAKE_MODE = 'ok';
  const retried = await hudClose(failed.ctx(), { job: opened.job });
  assert.equal(retried.ok, true);
  assert.equal(retried.observation, 'quit_and_closed');

  const ambiguous = stage(t);
  const second = await hudCreate(ambiguous.ctx(), imp(ambiguous.work, 'two-labels'));
  assert.equal(second.ok, true);
  clearTabId(ambiguous.home, String(second.job));
  ambiguous.env.HERDR_FAKE_MODE = 'dup-label';
  const both = await hudClose(ambiguous.ctx(), { job: second.job });
  assert.equal(both.ok, false);
  assert.equal(both.code, 'close_unresolved');
  assert.equal(storedReceipt(ambiguous.home, String(second.job)).state, 'open');

  const split = stage(t);
  const third = await hudCreate(split.ctx(), imp(split.work, 'two-panes'));
  assert.equal(third.ok, true);
  clearTabId(split.home, String(third.job));
  split.env.HERDR_FAKE_MODE = 'two-panes';
  const before = calls(split.log(), 'pane list').length;
  const closed = await hudClose(split.ctx(), { job: third.job });
  assert.equal(closed.ok, true);
  assert.equal(closed.observation, 'quit_and_closed');
  assert.equal(calls(split.log(), 'pane list').length, before);
  assert.equal(calls(split.log(), 'tab close').length, 1);
});

test('close waits on the same key lock as create', { timeout: 20_000 }, async (t) => {
  const s = stage(t, 'ok', 400);
  const creating = hudCreate(s.ctx(), imp(s.work, 'race-key'));
  const deadline = Date.now() + 2000;
  let file = '';
  while (Date.now() < deadline && !file) {
    file = receipts(s.home)[0] ?? '';
    if (!file) await delay(10);
  }
  assert.ok(file);
  const job = file.split('/').at(-2);
  let finished = false;
  const closing = hudClose(s.ctx(), { job }).then((result) => {
    finished = true;
    return result;
  });
  await delay(120);
  assert.equal(finished, false);
  const created = await creating;
  const closed = await closing;
  assert.equal(created.ok, true);
  assert.equal(closed.ok, true);
  assert.equal(closed.observation, 'quit_and_closed');
  assert.equal(storedReceipt(s.home, String(created.job)).state, 'closed');
  const commands = herdrLog(s.log()).map((entry) => `${entry.argv[0]} ${entry.argv[1]}`);
  const createAt = commands.indexOf('tab create');
  const promptAt = commands.indexOf('agent prompt');
  const closeAt = commands.lastIndexOf('tab close');
  assert.ok(createAt >= 0 && promptAt > createAt && closeAt > promptAt);
});

test('a codex wrapper is explicit and is not inferred from the env profile name', () => {
  const routing = parseRouting(ROUTING);
  assert.equal(routing.backends['codex-a']?.wrapper, 'codex2');
  assert.equal(routing.backends['codex-a']?.envProfile, null);
  assert.match(codexShell(routing.backends['codex-a']!), /^'codex2'/);
  const forced = parseRouting(
    ROUTING.replace(
      'CODEX_HOME = "/tmp/synthetic-codex-account2"',
      'CLAUDE_CONFIG_DIR = "/tmp/synthetic-claude"'
    ).replace('wrapper = "codex2"', 'wrapper = "codex"\nenv_profile = "codex2"')
  );
  assert.equal(forced.backends['codex-a']?.envProfile, 'codex2');
  assert.match(codexShell(forced.backends['codex-a']!), /^'codex'/);
  assert.throws(
    () => parseRouting(ROUTING.replace('wrapper = "codex2"', 'wrapper = "codex2"\nenv_profile = "codex2"')),
    (error) =>
      error instanceof RoutingError && error.code === 'invalid_value' && error.field === 'backends.codex-a.env_profile'
  );
  assert.throws(
    () => parseRouting(ROUTING.replace('wrapper = "codex2"\n', '')),
    (error) =>
      error instanceof RoutingError && error.code === 'missing_field' && error.field === 'backends.codex-a.wrapper'
  );
  assert.throws(
    () => parseRouting(ROUTING.replace('recipe = "pi-role"\n', 'recipe = "pi-role"\nwrapper = "codex"\n')),
    (error) =>
      error instanceof RoutingError && error.code === 'invalid_value' && error.field === 'backends.pi-a.wrapper'
  );
});

test('a lock heartbeats, and only a dead pid or a stale beat is stolen', async (t) => {
  const beat = stage(t);
  const file = join(beat.home, 'jobs', 'locks', 'beat');
  await withLock(
    beat.home,
    'beat',
    async () => {
      const first = statSync(file).mtimeMs;
      await delay(160);
      assert.ok(statSync(file).mtimeMs > first);
    },
    1_000,
    40
  );

  const empty = stage(t);
  const key = 'empty-lock';
  const root = formatRosterRoot(empty.root);
  const lock = join(empty.home, 'jobs', 'locks', `key-${sha256(canonicalJson([root, key]))}`);
  mkdirSync(join(lock, '..'), { recursive: true, mode: 0o700 });
  writeFileSync(lock, '');
  const started = Date.now();
  const waiting = await hudCreate({ ...empty.ctx(), lockWaitMs: 200 }, imp(empty.work, key));
  assert.equal(waiting.code, 'busy');
  assert.ok(Date.now() - started < 2000);
  assert.equal(empty.log().length, 0);

  const dead = stage(t);
  const deadPid = spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid;
  assert.ok(deadPid && deadPid >= 2);
  const deadKey = 'dead-lock';
  const deadRoot = formatRosterRoot(dead.root);
  const deadLock = join(dead.home, 'jobs', 'locks', `key-${sha256(canonicalJson([deadRoot, deadKey]))}`);
  mkdirSync(join(deadLock, '..'), { recursive: true, mode: 0o700 });
  writeFileSync(deadLock, `${deadPid}:${Date.now()}:synthetic`);
  const stolen = await hudCreate({ ...dead.ctx(), lockWaitMs: 200 }, imp(dead.work, deadKey));
  assert.equal(stolen.ok, true);
  assert.ok(calls(dead.log(), 'tab create').length >= 1);

  const stale = stage(t);
  const staleKey = 'stale-lock';
  const staleRoot = formatRosterRoot(stale.root);
  const staleLock = join(stale.home, 'jobs', 'locks', `key-${sha256(canonicalJson([staleRoot, staleKey]))}`);
  mkdirSync(join(staleLock, '..'), { recursive: true, mode: 0o700 });
  writeFileSync(staleLock, `${process.pid}:${Date.now()}:synthetic`);
  const old = new Date(Date.now() - LOCK_WAIT_MS - 5_000);
  utimesSync(staleLock, old, old);
  const took = await hudCreate({ ...stale.ctx(), lockWaitMs: 200 }, imp(stale.work, staleKey));
  assert.equal(took.ok, true);
  assert.ok(calls(stale.log(), 'tab create').length >= 1);
});

test('a retried launch uses the binding stored on the receipt', async (t) => {
  const s = stage(t);
  const created = await hudCreate(s.ctx(), imp(s.work, 'resume-binding'));
  assert.equal(created.ok, true);
  const job = String(created.job);
  const file = join(s.home, 'jobs', job, 'receipt.json');
  const stored = JSON.parse(readFileSync(file, 'utf8')) as {
    state: string;
    prompted: boolean;
    steps: { launch: string; rename: string; prompt: string };
    binding: { model: string };
  };
  stored.state = 'launching';
  stored.prompted = false;
  stored.steps.launch = 'unsent';
  stored.steps.rename = 'unsent';
  stored.steps.prompt = 'unsent';
  stored.binding.model = 'synthetic-from-receipt';
  writeFileSync(file, JSON.stringify(stored));
  writeFileSync(
    join(s.home, 'routing.toml'),
    readFileSync(join(s.home, 'routing.toml'), 'utf8').replace(
      'model = "synthetic-flash"',
      'model = "synthetic-from-routing"'
    )
  );
  const again = await hudCreate(s.ctx(), imp(s.work, 'resume-binding'));
  assert.equal(again.ok, true);
  const starts = calls(s.log(), 'agent start');
  const last = starts[starts.length - 1]!.argv;
  assert.ok(last.includes('synthetic-from-receipt'));
  assert.equal(last.includes('synthetic-from-routing'), false);
  assert.equal(last[last.indexOf('--kind') + 1], 'claude');
});

test('pi-role PATH no longer supplies argv from a checkout', async (t) => {
  const s = stage(t);
  s.env.PI_ROLE_NOTIFY = 'herdr agent prompt w0:p1';
  s.env.PI_ORCHESTRATOR_PANE = 'w0:p9';
  s.env.HERDR_ENV = '0';
  writeFileSync(join(s.home, 'routing.toml'), ROUTING);
  const created = await hudCreate(s.ctx(), imp(s.work, 'scrubbed-pi'));
  assert.equal(created.code, 'pi_owned_release_unverified');
  assert.deepEqual(s.log(), []);
});

test('codex rename waits three seconds, matching the recipe', () => {
  assert.deepEqual([...RENAME_BACKOFF_MS], [3000, 3000, 3000]);
});

test('hud_read polls at one second and then backs off', { timeout: 15_000 }, async (t) => {
  const s = stage(t);
  const created = await hudCreate(s.ctx(), imp(s.work, 'read-backoff'));
  assert.equal(created.ok, true);
  s.env.HERDR_FAKE_WAIT_SLEEP = 'timeout';
  s.env.HERDR_FAKE_STATUS = 'working';
  const started = Date.now();
  const reading = await hudRead(s.ctx(), { job: created.job, wait_ms: 3500 });
  const elapsed = Date.now() - started;
  assert.equal(reading.ok, true);
  assert.ok(elapsed >= 3000 && elapsed < 8000);
  const waits = calls(s.log(), 'agent wait').map((entry) => Number(entry.argv[entry.argv.indexOf('--timeout') + 1]));
  assert.deepEqual(waits.slice(0, 2), [1000, 2000]);
  assert.ok((waits[2] ?? 0) > 0 && (waits[2] ?? 0) <= 500);
});

async function jevRuntime(t: TestContext, home: string, creds: boolean): Promise<JevRuntime> {
  const stateDir = join(home, 'jev-state');
  mkdirSync(stateDir, { mode: 0o700 });
  if (creds) {
    const file = join(home, 'credentials.env');
    writeFileSync(file, 'TYPESAFE_API_KEY=synthetic-r23-typesafe\n', { mode: 0o600 });
    chmodSync(file, 0o600);
  }
  const runtime = new JevRuntime({
    chrome: '/synthetic/chrome',
    profile: '/synthetic/profile',
    cdpUrl: 'http://offline.invalid',
    hudHome: home,
    stateDir,
    fake: true,
    graceMs: 60_000,
  });
  await runtime.start();
  t.after(() => runtime.stop());
  return runtime;
}

async function untilTerminal(ctx: FacadeContext, job: string): Promise<Record<string, unknown>> {
  let latest: Record<string, unknown> = { ok: false, code: 'missing' };
  for (let attempt = 0; attempt < 80; attempt += 1) {
    latest = (await hudRead(ctx, { job })) as Record<string, unknown>;
    if (latest.ok === true && (latest.state === 'done' || latest.state === 'error' || latest.state === 'closed')) {
      return latest;
    }
    await delay(50);
  }
  return latest;
}

test('oracle ask maps onto the runtime and reports target_pending', async (t) => {
  const s = stage(t);
  const runtime = await jevRuntime(t, s.home, true);
  const jev = createRoleJevExecutor(s.home, runtime);
  const ctx = s.ctx(s.root, jev);
  const created = await hudCreate(ctx, {
    role: 'oracle',
    phase: 'propose',
    request_key: 'oracle-web',
    task: 'synthetic proposal',
    cwd: s.work,
  });
  assert.equal(created.ok, true);
  const executor = created.executor as { kind: string; job: string };
  assert.equal(executor.kind, 'jev');
  assert.match(executor.job, /^jev-/);
  const again = await hudCreate(ctx, {
    role: 'oracle',
    phase: 'propose',
    request_key: 'oracle-web',
    task: 'synthetic proposal',
    cwd: s.work,
  });
  assert.equal(again.ok, true);
  assert.equal(again.idempotent, true);
  assert.equal(again.job, created.job);
  const read = await untilTerminal(ctx, String(created.job));
  assert.equal(read.ok, true);
  assert.equal(read.state, 'done');
  const result = read.result as { status?: string; target?: string };
  assert.equal(result.status, 'target_pending');
  assert.equal(result.target, 'chatgpt-pro');
  const stored = JSON.parse(readFileSync(join(s.home, 'jev-runtime', 'jobs', `${executor.job}.json`), 'utf8')) as {
    requestKey: string;
    input: { tag: string; target: string; label: string; prompt: string };
  };
  assert.equal(stored.input.tag, 'ask');
  assert.equal(stored.input.target, 'chatgpt-pro');
  assert.equal(stored.input.prompt, 'synthetic proposal');
  assert.match(stored.input.label, /^o-[a-f0-9]{12}$/);
  assert.match(stored.requestKey, /^r2-[a-f0-9]{40}$/);
  assert.notEqual(stored.requestKey, 'oracle-web');
  assert.equal(readdirSync(join(s.home, 'jev-runtime', 'jobs')).length, 1);
  assert.equal(s.log().length, 0);
  const browserAsk = await hudCreate(ctx, {
    role: 'jev',
    request_key: 'ask-browser',
    input: { kind: 'ask', text: 'synthetic question' },
  });
  assert.equal(browserAsk.ok, false);
  assert.equal(browserAsk.code, 'invalid_arguments');
  assert.equal(browserAsk.field, 'input');
  const sent = await hudSend(ctx, { job: created.job, message_key: 'note-1', text: 'follow up' });
  assert.equal(sent.ok, false);
  assert.equal(sent.code, 'unsupported');
});

test('browse and judge round-trip through create, read, and close', async (t) => {
  const s = stage(t);
  const runtime = await jevRuntime(t, s.home, true);
  const jev = createRoleJevExecutor(s.home, runtime);
  const ctx = s.ctx(s.root, jev);
  const browse = await hudCreate(ctx, {
    role: 'jev',
    request_key: 'browse-1',
    input: { kind: 'browse', text: 'Read the synthetic page.', url: 'https://example.invalid/fixture' },
  });
  assert.equal(browse.ok, true);
  const browsed = await untilTerminal(ctx, String(browse.job));
  assert.equal(browsed.ok, true);
  assert.equal(browsed.state, 'done');
  const judge = await hudCreate(ctx, {
    role: 'jev',
    request_key: 'judge-1',
    input: {
      kind: 'judge',
      url: 'https://example.invalid/fixture',
      statements: ['The page is ready.'],
    },
  });
  assert.equal(judge.ok, true);
  const judged = await untilTerminal(ctx, String(judge.job));
  assert.equal(judged.ok, true);
  assert.equal(judged.state, 'done');
  const verdicts = (judged.result as { statements?: Array<{ name: string; verdict: string }> }).statements ?? [];
  assert.equal(verdicts[0]?.name, 's1');
  assert.equal(verdicts[0]?.verdict, 'pass');
  const closed = await hudClose(ctx, { job: browse.job });
  assert.equal(closed.ok, true);
  assert.equal(closed.closed, true);
  assert.equal(closed.idempotent, false);
  const again = await hudClose(ctx, { job: browse.job });
  assert.equal(again.ok, true);
  assert.equal(again.idempotent, true);
  const judgeClosed = await hudClose(ctx, { job: judge.job });
  assert.equal(judgeClosed.ok, true);
  assert.equal(judgeClosed.closed, true);
  assert.equal(s.log().length, 0);
});

test('the same request key on two parents does not conflict', async (t) => {
  const s = stage(t);
  const runtime = await jevRuntime(t, s.home, true);
  const jev = createRoleJevExecutor(s.home, runtime);
  const input = { kind: 'browse', text: 'Read the synthetic page.', url: 'https://example.invalid/shared' };
  const first = await hudCreate(s.ctx(s.root, jev), { role: 'jev', request_key: 'shared-key', input });
  const second = await hudCreate(s.ctx(s.other, jev), { role: 'jev', request_key: 'shared-key', input });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.notEqual(first.job, second.job);
  assert.notEqual(first.code, 'association_conflict');
  assert.notEqual(second.code, 'association_conflict');
  const keys = readdirSync(join(s.home, 'jev-runtime', 'jobs')).map((name) => {
    const job = JSON.parse(readFileSync(join(s.home, 'jev-runtime', 'jobs', name), 'utf8')) as { requestKey: string };
    return job.requestKey;
  });
  assert.equal(keys.length, 2);
  assert.equal(new Set(keys).size, 2);
  assert.ok(keys.every((key) => /^r2-[a-f0-9]{40}$/.test(key)));
});

test('a lost createJob acknowledgement retries the same runtime key', async (t) => {
  const s = stage(t);
  const runtime = await jevRuntime(t, s.home, true);
  const keys: string[] = [];
  let calls = 0;
  const wrapped = {
    async createJob(request: JevCreateRequest): Promise<JevJob> {
      calls += 1;
      keys.push(request.requestKey);
      if (calls === 1) {
        const files = receipts(s.home);
        assert.equal(files.length, 1);
        const stored = JSON.parse(readFileSync(files[0]!, 'utf8')) as {
          job: string;
          executor: { kind: string; job: string | null };
        };
        assert.equal(stored.executor.kind, 'jev');
        assert.equal(stored.executor.job, null);
        assert.equal(existsSync(join(s.home, 'assoc', `${stored.job}.json`)), true);
      }
      if (calls < 3) throw Object.assign(new Error('lost'), { code: 'runtime_timeout' });
      return runtime.createJob(request);
    },
    readJob: (jobId: string, options?: { waitMs?: number; afterSeq?: number }) => runtime.readJob(jobId, options),
    sendFollowUp: (jobId: string, followUp: { key: string; text: string }) => runtime.sendFollowUp(jobId, followUp),
    closeJob: (jobId: string) => runtime.closeJob(jobId),
  };
  const jev = createRoleJevExecutor(s.home, wrapped);
  const ctx = s.ctx(s.root, jev);
  const args = {
    role: 'oracle',
    phase: 'propose',
    request_key: 'lost-ack',
    task: 'synthetic proposal',
    cwd: s.work,
  };
  const lost = await hudCreate(ctx, args);
  assert.equal(lost.ok, false);
  assert.equal(lost.code, 'launch_unknown');
  assert.equal(calls, 2);
  const created = await hudCreate(ctx, args);
  assert.equal(created.ok, true);
  assert.equal(created.job, lost.job);
  assert.equal(calls, 3);
  assert.equal(new Set(keys).size, 1);
  assert.match(keys[0] ?? '', /^r2-[a-f0-9]{40}$/);
  assert.notEqual(keys[0], 'lost-ack');
  assert.equal(readdirSync(join(s.home, 'jev-runtime', 'jobs')).length, 1);
});

test('a runtime that cannot start returns its typed code', async (t) => {
  const s = stage(t);
  const missingCreds = await jevRuntime(t, s.home, false);
  const creds = createRoleJevExecutor(s.home, missingCreds);
  const failed = await hudCreate(s.ctx(s.root, creds), {
    role: 'oracle',
    phase: 'propose',
    request_key: 'missing-creds',
    task: 'synthetic proposal',
    cwd: s.work,
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'backend_unavailable');
  assert.equal(failed.executor, 'jev');
  assert.equal(failed.reason, 'jev_credentials_missing');
  const stateDir = {
    async createJob(): Promise<JevJob> {
      throw Object.assign(new Error('missing'), { code: 'jev_state_dir_missing' });
    },
    async readJob(): Promise<JevJob> {
      throw Object.assign(new Error('missing'), { code: 'jev_state_dir_missing' });
    },
    async sendFollowUp(): Promise<JevJob> {
      throw Object.assign(new Error('missing'), { code: 'jev_state_dir_missing' });
    },
    async closeJob(): Promise<JevJob> {
      throw Object.assign(new Error('missing'), { code: 'jev_state_dir_missing' });
    },
  };
  const unavailable = await hudCreate(s.ctx(s.root, createRoleJevExecutor(s.home, stateDir)), {
    role: 'jev',
    request_key: 'missing-state',
    input: { kind: 'browse', text: 'Read the synthetic page.', url: 'https://example.invalid/fixture' },
  });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.code, 'backend_unavailable');
  assert.equal(unavailable.executor, 'jev');
  assert.equal(unavailable.reason, 'jev_state_dir_missing');
  const create = ROLE_TOOLS.find((tool) => tool.name === 'hud_create') as ToolDefinition;
  const statements = Array.from({ length: 13 }, () => 'synthetic statement');
  assert.equal(
    validateToolArguments(create, { role: 'jev', request_key: 'too-many', input: { kind: 'judge', statements } }),
    false
  );
  assert.equal(
    validateToolArguments(create, {
      role: 'jev',
      request_key: 'named',
      input: {
        kind: 'judge',
        url: 'https://example.invalid/fixture',
        statements: [{ name: 'page_ready', statement: 'The page is ready.' }],
      },
    }),
    true
  );
  const tooMany = await hudCreate(s.ctx(), {
    role: 'jev',
    request_key: 'too-many',
    input: { kind: 'judge', url: 'https://example.invalid/fixture', statements },
  });
  assert.equal(tooMany.ok, false);
  assert.equal(tooMany.code, 'invalid_arguments');
  assert.equal(tooMany.field, 'input');
});

test('role create accepts judge statements and rejects extra statement fields', () => {
  const create = ROLE_TOOLS.find((tool) => tool.name === 'hud_create') as ToolDefinition;
  assert.equal(
    validateToolArguments(create, {
      role: 'jev',
      request_key: 'named',
      input: { kind: 'judge', url: 'https://example.invalid/fixture', statements: ['The page is ready.'] },
    }),
    true
  );
  assert.equal(
    validateToolArguments(create, {
      role: 'jev',
      request_key: 'named',
      input: {
        kind: 'judge',
        url: 'https://example.invalid/fixture',
        statements: [{ name: 'page_ready', statement: 'The page is ready.', extra: true }],
      },
    }),
    false
  );
});

test('a closed jev job stays closed', async (t) => {
  const s = stage(t);
  const runtime = await jevRuntime(t, s.home, true);
  let calls = 0;
  let mode: 'lose' | 'hold' | 'pass' = 'lose';
  let blocked = false;
  let release = (): void => {};
  const wrapped = {
    async createJob(request: JevCreateRequest): Promise<JevJob> {
      calls += 1;
      if (mode === 'lose' && calls === 1) {
        await runtime.createJob(request);
        throw Object.assign(new Error('lost'), { code: 'runtime_timeout' });
      }
      if (mode === 'lose' && calls === 2) throw Object.assign(new Error('lost'), { code: 'runtime_timeout' });
      if (mode === 'hold') {
        blocked = true;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return runtime.createJob(request);
    },
    readJob: (jobId: string, options?: { waitMs?: number; afterSeq?: number }) => runtime.readJob(jobId, options),
    sendFollowUp: (jobId: string, followUp: { key: string; text: string }) => runtime.sendFollowUp(jobId, followUp),
    closeJob: (jobId: string) => runtime.closeJob(jobId),
  };
  const jev = createRoleJevExecutor(s.home, wrapped);
  const ctx = s.ctx(s.root, jev);
  const input = { kind: 'browse', text: 'Read the synthetic page.', url: 'https://example.invalid/fixture' };
  const lost = await hudCreate(ctx, { role: 'jev', request_key: 'close-lost', input });
  assert.equal(lost.ok, false);
  assert.equal(lost.code, 'launch_unknown');
  assert.equal(calls, 2);
  const closed = await hudClose(ctx, { job: lost.job });
  assert.equal(closed.ok, true);
  assert.equal(closed.closed, true);
  assert.equal(closed.idempotent, false);
  assert.equal(calls, 3);
  const stored = JSON.parse(readFileSync(join(s.home, 'jobs', String(lost.job), 'receipt.json'), 'utf8')) as {
    state: string;
  };
  assert.equal(stored.state, 'closed');
  const again = await hudCreate(ctx, { role: 'jev', request_key: 'close-lost', input });
  assert.equal(again.ok, true);
  assert.equal(again.idempotent, true);
  assert.equal(again.job, lost.job);
  assert.equal(again.state, 'closed');
  assert.equal(calls, 3);
  const runtimeJobs = readdirSync(join(s.home, 'jev-runtime', 'jobs')).map((name) => {
    return JSON.parse(readFileSync(join(s.home, 'jev-runtime', 'jobs', name), 'utf8')) as { closed?: boolean };
  });
  assert.equal(runtimeJobs.length, 1);
  assert.equal(runtimeJobs[0]?.closed, true);

  mode = 'hold';
  let closeDone = false;
  const creating = hudCreate(ctx, { role: 'jev', request_key: 'close-race', input });
  for (let attempt = 0; attempt < 50 && !blocked; attempt += 1) await delay(10);
  assert.equal(blocked, true);
  const raceFile = receipts(s.home).find((file) => {
    const body = JSON.parse(readFileSync(file, 'utf8')) as { request_key?: string };
    return body.request_key === 'close-race';
  });
  assert.ok(raceFile);
  const raceJob = (JSON.parse(readFileSync(raceFile, 'utf8')) as { job: string }).job;
  const closing = hudClose(ctx, { job: raceJob }).then((result) => {
    closeDone = true;
    return result;
  });
  await delay(80);
  assert.equal(closeDone, false);
  release();
  const raced = await creating;
  const raceClosed = await closing;
  assert.equal(raced.ok, true);
  assert.equal(raceClosed.ok, true);
  assert.equal(raceClosed.idempotent, false);
  const racedAgain = await hudCreate(ctx, { role: 'jev', request_key: 'close-race', input });
  assert.equal(racedAgain.ok, true);
  assert.equal(racedAgain.job, raced.job);
  assert.equal(racedAgain.state, 'closed');
  assert.equal(racedAgain.idempotent, true);
});

test('a transient jev error leaves the job state unchanged', async (t) => {
  const s = stage(t);
  const runtime = await jevRuntime(t, s.home, true);
  let failRead = false;
  let failSend = false;
  let missingClose = false;
  const wrapped = {
    createJob: (request: JevCreateRequest) => runtime.createJob(request),
    async readJob(jobId: string, options?: { waitMs?: number; afterSeq?: number }): Promise<JevJob> {
      if (failRead) {
        failRead = false;
        throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
      }
      return runtime.readJob(jobId, options);
    },
    async sendFollowUp(jobId: string, followUp: { key: string; text: string }): Promise<JevJob> {
      if (failSend) {
        failSend = false;
        throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
      }
      return runtime.sendFollowUp(jobId, followUp);
    },
    async closeJob(jobId: string): Promise<JevJob> {
      if (missingClose) throw Object.assign(new Error('missing'), { code: 'not_found' });
      return runtime.closeJob(jobId);
    },
  };
  const ctx = s.ctx(s.root, createRoleJevExecutor(s.home, wrapped));
  const created = await hudCreate(ctx, {
    role: 'jev',
    request_key: 'transient',
    input: { kind: 'browse', text: 'Read the synthetic page.', url: 'https://example.invalid/fixture' },
  });
  assert.equal(created.ok, true);
  const done = await untilTerminal(ctx, String(created.job));
  assert.equal(done.state, 'done');
  const file = join(s.home, 'jobs', String(created.job), 'receipt.json');
  failRead = true;
  const reset = await hudRead(ctx, { job: created.job });
  assert.equal(reset.ok, false);
  assert.equal(reset.code, 'runtime_unavailable');
  assert.equal(reset.executor, 'jev');
  assert.equal(reset.reason, 'ECONNRESET');
  assert.equal((JSON.parse(readFileSync(file, 'utf8')) as { state: string }).state, 'done');
  const again = await hudRead(ctx, { job: created.job });
  assert.equal(again.ok, true);
  assert.equal(again.state, 'done');
  failSend = true;
  const sent = await hudSend(ctx, { job: created.job, message_key: 'note-reset', text: 'Look again.' });
  assert.equal(sent.ok, false);
  assert.equal(sent.code, 'runtime_unavailable');
  assert.equal(sent.reason, 'ECONNRESET');
  assert.equal((JSON.parse(readFileSync(file, 'utf8')) as { state: string }).state, 'done');
  missingClose = true;
  const closed = await hudClose(ctx, { job: created.job });
  assert.equal(closed.ok, true);
  assert.equal(closed.observation, 'already_gone');
  assert.equal((JSON.parse(readFileSync(file, 'utf8')) as { state: string }).state, 'closed');
});

test('a jev retry uses the binding stored on the receipt', async (t) => {
  const s = stage(t);
  const runtime = await jevRuntime(t, s.home, true);
  const seen: string[] = [];
  let calls = 0;
  const wrapped = {
    async createJob(request: JevCreateRequest): Promise<JevJob> {
      calls += 1;
      seen.push(request.input.tag === 'ask' ? request.input.target : request.input.tag);
      if (calls === 1) {
        await runtime.createJob(request);
        throw Object.assign(new Error('lost'), { code: 'runtime_timeout' });
      }
      if (calls === 2) throw Object.assign(new Error('lost'), { code: 'runtime_timeout' });
      return runtime.createJob(request);
    },
    readJob: (jobId: string, options?: { waitMs?: number; afterSeq?: number }) => runtime.readJob(jobId, options),
    sendFollowUp: (jobId: string, followUp: { key: string; text: string }) => runtime.sendFollowUp(jobId, followUp),
    closeJob: (jobId: string) => runtime.closeJob(jobId),
  };
  const ctx = s.ctx(s.root, createRoleJevExecutor(s.home, wrapped));
  const args = {
    role: 'oracle',
    phase: 'propose',
    request_key: 'stored-binding',
    task: 'synthetic proposal',
    cwd: s.work,
  };
  const lost = await hudCreate(ctx, args);
  assert.equal(lost.ok, false);
  assert.equal(lost.code, 'launch_unknown');
  writeFileSync(
    join(s.home, 'routing.toml'),
    ROUTING.replace('target = "chatgpt-pro"', 'target = "aistudio"').replace(
      'provider = "typesafe"',
      'provider = "openai"'
    ),
    { mode: 0o600 }
  );
  const created = await hudCreate(ctx, args);
  assert.equal(created.ok, true);
  assert.equal(created.job, lost.job);
  assert.equal(calls, 3);
  assert.deepEqual(seen, ['chatgpt-pro', 'chatgpt-pro', 'chatgpt-pro']);
  const binding = created.binding as { target?: string };
  assert.equal(binding.target, 'chatgpt-pro');
  const jobs = readdirSync(join(s.home, 'jev-runtime', 'jobs'));
  assert.equal(jobs.length, 1);
  const runtimeJob = JSON.parse(readFileSync(join(s.home, 'jev-runtime', 'jobs', jobs[0]!), 'utf8')) as {
    input: { target: string };
  };
  assert.equal(runtimeJob.input.target, 'chatgpt-pro');
});

test('hud_read carries the runtime error code', async (t) => {
  const s = stage(t);
  const failed: JevJob = {
    executor: 'jev',
    id: 'jev-synthetic-failed',
    requestKey: 'r2-synthetic',
    fingerprint: 'synthetic',
    session: { namespace: s.root.namespace, sessionId: s.root.sessionId },
    tag: 'browse',
    decisionProfile: null,
    provider: null,
    state: 'failed',
    closed: false,
    seq: 2,
    result: null,
    error: { code: 'synthetic_failed', message: 'synthetic failure' },
  };
  const handle = {
    async createJob(request: JevCreateRequest): Promise<JevJob> {
      return { ...failed, requestKey: request.requestKey, session: request.session };
    },
    async readJob(): Promise<JevJob> {
      return failed;
    },
    async sendFollowUp(): Promise<JevJob> {
      return failed;
    },
    async closeJob(): Promise<JevJob> {
      return { ...failed, state: 'closed', closed: true };
    },
  };
  const ctx = s.ctx(s.root, createRoleJevExecutor(s.home, handle));
  const created = await hudCreate(ctx, {
    role: 'jev',
    request_key: 'failed-read',
    input: { kind: 'browse', text: 'Read the synthetic page.', url: 'https://example.invalid/fixture' },
  });
  assert.equal(created.ok, true);
  const read = await hudRead(ctx, { job: created.job });
  assert.equal(read.ok, true);
  assert.equal(read.state, 'error');
  assert.equal(read.status, 'synthetic_failed');
  assert.equal((read.error as { code?: string }).code, 'synthetic_failed');
});

test('a jev create points at hud_read', async (t) => {
  const s = stage(t);
  const runtime = await jevRuntime(t, s.home, true);
  const ctx = s.ctx(s.root, createRoleJevExecutor(s.home, runtime));
  const created = await hudCreate(ctx, {
    role: 'oracle',
    phase: 'propose',
    request_key: 'read-wait',
    task: 'synthetic proposal',
    cwd: s.work,
  });
  assert.equal(created.ok, true);
  const wait = created.wait as { command: string; argv: string[] };
  assert.equal(wait.command, `hud_read --job ${created.job}`);
  assert.deepEqual(wait.argv, ['hud_read', '--job', created.job]);
  assert.equal(wait.command.includes('hud wait'), false);
  assert.equal(created.brief_path, undefined);
});

test('hud_read does not reopen a closed jev job', async (t) => {
  const s = stage(t);
  const runtime = await jevRuntime(t, s.home, true);
  let hold = false;
  let held = false;
  let release = (): void => {};
  const wrapped = {
    createJob: (request: JevCreateRequest) => runtime.createJob(request),
    async readJob(jobId: string, options?: { waitMs?: number; afterSeq?: number }): Promise<JevJob> {
      const job = await runtime.readJob(jobId, hold ? { waitMs: 0 } : options);
      if (!hold) return job;
      held = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { ...job, state: 'running' };
    },
    sendFollowUp: (jobId: string, followUp: { key: string; text: string }) => runtime.sendFollowUp(jobId, followUp),
    closeJob: (jobId: string) => runtime.closeJob(jobId),
  };
  const ctx = s.ctx(s.root, createRoleJevExecutor(s.home, wrapped));
  const created = await hudCreate(ctx, {
    role: 'jev',
    request_key: 'read-close',
    input: { kind: 'browse', text: 'Read the synthetic page.', url: 'https://example.invalid/fixture' },
  });
  assert.equal(created.ok, true);
  const done = await untilTerminal(ctx, String(created.job));
  assert.equal(done.state, 'done');
  hold = true;
  const reading = hudRead(ctx, { job: created.job });
  for (let attempt = 0; attempt < 50 && !held; attempt += 1) await delay(10);
  assert.equal(held, true);
  const closed = await hudClose(ctx, { job: created.job });
  assert.equal(closed.ok, true);
  const file = join(s.home, 'jobs', String(created.job), 'receipt.json');
  assert.equal((JSON.parse(readFileSync(file, 'utf8')) as { state: string }).state, 'closed');
  release();
  const read = await reading;
  assert.equal(read.ok, true);
  assert.equal(read.state, 'closed');
  assert.equal((JSON.parse(readFileSync(file, 'utf8')) as { state: string }).state, 'closed');
});
