import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  observeClaudeConfiguration,
  sameClaudeConfiguration,
  type ClaudeConfigurationRequest,
} from '../../src/cli/claude-configuration.js';
import { claudeExpectation, claudeLaunchPlan, launchClaudeInTmux } from '../../src/cli/claude-launch.js';
import { nativeFile, type TmuxStartup } from '../../src/cli/claude-tmux.js';
import { resolveLaunchCommand } from '../../src/core/capabilities.js';
import type { CapabilityManifestV1, LaunchProfile } from '../../src/core/types/capabilities.js';

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hud-claude-config-')));
  const sourceRoot = join(root, 'source'),
    cwd = join(root, 'first'),
    second = join(root, 'second'),
    managedRoot = join(root, 'managed');
  for (const path of [sourceRoot, cwd, second, managedRoot]) mkdirSync(path);
  for (const path of [cwd, second])
    execFileSync('/usr/bin/git', ['init', '--quiet', path], { env: { HOME: root, PATH: '/usr/bin:/bin' } });
  const request: ClaudeConfigurationRequest = {
    sourceRoot,
    cwd,
    argv: [process.execPath],
    env: { HOME: root, CLAUDE_CONFIG_DIR: sourceRoot, CLAUDE_CODE_USE_BEDROCK: '1' },
    version: '2.1.305',
    kernel: 'synthetic-linux',
    settings: {},
  };
  // This executor remaps system file ownership. The explicit test seam does not
  // change production's root-owned executable/ancestor requirement.
  const observe = (value = request) =>
    observeClaudeConfiguration(value, { managedRoot, gitExecutable: () => '/usr/bin/git' });
  return { root, request, observe, second, managedRoot, close: () => rmSync(root, { recursive: true, force: true }) };
}
const json = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value));

test('Claude default local inputs bind user/project/local, scoped MCP and managed files with explicit missing states', () => {
  const f = fixture();
  try {
    mkdirSync(join(f.request.cwd, '.claude'));
    json(join(f.request.sourceRoot, 'settings.json'), { hooks: { Stop: [] } });
    json(join(f.request.cwd, '.claude/settings.json'), { permissions: { deny: ['Bash(synthetic)'] } });
    json(join(f.request.cwd, '.claude/settings.local.json'), { enableAllProjectMcpServers: true });
    json(join(f.request.sourceRoot, '.claude.json'), {
      mcpServers: { user: { command: '/synthetic/server' } },
      projects: {
        [f.request.cwd]: { mcpServers: { local: { command: '/synthetic/local' } } },
        [f.second]: { mcpServers: { unrelated: { command: '/synthetic/other' } } },
      },
    });
    json(join(f.request.cwd, '.mcp.json'), { mcpServers: { project: { command: '/synthetic/project' } } });
    json(join(f.managedRoot, 'managed-settings.json'), { permissions: { deny: ['Bash(other)'] } });
    mkdirSync(join(f.managedRoot, 'managed-settings.d'));
    json(join(f.managedRoot, 'managed-settings.d/10-synthetic.json'), { allowManagedHooksOnly: true });
    const before = f.observe();
    assert.equal(before.reason, null);
    assert.ok(before.observation);
    assert.equal(before.observation.description.layers.find((layer) => layer.role === 'managed-mcp')!.state, 'missing');
    assert.equal(
      before.observation.description.layers.find((layer) => layer.role === 'managed-dropin:10-synthetic.json')!.state,
      'file'
    );
    assert.equal(sameClaudeConfiguration(before.observation, f.observe().observation), true);
    json(join(f.request.cwd, '.mcp.json'), { mcpServers: { project: { command: '/synthetic/changed' } } });
    const after = f.observe().observation!;
    assert.notDeepEqual(before.observation.description, after.description);
    assert.equal(sameClaudeConfiguration(before.observation, after), false);
  } finally {
    f.close();
  }
});

