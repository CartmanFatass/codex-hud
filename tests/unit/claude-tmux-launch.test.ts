import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  observeClaudeTmux,
  sameTmuxStartup,
  nativeFile,
  type NativeFile,
  type TmuxObserverPorts,
  type TmuxStartup,
} from '../../src/cli/claude-tmux.js';
import {
  claudeExpectation,
  claudeLaunchPlan,
  materializeClaudePlan,
  launchClaudeInTmux,
  type ClaudeHelper,
} from '../../src/cli/claude-launch.js';
import type { ProcRecord } from '../../src/core/run/process.js';
import type { CapabilityManifestV1, LaunchProfile } from '../../src/core/types/capabilities.js';
import { makeHookSettings } from '../../packages/hud-mcp/src/hook/record.js';
import { digest } from '../../src/core/canonical.js';
import { claudeCommand } from '../../src/cli/launcher.js';
import { delegateConfig, installationRoot, mcpModule } from '../../src/cli/runtime.js';
import type { ClaudeConfiguration } from '../../src/cli/claude-configuration.js';

const identity = (path: string): NativeFile => ({
  path,
  file: { dev: '1', ino: '2', size: '3', mtimeNs: '4', ctimeNs: '5' },
});
function observerFixture() {
  const host = identity('/usr/bin/tmux'),
    shell = identity('/bin/bash'),
    node = identity('/usr/bin/node');
  const proc = (pid: number, ppid: number, pgid: number, tty: number, sid: number): ProcRecord => ({
    stamp: { pid, proc_start: String(pid * 10), boot_id: 'synthetic-boot', pid_domain: 'synthetic-domain' },
    state: 'S',
    flags: 0,
    ppid,
    pgid,
    tty,
    sid,
    foregroundPgid: tty ? 30 : -1,
  });
  const records = new Map([
    [10, proc(10, 1, 10, 0, 10)],
    [20, proc(20, 10, 20, 34817, 20)],
    [30, proc(30, 20, 30, 34817, 20)],
  ]);
  const env = { TMUX: '/synthetic/tmux.sock,10,0', TMUX_PANE: '%1' };
  const response = '10\t/synthetic/tmux.sock\t%1\t20\t/dev/pts/1\t3.4';
  const ports: TmuxObserverPorts = {
    platform: 'linux',
    kernel: 'synthetic-kernel',
    pid: 30,
    nodeVersion: '24.0.0',
    tmux: () => host,
    native: (path) => ({ '/proc/10/exe': host, '/proc/20/exe': shell, '/proc/30/exe': node })[path] ?? null,
    process: (pid) => structuredClone(records.get(pid) ?? null),
    socket: (path) => (path === '/synthetic/tmux.sock' ? { path, dev: '1', ino: '42' } : null),
    terminal: () => '34817',
    query: async (_path, args) =>
      args[0] === '-V'
        ? 'tmux 3.4'
        : args[0] === '--version'
          ? 'GNU bash, version 5.2.15(1)-release (x86_64)'
          : response,
  };
  return { env, ports, records, response };
}

test('Claude tmux observer joins locator to bracketed server/process/TTY/foreground facts', async () => {
  const f = observerFixture();
  const actual = await observeClaudeTmux(f.env, f.ports);
  assert.ok(actual);
  assert.equal(actual.shell.version, '5.2.15(1)-release');
  assert.deepEqual(
    actual.receipt.ancestry.map((entry) => entry.stamp.pid),
    [30, 20]
  );
  assert.equal(sameTmuxStartup(actual, structuredClone(actual)), true);
  for (const change of [
    (value: TmuxStartup) => {
      value.receipt.server.stamp.proc_start = '999';
    },
    (value: TmuxStartup) => {
      value.receipt.ancestry[0].foregroundPgid = 31;
    },
    (value: TmuxStartup) => {
      value.host.file.ino = '999';
    },
    (value: TmuxStartup) => {
      value.receipt.socket.ino = '999';
    },
  ]) {
    const changed: TmuxStartup = structuredClone(actual);
    change(changed);
    assert.equal(sameTmuxStartup(actual, changed), false);
  }
});

