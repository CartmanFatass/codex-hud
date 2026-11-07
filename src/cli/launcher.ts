import { foreground } from './compat.js';
export { foreground, codexCommand } from './compat.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { launchProfileDigest, resolveLaunchCommand, shellQuote, validateLaunchCommand } from '../core/capabilities.js';
import { executableIdentity } from '../core/launch/fingerprint.js';
import { snapshotBrief } from '../core/launch/brief.js';
import type { ClaudeProductionDependencies } from './claude-launch.js';
import type { LaunchCommand, LaunchProfile } from '../core/types/capabilities.js';
import type { HudIO } from './link-export.js';
import { CliError, nativeDelegateConfig, identifier, installationRoot, mcpModule, options } from './runtime.js';

export const CLAUDE_HELP = `Usage: hud claude [--profile NAME] [--resume SESSION] [--settings FILE]
       hud claude --profile NAME -- <executable> [ARG ...]
       hud claude --profile NAME --shell TEXT [--settings FILE]

Select a Claude profile from HUD_HOME/delegate.json (required when selection is ambiguous).
argv templates preserve argument bytes; explicit shell templates run through shellPath -ic.
The claude_pre_tool_use_v1 profile adds the synchronous HUD hook with --settings while preserving existing hooks.
Launches the configured local executable directly, without a client-version or machine qualification gate.
Native --resume follows the selected profile. hud codex [ARG ...] retains codex-hud compatibility.
`;

export function parseClaude(args: readonly string[]) {
  const split = args.indexOf('--');
  const flags = options(
    split < 0 ? args : args.slice(0, split),
    [],
    ['--profile', '--resume', '--settings', '--shell']
  );
  const argv = split < 0 ? undefined : [...args.slice(split + 1)];
  if (
    argv?.some((v) => v.includes('\0')) ||
    (argv && !validateLaunchCommand({ argv })) ||
    (argv && flags.has('--shell')) ||
    ((argv || flags.has('--shell')) && (!flags.has('--profile') || flags.has('--resume')))
  )
    throw new CliError('invalid_arguments');
  return {
    profile: flags.get('--profile') as string | undefined,
    resume: flags.has('--resume') ? identifier(String(flags.get('--resume'))) : undefined,
    settings: flags.get('--settings') as string | undefined,
    argv,
    shell: flags.get('--shell') as string | undefined,
  };
}

export function appendArguments(command: LaunchCommand, args: readonly string[]): LaunchCommand {
  return command.argv
    ? { argv: [...command.argv, ...args] }
    : {
        shellPath: command.shellPath,
        shell: command.shell + (args.length ? ' ' + args.map(shellQuote).join(' ') : ''),
      };
}

/** Preserve configured argv while placing native resume flags before prompt data. */
function nativeResumeTemplate(command: LaunchCommand): LaunchCommand {
  if (!command.argv) throw new CliError('native_resume_template_required', 4);
  const argv = [...command.argv];
  const terminator = argv.indexOf('--', 1);
  argv.splice(terminator < 0 ? argv.length : terminator, 0, '--resume', '{{sessionId}}');
  return { argv };
}

function settingsInput(command: LaunchCommand, explicit: string | undefined) {
  const sources: string[] = explicit === undefined ? [] : [explicit];
  if (!command.argv) return { command, sources };
  const argv = [command.argv[0]];
  for (let index = 1; index < command.argv.length; index++) {
    const arg = command.argv[index];
    if (arg === '--') {
      argv.push(...command.argv.slice(index));
      break;
    }
    if (arg === '--settings') {
      const source = command.argv[++index];
      if (!source) throw new CliError('invalid_settings');
      sources.push(source);
    } else if (arg.startsWith('--settings=')) sources.push(arg.slice('--settings='.length));
    else argv.push(arg);
  }
  return { command: { argv } as LaunchCommand, sources };
}
function injectSettings(command: LaunchCommand, file: string): LaunchCommand {
  if (!command.argv) throw new CliError('shell_settings_injection_unverified', 4);
  const terminator = command.argv.indexOf('--', 1);
  const at = terminator < 0 ? command.argv.length : terminator;
  return { argv: [...command.argv.slice(0, at), '--settings', file, ...command.argv.slice(at)] };
}

