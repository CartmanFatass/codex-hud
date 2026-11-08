import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { main } from '../../src/cli/hud.js';
import { canonicalJson } from '../../src/core/canonical.js';
import {
  hudClose,
  hudCreate,
  hudRead,
  hudRespond,
  hudRoster,
  hudSend,
  type FacadeContext,
  type JevExecutor,
} from '../../src/roles/facade.js';
import { listedAgents } from '../../src/roles/herdr-run.js';
import { LOCK_WAIT_MS, withLock } from '../../src/roles/job-store.js';
import { codexShell, parsePiRoleArgs, RENAME_BACKOFF_MS } from '../../src/roles/launch.js';
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
const FAKE_PI = join(REPO_ROOT, 'tests/fakes/pi-role.mjs');

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
  writeFileSync(join(home, 'routing.toml'), ROUTING, { mode: 0o600 });
  const bin = join(home, 'bin');
  mkdirSync(bin, { mode: 0o700 });
  const wrapper = join(bin, 'herdr');
  writeFileSync(wrapper, `#!/bin/bash\nexec ${quote(process.execPath)} ${quote(FAKE)} "$@"\n`);
  chmodSync(wrapper, 0o755);
  const piRole = join(bin, 'pi-role');
  writeFileSync(piRole, `#!/bin/bash\nexec ${quote(process.execPath)} ${quote(FAKE_PI)} "$@"\n`);
  chmodSync(piRole, 0o755);
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
  assert.equal(receipt.binding.harness, 'pi');
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
  assert.equal(association.schema, 1);
  assert.equal(association.preset, 'daily');
  assert.equal(association.herdr.tab_id, 'tab1');
  assert.equal(association.herdr.agent, `hud-${job}`);
  assert.equal(association.report_path, join(directory, 'report.md'));
  assert.equal(association.closed, false);
  assert.equal(created.acceptance, undefined);
  const wait = created.wait as { command: string; argv: string[] };
  assert.equal(wait.command, `hud wait --job ${job}`);
  assert.deepEqual(wait.argv, ['hud', 'wait', '--job', job]);

  const launched = herdrLog(s.log());
  assert.equal(launched[0]?.receipt_before, true);
  assert.deepEqual(
    launched.map((entry) => `${entry.argv[0]} ${entry.argv[1]}`),
    ['tab create', 'agent start', 'agent prompt']
  );
  const pi = s.log().filter((entry) => entry.bin === 'pi-role');
  assert.equal(pi.length, 1);
  assert.deepEqual(pi[0]!.argv.slice(0, 2), ['--args-json', 'implementer']);
  assert.ok(pi[0]!.argv.includes(join(directory, 'qa')));
  const createArgs = launched[0]!.argv;
  assert.ok(createArgs.includes('--no-focus'));
  assert.ok(createArgs.includes('--label'));
  assert.match(createArgs[createArgs.indexOf('--label') + 1]!, /^imp:[a-f0-9]{8}$/);
  assert.equal(createArgs.includes('--workspace'), false);
  const start = launched[1]!.argv;
  assert.deepEqual(start.slice(0, 8), ['agent', 'start', `hud-${job}`, '--kind', 'pi', '--pane', 'pane1', '--timeout']);
  assert.ok(start.includes('--'));
  assert.ok(start.includes('--role') && start.includes('implementer'));
  assert.ok(start.includes('--model') && start.includes('synthetic-flash'));
  assert.ok(start.includes('--thinking') && start.includes('max'));
  assert.ok(start.includes('--tui-mode') && start.includes('regular'));
  assert.ok(start.includes(join(directory, 'qa')));
  assert.ok(start.includes(join(directory, 'sessions')));
  const brief = readFileSync(join(directory, 'brief.md'), 'utf8');
  assert.match(brief, /Implement the synthetic task\.\nKeep the change local\./);
  assert.equal(launched[2]!.argv[3], `Read ${join(directory, 'brief.md')} and do exactly what it asks.`);
  assert.equal(launched[2]!.argv[3]!.includes('\n'), false);

  const early = await hudRespond(s.ctx(), { job, request_id: 'q1', answer: 'not yet' });
  assert.equal(early.ok, false);
  assert.equal(early.code, 'request_missing');
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
  assert.deepEqual(answered, {
    ok: true,
    job,
    request_id: 'q1',
    idempotent: false,
    consumed: false,
  });
  assert.equal(readFileSync(join(directory, 'qa', 'q1.answer.md'), 'utf8'), 'Use the synthetic file.\n');
  const again = await hudRespond(s.ctx(), { job, request_id: 'q1', answer: 'Use the synthetic file.' });
  assert.equal(again.ok, true);
  assert.equal(again.idempotent, true);
  const clash = await hudRespond(s.ctx(), { job, request_id: 'q1', answer: 'A different answer.' });
  assert.equal(clash.ok, false);
  assert.equal(clash.code, 'conflict');
  const after = await hudRead(s.ctx(), { job });
  assert.deepEqual(after.pending, []);
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
  assert.equal(existsSync(join(directory, 'qa', 'q1.answer.md')), true);
  const afterClose = JSON.parse(readFileSync(join(s.home, 'assoc', `${job}.json`), 'utf8')) as { closed: boolean };
  assert.equal(afterClose.closed, true);
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
  assert.match(stdout, /60000/);
  const bad = await main(['wait'], io);
  assert.equal(bad, 2);
});

test('unnamed agents are skipped and unsafe pi-role words are rejected', () => {
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
  assert.deepEqual(parsePiRoleArgs('["-ne","--role","implementer"]'), ['-ne', '--role', 'implementer']);
  assert.throws(() => parsePiRoleArgs('["ok $(whoami)"]'));
  assert.throws(() => parsePiRoleArgs("'a'b"));
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

test('an oracle on the pi adapter is not launched', async (t) => {
  const s = stage(t);
  const created = await hudCreate(s.ctx(), {
    role: 'oracle',
    phase: 'converge',
    request_key: 'oracle-pi',
    task: 'synthetic oracle task',
    cwd: s.work,
  });
  assert.equal(created.ok, false);
  assert.equal(created.code, 'role_unmapped');
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
    ROUTING.replace('model = "synthetic-flash"', 'model = "synthetic-from-routing"')
  );
  const again = await hudCreate(s.ctx(), imp(s.work, 'resume-binding'));
  assert.equal(again.ok, true);
  const starts = calls(s.log(), 'agent start');
  const last = starts[starts.length - 1]!.argv;
  assert.ok(last.includes('synthetic-from-receipt'));
  assert.equal(last.includes('synthetic-from-routing'), false);
  assert.equal(last[last.indexOf('--kind') + 1], 'pi');
});

test('pi-role uses args-json and does not inherit notify env', async (t) => {
  const s = stage(t);
  s.env.PI_ROLE_NOTIFY = 'herdr agent prompt w0:p1';
  s.env.PI_ORCHESTRATOR_PANE = 'w0:p9';
  s.env.HERDR_ENV = '0';
  const created = await hudCreate(s.ctx(), imp(s.work, 'scrubbed-pi'));
  assert.equal(created.ok, true);
  const pi = s.log().filter((entry) => entry.bin === 'pi-role');
  assert.equal(pi.length, 1);
  assert.equal(pi[0]!.argv[0], '--args-json');
  assert.equal(pi[0]!.notify, '');
  assert.equal(pi[0]!.herdrEnv, '1');
  const start = calls(s.log(), 'agent start')[0]!.argv.join(' ');
  assert.equal(start.includes('herdr agent prompt'), false);
  assert.equal(start.includes('w0:p9'), false);
  assert.ok(start.includes('herdr-agent-state'));
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
