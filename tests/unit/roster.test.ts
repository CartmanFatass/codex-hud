import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { main } from '../../src/cli/hud.js';
import { ROSTER_HELP, rosterCommand } from '../../src/cli/roster.js';
import { makeSourceId } from '../../src/core/identity.js';
import { callerRoot, type CallerProbe } from '../../src/roles/caller.js';
import type { SessionRef } from '../../src/core/types/identity.js';
import {
  ROUTING_MAX_BYTES,
  RoutingError,
  idValue,
  knownPreset,
  loadRosterSelection,
  loadRouting,
  parseRosterRoot,
  parseRouting,
  resolveRoster,
  rosterRootFromSessionRef,
  rosterSelectionKey,
  rosterSelectionPath,
  saveRosterSelection,
  type RosterRoot,
  type RosterSelection,
} from '../../src/roles/index.js';
import { REPO_ROOT } from '../fixtures/paths.js';

const FIXTURES = join(REPO_ROOT, 'tests/fixtures/roster');
const EXAMPLE = join(REPO_ROOT, 'docs/examples/routing.toml');

function text(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

function routingError(run: () => unknown): RoutingError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof RoutingError, error instanceof Error ? error.message : 'not a RoutingError');
    return error;
  }
  assert.fail('expected a RoutingError');
}

function expectFile(name: string, code: string, field: string): void {
  const error = routingError(() => parseRouting(text(name)));
  assert.equal(error.code, code, name);
  assert.equal(error.field, field, name);
}

function makeHome(t: TestContext): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'hud-roster-')));
  chmodSync(dir, 0o700);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function root(namespace: string, sessionId = 'synthetic-session'): RosterRoot {
  return parseRosterRoot(`${namespace}/${sessionId}`);
}

function selection(value: RosterRoot, preset: string): RosterSelection {
  return { schema: 1, namespace: value.namespace, sessionId: value.sessionId, preset };
}

async function run(args: string[], env: NodeJS.ProcessEnv) {
  let stdout = '';
  let stderr = '';
  const code = await main(args, {
    env,
    stdout: (chunk) => {
      stdout += chunk;
    },
    stderr: (chunk) => {
      stderr += chunk;
    },
  });
  return { code, stdout, stderr };
}

function homeEnv(home: string): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, HOME: home, HUD_HOME: home, TMPDIR: home };
}

test('fixture errors name the field', () => {
  expectFile('unknown-key.toml', 'unknown_key', 'backends.cli.home');
  expectFile('unbound-slot.toml', 'unbound_slot', 'presets.daily.roles["sonic"]');
  expectFile('dangling-backend.toml', 'dangling_id', 'presets.daily.roles["imp"]');
  expectFile('dangling-decision.toml', 'dangling_id', 'presets.daily.jev_decisions');
  expectFile('dangling-default.toml', 'dangling_id', 'default_preset');
  expectFile('web-oracle-imp.toml', 'incompatible_binding', 'presets.daily.roles["imp"]');
  expectFile('web-oracle-reviewer.toml', 'incompatible_binding', 'presets.daily.roles["reviewer"]');
  expectFile('sonic-web-oracle.toml', 'incompatible_binding', 'presets.daily.roles["sonic"]');
  expectFile('jev-on-herdr.toml', 'incompatible_binding', 'presets.daily.roles["jev"]');
  expectFile('oracle-browser.toml', 'incompatible_binding', 'presets.daily.roles["oracle.propose"]');
  expectFile('env-profile-path.toml', 'invalid_value', 'backends.cli.env_profile');
  const broken = routingError(() => parseRouting(text('broken.toml')));
  assert.equal(broken.code, 'invalid_toml');
  assert.match(broken.field, /^routing\.toml(:\d+)?$/);
});