export async function claudeCommand(
  args: readonly string[],
  home: string,
  io: HudIO,
  trusted: {
    /** Deprecated historical test seam. Ordinary launch never invokes a qualification verifier. */
    verify?: (
      profile: LaunchProfile,
      command: LaunchCommand,
      facts: { settingsFingerprint: string }
    ) => Promise<boolean>;
    launch?: typeof foreground;
    production?: ClaudeProductionDependencies;
  } = {}
): Promise<number> {
  const parsed = parseClaude(args);
  const config = await nativeDelegateConfig(home);
  const candidates = config.profiles.filter(
    (p) => p.harness === 'claude' && (!parsed.profile || p.name === parsed.profile)
  );
  if (candidates.length !== 1) throw new CliError('claude_profile_required');
  const configuredProfile = candidates[0];
  let profile = configuredProfile;
  let template = parsed.resume ? (profile.resume ?? nativeResumeTemplate(profile.launch)) : profile.launch;
  if (parsed.argv) template = { argv: parsed.argv };
  if (parsed.shell !== undefined) {
    const shellPath = profile.launch.shellPath ?? io.env.SHELL;
    if (!shellPath || !isAbsolute(shellPath)) throw new CliError('explicit_shell_path_required');
    template = { shell: parsed.shell, shellPath };
  }
  if (!template || !validateLaunchCommand(template)) throw new CliError('invalid_native_launch_command', 4);
  if (parsed.argv || parsed.shell !== undefined) profile = { ...profile, launch: template };
  const values: Record<string, string> = { cwd: process.cwd(), sourceRoot: profile.source.root };
  if (parsed.resume) values.sessionId = parsed.resume;
  // Explicit overrides contain literal data; profile templates alone interpolate placeholders.
  const resolved = parsed.argv || parsed.shell !== undefined ? template : resolveLaunchCommand(template, values);
  if (profile.callSource && resolved.shell !== undefined) throw new CliError('shell_hook_target_unverified', 4);
  if (resolved.shell !== undefined && parsed.settings !== undefined)
    throw new CliError('shell_settings_injection_unverified', 4);
  const prepared = settingsInput(resolved, parsed.settings);
  if (prepared.sources.length > 1) throw new CliError('multiple_settings_sources');
  let settings: Record<string, unknown> = {};
  if (prepared.sources.length) {
    const source = prepared.sources[0];
    if (!source) throw new CliError('invalid_settings');
    const bytes = source.trimStart().startsWith('{')
      ? Buffer.from(source)
      : (await snapshotBrief(resolve(source))).bytes();
    if (bytes.length > 262_144) throw new CliError('settings_too_large');
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new CliError('invalid_settings');
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CliError('invalid_settings');
    settings = value as Record<string, unknown>;
  }
  const env: NodeJS.ProcessEnv = {
    ...io.env,
    ...profile.env,
    HUD_HOME: home,
    CLAUDE_CONFIG_DIR: profile.source.root,
    HUD_MCP_PROFILE: profile.name,
  };
  for (const key of ['HUD_CLAIM', 'HUD_RUN', 'HUD_LINK', 'HUD_MCP_REGISTRY_DIR', 'HUD_RUN_PORT_MODULE'])
    delete env[key];
  // Local executable discovery is necessary; version strings, release manifests,
  // machine fingerprints and tmux profiles are not admission requirements.
  const executable = await executableIdentity(resolved, env);
  if (!executable.resolved) throw new CliError('executable_unavailable', 4);
  delete env.HUD_CLAUDE_HOOK_CONFIG;
  let directory: string | undefined;
  try {
    let command: LaunchCommand = prepared.command.argv
      ? { argv: [executable.resolved, ...prepared.command.argv.slice(1)] }
      : prepared.command;
    if (profile.callSource || prepared.sources.length) directory = await mkdtemp(join(home, 'claude-launch-'));
    if (profile.callSource?.kind === 'claude_pre_tool_use_v1') {
      const record = await mcpModule('hook/record');
      const hook = {
        version: 1,
        implementation: record.IMPLEMENTATION,
        claudeExecutable: executable.resolved,
        sourceRoot: profile.source.root,
        directory,
        serverName: profile.mcpServerName,
        // MCP selects delegate.json's original profile; the effective override
        // does not replace the native ancestry/session proof at each tool call.
        profileFingerprint: launchProfileDigest(configuredProfile),
        clockTicksPerSecond: 100,
      };
      const hookFile = join(directory!, 'hook.json');
      await writeFile(hookFile, JSON.stringify(hook), { mode: 0o600, flag: 'wx' });
      env.HUD_CLAUDE_HOOK_CONFIG = hookFile;
      const hookCommand = [
        process.execPath,
        join(installationRoot(), 'packages/hud-mcp/bin/hud-claude-hook.mjs'),
        hookFile,
      ]
        .map(shellQuote)
        .join(' ');
      settings = record.makeHookSettings(hook, hookCommand, settings);
    }
    if (directory) {
      const settingsFile = join(directory, 'settings.json');
      await writeFile(settingsFile, JSON.stringify(settings), {
        mode: 0o600,
        flag: 'wx',
      });
      command = injectSettings(command, settingsFile);
    }
    return await (trusted.launch ?? trusted.production?.launch ?? foreground)(command, env);
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