test('Claude global/local capability projection ignores only known statistics while receipts retain the complete file', () => {
  const f = fixture();
  try {
    const file = join(f.request.sourceRoot, '.claude.json');
    const value = {
      numStartups: 1,
      lastCost: 0.5,
      lastSessionId: 'synthetic-first',
      mcpServers: { user: { command: '/synthetic/user', env: { MODE: 'fixed' } } },
      projects: {
        [f.request.cwd]: {
          numStartups: 2,
          lastCost: 0.25,
          lastSessionId: 'synthetic-local',
          mcpServers: { local: { command: '/synthetic/local' } },
          hasTrustDialogAccepted: true,
          allowedTools: ['synthetic'],
          mcpContextUris: ['synthetic://resource'],
          enableAllProjectMcpServers: false,
          enabledMcpjsonServers: ['project'],
          disabledMcpjsonServers: [] as string[],
          enabledMcpServers: ['local'],
          disabledMcpServers: [] as string[],
        },
      },
    };
    json(file, value);
    const before = planFixture(f, f.request.cwd).plan;
    value.numStartups++;
    value.lastCost = 7;
    value.lastSessionId = 'PWD';
    value.projects[f.request.cwd].numStartups++;
    value.projects[f.request.cwd].lastCost = 8;
    value.projects[f.request.cwd].lastSessionId = 'OLDPWD';
    json(file, value);
    const after = planFixture(f, f.request.cwd).plan;
    assert.equal(
      claudeExpectation(before, 'synthetic-reviewed-build').profileFingerprint,
      claudeExpectation(after, 'synthetic-reviewed-build').profileFingerprint
    );
    assert.deepEqual(before.configuration.description, after.configuration.description);
    assert.equal(sameClaudeConfiguration(before.configuration, after.configuration), false);
    for (const change of [
      (v: typeof value) => {
        v.mcpServers.user.command = '/synthetic/other';
      },
      (v: typeof value) => {
        v.mcpServers.user.env.MODE = 'other';
      },
      (v: typeof value) => {
        v.projects[f.request.cwd].mcpServers.local.command = '/synthetic/other';
      },
      (v: typeof value) => {
        v.projects[f.request.cwd].hasTrustDialogAccepted = false;
      },
      (v: typeof value) => {
        v.projects[f.request.cwd].disabledMcpServers = ['local'];
      },
      (v: typeof value) => {
        v.projects[f.request.cwd].disabledMcpjsonServers = ['project'];
      },
      (v: typeof value) => {
        v.projects[f.request.cwd].allowedTools = [];
      },
      (v: typeof value) => {
        v.projects[f.request.cwd].mcpContextUris = [];
      },
    ]) {
      const changed = structuredClone(value);
      change(changed);
      json(file, changed);
      const selected = planFixture(f, f.request.cwd).plan;
      assert.notEqual(
        claudeExpectation(after, 'synthetic-reviewed-build').profileFingerprint,
        claudeExpectation(selected, 'synthetic-reviewed-build').profileFingerprint
      );
    }
    for (const [scope, key, field] of [
      ['global', 'futureConfigSource', '/synthetic/source'],
      ['project', 'futureMcpSelector', 'other'],
      ['global', 'lastUnknownStatistic', 1],
      ['project', 'lastCost', { mcpServers: {} }],
    ] as const) {
      const changed = structuredClone(value);
      Object.assign(scope === 'global' ? changed : changed.projects[f.request.cwd], { [key]: field });
      json(file, changed);
      const result = f.observe();
      assert.equal(result.observation, null);
      assert.equal(result.reason, `configuration_${scope}_selector_uncovered`);
    }
  } finally {
    f.close();
  }
});

test('Claude missing-state and identity receipts reject creation and same-path replacement without stable inode coupling', () => {
  const f = fixture();
  try {
    const missing = f.observe().observation!;
    const file = join(f.request.sourceRoot, 'settings.json');
    json(file, { permissions: { deny: [] } });
    const present = f.observe().observation!;
    assert.equal(sameClaudeConfiguration(missing, present), false);
    renameSync(file, file + '.old');
    json(file, { permissions: { deny: [] } });
    const replaced = f.observe().observation!;
    assert.deepEqual(present.description, replaced.description);
    assert.equal(sameClaudeConfiguration(present, replaced), false);
  } finally {
    f.close();
  }
});