test('valid fixture keeps unused profiles and accepts a CLI oracle', () => {
  const routing = parseRouting(text('valid.toml'));
  assert.equal(routing.defaultPreset, 'daily');
  assert.equal(routing.backends.spare.envProfile, 'synthetic-account');
  assert.equal(routing.decisions['unused-openai'].provider, 'openai');
  assert.equal(
    Object.values(routing.presets).some((preset) => Object.values(preset.roles).includes('spare')),
    false
  );
  const resolved = resolveRoster(routing);
  assert.equal(resolved.source, 'default');
  assert.equal(resolved.preset, 'daily');
  assert.equal(resolved.root, null);
  const propose = resolved.roles.find((role) => role.slot === 'oracle.propose');
  const converge = resolved.roles.find((role) => role.slot === 'oracle.converge');
  assert.equal(propose?.backend.target, 'aistudio');
  assert.equal(propose?.backend.capabilities.includes('web_oracle'), true);
  assert.equal(converge?.backend.executor, 'herdr');
  assert.equal(converge?.backend.capabilities.includes('workspace_write'), true);
  assert.deepEqual(Object.keys(resolved), ['schema', 'preset', 'source', 'root', 'jev_decisions', 'roles']);
});

test('resolution order is override, then session, then default, and a prior result stays put', () => {
  const routing = parseRouting(text('valid.toml'));
  const session = root('a'.repeat(64));
  const daily = selection(session, 'daily');
  const other = selection(session, 'other');
  const first = resolveRoster(routing, { root: session, selection: daily });
  const second = resolveRoster(routing, { root: session, selection: other });
  const overridden = resolveRoster(routing, {
    root: session,
    selection: other,
    override: { slot: 'imp', backend: 'spare' },
  });
  const explicit = resolveRoster(routing, { root: session, selection: other, preset: 'daily' });
  assert.equal(first.roles.find((role) => role.slot === 'imp')?.backend.id, 'cli');
  assert.equal(first.source, 'session');
  assert.equal(second.roles.find((role) => role.slot === 'imp')?.backend.id, 'alt');
  assert.equal(overridden.roles.find((role) => role.slot === 'imp')?.backend.id, 'spare');
  assert.equal(overridden.roles.find((role) => role.slot === 'imp')?.override, true);
  assert.equal(overridden.roles.find((role) => role.slot === 'reviewer')?.backend.id, 'alt');
  assert.equal(overridden.roles.find((role) => role.slot === 'reviewer')?.override, false);
  assert.equal(overridden.jev_decisions.id, 'typesafe-default');
  assert.equal(overridden.source, 'session');
  assert.equal(explicit.source, 'explicit');
  assert.equal(explicit.preset, 'daily');
  assert.equal(explicit.roles.find((role) => role.slot === 'imp')?.backend.id, 'cli');
  assert.equal(first.preset, 'daily');
  assert.equal(first.roles.find((role) => role.slot === 'imp')?.backend.id, 'cli');

  const rejected = routingError(() =>
    resolveRoster(routing, { root: session, selection: other, override: { slot: 'imp', backend: 'web' } })
  );
  assert.equal(rejected.code, 'incompatible_binding');
  assert.equal(rejected.field, 'override["imp"]');
  const missing = routingError(() =>
    resolveRoster(routing, { root: session, selection: other, override: { slot: 'jev', backend: 'absent' } })
  );
  assert.equal(missing.code, 'dangling_id');
  assert.equal(missing.field, 'override["jev"]');
  const stale = routingError(() => resolveRoster(routing, { root: session, selection: selection(session, 'gone') }));
  assert.equal(stale.code, 'dangling_id');
  assert.equal(stale.field, 'selection.preset');
  const swapped = routingError(() =>
    resolveRoster(routing, { root: session, selection: selection(root('b'.repeat(64)), 'daily') })
  );
  assert.equal(swapped.code, 'selection_invalid');
  assert.equal(swapped.field, 'selection');
});