test('Claude tmux observer rejects forged locators, missing proof, wrong ancestry/TTY/group and replacement races', async () => {
  for (const mutate of [
    (f: ReturnType<typeof observerFixture>) => {
      f.env.TMUX_PANE = '%2';
    },
    (f: ReturnType<typeof observerFixture>) => {
      f.env.TMUX = '/synthetic/tmux.sock,11,0';
    },
    (f: ReturnType<typeof observerFixture>) => {
      f.ports.platform = 'darwin';
    },
    (f: ReturnType<typeof observerFixture>) => {
      f.ports.tmux = () => null;
    },
    (f: ReturnType<typeof observerFixture>) => {
      f.ports.socket = () => null;
    },
    (f: ReturnType<typeof observerFixture>) => {
      f.records.get(30)!.ppid = 99;
    },
    (f: ReturnType<typeof observerFixture>) => {
      const wrapper = structuredClone(f.records.get(30)!);
      wrapper.stamp.pid = 25;
      f.records.set(25, wrapper);
      f.records.get(30)!.ppid = 25;
    },
    (f: ReturnType<typeof observerFixture>) => {
      f.records.get(30)!.foregroundPgid = 99;
    },
    (f: ReturnType<typeof observerFixture>) => {
      f.records.get(20)!.tty = 99;
    },
    (f: ReturnType<typeof observerFixture>) => {
      f.records.get(20)!.ppid = 11;
    },
    (f: ReturnType<typeof observerFixture>) => {
      f.records.get(20)!.stamp.pid_domain = 'another-domain';
    },
    (f: ReturnType<typeof observerFixture>) => {
      f.ports.terminal = (path) => (path.endsWith('/fd/1') ? '9' : '34817');
    },
    (f: ReturnType<typeof observerFixture>) => {
      f.ports.native = () => identity('/synthetic/other-executable');
    },
    (f: ReturnType<typeof observerFixture>) => {
      f.ports.query = async () => null;
    },
    (f: ReturnType<typeof observerFixture>) => {
      const original = f.ports.query;
      let queries = 0;
      f.ports.query = async (path, args) => {
        if (++queries === 4) f.records.get(20)!.stamp.proc_start = 'reused-pid';
        return original(path, args);
      };
    },
    (f: ReturnType<typeof observerFixture>) => {
      const original = f.ports.query;
      let queries = 0;
      f.ports.query = async (path, args) => (++queries === 4 ? f.response.replace('%1', '%2') : original(path, args));
    },
  ]) {
    const f = observerFixture();
    mutate(f);
    assert.equal(await observeClaudeTmux(f.env, f.ports), null);
  }
});

