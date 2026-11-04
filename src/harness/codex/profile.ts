import type { CallBudget } from '../../ledger/call-budget.js';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { join } from 'node:path';
import * as TOML from '@iarna/toml';
import {
  codexHudOverrides,
  injectCodexHudEnv,
  launchProfileDigest,
  launchProfileUsable,
  resolveLaunchCommand,
  shellQuote,
} from '../../core/capabilities.js';
import { digest } from '../../core/canonical.js';
import { makeSourceId } from '../../core/identity.js';
import { freezeRetirementPolicy, type PolicyRunLaunchInput } from '../../core/run/retirement-policy.js';
import { codexClaimArgs, launchDigest, type StartOptions } from '../../core/run/control.js';
import { snapshotBrief, type BriefSnapshot } from '../../core/launch/brief.js';
import { formatLaunchMessage } from '../../core/launch/message.js';
import type { CodexCapabilityRequest } from '../../core/launch/capability.js';
import { capabilityTemplate, executableIdentity, type ExecutableIdentity } from '../../core/launch/fingerprint.js';
import type { CodexConfig, HudLaunchEnv, LaunchCommand, LaunchProfile } from '../../core/types/capabilities.js';
import type { RunMode } from '../../core/types/execution.js';
import type { RunLaunchInput } from '../../core/types/supervision.js';

export const MAX_PROMPT_BYTES = 65_536;
/** Leaves room for the private ticket in hud-run's 1 MiB protected JSON input. */
export const MAX_PREPARED_PAYLOAD_BYTES = 1_040_000;
export type PreparedStartPayload = Omit<StartOptions, 'ticket' | 'brief' | 'identifyHarness'> & {
  briefBase64: string;
};
export interface PreparedRunLaunch {
  readonly input: RunLaunchInput;
  readonly launchDigest: string;
  readonly payload: PreparedStartPayload;
  readonly deliveredSha256: string;
}
export interface CodexRunValues {
  runId: string;
  linkId: string;
  claim: string;
  hudHome: string;
  parent?: StartOptions['parent'];
}
export interface CodexLaunchPreparation {
  readonly profileDigest: string;
  readonly sourceId: string;
  readonly cwd: string;
  readonly brief: BriefSnapshot;
  readonly promptHash: string;
  readonly role: string | null;
  readonly model: string | null;
  readonly effort: string | null;
  /** Named-server transport/settings hash, excluding overwritten per-run leaves. */
  readonly configFingerprint: string;
  /** Resolved command fingerprint before random run credentials; suitable for params_digest. */
  readonly commandFingerprint: string;
  capabilityRequest(resumeFrom?: RunMode): CodexCapabilityRequest;
  /** Pure synchronous composition: safe to call while constructing the atomic intent. */
  forRun(values: CodexRunValues): PreparedRunLaunch;
}

export interface PrepareCodexLaunchOptions {
  budget?: CallBudget;
  executableIdentity?: ExecutableIdentity;
  profile: LaunchProfile;
  operation: 'spawn' | 'resume';
  mode: RunMode;
  cwd: string;
  briefPath: string;
  prompt?: string;
  role?: string;
  /** Frozen wake recovery bound, supplied by the trusted config owner. */
  retireRecoveryMs?: number;
  model?: string;
  effort?: string;
  resumeSessionId?: string;
  env?: NodeJS.ProcessEnv;
  /** Optional already-read user configuration for exact stdio-server preflight; never modified. */
  codexConfig?: CodexConfig;
}

const text = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && !value.includes('\0');
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const maxText = (value: string, bytes: number, reason: string) => {
  if (value.includes('\0') || Buffer.byteLength(value, 'utf8') > bytes) throw new Error(reason);
};
function claimArgs(server: string, env: HudLaunchEnv): string[] {
  const encoded = codexHudOverrides(server, env);
  // B3a accepts bare server keys only. Keep its argv for that production path,
  // using the shared TOML encoder where JSON differs (for example U+007F).
  const args = codexClaimArgs(server, env);
  return args.some((arg, index) => arg !== encoded[index]) ? encoded : args;
}

/**
 * Capture immutable input before acceptance. This performs no capability promotion,
 * transaction, Git operation or dispatch. Check the verifier only for a new intent,
 * after authorized idempotency replay has been considered.
 */
