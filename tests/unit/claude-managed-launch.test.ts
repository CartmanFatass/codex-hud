import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fsPromises, renameSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareClaudeLaunch } from '../../src/harness/claude/managed-launch.js';
import { claudeManagedConfiguration } from '../../src/harness/claude/managed-configuration.js';
import { claudeManagedCommand } from '../../src/harness/claude/managed-command.js';
import { claudeManagedRole } from '../../src/harness/claude/managed-role.js';
import { launchProfileDigest } from '../../src/core/capabilities.js';
import { launchDigest } from '../../src/core/run/control.js';
import type { LaunchProfile } from '../../src/core/types/capabilities.js';
import type { PrepareManagedLaunchOptions } from '../../src/core/launch/types.js';

const session = '11111111-2222-3333-4444-555555555555';
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'hud-managed-claude-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source'),
    cwd = join(root, 'project'),
    home = join(root, 'home'),
    hudHome = join(root, 'hud');
  for (const directory of [source, cwd, home, hudHome]) mkdirSync(directory, { mode: 0o700 });
  const briefPath = join(root, 'brief.txt');
  writeFileSync(briefPath, 'Synthetic task 内容.');
  const server = {
    type: 'stdio',
    command: process.execPath,
    args: ['synthetic-mcp.mjs'],
    env: { SENTINEL: 'preserved', HUD_CLAIM: 'old-server-claim' },
  };
  const configuration = { mcpServers: { selected_hud: server, unrelated: { command: 'synthetic-other' } } };
  writeFileSync(join(source, '.claude.json'), JSON.stringify(configuration));
  const profile: LaunchProfile = {
    name: 'synthetic-claude',
    harness: 'claude',
    source: { root: source, label: 'Synthetic Claude' },
    launch: { argv: [process.execPath] },
    headless: { argv: [process.execPath, '-p', '--output-format', 'stream-json', '--verbose'] },
    resume: null,
    resumeHeadless: {
      argv: [process.execPath, '-p', '--output-format', 'stream-json', '--verbose', '--resume', '{{sessionId}}'],
    },
    host: { kind: 'none', layout: 'none' },
    env: { CLAUDE_CONFIG_DIR: source },
    mcpServerName: 'selected_hud',
    claimTransport: 'config_env',
    clientToolTimeoutMs: 60000,
    responseMarginMs: 2000,
    orphan_policy: 'continue',
    managedShellVerified: false,
    callSource: { kind: 'claude_pre_tool_use_v1' },
    roles: { implementer: { model: 'synthetic-model', effort: 'high' } },
  };
  const options: PrepareManagedLaunchOptions = {
    profile,
    operation: 'spawn',
    mode: 'headless',
    cwd,
    briefPath,
    env: {
      HOME: home,
      HUD_CLAIM: 'stale-parent-claim',
      HUD_RUN: 'stale-parent-run',
      HUD_LINK: 'stale-parent-link',
      HUD_PI_EVIDENCE_FD: '99',
    },
    executableIdentity: { path: process.execPath, version: '2.1.305' },
  };
  const run = { runId: 'synthetic-claude-run', linkId: 'synthetic-link', claim: 'fresh-claim', hudHome };
  return { root, source, cwd, home, hudHome, briefPath, profile, options, run, configuration, server };
}
const decode = (prepared: ReturnType<Awaited<ReturnType<typeof prepareClaudeLaunch>>['forRun']>, kind: string) => {
  const artifact = prepared.payload.launchArtifacts!.find((item) => item.name.startsWith(kind))!;
  return { artifact, json: JSON.parse(Buffer.from(artifact.base64, 'base64').toString('utf8')) };
};