async function launchFixture(withHook = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hud-claude-tmux-')));
  const native = nativeFile(process.execPath)!;
  assert.ok(native);
  const executable = { ...native, version: process.versions.node };
  const observed = await observeClaudeTmux(observerFixture().env, observerFixture().ports);
  assert.ok(observed);
  const startup: TmuxStartup = { ...observed, node: executable };
  const profile: LaunchProfile = {
    name: 'synthetic-claude-tmux',
    harness: 'claude',
    source: { root, label: 'Synthetic' },
    launch: { argv: [process.execPath, 'literal $HOME; value', '--', 'prompt --resume'] },
    headless: null,
    resume: null,
    resumeHeadless: null,
    host: { kind: 'tmux', layout: 'pane' },
    env: {},
    mcpServerName: 'synthetic',
    claimTransport: 'config_env',
    clientToolTimeoutMs: 60000,
    responseMarginMs: 2000,
    orphan_policy: 'continue',
    managedShellVerified: false,
  };
  let helper: ClaudeHelper | null = null;
  let hookSettings: Parameters<typeof claudeLaunchPlan>[0]['makeHookSettings'] = null;
  if (withHook) {
    profile.callSource = { kind: 'claude_pre_tool_use_v1' };
    const record = await mcpModule('hook/record');
    const script = join(installationRoot(), 'packages/hud-mcp/bin/hud-claude-hook.mjs');
    const recordFile = join(installationRoot(), 'packages/hud-mcp/dist/packages/hud-mcp/src/hook/record.js');
    const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
    helper = {
      implementation: record.IMPLEMENTATION,
      claudeVersion: executable.version,
      script,
      scriptSha256: hash(script),
      record: recordFile,
      recordSha256: hash(recordFile),
    };
    hookSettings = record.makeHookSettings;
  }
  const env = { HOME: root, HUD_HOME: root, CLAUDE_CONFIG_DIR: root };
  const settings = {
    permissions: { allow: ['synthetic'] },
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'true' }] }] },
  };
  const info = statSync(root, { bigint: true });
  const configuration: ClaudeConfiguration = {
    description: {
      schema: 'claude-local-inputs-v1',
      selection: 'default-user-project-local',
      remote: 'bedrock-no-remote-settings-or-connectors',
      bookkeepingDependencies: [],
      projectLocalTracked: null,
      layers: [],
    },
    receipt: { cwd: realpathSync(process.cwd()), files: [] },
  };
  const input = {
    profile,
    configuredProfile: profile,
    command: profile.launch,
    settings,
    hasSettings: true,
    resume: false,
    home: root,
    env,
    configuration,
  };
  const plan = claudeLaunchPlan({
    ...input,
    source: { root, dev: String(info.dev), ino: String(info.ino) },
    cwd: realpathSync(process.cwd()),
    executable,
    startup,
    helper,
    makeHookSettings: hookSettings,
  });
  const actual = claudeExpectation(plan, 'synthetic-reviewed-build');
  const manifest: CapabilityManifestV1 = {
    version: 1,
    hudRevision: actual.versions.hudRevision,
    cells: [
      {
        ...actual,
        support: 'verified',
        incomplete: [],
        results: {
          identity: 'passed',
          input: 'passed',
          scope: 'passed',
          receipt: 'passed',
          singleSubmission: 'passed',
        },
        evidence: {
          script: 'synthetic-test-only',
          report: 'synthetic-fixture',
          reportSha256: 'a'.repeat(64),
          artifactDigest: 'b'.repeat(64),
          observedAt: 1,
          reviewStatus: 'accepted',
          scope: 'product',
        },
      },
    ],
  };
  return { root, input, plan, startup, manifest, close: () => rmSync(root, { recursive: true, force: true }) };
}

for (const withHook of [false, true])
  test(`Claude production matcher admits synthetic plan${withHook ? ` with discovered hook version ${process.versions.node}` : ''}, pins argv and rechecks before one dispatch`, async () => {
    const f = await launchFixture(withHook);
    try {
      let observations = 0,
        launches = 0;
      const result = await launchClaudeInTmux(f.input, {
        configuration: () => ({ observation: f.input.configuration, reason: null }),
        observe: async () => {
          observations++;
          return structuredClone(f.startup);
        },
        manifest: () => f.manifest,
        hudRevision: 'synthetic-reviewed-build',
        launch: async (command, env) => {
          launches++;
          assert.equal(observations, 2);
          assert.equal(command.argv![0], f.plan.executable.path);
          assert.deepEqual(command.argv!.slice(1, 2), ['literal $HOME; value']);
          assert.equal(command.argv!.at(-2), '--');
          assert.equal(command.argv!.at(-1), 'prompt --resume');
          assert.equal(env.CLAUDE_CONFIG_DIR, f.root);
          if (withHook) {
            const hook = JSON.parse(readFileSync(env.HUD_CLAUDE_HOOK_CONFIG!, 'utf8'));
            assert.equal(hook.claudeVersion, f.plan.executable.version);
            assert.equal(hook.claudeExecutable, f.plan.executable.path);
          }
          return 17;
        },
      });
      assert.equal(result, 17);
      assert.equal(launches, 1);
      assert.deepEqual(readdirSync(f.root), []);
    } finally {
      f.close();
    }
  });