test('two session roots keep separate selections and the write is atomic', (t) => {
  const home = makeHome(t);
  const first = root('a'.repeat(64), 'synthetic-session');
  const second = root('b'.repeat(64), 'synthetic-session');
  assert.notEqual(rosterSelectionKey(first), rosterSelectionKey(second));
  saveRosterSelection(home, first, 'daily');
  saveRosterSelection(home, second, 'other');
  const firstPath = rosterSelectionPath(home, first);
  const secondPath = rosterSelectionPath(home, second);
  assert.notEqual(firstPath, secondPath);
  assert.equal(loadRosterSelection(home, first)?.preset, 'daily');
  assert.equal(loadRosterSelection(home, second)?.preset, 'other');
  assert.equal(statSync(firstPath).mode & 0o777, 0o600);
  assert.equal(statSync(join(home, 'roster-selection')).mode & 0o777, 0o700);
  assert.equal(
    readdirSync(join(home, 'roster-selection')).some((name) => name.includes('.tmp')),
    false
  );

  assert.throws(() =>
    saveRosterSelection(home, first, 'other', {
      beforeRename: () => {
        throw new Error('synthetic stop');
      },
    })
  );
  assert.equal(JSON.parse(readFileSync(firstPath, 'utf8')).preset, 'daily');
  assert.equal(
    readdirSync(join(home, 'roster-selection')).some((name) => name.includes('.tmp')),
    false
  );

  saveRosterSelection(home, first, 'pi-build');
  const body = readFileSync(firstPath, 'utf8');
  assert.equal(
    body,
    `${JSON.stringify({ schema: 1, namespace: first.namespace, sessionId: first.sessionId, preset: 'pi-build' })}\n`
  );
  assert.equal(body.includes('daily'), false);
  assert.equal(loadRosterSelection(home, second)?.preset, 'other');

  const copied = rosterSelectionPath(home, root('c'.repeat(64)));
  writeFileSync(copied, body, { mode: 0o600 });
  const copiedError = routingError(() => loadRosterSelection(home, root('c'.repeat(64))));
  assert.equal(copiedError.code, 'selection_invalid');

  const ref: SessionRef = {
    harness: 'codex',
    sourceId: 'ab'.repeat(32),
    sessionId: 'synthetic-session',
    threadId: null,
  };
  const withThread: SessionRef = { ...ref, threadId: 'synthetic-thread' };
  assert.deepEqual(rosterRootFromSessionRef(ref), rosterRootFromSessionRef(withThread));
  assert.equal(rosterRootFromSessionRef(ref).namespace, ref.sourceId);
});

test('routing and selection symlinks are refused', (t) => {
  const home = makeHome(t);
  const outside = join(home, 'outside');
  mkdirSync(outside, { mode: 0o700 });
  writeFileSync(join(outside, 'routing.toml'), text('valid.toml'), { mode: 0o600 });
  symlinkSync(join(outside, 'routing.toml'), join(home, 'routing.toml'));
  const linked = routingError(() => loadRouting(home));
  assert.equal(linked.code, 'file_unreadable');
  assert.equal(linked.field, 'routing.toml');
  rmSync(join(home, 'routing.toml'));
  writeFileSync(join(home, 'routing.toml'), text('valid.toml'), { mode: 0o600 });
  symlinkSync(outside, join(home, 'roster-selection'));
  const selectionLink = routingError(() => saveRosterSelection(home, root('a'.repeat(64)), 'daily'));
  assert.equal(selectionLink.code, 'file_unreadable');
  assert.equal(selectionLink.field, 'roster-selection');
  assert.equal(readdirSync(outside).includes('routing.toml'), true);
  assert.equal(
    readdirSync(outside).some((name) => name.endsWith('.json')),
    false
  );

  const huge = makeHome(t);
  writeFileSync(join(huge, 'routing.toml'), `${' '.repeat(ROUTING_MAX_BYTES)}x`, { mode: 0o600 });
  const oversized = routingError(() => loadRouting(huge));
  assert.equal(oversized.code, 'file_too_large');
  assert.equal(oversized.field, 'routing.toml');
});