test('Claude configuration fails closed for remote/WSL, uncovered selectors, extensions, helpers and unsafe or oversized files', () => {
  for (const scenario of [
    'remote',
    'wsl',
    'version',
    'selector',
    'worktree',
    'plugin',
    'policy-helper',
    'env-selector',
    'symlink',
    'oversized',
  ] as const) {
    const f = fixture();
    try {
      if (scenario === 'remote') delete f.request.env.CLAUDE_CODE_USE_BEDROCK;
      if (scenario === 'wsl') f.request.kernel = 'microsoft-standard-WSL2';
      if (scenario === 'version') f.request.version = '2.1.306';
      if (scenario === 'selector') f.request.argv = [process.execPath, '--setting-sources', 'user'];
      if (scenario === 'worktree') {
        rmSync(join(f.request.cwd, '.git'), { recursive: true, force: true });
        writeFileSync(join(f.request.cwd, '.git'), 'gitdir: /synthetic/elsewhere');
      }
      if (scenario === 'plugin') mkdirSync(join(f.request.sourceRoot, 'plugins'));
      if (scenario === 'policy-helper')
        json(join(f.managedRoot, 'managed-settings.json'), { policyHelper: '/synthetic/helper' });
      if (scenario === 'env-selector')
        json(join(f.request.sourceRoot, 'settings.json'), { env: { CLAUDE_CODE_USE_BEDROCK: '0' } });
      if (scenario === 'symlink') {
        json(join(f.root, 'settings.json'), {});
        symlinkSync(join(f.root, 'settings.json'), join(f.request.sourceRoot, 'settings.json'));
      }
      if (scenario === 'oversized') writeFileSync(join(f.request.sourceRoot, 'settings.json'), ' '.repeat(262145));
      const before = scenario === 'symlink' ? readFileSync(join(f.root, 'settings.json'), 'utf8') : null;
      const result = f.observe();
      assert.equal(result.observation, null, scenario);
      assert.match(result.reason!, /^configuration_/, scenario);
      if (before !== null) assert.equal(readFileSync(join(f.root, 'settings.json'), 'utf8'), before);
    } finally {
      f.close();
    }
  }
});