test('hud claude launches natively without requiring a reviewed or shipped manifest', async () => {
  const f = await launchFixture();
  try {
    writeFileSync(join(f.root, 'delegate.json'), JSON.stringify({ version: 1, profiles: [f.input.profile] }));
    const profile = (await delegateConfig(f.root)).profiles[0];
    const env = { ...f.input.env, HUD_MCP_PROFILE: profile.name };
    const plan = claudeLaunchPlan({
      ...f.input,
      profile,
      configuredProfile: profile,
      settings: {},
      hasSettings: false,
      env,
      source: f.plan.source,
      cwd: f.plan.cwd,
      executable: f.plan.executable,
      startup: f.startup,
      helper: null,
      makeHookSettings: null,
    });
    Object.assign(f.manifest.cells[0], claudeExpectation(plan, 'synthetic-reviewed-build'));
    let launches = 0;
    const io = { env, stdout: () => {}, stderr: () => {} };
    assert.equal(
      await claudeCommand([], f.root, io, {
        production: {
          configuration: () => ({ observation: f.input.configuration, reason: null }),
          observe: async () => f.startup,
          manifest: () => f.manifest,
          hudRevision: 'synthetic-reviewed-build',
        },
        launch: async () => {
          launches++;
          return 0;
        },
      }),
      0
    );
    assert.equal(
      await claudeCommand([], f.root, io, {
        production: {
          observe: async () => {
            throw new Error('must not inspect machine qualification');
          },
          manifest: () => {
            throw new Error('must not inspect release manifest');
          },
        },
        launch: async () => {
          launches++;
          return 0;
        },
      }),
      0
    );
    assert.equal(launches, 2);
    assert.deepEqual(readdirSync(f.root), ['delegate.json']);
  } finally {
    f.close();
  }
});

test('Claude production refuses missing/mismatched evidence and stale host after preparation, cleaning private artifacts', async () => {
  const f = await launchFixture();
  try {
    for (const scenario of [
      'missing-host',
      'empty-manifest',
      'wrong-version',
      'changed-settings',
      'stale-host',
      'resume',
      'shell',
      'herdr',
      'loader',
    ] as const) {
      let observations = 0,
        launches = 0;
      const input = structuredClone(f.input);
      if (scenario === 'changed-settings') input.settings.permissions.allow.push('changed');
      if (scenario === 'resume') input.resume = true;
      if (scenario === 'shell') input.command = { shell: 'synthetic', shellPath: '/bin/sh' };
      if (scenario === 'herdr') input.profile.host = { kind: 'herdr', layout: 'tab' };
      if (scenario === 'loader') Object.assign(input.env, { LD_PRELOAD: '/synthetic/library.so' });
      await assert.rejects(
        launchClaudeInTmux(input, {
          configuration: () => ({ observation: f.input.configuration, reason: null }),
          observe: async () => {
            observations++;
            if (scenario === 'missing-host') return null;
            const current = structuredClone(f.startup);
            if (scenario === 'stale-host' && observations === 2) current.receipt.ancestry[0].foregroundPgid++;
            return current;
          },
          manifest: () => (scenario === 'empty-manifest' ? { version: 1, hudRevision: null, cells: [] } : f.manifest),
          hudRevision: scenario === 'wrong-version' ? 'different-build' : 'synthetic-reviewed-build',
          launch: async () => {
            launches++;
            return 0;
          },
        }),
        /capability_unverified/,
        scenario
      );
      assert.equal(launches, 0, scenario);
      assert.deepEqual(readdirSync(f.root), [], scenario);
    }
  } finally {
    f.close();
  }
});