test('managed Claude preparation is write-free, preserves default discovery and owns immutable stdin bytes', async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.cwd, '.claude'));
  const settings = {
    hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'synthetic-user-hook' }] }] },
    permissions: { deny: ['Bash(synthetic)'] },
  };
  writeFileSync(join(f.cwd, '.claude/settings.json'), JSON.stringify(settings));
  const original = readFileSync(join(f.source, '.claude.json'));
  const preparation = await prepareClaudeLaunch({
    ...f.options,
    role: 'implementer',
    prompt: 'Follow-up $(); \n保持 data.',
  });
  writeFileSync(f.briefPath, 'Changed after preparation');
  f.profile.roles!.implementer.model = 'mutated';
  f.profile.headless!.argv![0] = 'mutated';
  const prepared = preparation.forRun(f.run);
  const delivered = Buffer.from(prepared.payload.briefBase64, 'base64');
  assert.match(delivered.toString(), /^Synthetic task 内容\./);
  assert.match(delivered.toString(), /Follow-up \$\(\);/);
  assert.match(delivered.toString(), /delegate_whoami/);
  assert.match(delivered.toString(), /delegate_report.*synthetic-claude-run/);
  assert.ok(!delivered.includes(Buffer.from(f.run.claim)));
  assert.equal(hash(delivered), prepared.deliveredSha256);
  assert.equal(prepared.launchDigest, launchDigest(prepared.input));
  assert.deepEqual(readdirSync(f.hudHome), []);
  assert.deepEqual(readFileSync(join(f.source, '.claude.json')), original);
  assert.deepEqual(JSON.parse(readFileSync(join(f.cwd, '.claude/settings.json'), 'utf8')), settings);
  assert.equal(preparation.model, 'synthetic-model');
  assert.equal(preparation.effort, 'high');
  assert.deepEqual(prepared.input.launch.argv!.slice(0, 9), [
    process.execPath,
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    'synthetic-model',
    '--effort',
    'high',
  ]);
  assert.ok(
    !prepared.input.launch.argv!.some((arg) =>
      ['--bare', '--strict-mcp-config', '--dangerously-skip-permissions'].includes(arg)
    )
  );
  assert.equal(preparation.capabilityRequest().configurationCoverage, 'partial');
});

test('managed Claude artifacts overlay only selected server with fresh run/profile/hook identity and preserved env', async (t) => {
  const f = fixture(t);
  const preparation = await prepareClaudeLaunch(f.options);
  const prepared = preparation.forRun(f.run);
  const { artifact: hookFile, json: hook } = decode(prepared, 'claude-hook');
  const { json: settings } = decode(prepared, 'claude-settings');
  const { json: mcp } = decode(prepared, 'claude-mcp');
  const hookPath = join(f.hudHome, 'runs', f.run.runId, hookFile.name);
  assert.equal(hook.claudeExecutable, process.execPath);
  assert.equal(hook.sourceRoot, f.source);
  assert.equal(hook.ledgerPath, join(f.hudHome, 'ledger.sqlite'));
  assert.equal(hook.profileFingerprint, launchProfileDigest(f.profile));
  assert.equal(hook.directory, join(f.hudHome, 'runs', f.run.runId));
  assert.equal(settings.hooks.PreToolUse.length, 1);
  assert.match(settings.hooks.PreToolUse[0].matcher, /^\^mcp__selected_hud__/);
  assert.ok(settings.hooks.PreToolUse[0].hooks[0].command.includes(hookPath));
  assert.deepEqual(Object.keys(mcp.mcpServers), ['selected_hud']);
  const server = mcp.mcpServers.selected_hud;
  assert.equal(server.command, f.server.command);
  assert.deepEqual(server.args, f.server.args);
  assert.equal(server.env.SENTINEL, 'preserved');
  for (const [key, value] of Object.entries({
    HUD_CLAIM: f.run.claim,
    HUD_RUN: f.run.runId,
    HUD_LINK: f.run.linkId,
    HUD_HOME: f.hudHome,
    HUD_MCP_PROFILE: f.profile.name,
    HUD_CLAUDE_HOOK_CONFIG: hookPath,
  })) {
    assert.equal(server.env[key], value);
    assert.equal(prepared.payload.env![key], key === 'HUD_HOME' ? value : undefined);
  }
  assert.equal(prepared.payload.env!.HUD_PI_EVIDENCE_FD, undefined);
  assert.equal(prepared.payload.env!.CLAUDE_CONFIG_DIR, f.source);
  const next = preparation.forRun({ ...f.run, runId: 'next-run', claim: 'next-claim' });
  assert.notEqual(next.launchDigest, prepared.launchDigest);
  assert.ok(!JSON.stringify(next).includes('fresh-claim'));
  assert.ok(!JSON.stringify(prepared).includes('stale-parent-claim'));
});

test('managed Claude resume requires exact UUID and explicit resumeFrom without changing prompt identity', async (t) => {
  const f = fixture(t);
  const preparation = await prepareClaudeLaunch({ ...f.options, operation: 'resume', resumeSessionId: session });
  assert.throws(() => preparation.capabilityRequest(), /resume_from_required/);
  assert.equal(preparation.capabilityRequest('headless').key.operation, 'resume');
  const argv = preparation.forRun(f.run).input.launch.argv!;
  assert.equal(argv[argv.indexOf('--resume') + 1], session);
  for (const value of ['latest', '../session', '--continue', session.toUpperCase(), '11111111'])
    if (value !== session)
      await assert.rejects(
        prepareClaudeLaunch({ ...f.options, operation: 'resume', resumeSessionId: value }),
        /invalid_claude_resume_session/
      );
  await assert.rejects(prepareClaudeLaunch({ ...f.options, resumeSessionId: session }), /unexpected_resume_session/);
});