function planFixture(f: ReturnType<typeof fixture>, cwd: string, literal = false) {
  const native = nativeFile(process.execPath)!;
  const executable = { ...native, version: process.versions.node };
  const runtime: TmuxStartup = {
    topology: 'linux-tmux-existing-pane-foreground-argv-v1',
    host: { ...native, version: '3.4' },
    shell: { ...native, version: '5.2.15' },
    node: executable,
    platform: 'linux',
    kernel: 'synthetic-linux',
    receipt: {
      socket: { path: '/synthetic/socket', dev: '1', ino: '2' },
      pane: '%1',
      tty: '/dev/pts/1',
      terminalDevice: '34817',
      server: {
        stamp: { pid: 1, proc_start: '1', pid_domain: 'synthetic', boot_id: 'synthetic' },
        ppid: 0,
        pgid: 1,
        sid: 1,
        tty: 0,
        foregroundPgid: -1,
      },
      ancestry: [],
    },
  };
  const profile: LaunchProfile = {
    name: 'synthetic',
    harness: 'claude',
    source: { root: f.request.sourceRoot, label: 'Synthetic' },
    launch: { argv: [process.execPath, '--directory', '{{cwd}}', 'literal fixed'] },
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
  const command = literal
    ? profile.launch
    : resolveLaunchCommand(profile.launch, { cwd, sourceRoot: f.request.sourceRoot });
  const env = { ...f.request.env, PWD: cwd, OLDPWD: cwd + '-old', _: '/synthetic/shell', PATH: '/usr/bin:/bin' };
  const result = f.observe({ ...f.request, cwd, env, argv: command.argv! });
  const configuration = result.observation!;
  assert.ok(configuration, result.reason ?? 'configuration unavailable');
  const info = statSync(f.request.sourceRoot, { bigint: true });
  const input = {
    profile,
    configuredProfile: profile,
    command,
    ...(!literal ? { template: profile.launch } : {}),
    settings: {},
    hasSettings: false,
    resume: false,
    home: f.root,
    env,
    configuration,
  };
  const plan = claudeLaunchPlan({
    ...input,
    source: { root: f.request.sourceRoot, dev: String(info.dev), ino: String(info.ino) },
    cwd,
    executable,
    startup: runtime,
    helper: null,
    makeHookSettings: null,
  });
  return { input, plan, runtime };
}

test('Claude reusable template matches equivalent configurations across cwd while receipts retain expanded argv and bookkeeping', () => {
  const f = fixture();
  try {
    const first = planFixture(f, f.request.cwd),
      second = planFixture(f, f.second);
    const actual = (plan: typeof first.plan) => claudeExpectation(plan, 'synthetic-reviewed-build');
    assert.equal(actual(first.plan).profileFingerprint, actual(second.plan).profileFingerprint);
    assert.notDeepEqual(first.plan.argv, second.plan.argv);
    assert.notEqual(first.plan.environmentReceipt, second.plan.environmentReceipt);
    assert.notDeepEqual(first.plan.configuration.receipt, second.plan.configuration.receipt);
    assert.notEqual(
      actual(first.plan).profileFingerprint,
      actual(planFixture(f, f.request.cwd, true).plan).profileFingerprint,
      'literal {{cwd}} cannot become a typed slot'
    );
    const changed = structuredClone(first.plan);
    changed.environmentFingerprint = 'different-path-or-security-input';
    assert.notEqual(actual(first.plan).profileFingerprint, actual(changed).profileFingerprint);
    json(join(f.request.sourceRoot, 'settings.json'), { permissions: { deny: ['Bash(synthetic)'] } });
    assert.notEqual(
      actual(first.plan).profileFingerprint,
      actual(planFixture(f, f.request.cwd).plan).profileFingerprint
    );
    json(join(f.request.sourceRoot, 'settings.json'), {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo "$PWD"' }] }] },
    });
    assert.notEqual(
      actual(planFixture(f, f.request.cwd).plan).profileFingerprint,
      actual(planFixture(f, f.second).plan).profileFingerprint,
      'referenced bookkeeping remains security-relevant'
    );
  } finally {
    f.close();
  }
});

test('Claude production rechecks actual automatic config and frozen environment before dispatch', async () => {
  const originalCwd = process.cwd();
  for (const mutation of ['file-created', 'file-replaced', 'statistics', 'environment', 'argv'] as const) {
    const f = fixture();
    try {
      process.chdir(f.request.cwd);
      if (mutation === 'file-replaced') json(join(f.request.sourceRoot, 'settings.json'), { hooks: {} });
      if (mutation === 'statistics') json(join(f.request.sourceRoot, '.claude.json'), { numStartups: 1 });
      const { input, plan, runtime } = planFixture(f, f.request.cwd);
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
              script: 'synthetic',
              report: 'synthetic',
              reportSha256: 'a'.repeat(64),
              artifactDigest: 'b'.repeat(64),
              observedAt: 1,
              reviewStatus: 'accepted',
              scope: 'product',
            },
          },
        ],
      };
      let calls = 0,
        launches = 0;
      await assert.rejects(
        launchClaudeInTmux(input, {
          hudRevision: 'synthetic-reviewed-build',
          manifest: () => manifest,
          // Node is a synthetic stand-in; these are filesystem observer tests, not
          // native Claude/version or product evidence.
          configuration: (request) => f.observe({ ...request, version: '2.1.305' }),
          observe: async () => {
            if (++calls === 2) {
              const path = join(f.request.sourceRoot, 'settings.json');
              if (mutation === 'file-created') json(path, { hooks: {} });
              if (mutation === 'file-replaced') {
                renameSync(path, path + '.old');
                json(path, { hooks: {} });
              }
              if (mutation === 'environment') input.env.PATH = '/synthetic/changed';
              if (mutation === 'argv') input.command.argv![3] = 'changed';
              if (mutation === 'statistics') json(join(f.request.sourceRoot, '.claude.json'), { numStartups: 2 });
            }
            return structuredClone(runtime);
          },
          launch: async () => {
            launches++;
            return 0;
          },
        }),
        /capability_unverified/,
        mutation
      );
      assert.equal(calls, 2, mutation);
      assert.equal(launches, 0, mutation);
    } finally {
      process.chdir(originalCwd);
      f.close();
    }
  }
});