test('the example reproduces the daily and pi-build routing without home paths', () => {
  const raw = readFileSync(EXAMPLE, 'utf8');
  assert.doesNotMatch(raw, /~\/|\/home\/|CODEX_HOME|api[_-]?key|secret/i);
  const routing = parseRouting(raw);
  assert.equal(routing.defaultPreset, 'daily');
  assert.equal(routing.backends['codex-test'].model, 'gpt-6-luna');
  assert.equal(routing.backends['codex-test'].effort, 'medium');
  assert.equal(routing.backends['codex-test'].envProfile, 'codex2');
  assert.equal(routing.backends['codex-test'].harness, 'codex');
  assert.deepEqual(routing.backends['codex-test'].args, { service_tier: 'default' });
  assert.equal(routing.decisions['typesafe-default'].provider, 'typesafe');
  assert.equal(routing.decisions['typesafe-default'].model, null);
  assert.equal(routing.decisions['openai-decisions'].provider, 'openai');
  assert.equal(routing.decisions['openai-decisions'].model, 'gpt-6-luna');
  assert.equal(
    Object.values(routing.presets).some((preset) => Object.values(preset.roles).includes('codex-test')),
    false
  );

  const daily = resolveRoster(routing);
  const bySlot = new Map(daily.roles.map((role) => [role.slot, role]));
  assert.equal(bySlot.get('oracle.propose')?.backend.id, 'argon');
  assert.equal(bySlot.get('oracle.propose')?.backend.target, 'aistudio');
  assert.equal(bySlot.get('oracle.propose')?.backend.mode, 'argon');
  assert.equal(bySlot.get('oracle.converge')?.backend.id, 'pro');
  assert.equal(bySlot.get('oracle.converge')?.backend.target, 'chatgpt-pro');
  assert.equal(bySlot.get('imp')?.backend.model, 'grok-4.7');
  assert.equal(bySlot.get('imp')?.backend.effort, 'high');
  assert.equal(bySlot.get('imp')?.backend.harness, 'grok');
  assert.equal(bySlot.get('reviewer')?.backend.harness, 'claude');
  assert.equal(bySlot.get('reviewer')?.backend.model, 'opus');
  assert.equal(bySlot.get('reviewer')?.backend.effort, 'high');
  assert.equal(bySlot.get('sonic')?.backend.harness, 'pi');
  assert.match(bySlot.get('sonic')?.backend.model ?? '', /flash/);
  assert.equal(bySlot.get('jev')?.backend.target, 'browser');
  assert.equal(bySlot.get('jev')?.backend.executor, 'jev');
  assert.equal(daily.jev_decisions.id, 'typesafe-default');

  const pi = resolveRoster(routing, { preset: 'pi-build' });
  assert.equal(pi.roles.find((role) => role.slot === 'imp')?.backend.id, 'pi-imp');
  assert.equal(pi.roles.find((role) => role.slot === 'sonic')?.backend.id, 'pi-fast');
  assert.equal(pi.roles.find((role) => role.slot === 'reviewer')?.backend.id, 'claude-opus');
});