test('managed Claude refuses shell, bare, hooks disabled, alternate discovery/topology and implicit/fork resume selectors', async (t) => {
  const f = fixture(t);
  for (const argument of [
    '--bare',
    '--bare=true',
    '--continue',
    '--fork-session',
    '--no-session-persistence',
    '--agent',
    '--settings',
    '--mcp-config',
    '--strict-mcp-config',
    '--setting-sources',
    '--dangerously-skip-permissions',
    '--',
    'positional prompt',
  ]) {
    const profile = structuredClone(f.profile);
    profile.headless!.argv!.push(argument);
    await assert.rejects(prepareClaudeLaunch({ ...f.options, profile }), /invalid_claude_managed_arguments/);
  }
  const profile = structuredClone(f.profile);
  profile.headless = { shell: 'claude -p', shellPath: '/bin/sh' };
  await assert.rejects(prepareClaudeLaunch({ ...f.options, profile }), /claude_managed_argv_required/);
  delete profile.callSource;
  await assert.rejects(prepareClaudeLaunch({ ...f.options, profile }), /claude_hook_profile_required/);
  await assert.rejects(
    prepareClaudeLaunch({ ...f.options, env: { ...f.options.env, CLAUDE_CODE_SIMPLE: '1' } }),
    /claude_hook_disabled/
  );
});

test('managed Claude roles are data, never guessed models or option injection', (t) => {
  const f = fixture(t);
  assert.throws(() => claudeManagedRole(f.profile, { role: 'missing' }), /role_model_unconfigured/);
  assert.deepEqual(claudeManagedRole(f.profile, { role: 'missing', model: 'explicit-model', effort: 'low' }), {
    role: 'missing',
    model: 'explicit-model',
    effort: 'low',
  });
  for (const value of ['--dangerously-skip-permissions', 'a\0b', 'x'.repeat(257)])
    assert.throws(() => claudeManagedRole(f.profile, { model: value }), /invalid_role_options/);
  const command = claudeManagedCommand({
    template: {
      argv: [process.execPath, '--print', '--output-format', 'stream-json', '--verbose', '--model', '{{model}}'],
    },
    operation: 'spawn',
    cwd: f.cwd,
    sourceRoot: f.source,
    model: 'model with spaces',
    effort: null,
  });
  assert.equal(command.argv.at(-1), 'model with spaces');
});

test('managed Claude identity, version, source, missing brief and payload bounds refuse before any artifact writes', async (t) => {
  const f = fixture(t);
  await assert.rejects(
    prepareClaudeLaunch({ ...f.options, executableIdentity: undefined }),
    /claude_executable_unverified/
  );
  await assert.rejects(
    prepareClaudeLaunch({ ...f.options, executableIdentity: { path: process.execPath, version: 'other-version' } }),
    /claude_executable_unverified/
  );
  await assert.rejects(prepareClaudeLaunch({ ...f.options, mode: 'visible' }), /visible_launch_not_in_this_build/);
  const profile = structuredClone(f.profile);
  profile.env.CLAUDE_CONFIG_DIR = f.cwd;
  await assert.rejects(prepareClaudeLaunch({ ...f.options, profile }), /claude_source_mismatch/);
  await assert.rejects(prepareClaudeLaunch({ ...f.options, prompt: 'x'.repeat(65537) }), /prompt_too_large/);
  const preparation = await prepareClaudeLaunch(f.options);
  for (const run of [
    { ...f.run, runId: '../escape' },
    { ...f.run, claim: '' },
    { ...f.run, claim: 'x'.repeat(4097) },
  ])
    assert.throws(() => preparation.forRun(run), /invalid_launch_identity/);
  assert.throws(() => preparation.forRun({ ...f.run, hudHome: '../escape' }), /invalid_launch_artifacts/);
  assert.deepEqual(readdirSync(f.hudHome), []);
});

test('managed Claude local input fingerprints change with preserved settings/server environment and helper inputs remain private', async (t) => {
  const f = fixture(t);
  const first = await prepareClaudeLaunch(f.options);
  writeFileSync(join(f.source, 'settings.json'), JSON.stringify({ hooks: { Stop: [] } }));
  const second = await prepareClaudeLaunch(f.options);
  assert.notEqual(first.configFingerprint, second.configFingerprint);
  f.configuration.mcpServers.selected_hud.env.SENTINEL = 'changed';
  writeFileSync(join(f.source, '.claude.json'), JSON.stringify(f.configuration));
  const third = await prepareClaudeLaunch(f.options);
  assert.notEqual(second.configFingerprint, third.configFingerprint);
  assert.notEqual(second.capabilityRequest().profileFingerprint, third.capabilityRequest().profileFingerprint);
  assert.ok(!JSON.stringify(third.capabilityRequest()).includes('changed'));
});