export async function prepareCodexLaunch(options: PrepareCodexLaunchOptions): Promise<CodexLaunchPreparation> {
  const { operation, mode, budget } = options;
  budget?.check();
  const profile = structuredClone(options.profile);
  if (profile.harness !== 'codex') throw new Error('unsupported_harness');
  if (!isAbsolute(options.cwd)) throw new Error('absolute_launch_cwd_required');
  if (!isAbsolute(profile.source.root)) throw new Error('invalid_codex_source');
  const inherited = { ...(options.env ?? process.env) };
  const cwd = await fs.realpath(options.cwd);
  budget?.check();
  const root = await fs.realpath(profile.source.root);
  budget?.check();
  const brief = await snapshotBrief(options.briefPath, undefined, budget);
  budget?.check();
  const cwdStat = await fs.stat(cwd);
  budget?.check();
  const rootStat = await fs.stat(root);
  budget?.check();
  if (!cwdStat.isDirectory() || !rootStat.isDirectory()) throw new Error('invalid_launch_directory');
  budget?.check();
  const effectiveHome = profile.env.CODEX_HOME ?? inherited.CODEX_HOME;
  if (effectiveHome && (await fs.realpath(effectiveHome)) !== root) throw new Error('codex_source_mismatch');
  budget?.check();
  profile.source.root = root;
  const sourceId = makeSourceId('codex', root);
  const sentinel = { HUD_CLAIM: 'preflight', HUD_RUN: 'preflight', HUD_LINK: 'preflight', HUD_HOME: cwd };
  claimArgs(profile.mcpServerName, sentinel);
  let codexConfig = options.codexConfig;
  if (!codexConfig) {
    try {
      const configBytes = await snapshotBrief(join(root, 'config.toml'), undefined, budget);
      codexConfig = TOML.parse(configBytes.bytes().toString('utf8')) as unknown as CodexConfig;
    } catch (error) {
      budget?.check();
      throw new Error('hud_stdio_server_unavailable');
    }
  }
  budget?.check();
  if (codexConfig.mcp_servers?.[profile.mcpServerName]?.enabled === false)
    throw new Error('hud_stdio_server_unavailable');
  injectCodexHudEnv(codexConfig, profile.mcpServerName, sentinel);
  const server = codexConfig.mcp_servers[profile.mcpServerName];
  const configFingerprint = digest({
    serverName: profile.mcpServerName,
    server: {
      ...server,
      args: server.args ?? [],
      enabled: server.enabled ?? true,
      tool_timeout_sec: server.tool_timeout_sec ?? null,
      // Only overwritten per-run leaves are irrelevant to preserved server
      // behavior. Hash values as well as keys (e.g. HUD_MCP_PROFILE/NODE_OPTIONS);
      // no plaintext environment value is persisted in the ledger/cell request.
      env: Object.fromEntries(
        Object.entries(server.env ?? {}).filter(
          ([key]) => !['HUD_CLAIM', 'HUD_RUN', 'HUD_LINK', 'HUD_HOME'].includes(key)
        )
      ),
    },
  });
  const selected = launchProfileUsable(profile, operation, mode);
  // managedShellVerified is only a hint. The capability verifier remains mandatory
  // for new accepted operations; the preparation itself cannot grant execution.
  if (!selected.command && selected.reason !== 'capability_unverified') throw new Error(selected.reason!);
  const template =
    operation === 'resume'
      ? mode === 'headless'
        ? profile.resumeHeadless
        : profile.resume
      : mode === 'headless'
        ? profile.headless
        : profile.launch;
  if (!template) throw new Error('invalid_launch_template');
  if (operation === 'resume' && !text(options.resumeSessionId)) throw new Error('resume_session_required');
  if (operation === 'spawn' && options.resumeSessionId !== undefined) throw new Error('unexpected_resume_session');
  const role = options.role ?? null;
  const mapping = role !== null && profile.roles && Object.hasOwn(profile.roles, role) ? profile.roles[role] : null;
  const model = options.model ?? mapping?.model ?? (text(codexConfig.model) ? codexConfig.model : null);
  const effort =
    options.effort ??
    mapping?.effort ??
    (text(codexConfig.model_reasoning_effort) ? codexConfig.model_reasoning_effort : null);
  if (role !== null && model === null) throw new Error('role_model_unconfigured');
  for (const value of [role, model, effort])
    if (value !== null && !text(value)) throw new Error('invalid_role_options');
  const values: Record<string, string> = { cwd, sourceRoot: root };
  if (model !== null) values.model = model;
  if (effort !== null) values.effort = effort;
  if (options.resumeSessionId !== undefined) values.sessionId = options.resumeSessionId;
  const resolved = resolveLaunchCommand(template, values);
  const templateText = JSON.stringify(template);
  const settingArgs = [
    ...(model !== null && !templateText.includes('{{model}}') ? ['-c', `model=${JSON.stringify(model)}`] : []),
    ...(effort !== null && !templateText.includes('{{effort}}')
      ? ['-c', `model_reasoning_effort=${JSON.stringify(effort)}`]
      : []),
  ];
  const appendSettings = (command: LaunchCommand, args: string[]): LaunchCommand =>
    command.argv
      ? { argv: [command.argv[0], ...args, ...command.argv.slice(1)] }
      : {
          shell: `${command.shell}${args.length ? ' ' + args.map(shellQuote).join(' ') : ''}`,
          shellPath: command.shellPath,
        };
  const command = appendSettings(resolved, settingArgs);
  const executable = await executableIdentity(
    command,
    { ...inherited, ...profile.env },
    options.executableIdentity,
    budget
  );
  budget?.check();
  const capabilityEnv = Object.fromEntries(
    Object.entries(profile.env).filter(([key]) => !['HUD_CLAIM', 'HUD_RUN', 'HUD_LINK', 'HUD_HOME'].includes(key))
  );
  const capabilityProfileDigest = launchProfileDigest({ ...profile, env: capabilityEnv });
  const capabilityFingerprint = digest({
    profileDigest: capabilityProfileDigest,
    template: capabilityTemplate(template, {
      sourceRoot: root,
      ...(model !== null ? { model } : {}),
      ...(effort !== null ? { effort } : {}),
    }),
    executable,
    model,
    effort,
    settingArgs,
    configFingerprint,
    serverName: profile.mcpServerName,
    host: profile.host,
    mode,
    operation,
    perRunEnv: ['HUD_CLAIM', 'HUD_RUN', 'HUD_LINK', 'HUD_HOME'].map((name) => ({ kind: 'run', name })),
    input: { brief: { kind: 'run', name: 'brief' }, prompt: { kind: 'run', name: 'prompt' } },
  });
  const profileDigest = launchProfileDigest(profile);
  const prompt = options.prompt ?? '';
  maxText(prompt, MAX_PROMPT_BYTES, 'prompt_too_large');
  const env: NodeJS.ProcessEnv = { ...inherited, ...profile.env, CODEX_HOME: root };
  delete env.HUD_CLAIM;
  delete env.HUD_RUN;
  delete env.HUD_LINK;
  const commandFingerprint = digest({ command, configFingerprint });
  const preparation: CodexLaunchPreparation = {
    profileDigest,
    sourceId,
    cwd,
    brief,
    promptHash: sha256(prompt),
    role,
    model,
    effort,
    configFingerprint,
    commandFingerprint,
    capabilityRequest(resumeFrom) {
      if (operation === 'resume' && resumeFrom !== 'visible' && resumeFrom !== 'headless')
        throw new Error('resume_from_required');
      return {
        executableIdentity: { path: executable.resolved, version: executable.version },
        key: {
          harness: 'codex',
          profileDigest: capabilityProfileDigest,
          hostKind: profile.host.kind,
          layout: profile.host.layout,
          mode,
          ...(operation === 'resume'
            ? { operation: 'resume' as const, resumeFrom: resumeFrom! }
            : { operation: 'spawn' as const }),
        },
        sourceId,
        profileFingerprint: capabilityFingerprint,
      };
    },
    forRun(run) {
      if (mode !== 'headless') throw new Error('visible_launch_not_in_this_build');
      if (profile.host.kind !== 'none' || profile.host.layout !== 'none') throw new Error('unsupported_headless_host');
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(run.runId) || !text(run.linkId) || !text(run.claim))
        throw new Error('invalid_launch_identity');
      maxText(run.claim, 4096, 'invalid_launch_claim');
      const hudEnv = { HUD_CLAIM: run.claim, HUD_RUN: run.runId, HUD_LINK: run.linkId, HUD_HOME: run.hudHome };
      const overrides = claimArgs(profile.mcpServerName, hudEnv);
      const launch = appendSettings(command, overrides);
      const instructions =
        `\n\n[HUD delegation]\nCall delegate_whoami before doing this task, then call delegate_report with runId ` +
        `${JSON.stringify(run.runId)} when reporting the result.\n`;
      const fallback = profile.claimTransport === 'launch_message' ? formatLaunchMessage(run) + '\n' : '';
      const delivery = Buffer.concat([
        brief.bytes(),
        Buffer.from((prompt ? '\n\n' + prompt : '') + instructions + fallback, 'utf8'),
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
        retire: freezeRetirementPolicy(profile.retire, role ?? 'implementer', 10_000, options.retireRecoveryMs),
      };
      const payload: PreparedStartPayload = {
        input,
        briefBase64: delivery.toString('base64'),
        env: { ...env, HUD_HOME: run.hudHome },
        ...(launch.shell !== undefined ? { managedShellVerified: profile.managedShellVerified } : {}),
        ...(run.parent ? { parent: structuredClone(run.parent) } : {}),
      };
      if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > MAX_PREPARED_PAYLOAD_BYTES)
        throw new Error('protected_launch_input_too_large');
      return { input, launchDigest: launchDigest(input), payload, deliveredSha256: sha256(delivery) };
    },
  };
  budget?.check();
  return Object.freeze(preparation);
}