test('hud roster JSON is stable and sessions do not share a selection', async (t) => {
  const home = makeHome(t);
  writeFileSync(join(home, 'routing.toml'), readFileSync(EXAMPLE), { mode: 0o600 });
  const env = homeEnv(home);
  const help = await run(['roster', '--help'], env);
  assert.equal(help.code, 0);
  assert.equal(help.stdout, ROSTER_HELP);
  assert.equal(help.stderr, '');

  const listed = await run(['roster', 'list', '--json'], env);
  assert.equal(listed.code, 0);
  assert.equal(listed.stderr, '');
  assert.equal(listed.stdout.split('\n').length, 2);
  const list = JSON.parse(listed.stdout) as { schema: number; default_preset: string; presets: { name: string }[] };
  assert.deepEqual(Object.keys(list), ['schema', 'default_preset', 'presets']);
  assert.deepEqual(
    list.presets.map((preset) => preset.name),
    ['daily', 'pi-build']
  );
  assert.equal(list.default_preset, 'daily');
  const again = await run(['roster', 'list', '--json'], env);
  assert.equal(again.stdout, listed.stdout);

  const shown = await run(['roster', 'show', '--json'], env);
  const show = JSON.parse(shown.stdout) as {
    preset: string;
    source: string;
    root: null;
    roles: { slot: string; backend: { id: string } }[];
  };
  assert.equal(show.source, 'default (no session identity)');
  assert.equal(show.preset, 'daily');
  assert.equal(show.root, null);
  const plain = await run(['roster', 'show'], env);
  assert.match(plain.stdout, /source: default \(no session identity\)/);
  assert.equal(show.roles.find((role) => role.slot === 'imp')?.backend.id, 'grok-build');

  const first = `${'ab'.repeat(32)}/synthetic-session`;
  const second = `${'cd'.repeat(32)}/synthetic-session`;
  const used = await run(['roster', 'use', 'pi-build', '--root', first, '--json'], env);
  assert.equal(used.code, 0, used.stderr);
  assert.deepEqual(JSON.parse(used.stdout), { schema: 1, root: first, preset: 'pi-build' });
  const next = JSON.parse((await run(['roster', 'show', '--root', first, '--json'], env)).stdout) as {
    source: string;
    preset: string;
    roles: { slot: string; backend: { id: string } }[];
  };
  assert.equal(next.source, 'session');
  assert.equal(next.preset, 'pi-build');
  assert.equal(next.roles.find((role) => role.slot === 'imp')?.backend.id, 'pi-imp');

  assert.equal((await run(['roster', 'use', '--root', second, 'daily'], env)).code, 0);
  const still = JSON.parse((await run(['roster', 'show', '--root', first, '--json'], env)).stdout) as {
    preset: string;
  };
  const other = JSON.parse(
    (await run(['roster', 'show', '--root', second, '--role', 'imp', '--json'], env)).stdout
  ) as {
    preset: string;
    roles: { slot: string; backend: { id: string } }[];
  };
  assert.equal(still.preset, 'pi-build');
  assert.equal(other.preset, 'daily');
  assert.deepEqual(
    other.roles.map((role) => role.slot),
    ['imp']
  );
  assert.equal(other.roles[0].backend.id, 'grok-build');

  const before = readFileSync(rosterSelectionPath(home, parseRosterRoot(first)), 'utf8');
  const explicit = JSON.parse(
    (await run(['roster', 'show', '--root', first, '--preset', 'daily', '--json'], env)).stdout
  ) as {
    source: string;
    preset: string;
  };
  assert.equal(explicit.source, 'explicit');
  assert.equal(explicit.preset, 'daily');
  assert.equal(readFileSync(rosterSelectionPath(home, parseRosterRoot(first)), 'utf8'), before);
  assert.deepEqual(readdirSync(home).sort(), ['roster-selection', 'routing.toml']);
  assert.equal(lstatSync(join(home, 'roster-selection')).isDirectory(), true);
});

test('roster help and argument errors do not read HUD_HOME', async () => {
  const env = new Proxy({} as NodeJS.ProcessEnv, {
    get() {
      throw new Error('environment was read');
    },
  });
  const help = await run(['--help'], env);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /hud roster --help/);
  assert.equal((await run(['roster', '--help'], env)).stdout, ROSTER_HELP);
  assert.equal((await run(['roster', 'list', '--help'], env)).stdout, 'Usage: hud roster list [--json]\n');
  const badRoot = await run(['roster', 'use', 'daily', '--root', 'not a root'], env);
  assert.equal(badRoot.code, 2);
  assert.equal(badRoot.stderr, 'invalid_value: root\n');
  assert.equal(badRoot.stdout, '');
  const badRole = await run(['roster', 'show', '--role', 'oracle'], env);
  assert.equal(badRole.code, 2);
  assert.equal(badRole.stderr, 'invalid_value: role\n');
  const missing = await run(['roster'], env);
  assert.equal(missing.code, 2);
  assert.equal(missing.stderr, 'invalid_command: hud roster --help\n');
});