test('managed Claude server absence, conflicting duplicate, HTTP transport, disabled hooks/server, malformed/oversized/symlink config fail closed', async (t) => {
  const f = fixture(t);
  const file = join(f.source, '.claude.json');
  writeFileSync(file, '{}');
  await assert.rejects(claudeManagedConfiguration(f.source, f.cwd, 'selected_hud'), /hud_stdio_server_unavailable/);
  writeFileSync(file, JSON.stringify(f.configuration));
  writeFileSync(join(f.cwd, '.mcp.json'), JSON.stringify({ mcpServers: { selected_hud: { command: 'different' } } }));
  await assert.rejects(claudeManagedConfiguration(f.source, f.cwd, 'selected_hud'), /hud_stdio_server_ambiguous/);
  rmSync(join(f.cwd, '.mcp.json'));
  writeFileSync(file, JSON.stringify({ mcpServers: { selected_hud: { type: 'http', url: 'https://invalid.test' } } }));
  await assert.rejects(claudeManagedConfiguration(f.source, f.cwd, 'selected_hud'), /hud_stdio_server_unavailable/);
  writeFileSync(file, JSON.stringify(f.configuration));
  for (const setting of [
    { disableAllHooks: true },
    { disabledMcpServers: ['selected_hud'] },
    { env: { CLAUDE_CONFIG_DIR: '/other' } },
  ]) {
    writeFileSync(join(f.source, 'settings.json'), JSON.stringify(setting));
    await assert.rejects(
      claudeManagedConfiguration(f.source, f.cwd, 'selected_hud'),
      /claude_hook_disabled|hud_stdio_server_disabled|claude_configuration_source_override/
    );
  }
  rmSync(join(f.source, 'settings.json'));
  writeFileSync(file, '{');
  await assert.rejects(claudeManagedConfiguration(f.source, f.cwd, 'selected_hud'), SyntaxError);
  writeFileSync(file, 'x'.repeat(131073));
  await assert.rejects(claudeManagedConfiguration(f.source, f.cwd, 'selected_hud'), /claude_configuration_limit/);
  rmSync(file);
  symlinkSync(f.briefPath, file);
  await assert.rejects(claudeManagedConfiguration(f.source, f.cwd, 'selected_hud'), /claude_configuration_symlink/);
});

test('managed Claude configuration reads through held parent descriptors during an ancestor swap', async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.source, '.claude.json'), '{}');
  writeFileSync(
    join(f.cwd, '.mcp.json'),
    JSON.stringify({ mcpServers: { selected_hud: { command: 'intended-server' } } })
  );
  const outside = join(f.root, 'outside');
  const held = join(f.root, 'project-held');
  mkdirSync(outside);
  writeFileSync(
    join(outside, '.mcp.json'),
    JSON.stringify({ mcpServers: { selected_hud: { command: 'outside-server' } } })
  );
  const originalOpen = fsPromises.open;
  let swapped = false;
  t.mock.method(fsPromises, 'open', async (...args: Parameters<typeof fsPromises.open>) => {
    if (!swapped && String(args[0]).endsWith('/.mcp.json')) {
      swapped = true;
      renameSync(f.cwd, held);
      symlinkSync(outside, f.cwd);
      try {
        return await originalOpen(...args);
      } finally {
        unlinkSync(f.cwd);
        renameSync(held, f.cwd);
      }
    }
    return originalOpen(...args);
  });
  const result = await claudeManagedConfiguration(f.source, f.cwd, 'selected_hud');
  assert.equal(swapped, true, 'the swap occurs exactly across the actual leaf open');
  assert.equal(result.server.command, 'intended-server');
});

test('an unrelated inherited-environment child receives no selected-server authority', async (t) => {
  const f = fixture(t);
  const prepared = (await prepareClaudeLaunch(f.options)).forRun(f.run);
  const names = ['HUD_CLAIM', 'HUD_RUN', 'HUD_LINK', 'HUD_MCP_PROFILE', 'HUD_CLAUDE_HOOK_CONFIG'];
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(names)}.map(key => [key, process.env[key] ?? null]))))`,
    ],
    { env: prepared.payload.env, cwd: f.cwd, encoding: 'utf8', timeout: 2000 }
  );
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), Object.fromEntries(names.map((key) => [key, null])));
  const { json: mcp } = decode(prepared, 'claude-mcp');
  assert.equal(mcp.mcpServers.selected_hud.env.HUD_CLAIM, f.run.claim);
  assert.equal(mcp.mcpServers.selected_hud.env.HUD_RUN, f.run.runId);
  assert.equal(mcp.mcpServers.selected_hud.env.HUD_LINK, f.run.linkId);
});