test('Claude pre-dispatch source identity recheck rejects a directory replaced at the same path', async () => {
  const f = await launchFixture();
  try {
    const source = join(f.root, 'source');
    mkdirSync(source);
    f.input.profile.source.root = source;
    f.input.env.CLAUDE_CONFIG_DIR = source;
    const info = statSync(source, { bigint: true });
    const plan = claudeLaunchPlan({
      ...f.input,
      source: { root: source, dev: String(info.dev), ino: String(info.ino) },
      cwd: f.plan.cwd,
      executable: f.plan.executable,
      startup: f.startup,
      helper: null,
      makeHookSettings: null,
    });
    Object.assign(f.manifest.cells[0], claudeExpectation(plan, 'synthetic-reviewed-build'));
    let observations = 0,
      launches = 0;
    await assert.rejects(
      launchClaudeInTmux(f.input, {
        configuration: () => ({ observation: f.input.configuration, reason: null }),
        observe: async () => {
          if (++observations === 2) {
            renameSync(source, source + '-old');
            mkdirSync(source);
          }
          return f.startup;
        },
        hudRevision: 'synthetic-reviewed-build',
        manifest: () => f.manifest,
        launch: async () => {
          launches++;
          return 0;
        },
      }),
      /capability_unverified/
    );
    assert.equal(observations, 2);
    assert.equal(launches, 0);
    assert.deepEqual(readdirSync(f.root).sort(), ['source', 'source-old']);
  } finally {
    f.close();
  }
});

test('Claude pure plan binds helper/settings/source/runtime; materialization preserves hooks and literal slot-like data', async () => {
  const f = await launchFixture();
  try {
    const helper = {
      implementation: 'synthetic-helper-1',
      claudeVersion: '2.1.305',
      script: '/synthetic/hook.mjs',
      scriptSha256: 'a'.repeat(64),
      record: '/synthetic/record.js',
      recordSha256: 'b'.repeat(64),
    };
    const profile = { ...f.input.profile, callSource: { kind: 'claude_pre_tool_use_v1' as const } };
    const settings = { ...f.input.settings, literal: '<HUD:typed-private-hook-command-slot:v1>' };
    const plan = claudeLaunchPlan({
      ...f.input,
      profile,
      settings,
      source: f.plan.source,
      cwd: f.plan.cwd,
      executable: f.plan.executable,
      startup: f.startup,
      helper,
      makeHookSettings: (config, command, existing) =>
        makeHookSettings(config as Parameters<typeof makeHookSettings>[0], command, existing),
    });
    const materialized = materializeClaudePlan(plan, '/synthetic/private launch', (config, command, existing) =>
      makeHookSettings(config as Parameters<typeof makeHookSettings>[0], command, existing)
    );
    assert.equal(materialized.settings.literal, settings.literal);
    assert.deepEqual((materialized.settings.hooks as Record<string, unknown>).Stop, settings.hooks.Stop);
    assert.equal((materialized.hook as { sourceRoot: string }).sourceRoot, f.root);
    for (const mutate of [
      (p: typeof plan) => {
        p.argv[1] = 'different';
      },
      (p: typeof plan) => {
        p.settings.literal = 'different';
      },
      (p: typeof plan) => {
        p.hook!.helper.implementation = 'different';
      },
      (p: typeof plan) => {
        p.hook!.helper.scriptSha256 = 'c'.repeat(64);
      },
      (p: typeof plan) => {
        p.source.ino = 'different';
      },
      (p: typeof plan) => {
        p.executable.file.ino = 'different';
      },
      (p: typeof plan) => {
        p.runtime.shell.version = 'different';
      },
    ]) {
      const changed = structuredClone(plan);
      mutate(changed);
      assert.notEqual(digest(changed), digest(plan));
    }
    assert.deepEqual(readdirSync(f.root), [], 'planning/materialization is pure');
  } finally {
    f.close();
  }
});
