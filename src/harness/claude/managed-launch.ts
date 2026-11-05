import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { launchProfileDigest, shellQuote } from '../../core/capabilities.js';
import { digest } from '../../core/canonical.js';
import { makeSourceId } from '../../core/identity.js';
import { freezeRetirementPolicy, type PolicyRunLaunchInput } from '../../core/run/retirement-policy.js';
import { launchDigest } from '../../core/run/control.js';
import { snapshotBrief } from '../../core/launch/brief.js';
import { capabilityTemplate, executableIdentity } from '../../core/launch/fingerprint.js';
import type {
  ManagedLaunchPreparation,
  PrepareManagedLaunchOptions,
  PreparedStartPayload,
} from '../../core/launch/types.js';
import { installationRoot, mcpModule } from '../../cli/runtime.js';
import { claudeManagedConfiguration, CLAUDE_RUN_ENV } from './managed-configuration.js';
import { CLAUDE_MANAGED_VERSION, claudeManagedCommand } from './managed-command.js';
import { claudeManagedInstructions, claudeManagedRole } from './managed-role.js';
import { encodeLaunchArtifact, launchArtifactPath, validateLaunchArtifacts } from '../../core/run/launch-artifacts.js';

const MAX_PROMPT_BYTES = 65536;
const MAX_PREPARED_PAYLOAD_BYTES = 1040000;
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && !value.includes('\0');

/** Production composition, not capability promotion. This function snapshots inputs
 * only; the accepted-intent ticket winner owns artifact writes and process launch.
 * The first lane's discovery coverage is partial, so shipped verification refuses it.
 */