test('roster reports a bad home and a bad file without launching', async (t) => {
  const relative = await run(['roster', 'list'], { PATH: process.env.PATH, HOME: tmpdir(), HUD_HOME: 'relative' });
  assert.equal(relative.code, 3);
  assert.equal(relative.stderr, 'invalid_hud_home\n');
  assert.equal(relative.stdout, '');

  const home = makeHome(t);
  writeFileSync(join(home, 'routing.toml'), text('web-oracle-imp.toml'), { mode: 0o600 });
  const invalid = await run(['roster', 'show', '--json'], homeEnv(home));
  assert.equal(invalid.code, 2);
  assert.equal(invalid.stdout, '');
  assert.equal(invalid.stderr, 'incompatible_binding: presets.daily.roles["imp"]\n');
  assert.deepEqual(readdirSync(home), ['routing.toml']);
});

test('prototype preset and backend ids are unknown, and a path after = is rejected', async (t) => {
  const routing = parseRouting(text('valid.toml'));
  for (const name of ['constructor', 'toString', '__proto__']) {
    assert.equal(idValue(routing.presets, name), undefined, name);
    assert.equal(idValue(routing.backends, name), undefined, name);
    const preset = routingError(() => resolveRoster(routing, { preset: name }));
    assert.ok(preset.code === 'unknown_preset' || preset.code === 'dangling_id', name);
    const override = routingError(() => resolveRoster(routing, { override: { slot: 'imp', backend: name } }));
    assert.equal(override.code, 'dangling_id', name);
    assert.equal(override.field, 'override["imp"]', name);
  }
  const named = routingError(() => knownPreset(routing, 'constructor', 'preset'));
  assert.equal(named.code, 'unknown_preset');
  assert.equal(named.field, 'preset');

  const withArgs = (line: string) =>
    text('valid.toml').replace('recipe = "pi-implementer"\n', `recipe = "pi-implementer"\n${line}\n`);
  for (const line of ['args = ["--config=/tmp/synthetic"]', 'args = ["--x=~/synthetic"]']) {
    const error = routingError(() => parseRouting(withArgs(line)));
    assert.equal(error.code, 'invalid_value', line);
    assert.equal(error.field, 'backends.cli.args[0]', line);
  }

  const home = makeHome(t);
  writeFileSync(join(home, 'routing.toml'), text('valid.toml'), { mode: 0o600 });
  const env = homeEnv(home);
  const rootId = `${'ab'.repeat(32)}/synthetic-session`;
  const used = await run(['roster', 'use', 'constructor', '--root', rootId], env);
  assert.equal(used.code, 2);
  assert.equal(used.stderr, 'unknown_preset: preset\n');
  assert.equal(used.stdout, '');
  const shown = await run(['roster', 'show', '--preset', 'constructor', '--json'], env);
  assert.equal(shown.code, 2);
  assert.equal(shown.stderr, 'unknown_preset: preset\n');
  const missed = await run(['roster', 'use', 'daily'], env);
  assert.equal(missed.code, 2);
  assert.equal(missed.stderr, 'session_identity_missing: root\n');
  assert.equal(missed.stdout, '');
  assert.deepEqual(readdirSync(home), ['routing.toml']);
});

test('an established caller root selects only that session', async (t) => {
  const home = makeHome(t);
  writeFileSync(join(home, 'routing.toml'), text('valid.toml'), { mode: 0o600 });
  const env = homeEnv(home);
  const first = root('a'.repeat(64), 'synthetic-session');
  const second = root('a'.repeat(64), 'other-session');
  const capture = () => {
    let stdout = '';
    let stderr = '';
    return {
      io: {
        env,
        stdout: (chunk: string) => {
          stdout += chunk;
        },
        stderr: (chunk: string) => {
          stderr += chunk;
        },
      },
      read: () => ({ stdout, stderr }),
    };
  };
  const used = capture();
  assert.equal(await rosterCommand(['use', 'other', '--json'], used.io, { root: () => first }), 0);
  assert.deepEqual(JSON.parse(used.read().stdout), {
    schema: 1,
    root: 'a'.repeat(64) + '/synthetic-session',
    preset: 'other',
  });
  const shown = capture();
  assert.equal(await rosterCommand(['show', '--json'], shown.io, { root: () => first }), 0);
  const firstView = JSON.parse(shown.read().stdout) as { source: string; preset: string; root: string };
  assert.equal(firstView.source, 'session');
  assert.equal(firstView.preset, 'other');
  assert.equal(firstView.root, 'a'.repeat(64) + '/synthetic-session');
  const other = capture();
  assert.equal(await rosterCommand(['show', '--json'], other.io, { root: () => second }), 0);
  const secondView = JSON.parse(other.read().stdout) as { source: string; preset: string; root: string };
  assert.equal(secondView.source, 'default');
  assert.equal(secondView.preset, 'daily');
  assert.equal(secondView.root, 'a'.repeat(64) + '/other-session');
  assert.equal(loadRosterSelection(home, second), null);
});

