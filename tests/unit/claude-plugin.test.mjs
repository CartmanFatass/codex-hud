import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { fixture, replaceFixtureFile } from '../../scripts/runtime-package/test-fixture.mjs';
import { planInstall, executeInstall } from '../../scripts/runtime-package/installer.mjs';
import {
  planActivation,
  applyActivation,
  planDeactivation,
  restoreActivation,
} from '../../scripts/runtime-package/activation.mjs';
const { CLAUDE_TEMPLATES, aliasStep } = await import(
  pathToFileURL(process.env.R6A_CLAUDE_GENERATOR_MODULE ?? path.resolve('scripts/runtime-package/claude.mjs'))
);
import { EXTRA_FILES, REQUIRED_OUTPUTS } from '../../scripts/pack-cloud-preview.mjs';
import { REQUIRED } from '../../scripts/runtime-package/manifest.mjs';
import { digest } from '../../scripts/runtime-package/safety.mjs';
const emittedRoot = process.env.R6A_CLAUDE_EMITTED_ROOT ?? path.resolve('dist');
const { parseCommand, handleHook } = await import(pathToFileURL(path.join(emittedRoot, 'integrations/claude/hook.js')));
const { mcpLaunch } = await import(pathToFileURL(path.join(emittedRoot, 'integrations/claude/mcp.js')));
import { captureNative } from '../../dist/integrations/claude/native.js';
import { setupCommand, draftInventory } from '../../dist/integrations/claude/setup.js';
import { readPanelInput } from '../../dist/integrations/panel/cli.js';
import { PanelStore, displayTarget, panelKey, saveJson } from '../../dist/integrations/panel/receipt.js';
const node = fs.realpathSync(process.execPath);
function setup(t) {
  const f = fixture(t, 'claude');
  for (const name of [
    ...CLAUDE_TEMPLATES,
    'integrations/skills/hud-delegate/SKILL.md',
    'integrations/claude/README.md',
  ])
    replaceFixtureFile(f, name, fs.readFileSync(path.join(process.env.R6A_CLAUDE_TEMPLATE_ROOT ?? '.', name)));
  const p = planInstall(f.bundle, f.prefix, undefined, false, true);
  executeInstall(f.bundle, f.prefix, p.planDigest, undefined, { stageOnly: true });
  const options = {
    prefix: f.prefix,
    release: p.bundleDigest,
    hudHome: path.join(f.home, 'hud'),
    shimDir: path.join(f.home, 'bin'),
    path: '/usr/bin',
    claude: { node },
  };
  f.options = options;
  return f;
}
function materialize(f) {
  const p = planActivation(f.options);
  const r = applyActivation(f.options, p.planId);
  return { ...r, plan: p, plugin: p.plugin };
}
function synthetic(t) {
  const f = fixture(t, 'hook');
  const home = path.join(f.home, 'hud');
  fs.mkdirSync(home, { mode: 0o700 });
  const env = {
    ...f.env,
    HUD_HOME: home,
    CODEX_HOME: path.join(f.home, 'codex'),
    CLAUDE_CONFIG_DIR: path.join(f.home, '.claude'),
  };
  fs.mkdirSync(env.CLAUDE_CONFIG_DIR, { mode: 0o700 });
  const binding = {
    version: 1,
    release: path.resolve('.'),
    digest: 'a'.repeat(64),
    releaseVersion: '0.1.0',
    node,
    hudHome: home,
    parityInventory: null,
  };
  const stamp = { pid: 400, proc_start: '10', boot_id: 'boot', pid_domain: 'domain' };
  const origin = { pane: 'main', tab: 'tab', terminal: 'tty', workspace: 'w', process: stamp };
  const context = {
    target: displayTarget('claude', 'session-a', env.CLAUDE_CONFIG_DIR),
    main: stamp,
    instance: 'instance',
    origin,
    runtime: { node, entry: path.resolve('bin/hud'), digest: binding.digest },
  };
  const native = {
    identity: { harness: 'claude', root: { namespace: context.target.ref.sourceId, sessionId: 'session-a' } },
    topology: 'top-level',
    ui: 'tui',
    verified: true,
  };
  const panels = new Map([['main', origin]]);
  let splits = 0;
  let closed = 0;
  const herdr = {
    instance: async () => 'instance',
    preflight: async () => 'instance',
    observe: async (p) => panels.get(p) ?? null,
    split: async () => {
      splits++;
      const p = { ...origin, pane: 'display', process: { ...stamp, pid: 500 }, atPrompt: true };
      panels.set('display', p);
      return { pane: 'display', workspace: 'w' };
    },
    start: async () => {
      const store = new PanelStore(env);
      const r = store.read(panelKey(context));
      saveJson(store.registration(r.token), { generation: r.generation, panel: panels.get('display') });
    },
    close: async (p) => {
      assert.equal(p, 'display');
      closed++;
      panels.delete(p);
    },
  };
  return { ...f, env, binding, stamp, origin, context, native, herdr, panels, counts: () => ({ splits, closed }) };
}
test('caller steps cannot inject planner fields; confirmed preexisting file restores exact bytes and mode without deletion', (t) => {
  const f = setup(t),
    target = path.join(f.home, 'synthetic-client.json'),
    original = Buffer.from([0, 255, 66, 10]);
  fs.writeFileSync(target, original, { mode: 0o640 });
  const step = {
    kind: 'owned-file',
    path: target,
    content: 'approved replacement\n',
    mode: 0o600,
    expectedOriginalHash: digest(original),
    confirmation: 'Replace this exact synthetic file only.',
  };
  const snapshot = () =>
    fs
      .readdirSync(f.root, { recursive: true })
      .sort()
      .map((name) => {
        const file = path.join(f.root, name),
          s = fs.lstatSync(file);
        // Stat identity/ctime/mtime detects writes without repeatedly hashing copied Node binaries.
        return [name, s.mode, s.ino, s.size, s.ctimeMs, s.mtimeMs];
      });
  const before = snapshot();
  for (const key of ['generated', 'reused', 'original', 'proposed', 'backup', 'phase', 'unknown', '__proto__']) {
    assert.throws(
      () => planActivation({ ...f.options, steps: [{ ...step, [key]: true }] }),
      /reserved_client_step_field/
    );
    assert.deepEqual(snapshot(), before);
    assert.deepEqual(fs.readFileSync(target), original);
  }
  assert.throws(
    () =>
      planActivation({
        ...f.options,
        steps: [{ kind: 'private-dir', path: path.join(f.home, 'new-dir'), generated: true }],
      }),
    /reserved_client_step_field/
  );
  assert.deepEqual(snapshot(), before);
  const options = { ...f.options, steps: [step] },
    plan = planActivation(options),
    applied = applyActivation(options, plan.planId);
  assert.equal(fs.readFileSync(target, 'utf8'), step.content);
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  const receipt = JSON.parse(fs.readFileSync(applied.receipt));
  const entry = receipt.journal.find((e) => receipt.plan.actions[e.index].path === target);
  assert.equal(entry.before.kind, 'file');
  assert.deepEqual(Buffer.from(entry.backup, 'base64'), original);
  assert.equal(restoreActivation(applied.receipt).status, 'deactivated; release retained');
  assert.equal(fs.existsSync(target), true);
  assert.deepEqual(fs.readFileSync(target), original);
  assert.equal(fs.statSync(target).mode & 0o777, 0o640);
});
test('templates: one discovery manifest, six-role stdio adapter, no dotfiles in release, canonical skill and pin', (t) => {
  const f = setup(t);
  const r = materialize(f);
  const manifest = JSON.parse(fs.readFileSync(path.join(r.plugin, '.claude-plugin/plugin.json')));
  assert.equal(manifest.name, 'hud');
  assert.equal(manifest.version, r.plan.releaseVersion);
  assert.equal(manifest.statusLine, undefined);
  assert.equal(manifest.hooks, undefined);
  const mcp = JSON.parse(fs.readFileSync(path.join(r.plugin, '.mcp.json')));
  assert.deepEqual(mcp, {
    mcpServers: { 'hud-mcp': { type: 'stdio', command: node, args: ['${CLAUDE_PLUGIN_ROOT}/scripts/mcp.mjs'] } },
  });
  const hooks = JSON.parse(fs.readFileSync(path.join(r.plugin, 'hooks/hooks.json'))).hooks;
  assert.deepEqual(Object.keys(hooks), ['SessionStart', 'SessionEnd', 'UserPromptExpansion']);
  assert.equal(hooks.UserPromptExpansion[0].matcher, '^(hud:hud|hud|hud:setup)$');
  assert.ok(f.manifest.entries.every((e) => e.path.split('/').every((p) => !p.startsWith('.'))));
  assert.equal(digest(fs.readFileSync(path.join(r.plugin, 'skills/hud-delegate/SKILL.md'))), r.plan.skillHash);
  assert.ok(!fs.readFileSync(path.join(r.plugin, 'skills/hud-delegate/SKILL.md'), 'utf8').includes('mcp__hud-mcp__'));
  for (const name of ['hud', 'setup'])
    assert.doesNotMatch(
      fs.readFileSync(path.join(r.plugin, `commands/${name}.md`), 'utf8'),
      /!`|\$\(|\bbash\b|\bshell\b/
    );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(r.plugin, 'binding.json'))).release,
    path.join(f.prefix, 'releases', r.plan.runtimeDigest)
  );
});
test('both packers share complete template and emitted-output inventory; missing template fails verification', (t) => {
  const f = setup(t);
  for (const file of CLAUDE_TEMPLATES) {
    assert.ok(EXTRA_FILES.includes(file));
    assert.ok(REQUIRED.includes(file));
  }
  for (const [src, out] of Object.entries(REQUIRED_OUTPUTS).filter(([src]) => src.includes('/integrations/claude/'))) {
    assert.ok(fs.existsSync(src));
    assert.ok(REQUIRED.includes(out));
  }
  fs.unlinkSync(path.join(f.prefix, 'releases', f.options.release, CLAUDE_TEMPLATES[0]));
  assert.throws(() => planActivation(f.options));
});
test('generated activation preview is read-only; interrupted apply restores; changed plugin is never deleted', (t) => {
  const f = setup(t);
  const p = planActivation(f.options);
  assert.equal(fs.existsSync(f.options.hudHome), false);
  let receipt;
  assert.throws(
    () =>
      applyActivation(f.options, p.planId, {
        checkpoint(phase, index, file) {
          receipt = file;
          if (phase === 'after' && p.actions[index]?.path.endsWith('commands/hud.md')) throw Error('interrupted');
        },
      }),
    /interrupted/
  );
  assert.equal(restoreActivation(receipt).status, 'deactivated; release retained');
  assert.equal(fs.existsSync(p.plugin), false);
  const r = materialize(f);
  fs.appendFileSync(path.join(r.plugin, 'commands/hud.md'), 'changed');
  assert.equal(restoreActivation(r.receipt).status, 'CONFLICT');
  assert.ok(fs.existsSync(r.plugin));
});
test('reserved metadata and other IDs, preexisting and symlink integration files are refused', (t) => {
  const f = setup(t);
  const p = planActivation(f.options);
  for (const file of [
    path.join(f.options.hudHome, 'installation/evil.json'),
    path.join(f.options.hudHome, 'installation/integrations', 'b'.repeat(64), 'evil'),
  ])
    assert.throws(
      () => planActivation({ ...f.options, steps: [{ kind: 'owned-file', path: file, content: 'bad', mode: 0o600 }] }),
      /reserved_activation_target/
    );
  const root = path.dirname(p.plugin);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  assert.throws(() => planActivation(f.options), /generated_integration_foreign/);
  fs.rmdirSync(root);
  fs.symlinkSync(f.home, root);
  assert.throws(() => planActivation(f.options), /symlink_target_refused/);
});
test('same integrationId reused only with receipt-backed exact bytes, last active receipt removes unchanged files', (t) => {
  const f = setup(t);
  const first = materialize(f);
  // Two separately activated entrypoint sets may share one immutable client package.
  f.options.shimDir = path.join(f.home, 'other bin');
  const second = materialize(f);
  assert.equal(first.plan.integrationId, second.plan.integrationId);
  assert.notEqual(first.receipt, second.receipt);
  assert.ok(second.plan.actions.filter((a) => a.generated).every((a) => a.reused));
  assert.equal(restoreActivation(first.receipt).status, 'deactivated; release retained');
  assert.ok(fs.existsSync(first.plugin));
  assert.equal(restoreActivation(second.receipt).status, 'deactivated; release retained');
  assert.equal(fs.existsSync(first.plugin), false);
});
test('MCP env is child-only; cached relocation with spaces resolves the pinned scripts', (t) => {
  const f = setup(t);
  const r = materialize(f);
  const cached = path.join(f.home, 'cached plugin with spaces');
  fs.cpSync(r.plugin, cached, { recursive: true });
  const pin = JSON.parse(fs.readFileSync(path.join(cached, 'binding.json')));
  const parent = { HUD_HOME: '/untrusted', HUD_MCP_SURFACE: 'old' };
  const launch = mcpLaunch(pin, parent);
  assert.equal(launch.env.HUD_HOME, f.options.hudHome);
  assert.equal(launch.env.HUD_MCP_SURFACE, 'roles');
  assert.deepEqual(parent, { HUD_HOME: '/untrusted', HUD_MCP_SURFACE: 'old' });
  // Run the real cached adapter/relay; the synthetic server records precisely its child environment.
  const release = pin.release;
  fs.copyFileSync('dist/integrations/claude/mcp.js', path.join(release, 'dist/integrations/claude/mcp.js'));
  fs.writeFileSync(
    path.join(release, 'packages/hud-mcp/bin/hud-mcp.mjs'),
    `console.log(JSON.stringify({home:process.env.HUD_HOME,surface:process.env.HUD_MCP_SURFACE}));`
  );
  const out = spawnSync(node, [path.join(cached, 'scripts/mcp.mjs')], {
    env: { ...f.env, CODEX_HOME: path.join(f.home, 'codex'), CLAUDE_CONFIG_DIR: path.join(f.home, '.claude') },
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout), { home: f.options.hudHome, surface: 'roles' });
});
test('exact command grammar; prose and prefixes pass, unknowns and operation failures stay blocked', async (t) => {
  const f = synthetic(t);
  for (const prompt of ['please /hud status', '/hudson', '/hud:hudson', '/hud status\nmore'])
    assert.equal(parseCommand({ hook_event_name: 'UserPromptSubmit', prompt }), null);
  for (const name of ['hud:hud', 'hud', 'hud:setup'])
    assert.ok(
      parseCommand({
        hook_event_name: 'UserPromptExpansion',
        expansion_type: 'slash_command',
        command_name: name,
        command_args: 'status',
      })
    );
  assert.equal(
    parseCommand({ hook_event_name: 'UserPromptExpansion', expansion_type: 'slash_command', command_name: 'hudson' }),
    null
  );
  for (const prompt of ['/hud bad', '/hud on extra', '/hud on', '/hud:setup apply']) {
    const result = await handleHook(
      { hook_event_name: 'UserPromptSubmit', prompt, session_id: 'session-a' },
      f.binding,
      f.env,
      {
        capture: async () => {
          throw Error('panel_worker_session');
        },
      }
    );
    assert.equal(result.decision, 'block');
    assert.ok(result.reason.length < 4096);
  }
  const result = await handleHook(
    { hook_event_name: 'UserPromptSubmit', prompt: '/hud on', session_id: 'session-a' },
    f.binding,
    f.env,
    {
      capture: async () => {
        throw Error('panel_worker_session');
      },
    }
  );
  assert.match(result.reason, /panel_worker_session; panel belongs to the main session/);
});
test('bounded stdin rejects >64 KiB and incomplete input', async () => {
  await assert.rejects(readPanelInput(Readable.from([Buffer.alloc(65537)])), /oversize/);
  await assert.rejects(readPanelInput(new Readable({ read() {} }), 10), /deadline/);
});
function nativeDeps(f, changes = {}) {
  const root = f.env.CLAUDE_CONFIG_DIR;
  const procs = new Map([
    [
      400,
      {
        pid: 400,
        ppid: 200,
        procStart: '10',
        argv: ['/usr/bin/claude'],
        env: { HOME: f.home, CLAUDE_CONFIG_DIR: root },
      },
    ],
    [200, { pid: 200, ppid: 1, procStart: '20', argv: ['/usr/bin/herdr'], env: {} }],
  ]);
  const probe = {
    ppid: 400,
    env: {},
    read: (pid) => procs.get(pid) ?? null,
    readText: () => JSON.stringify({ pid: 400, procStart: '10', sessionId: 'session-a' }),
    realpath: (p) => p,
    codexThread: () => null,
    started: () => 1,
  };
  const processInfo = (pid) =>
    procs.has(pid)
      ? {
          stamp: { ...f.stamp, pid, proc_start: pid === 400 ? '10' : '20' },
          ppid: procs.get(pid).ppid,
          tty: 2,
          pgid: 400,
          foregroundPgid: 400,
          sid: 400,
          state: 'S',
          flags: 0,
        }
      : null;
  const launch = (pid) => (procs.has(pid) ? { argv: procs.get(pid).argv, env: procs.get(pid).env } : null);
  return { probe, processInfo, launch, herdr: f.herdr, procs, ...changes };
}
test('native eligibility positive proof and each disqualifier; JSON alone never supplies eligibility; current-stamp fence', async (t) => {
  const f = synthetic(t);
  const deps = nativeDeps(f);
  const yes = await captureNative(f.binding, { ...f.env, HERDR_PANE_ID: 'main' }, deps);
  assert.equal(yes.native.verified, true);
  assert.equal(yes.isCurrent(), true);
  for (const mutate of [
    (d) => d.procs.get(400).argv.push('--print'),
    (d) => d.procs.get(400).argv.push('-pSynthetic'),
    (d) => d.procs.get(400).argv.push('--sdk-url=http://localhost'),
    (d) => (d.launch = () => null),
    (d) => d.procs.get(400).argv.push('--output-format', 'stream-json'),
    (d) => (d.procs.get(400).env.HUD_ROLE_CONTRACT = 'worker'),
    (d) => (d.procs.get(200).argv = ['/usr/bin/claude']),
    (d) => (d.procs.get(200).argv = ['/usr/bin/node', '/synthetic/@anthropic-ai/claude-code/cli.js']),
    (d) => (d.procs.get(200).argv = ['/usr/bin/node', '/synthetic/hud-mcp.mjs']),
    (d) => (d.processInfo = (pid) => ({ ...deps.processInfo(pid), tty: 0 })),
    (d) => (d.herdr = { ...f.herdr, observe: async () => ({ ...f.origin, process: { ...f.stamp, pid: 999 } }) }),
    (d) =>
      (d.probe = { ...d.probe, readText: () => JSON.stringify({ pid: 400, procStart: '99', sessionId: 'session-a' }) }),
  ]) {
    const d = nativeDeps(f);
    mutate(d);
    await assert.rejects(captureNative(f.binding, { ...f.env, HERDR_PANE_ID: 'main' }, d));
  }
  deps.procs.get(400).procStart = '99';
  assert.equal(yes.isCurrent(), false);
  await assert.rejects(
    captureNative(f.binding, f.env, nativeDeps(f, { probe: { ...deps.probe, read: () => null } })),
    /identity_unverified/
  );
  // Hook JSON carrying a captured proof is ignored: the hook re-derives native evidence. Inject the
  // no-proof probe so the result never depends on the host process tree running the test.
  const result = await handleHook(
    { hook_event_name: 'SessionStart', session_id: 'session-a', native: yes.native },
    f.binding,
    f.env,
    {
      capture: () => captureNative(f.binding, f.env, nativeDeps(f, { probe: { ...deps.probe, read: () => null } })),
    }
  );
  assert.match(result.systemMessage, /identity_unverified/);
  assert.equal(f.counts().splits, 0);
});
test('SessionStart opens once via real controlPanel, disabled auto-open opens none, SessionEnd fences exact generation and late end cannot close replacement', async (t) => {
  const f = synthetic(t);
  const d = nativeDeps(f);
  const captured = { context: f.context, native: f.native, herdr: f.herdr, isCurrent: () => true };
  const options = {
    capture: async () => captured,
    panelProbes: { processInfo: d.processInfo, processLaunch: d.launch, registered: () => true },
  };
  const start = { hook_event_name: 'SessionStart', session_id: 'session-a' };
  await handleHook(start, f.binding, f.env, options);
  assert.equal(f.counts().splits, 1);
  await handleHook(start, f.binding, f.env, options);
  assert.equal(f.counts().splits, 1);
  const store = new PanelStore(f.env);
  const old = store.read(panelKey(f.context));
  assert.equal(old.phase, 'open');
  await handleHook({ hook_event_name: 'SessionEnd', session_id: 'session-a' }, f.binding, f.env, options);
  assert.equal(f.counts().closed, 1);
  assert.ok(store.fenced(old));
  const replacement = { ...f.context, target: displayTarget('claude', 'session-b', f.env.CLAUDE_CONFIG_DIR) };
  captured.context = replacement;
  captured.native = {
    ...f.native,
    identity: { harness: 'claude', root: { namespace: replacement.target.ref.sourceId, sessionId: 'session-b' } },
  };
  // Fake start registers only the pane just opened, using the new root's persisted receipt.
  await handleHook({ hook_event_name: 'SessionStart', session_id: 'session-b' }, f.binding, f.env, options);
  assert.equal(f.counts().splits, 2);
  const current = store.read(panelKey(replacement));
  assert.notEqual(current.generation, old.generation);
  await handleHook({ hook_event_name: 'SessionEnd', session_id: 'session-a' }, f.binding, f.env, options);
  assert.equal(f.counts().closed, 1);
  assert.equal(store.fenced(current), false);
  fs.writeFileSync(path.join(f.binding.hudHome, 'integration-config.json'), JSON.stringify({ panelAutoOpen: false }), {
    mode: 0o600,
  });
  captured.context = { ...replacement, target: displayTarget('claude', 'session-c', f.env.CLAUDE_CONFIG_DIR) };
  captured.native = {
    ...f.native,
    identity: { harness: 'claude', root: { namespace: replacement.target.ref.sourceId, sessionId: 'session-c' } },
  };
  const disabled = await handleHook(
    { hook_event_name: 'SessionStart', session_id: 'session-c' },
    f.binding,
    f.env,
    options
  );
  assert.match(disabled.systemMessage, /disabled/);
  assert.equal(f.counts().splits, 2);
  const explicit = await handleHook(
    {
      hook_event_name: 'UserPromptExpansion',
      expansion_type: 'slash_command',
      command_name: 'hud:hud',
      command_args: 'on',
      session_id: 'session-c',
    },
    f.binding,
    f.env,
    options
  );
  assert.equal(explicit.decision, 'block');
  assert.equal(f.counts().splits, 3);
  const workerDeps = nativeDeps(f);
  workerDeps.procs.get(400).argv.push('--print');
  options.capture = () => captureNative(f.binding, { ...f.env, HERDR_PANE_ID: 'main' }, workerDeps);
  const worker = await handleHook(
    {
      hook_event_name: 'UserPromptExpansion',
      expansion_type: 'slash_command',
      command_name: 'hud:hud',
      command_args: 'on',
      session_id: 'session-c',
    },
    f.binding,
    f.env,
    options
  );
  assert.match(worker.reason, /panel_worker_session; panel belongs to the main session/);
  assert.equal(f.counts().splits, 3);
});
test('hook JSON native claims cannot replace unavailable native eligibility', async (t) => {
  const f = synthetic(t);
  const deps = nativeDeps(f);
  const claimed = { context: f.context, native: f.native, herdr: f.herdr, isCurrent: () => true };
  const result = await handleHook(
    { hook_event_name: 'SessionStart', session_id: 'session-a', native: f.native },
    f.binding,
    f.env,
    {
      capture: async () => ({ ...claimed, native: null }),
      panelProbes: { processInfo: deps.processInfo, processLaunch: deps.launch, registered: () => true },
    }
  );
  assert.equal(f.counts().splits, 0);
  assert.match(result.systemMessage, /panel_eligibility_unknown/);
});
test('real role MCP initialize/tools-list and per-call Claude ancestry survive cached adapter relay', (t) => {
  const f = setup(t);
  const r = materialize(f);
  const pin = JSON.parse(fs.readFileSync(path.join(r.plugin, 'binding.json')));
  fs.copyFileSync('dist/integrations/claude/mcp.js', path.join(pin.release, 'dist/integrations/claude/mcp.js'));
  fs.writeFileSync(
    path.join(pin.release, 'packages/hud-mcp/bin/hud-mcp.mjs'),
    `await import(${JSON.stringify(pathToFileURL(path.resolve('packages/hud-mcp/bin/hud-mcp.mjs')).href)});`
  );
  fs.writeFileSync(path.join(f.options.hudHome, 'routing.toml'), fs.readFileSync('docs/examples/routing.toml'), {
    mode: 0o600,
  });
  pin.parityInventory = path.join(f.options.hudHome, 'absent-parity.json');
  fs.writeFileSync(path.join(r.plugin, 'binding.json'), JSON.stringify(pin));
  const cached = path.join(f.home, 'cache with spaces');
  fs.cpSync(r.plugin, cached, { recursive: true });
  const harness = path.join(f.home, 'synthetic-claude.mjs');
  fs.writeFileSync(
    harness,
    `import * as fs from 'node:fs';import {spawn} from 'node:child_process';
  const root=process.env.CLAUDE_CONFIG_DIR;fs.mkdirSync(root+'/sessions',{recursive:true,mode:448});
  const stat=fs.readFileSync('/proc/self/stat','utf8');const procStart=stat.slice(stat.lastIndexOf(')')+2).split(' ')[19];
  fs.writeFileSync(root+'/sessions/'+process.pid+'.json',JSON.stringify({pid:process.pid,procStart,sessionId:'adapter-native'}));
  const p=spawn(${JSON.stringify(node)},[process.argv[2]],{stdio:['pipe','pipe','inherit']});let buffer='';
  p.stdout.on('data',b=>{process.stdout.write(b);buffer+=b;if(buffer.includes('"id":3'))p.stdin.end();});
  p.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'synthetic',version:'1'}}})+'\\n');
  setTimeout(()=>p.stdin.write(JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list'})+'\\n'+JSON.stringify({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'hud_roster',arguments:{action:'show'}}})+'\\n'),100);
  p.on('exit',c=>process.exitCode=c??2);`
  );
  const env = { ...f.env, CODEX_HOME: path.join(f.home, 'codex'), CLAUDE_CONFIG_DIR: path.join(f.home, '.claude') };
  const out = spawnSync(
    '/bin/bash',
    ['-c', 'exec -a claude "$1" "$2" "$3"', 'fixture', node, harness, path.join(cached, 'scripts/mcp.mjs')],
    { env, encoding: 'utf8', timeout: 10000 }
  );
  assert.equal(out.status, 0, out.stderr);
  const replies = out.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    replies
      .find((v) => v.id === 2)
      .result.tools.map((v) => v.name)
      .sort(),
    ['hud_close', 'hud_create', 'hud_read', 'hud_respond', 'hud_roster', 'hud_send']
  );
  const result = replies.find((v) => v.id === 3).result.structuredContent;
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.match(JSON.stringify(result), /adapter-native/);
  fs.writeFileSync(pin.parityInventory, 'unreadable', { mode: 0o000 });
  const unreadable = spawnSync(
    '/bin/bash',
    ['-c', 'exec -a claude "$1" "$2" "$3"', 'fixture', node, harness, path.join(cached, 'scripts/mcp.mjs')],
    { env, encoding: 'utf8', timeout: 10000 }
  );
  fs.chmodSync(pin.parityInventory, 0o600);
  assert.equal(unreadable.status, 0, unreadable.stderr);
  assert.match(unreadable.stdout, /"id":2/);
});
test('setup delegates actual settings writer; preview is read-only, gaps/wrapper block, backup preserves whole original, stale edit refused', (t) => {
  const f = synthetic(t);
  const settings = path.join(f.env.CLAUDE_CONFIG_DIR, 'settings.json');
  const config = path.join(f.home, 'third-party.json');
  const original =
    JSON.stringify({
      enabledPlugins: { 'third-party': true },
      statusLine: { type: 'command', command: 'claude-hud --width 80 | tee /tmp/synthetic-toktrack' },
    }) + '\n';
  fs.writeFileSync(settings, original, { mode: 0o600 });
  fs.writeFileSync(
    config,
    JSON.stringify({ display: { model: true, context: true, tools: true, unknownNewField: true } }),
    { mode: 0o600 }
  );
  f.binding.parityInventory = path.join(f.binding.hudHome, 'parity.json');
  fs.writeFileSync(f.binding.parityInventory, JSON.stringify(draftInventory(f.home, config)), { mode: 0o600 });
  const preview = setupCommand([], f.binding, f.env);
  assert.equal(fs.readFileSync(settings, 'utf8'), original);
  assert.equal(preview.comparison.status, 'BLOCKED');
  assert.deepEqual(preview.comparison.gaps, ['display.tools', 'display.unknownNewField', 'statusline_wrapper']);
  const file = path.join(f.home, 'plan.json');
  fs.writeFileSync(file, JSON.stringify(preview.statusline), { mode: 0o600 });
  assert.equal(setupCommand(['apply', '--plan', file], f.binding, f.env).status, 'BLOCKED');
  // Existing writer, not a second editor, retains the wrapper byte-for-byte in its backup.
  const apply = spawnSync(node, ['bin/hud', 'statusline', 'settings', 'apply', '--plan', file], {
    env: f.env,
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(apply.status, 0, apply.stderr);
  const backup = JSON.parse(apply.stdout).backup;
  const record = JSON.parse(fs.readFileSync(backup));
  assert.equal(Buffer.from(record.original, 'base64').toString(), original);
  assert.equal(setupCommand(['restore', '--backup', backup], f.binding, f.env).status, 'DONE');
  assert.equal(fs.readFileSync(settings, 'utf8'), original);
  fs.writeFileSync(settings, JSON.stringify({ statusLine: { type: 'command', command: 'claude-hud' } }), {
    mode: 0o600,
  });
  fs.writeFileSync(config, JSON.stringify({ model: true, context: true }), { mode: 0o600 });
  fs.writeFileSync(f.binding.parityInventory, JSON.stringify(draftInventory(f.home, config)));
  const approved = setupCommand(['preview'], f.binding, f.env);
  assert.equal(approved.comparison.status, 'PASS');
  fs.writeFileSync(file, JSON.stringify(approved.statusline));
  fs.writeFileSync(config, JSON.stringify({ model: true, effort: true }));
  assert.throws(() => setupCommand(['apply', '--plan', file], f.binding, f.env), /parity_inventory_stale/);
  fs.writeFileSync(config, JSON.stringify({ model: true, context: true }));
  fs.appendFileSync(settings, ' ');
  assert.throws(() => setupCommand(['apply', '--plan', file], f.binding, f.env), /parity_inventory_stale/);
  fs.writeFileSync(f.binding.parityInventory, JSON.stringify(draftInventory(f.home, config)));
  const current = setupCommand([], f.binding, f.env);
  fs.writeFileSync(file, JSON.stringify(current.statusline));
  const done = setupCommand(['apply', '--plan', file], f.binding, f.env);
  assert.equal(done.status, 'DONE');
  fs.unlinkSync(f.binding.parityInventory); // parity must not prevent reverse restore.
  assert.equal(setupCommand(['restore', '--backup', done.statusline.backup], f.binding, f.env).status, 'DONE');
  const draft = spawnSync(node, ['scripts/claude-parity.mjs', 'preview', '--home', f.home, '--config', config], {
    env: f.env,
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(draft.status, 0, draft.stderr);
  assert.deepEqual(JSON.parse(draft.stdout).enabledFields, ['context', 'model']);
  for (const args of [['apply'], ['restore'], ['apply', '--plan', 'relative']])
    assert.throws(() => setupCommand(args, f.binding, f.env));
});
test('bare alias is NOT_VERIFIED without real zero-model evidence and existing personal command collision is refused', (t) => {
  const f = setup(t);
  const r = materialize(f);
  fs.mkdirSync(path.join(f.home, '.claude/commands'), { recursive: true, mode: 0o700 });
  assert.throws(() => aliasStep(f.home, null, r.plugin), /NOT_VERIFIED/);
  fs.writeFileSync(path.join(f.home, '.claude/commands/hud.md'), 'foreign', { mode: 0o600 });
  const proof = {
    status: 'PASS',
    commands: { canonical: 0, alias: 0, setup: 0 },
    negativeControls: { missingBinding: true, missingModule: true, nonzero: true, missingNode: true },
    ordinaryRequests: 1,
    plugin: r.plugin,
    pluginHashes: Object.fromEntries(
      [
        '.claude-plugin/plugin.json',
        'hooks/hooks.json',
        'commands/hud.md',
        'scripts/hook.mjs',
        'scripts/binding.mjs',
        'scripts/mcp.mjs',
        '.mcp.json',
      ].map((file) => [file, digest(fs.readFileSync(path.join(r.plugin, file)))])
    ),
  };
  assert.throws(() => aliasStep(f.home, proof, r.plugin), /alias_collision/);
  assert.equal(fs.readFileSync(path.join(f.home, '.claude/commands/hud.md'), 'utf8'), 'foreign');
  fs.unlinkSync(path.join(f.home, '.claude/commands/hud.md'));
  fs.symlinkSync(path.join(f.home, 'missing'), path.join(f.home, '.claude/commands/hud.md'));
  assert.throws(() => aliasStep(f.home, proof, r.plugin), /alias_collision/);
  fs.unlinkSync(path.join(f.home, '.claude/commands/hud.md'));
  for (const ordinaryRequests of [undefined, 0, -1, NaN, '1'])
    assert.throws(() => aliasStep(f.home, { ...proof, ordinaryRequests }, r.plugin), /NOT_VERIFIED/);
  assert.throws(() => aliasStep(f.home, { ...proof, negativeControls: {} }, r.plugin), /NOT_VERIFIED/);
  const step = aliasStep(f.home, proof, r.plugin);
  assert.equal(step.kind, 'owned-file');
  const options = { ...f.options, steps: [step] };
  const preview = planActivation(options);
  const receipt = applyActivation(options, preview.planId);
  assert.equal(fs.readFileSync(step.path, 'utf8'), fs.readFileSync(path.join(r.plugin, 'commands/hud.md'), 'utf8'));
  const undo = planDeactivation(receipt.receipt);
  assert.equal(restoreActivation(receipt.receipt, undo.planId, true).status, 'deactivated; release retained');
  assert.equal(fs.existsSync(step.path), false);
  proof.pluginHashes['commands/hud.md'] = 'a'.repeat(64);
  assert.throws(() => aliasStep(f.home, proof, r.plugin), /NOT_VERIFIED/);
});
test('actual bootstrap restores with missing/unreadable inventory; command guard emits one bounded block while lifecycle fails quietly', (t) => {
  const f = setup(t),
    r = materialize(f);
  const bindingFile = path.join(r.plugin, 'binding.json');
  const pin = JSON.parse(fs.readFileSync(bindingFile));
  fs.cpSync('dist', path.join(pin.release, 'dist'), { recursive: true });
  fs.copyFileSync('bin/hud', path.join(pin.release, 'bin/hud'));
  for (const name of ['@iarna/toml', 'chokidar', 'readdirp'])
    fs.cpSync(path.join('node_modules', name), path.join(pin.release, 'node_modules', name), { recursive: true });
  const configDir = path.join(f.home, '.claude');
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const settings = path.join(configDir, 'settings.json'),
    config = path.join(f.home, 'third-party.json');
  const original =
    JSON.stringify({ enabledPlugins: { synthetic: true }, statusLine: { type: 'command', command: 'claude-hud' } }) +
    '\n';
  fs.writeFileSync(settings, original, { mode: 0o600 });
  fs.writeFileSync(config, JSON.stringify({ model: true }), { mode: 0o600 });
  pin.parityInventory = path.join(f.options.hudHome, 'parity.json');
  fs.writeFileSync(pin.parityInventory, JSON.stringify(draftInventory(f.home, config)), { mode: 0o600 });
  fs.writeFileSync(bindingFile, JSON.stringify(pin));
  const env = { ...f.env, CLAUDE_CONFIG_DIR: configDir, CLAUDE_PLUGIN_ROOT: r.plugin };
  const commands = JSON.parse(fs.readFileSync(path.join(r.plugin, 'hooks/hooks.json'))).hooks;
  const command = commands.UserPromptExpansion[0].hooks[0].command;
  const run = (args, hook = command, input = null) => {
    const out = spawnSync('/bin/sh', ['-c', hook], {
      env,
      encoding: 'utf8',
      timeout: 6000,
      input: JSON.stringify(
        input ?? {
          hook_event_name: 'UserPromptExpansion',
          expansion_type: 'slash_command',
          command_name: 'hud:setup',
          command_args: args,
        }
      ),
    });
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stdout.trim().split('\n').length, 1);
    return JSON.parse(out.stdout);
  };
  const preview = JSON.parse(run('preview --shim-dir ' + JSON.stringify(f.options.shimDir)).reason.slice(5));
  assert.equal(preview.comparison.status, 'PASS');
  assert.equal(fs.readFileSync(settings, 'utf8'), original);
  const plan = path.join(f.home, 'saved plan.json');
  fs.writeFileSync(plan, JSON.stringify(preview.statusline), { mode: 0o600 });
  const done = JSON.parse(run('apply --plan ' + JSON.stringify(plan)).reason.slice(5));
  assert.equal(done.status, 'DONE');
  fs.unlinkSync(pin.parityInventory);
  assert.equal(
    JSON.parse(run('restore --backup ' + JSON.stringify(done.statusline.backup)).reason.slice(5)).status,
    'DONE'
  );
  assert.equal(fs.readFileSync(settings, 'utf8'), original);
  // Restore still runs when the configured inventory is a non-file, unreadable parity source.
  fs.mkdirSync(pin.parityInventory, { mode: 0o000 });
  const again = spawnSync(
    pin.node,
    [path.join(pin.release, 'bin/hud'), 'statusline', 'settings', 'apply', '--plan', plan],
    { env, encoding: 'utf8', timeout: 5000 }
  );
  assert.equal(again.status, 0, again.stderr);
  const backup = JSON.parse(again.stdout).backup;
  assert.equal(JSON.parse(run('restore --backup ' + JSON.stringify(backup)).reason.slice(5)).status, 'DONE');
  fs.chmodSync(pin.parityInventory, 0o700);
  assert.equal(fs.readFileSync(settings, 'utf8'), original);
  const entry = path.join(r.plugin, 'scripts/hook.mjs'),
    source = fs.readFileSync(entry);
  for (const body of [
    'process.stdout.write("partial");process.exit(7);',
    'process.stdout.write("x".repeat(20000));',
    'process.stdout.write("not JSON");',
    'process.stdout.write("{}");',
  ]) {
    fs.writeFileSync(entry, body);
    const refusal = run('preview');
    assert.equal(refusal.decision, 'block');
    assert.match(refusal.reason, /hook_startup_failed/);
  }
  fs.writeFileSync(entry, source);
  fs.unlinkSync(path.join(r.plugin, 'scripts/binding.mjs'));
  assert.match(run('preview').reason, /binding_or_hook_failed/);
  for (const event of ['SessionStart', 'SessionEnd'])
    assert.deepEqual(run('', commands[event][0].hooks[0].command, { hook_event_name: event }), {});
});