export async function prepareClaudeLaunch(options: PrepareManagedLaunchOptions): Promise<ManagedLaunchPreparation> {
  const { operation, retireRecoveryMs } = options;
  const profile = structuredClone(options.profile);
  if (profile.harness !== 'claude') throw new Error('unsupported_harness');
  if (options.mode !== 'headless') throw new Error('visible_launch_not_in_this_build');
  if (profile.host.kind !== 'none' || profile.host.layout !== 'none') throw new Error('unsupported_headless_host');
  if (profile.callSource?.kind !== 'claude_pre_tool_use_v1') throw new Error('claude_hook_profile_required');
  if (profile.claimTransport !== 'config_env') throw new Error('claude_config_env_required');
  if (!isAbsolute(options.cwd) || !isAbsolute(profile.source.root)) throw new Error('absolute_launch_cwd_required');
  const inherited = { ...(options.env ?? process.env) };
  const [cwd, root, brief] = await Promise.all([
    fs.realpath(options.cwd),
    fs.realpath(profile.source.root),
    snapshotBrief(options.briefPath),
  ]);
  if (!(await fs.stat(cwd)).isDirectory() || !(await fs.stat(root)).isDirectory())
    throw new Error('invalid_launch_directory');
  const selected = profile.env.CLAUDE_CONFIG_DIR ?? inherited.CLAUDE_CONFIG_DIR;
  if (selected !== undefined && (!isAbsolute(selected) || (await fs.realpath(selected)) !== root))
    throw new Error('claude_source_mismatch');
  const configuredProfileDigest = launchProfileDigest(profile);
  profile.source.root = root;
  const sourceId = makeSourceId('claude', root);
  const template = operation === 'spawn' ? profile.headless : profile.resumeHeadless;
  if (!template) throw new Error('invalid_launch_template');
  const role = claudeManagedRole(profile, options);
  const command = claudeManagedCommand({
    template,
    operation,
    cwd,
    sourceRoot: root,
    model: role.model,
    effort: role.effort,
    resumeSessionId: options.resumeSessionId,
  });
  const env: NodeJS.ProcessEnv = { ...inherited, ...profile.env, CLAUDE_CONFIG_DIR: root };
  if (env.CLAUDE_CODE_SIMPLE && env.CLAUDE_CODE_SIMPLE !== '0') throw new Error('claude_hook_disabled');
  // Ancestor claims and unrelated harness identity markers must not become target authority.
  for (const key of Object.keys(env)) if (key.startsWith('HUD_')) delete env[key];
  const executable = await executableIdentity(command, env, options.executableIdentity);
  if (!executable.resolved || executable.version !== CLAUDE_MANAGED_VERSION)
    throw new Error('claude_executable_unverified');
  command.argv[0] = executable.resolved;
  const configuration = await claudeManagedConfiguration(root, cwd, profile.mcpServerName);
  const record = await mcpModule('hook/record');
  if (record.CLAUDE_VERSION !== CLAUDE_MANAGED_VERSION || record.IMPLEMENTATION !== 'claude-hook-2')
    throw new Error('claude_hook_helper_unverified');
  const installation = installationRoot();
  const script = join(installation, 'packages/hud-mcp/bin/hud-claude-hook.mjs');
  const helperFiles = [
    script,
    ...['command', 'record', 'process', 'resolve'].map((name) =>
      join(installation, 'packages/hud-mcp/dist/packages/hud-mcp/src/hook', `${name}.js`)
    ),
  ];
  const helperSnapshots = await Promise.all(helperFiles.map((file) => snapshotBrief(file)));
  const node = await executableIdentity({ argv: [process.execPath] }, env, {
    path: process.execPath,
    version: process.versions.node,
  });
  if (!node.resolved) throw new Error('claude_hook_helper_unverified');
  const helper = {
    implementation: record.IMPLEMENTATION,
    claudeVersion: record.CLAUDE_VERSION,
    files: helperSnapshots.map((file) => ({ path: file.path, sha256: file.sha256 })),
    node,
  };
  const configFingerprint = digest({
    configuration: configuration.fingerprint,
    coverage: configuration.coverage,
    helper,
    serverName: profile.mcpServerName,
    configuredProfileDigest,
  });
  const capabilityEnv = Object.fromEntries(Object.entries(profile.env).filter(([key]) => !key.startsWith('HUD_')));
  const capabilityProfileDigest = launchProfileDigest({ ...profile, env: capabilityEnv });
  const capabilityFingerprint = digest({
    schema: 'claude-managed-print-v1',
    profileDigest: capabilityProfileDigest,
    template: capabilityTemplate(template, {
      sourceRoot: root,
      ...(role.model !== null ? { model: role.model } : {}),
      ...(role.effort !== null ? { effort: role.effort } : {}),
    }),
    executable,
    configFingerprint,
    role,
    host: profile.host,
    mode: options.mode,
    operation,
    environment: digest(env),
    perRunEnv: CLAUDE_RUN_ENV.map((name) => ({ kind: 'run', name })),
    stdin: { brief: { kind: 'run', name: 'brief' }, prompt: { kind: 'run', name: 'prompt' } },
  });
  const profileDigest = launchProfileDigest(profile);
  const prompt = options.prompt ?? '';
  if (prompt.includes('\0') || Buffer.byteLength(prompt) > MAX_PROMPT_BYTES) throw new Error('prompt_too_large');
  const preparation: ManagedLaunchPreparation = {
    harness: 'claude',
    sourceRoot: root,
    sourceId,
    profileDigest,
    cwd,
    brief,
    promptHash: hash(prompt),
    ...role,
    configFingerprint,
    commandFingerprint: digest({ command, configFingerprint }),
    capabilityRequest(resumeFrom) {
      if (operation === 'resume' && resumeFrom !== 'visible' && resumeFrom !== 'headless')
        throw new Error('resume_from_required');
      return {
        executableIdentity: { path: executable.resolved, version: executable.version },
        key: {
          harness: 'claude',
          profileDigest: capabilityProfileDigest,
          hostKind: 'none',
          layout: 'none',
          mode: 'headless',
          ...(operation === 'resume'
            ? { operation: 'resume' as const, resumeFrom: resumeFrom! }
            : { operation: 'spawn' as const }),
        },
        sourceId,
        profileFingerprint: capabilityFingerprint,
        configurationCoverage: configuration.coverage,
      };
    },
    forRun(run) {
      if (
        !/^[A-Za-z0-9_-]{1,128}$/.test(run.runId) ||
        !text(run.linkId) ||
        !text(run.claim) ||
        Buffer.byteLength(run.claim) > 4096
      )
        throw new Error('invalid_launch_identity');
      const directory = join(run.hudHome, 'runs', run.runId);
      const hook = {
        version: 1,
        implementation: record.IMPLEMENTATION,
        claudeVersion: record.CLAUDE_VERSION,
        claudeExecutable: executable.resolved,
        sourceRoot: root,
        ledgerPath: join(run.hudHome, 'ledger.sqlite'),
        directory,
        serverName: profile.mcpServerName,
        profileFingerprint: configuredProfileDigest,
        clockTicksPerSecond: 100,
      };
      const hookArtifact = encodeLaunchArtifact('claude-hook', Buffer.from(JSON.stringify(hook)));
      const hookPath = launchArtifactPath(run.hudHome, run.runId, hookArtifact.name);
      const hookCommand = [node.resolved!, script, hookPath].map(shellQuote).join(' ');
      const settings = record.makeHookSettings(hook, hookCommand, {});
      const settingsArtifact = encodeLaunchArtifact('claude-settings', Buffer.from(JSON.stringify(settings)));
      const hudEnv = {
        HUD_CLAIM: run.claim,
        HUD_RUN: run.runId,
        HUD_LINK: run.linkId,
        HUD_HOME: run.hudHome,
        HUD_MCP_PROFILE: profile.name,
        HUD_CLAUDE_HOOK_CONFIG: hookPath,
      };
      const mcp = {
        mcpServers: {
          [profile.mcpServerName]: { ...configuration.server, env: { ...configuration.server.env, ...hudEnv } },
        },
      };
      const mcpArtifact = encodeLaunchArtifact('claude-mcp', Buffer.from(JSON.stringify(mcp)));
      const launch = {
        argv: [
          ...command.argv,
          '--settings',
          launchArtifactPath(run.hudHome, run.runId, settingsArtifact.name),
          '--mcp-config',
          launchArtifactPath(run.hudHome, run.runId, mcpArtifact.name),
        ],
      };
      const delivery = Buffer.concat([
        brief.bytes(),
        Buffer.from((prompt ? '\n\n' + prompt : '') + claudeManagedInstructions(run.runId)),
      ]);
      const input: PolicyRunLaunchInput = {
        runId: run.runId,
        mode: 'headless',
        launch,
        cwd,
        sourceId,
        profileDigest,
        stdin: 'brief',
        orphanPolicy: profile.orphan_policy,
        retire: freezeRetirementPolicy(profile.retire, role.role ?? 'implementer', 10000, retireRecoveryMs),
      };
      const payload: PreparedStartPayload = {
        input,
        briefBase64: delivery.toString('base64'),
        // Only the selected MCP server receives run authority. Unrelated default
        // MCP servers and tool children inherit no claim, run, link or hook selector.
        env: { ...env, HUD_HOME: run.hudHome },
        launchArtifacts: [hookArtifact, settingsArtifact, mcpArtifact],
        ...(run.parent ? { parent: structuredClone(run.parent) } : {}),
      };
      validateLaunchArtifacts(payload.launchArtifacts, run.hudHome, run.runId, launch);
      if (Buffer.byteLength(JSON.stringify(payload)) > MAX_PREPARED_PAYLOAD_BYTES)
        throw new Error('protected_launch_input_too_large');
      return { input, payload, launchDigest: launchDigest(input), deliveredSha256: hash(delivery) };
    },
  };
  return Object.freeze(preparation);
}