test('caller detection uses the harness session carriers and stops on a test runner', () => {
  const base = {
    ppid: 10,
    env: {},
    readText: () => null,
    realpath: (path: string) => path,
    codexThread: () => null,
    started: () => 10,
  };
  const pi: CallerProbe = {
    ...base,
    read: (pid) =>
      pid === 10
        ? {
            pid,
            ppid: 1,
            procStart: '5',
            argv: ['pi', '--session-dir', '/tmp/synthetic-pi-root', '--session-id', 'synthetic-session'],
            env: {},
          }
        : null,
  };
  const found = callerRoot(pi);
  assert.equal(found?.sessionId, 'synthetic-session');
  assert.equal(found?.namespace, makeSourceId('pi', '/tmp/synthetic-pi-root'));

  const claude: CallerProbe = {
    ...base,
    env: { CLAUDE_CODE_SESSION_ID: 'synthetic-session' },
    read: (pid) =>
      pid === 10 ? { pid, ppid: 1, procStart: '99', argv: ['claude'], env: { HOME: '/tmp/synthetic-home' } } : null,
    realpath: (path) => (path === '/tmp/synthetic-home/.claude' ? '/tmp/synthetic-claude' : null),
    readText: (path) =>
      path === '/tmp/synthetic-claude/sessions/10.json'
        ? JSON.stringify({ pid: 10, procStart: '99', sessionId: 'synthetic-session' })
        : null,
  };
  assert.equal(callerRoot(claude)?.namespace, makeSourceId('claude', '/tmp/synthetic-claude'));
  const contradicted: CallerProbe = { ...claude, env: { CLAUDE_CODE_SESSION_ID: 'other-session' } };
  assert.equal(callerRoot(contradicted), null);

  const codex: CallerProbe = {
    ...base,
    read: (pid) =>
      pid === 10
        ? { pid, ppid: 1, procStart: '1', argv: ['/usr/bin/codex'], env: { CODEX_HOME: '/tmp/synthetic-codex' } }
        : null,
    realpath: (path) => (path === '/tmp/synthetic-codex' ? path : null),
    codexThread: (dir, pid, since) =>
      dir === '/tmp/synthetic-codex' && pid === 10 && since === 10 ? 'synthetic-session' : null,
  };
  assert.equal(callerRoot(codex)?.namespace, makeSourceId('codex', '/tmp/synthetic-codex'));
  assert.equal(callerRoot(codex)?.sessionId, 'synthetic-session');

  const runner: CallerProbe = {
    ...pi,
    read: (pid) => {
      const proc = pi.read(pid);
      return proc ? { ...proc, env: { ...proc.env, NODE_TEST_CONTEXT: '1' } } : null;
    },
  };
  assert.equal(callerRoot(runner), null);
});

test('installed hud entry lists the example roster', (t) => {
  const home = makeHome(t);
  writeFileSync(join(home, 'routing.toml'), readFileSync(EXAMPLE), { mode: 0o600 });
  const result = spawnSync(process.execPath, [join(REPO_ROOT, 'bin/hud'), 'roster', 'list', '--json'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 15000,
    env: homeEnv(home),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).default_preset, 'daily');
});
