import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson, digest } from '../core/canonical.js';
import { makeSourceId } from '../core/identity.js';
import { launchProfileDigest, resolveLaunchCommand, shellQuote } from '../core/capabilities.js';
import { capabilityTemplate } from '../core/launch/fingerprint.js';
import type { CapabilityManifestV1, LaunchCommand, LaunchProfile } from '../core/types/capabilities.js';
import { foreground } from './compat.js';
import { CliError, installationRoot, mcpModule } from './runtime.js';
import {
  HUD_REVISION,
  discoverExecutable,
  matchesCapability,
  shippedManifest,
  type CapabilityExpectation,
} from './capability.js';
import { nativeFile, observeClaudeTmux, sameTmuxStartup, type NativeFile, type TmuxStartup } from './claude-tmux.js';
import {
  observeClaudeConfiguration,
  sameClaudeConfiguration,
  bookkeepingDependencies,
  type ClaudeConfiguration,
} from './claude-configuration.js';

interface SourceReceipt {
  root: string;
  dev: string;
  ino: string;
}
export interface ClaudeHelper {
  implementation: string;
  claudeVersion: string;
  script: string;
  scriptSha256: string;
  record: string;
  recordSha256: string;
}
type HookSettings = (config: object, command: string, settings: Record<string, unknown>) => Record<string, unknown>;
export interface ClaudeLaunchPlan {
  version: 2;
  profileDigest: string;
  source: SourceReceipt;
  cwd: string;
  argv: string[];
  commandTemplate: ReturnType<typeof capabilityTemplate>;
  settings: Record<string, unknown>;
  injectSettings: boolean;
  hook: null | {
    helper: ClaudeHelper;
    node: NativeFile;
    ledgerPath: string;
    serverName: string;
    configuredProfileDigest: string;
  };
  /** Original settings and slot description are separate: user bytes cannot become a slot. */
  settingsTemplate: Record<string, unknown>;
  executable: NativeFile & { version: string };
  environmentFingerprint: string;
  environmentReceipt: string;
  configuration: ClaudeConfiguration;
  runtime: Omit<TmuxStartup, 'receipt'>;
}

/** Pure, deterministic plan. Random private paths exist only during materialization. */
export function claudeLaunchPlan(input: {
  profile: LaunchProfile;
  configuredProfile: LaunchProfile;
  source: SourceReceipt;
  cwd: string;
  home: string;
  command: LaunchCommand;
  /** Only profile templates use declared substitutions. Explicit argv is literal. */
  template?: LaunchCommand;
  settings: Record<string, unknown>;
  hasSettings: boolean;
  executable: NativeFile & { version: string };
  startup: TmuxStartup;
  helper: ClaudeHelper | null;
  makeHookSettings: HookSettings | null;
  env: NodeJS.ProcessEnv;
  configuration: ClaudeConfiguration;
}): ClaudeLaunchPlan {
  if (!input.command.argv) throw new CliError('capability_unverified', 4);
  if (
    input.template &&
    (!input.template.argv ||
      input.template.argv.some((arg) =>
        [...arg.matchAll(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g)].some((match) => !['cwd', 'sourceRoot'].includes(match[1]))
      ))
  )
    throw new CliError('capability_unverified', 4);
  if (
    input.template &&
    !equal(
      resolveLaunchCommand(input.template, { cwd: input.cwd, sourceRoot: input.profile.source.root }),
      input.command
    )
  )
    throw new CliError('capability_unverified', 4);
  const commandTemplate: ReturnType<typeof capabilityTemplate> = input.template
    ? capabilityTemplate(input.template, { sourceRoot: input.profile.source.root })
    : { kind: 'argv', arguments: input.command.argv.map((value) => [{ kind: 'literal', value }]) };
  const { receipt: _receipt, ...runtime } = input.startup;
  const hook = input.helper
    ? {
        helper: input.helper,
        node: { path: runtime.node.path, file: runtime.node.file },
        ledgerPath: join(input.home, 'ledger.sqlite'),
        serverName: input.profile.mcpServerName,
        configuredProfileDigest: launchProfileDigest(input.configuredProfile),
      }
    : null;
  if (!!input.profile.callSource !== !!hook || (hook && !input.makeHookSettings))
    throw new CliError('capability_unverified', 4);
  const referenced = new Set([
    ...input.configuration.description.bookkeepingDependencies,
    ...bookkeepingDependencies(input.settings),
  ]);
  const environment = Object.fromEntries(
    Object.entries(input.env).filter(
      ([key, value]) =>
        value !== undefined &&
        !['TMUX', 'TMUX_PANE', 'HUD_CLAUDE_HOOK_CONFIG'].includes(key) &&
        (!['PWD', 'OLDPWD', '_'].includes(key) || referenced.has(key))
    )
  );
  return structuredClone({
    version: 2,
    profileDigest: launchProfileDigest(input.profile),
    source: input.source,
    cwd: input.cwd,
    argv: [input.executable.path, ...input.command.argv.slice(1)],
    commandTemplate,
    settings: input.settings,
    injectSettings: input.hasSettings || !!hook,
    hook,
    settingsTemplate: hook
      ? input.makeHookSettings!(
          { serverName: hook.serverName },
          '<HUD:typed-private-hook-command-slot:v1>',
          input.settings
        )
      : input.settings,
    executable: input.executable,
    // Values are never logged/exported; only the digest enters the capability.
    // The terminal locator is independently observed and kept in its private receipt.
    environmentFingerprint: digest(environment),
    environmentReceipt: environmentReceipt(input.env),
    configuration: input.configuration,
    runtime,
  });
}

export function claudeExpectation(plan: ClaudeLaunchPlan, hudRevision: string): CapabilityExpectation {
  // Reusable capability shape and per-launch identity receipts are distinct.
  // {{cwd}} is a typed template slot, never a text replacement in user argv.
  const {
    cwd: _cwd,
    argv: _argv,
    environmentReceipt: _environmentReceipt,
    source,
    configuration,
    ...description
  } = plan;
  return {
    key: {
      harness: 'claude',
      profileDigest: plan.profileDigest,
      hostKind: 'tmux',
      layout: 'pane',
      mode: 'visible',
      operation: 'launch',
    },
    sourceId: makeSourceId('claude', plan.source.root),
    profileFingerprint: digest({ ...description, sourceRoot: source.root, configuration: configuration.description }),
    topology: plan.runtime.topology,
    versions: {
      hudRevision,
      harness: plan.executable.version,
      mcpClient: plan.executable.version,
      host: plan.runtime.host.version,
      shell: plan.runtime.shell.version,
      node: plan.runtime.node.version,
      platform: plan.runtime.platform,
      kernel: plan.runtime.kernel,
    },
  };
}

/** Literal argv insertion only. User arguments/settings are never searched/replaced for slots. */
export function materializeClaudePlan(
  plan: ClaudeLaunchPlan,
  directory: string | null,
  makeHookSettings: HookSettings | null
) {
  const argv = [...plan.argv];
  let settings = structuredClone(plan.settings);
  let hook: object | null = null;
  if (plan.injectSettings && !directory) throw new Error('private_launch_directory_required');
  if (plan.hook) {
    if (!makeHookSettings) throw new Error('hook_helper_required');
    hook = {
      version: 1,
      implementation: plan.hook.helper.implementation,
      claudeVersion: plan.hook.helper.claudeVersion,
      claudeExecutable: plan.executable.path,
      sourceRoot: plan.source.root,
      ledgerPath: plan.hook.ledgerPath,
      directory,
      serverName: plan.hook.serverName,
      profileFingerprint: plan.hook.configuredProfileDigest,
      clockTicksPerSecond: 100,
    };
    const command = [plan.hook.node.path, plan.hook.helper.script, join(directory!, 'hook.json')]
      .map(shellQuote)
      .join(' ');
    settings = makeHookSettings(hook, command, settings);
  }
  if (plan.injectSettings) {
    const terminator = argv.indexOf('--', 1);
    argv.splice(terminator < 0 ? argv.length : terminator, 0, '--settings', join(directory!, 'settings.json'));
  }
  return { command: { argv } as LaunchCommand, settings, hook };
}

function fileHash(path: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size > 262144n) return null;
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, length);
      if (!count) break;
      length += count;
    }
    const after = fstatSync(fd, { bigint: true });
    if (
      BigInt(length) !== before.size ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      return null;
    return createHash('sha256').update(bytes.subarray(0, length)).digest('hex');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
async function sourceReceipt(path: string): Promise<SourceReceipt | null> {
  try {
    const root = await realpath(path);
    const info = await stat(root, { bigint: true });
    return info.isDirectory() ? { root, dev: String(info.dev), ino: String(info.ino) } : null;
  } catch {
    return null;
  }
}
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function environmentReceipt(env: NodeJS.ProcessEnv): string {
  return digest(
    Object.fromEntries(
      Object.entries(env).filter(([key, value]) => value !== undefined && key !== 'HUD_CLAUDE_HOOK_CONFIG')
    )
  );
}

export interface ClaudeProductionDependencies {
  /** Trusted composition/test seams. There is no CLI, env or config selector. */
  observe?: typeof observeClaudeTmux;
  configuration?: typeof observeClaudeConfiguration;
  manifest?: () => CapabilityManifestV1 | null;
  hudRevision?: string;
  launch?: typeof foreground;
}

/** Historical tmux qualification experiment, not the ordinary hud claude entry.
 * Retained for old evidence/tests only. Native launch lives in launcher.ts. */
export async function launchClaudeInTmux(
  input: {
    profile: LaunchProfile;
    configuredProfile: LaunchProfile;
    command: LaunchCommand;
    template?: LaunchCommand;
    settings: Record<string, unknown>;
    hasSettings: boolean;
    resume: boolean;
    home: string;
    env: NodeJS.ProcessEnv;
  },
  dependencies: ClaudeProductionDependencies = {}
): Promise<number> {
  const reject = () => {
    throw new CliError('capability_unverified', 4);
  };
  if (
    process.platform !== 'linux' ||
    input.resume ||
    !input.command.argv ||
    input.profile.harness !== 'claude' ||
    input.profile.host.kind !== 'tmux' ||
    input.profile.host.layout !== 'pane'
  )
    return reject();
  const terminator = input.command.argv.indexOf('--', 1);
  const flags = input.command.argv.slice(1, terminator < 0 ? undefined : terminator);
  if (flags.some((arg) => /^(?:--(?:print|resume|continue|fork-session)(?:=|$)|-[pcr])/.test(arg))) return reject();
  // Dynamic loader hooks can substitute the measured native executable at dispatch.
  if (
    Object.keys(input.env).some(
      (key) => /^(?:LD_|DYLD_|NODE_OPTIONS$|NODE_PATH$|BASH_ENV$|ENV$)/.test(key) && input.env[key]
    )
  )
    return reject();
  const observe = dependencies.observe ?? observeClaudeTmux;
  const observed = await observe(input.env);
  const startup = observed ? structuredClone(observed) : null;
  if (!startup) return reject();
  const source = await sourceReceipt(input.profile.source.root);
  const discovered = await discoverExecutable(input.command, input.env);
  const native = discovered.resolved && nativeFile(discovered.resolved);
  if (!startup || !source || !native || !discovered.version) return reject();
  const executable = { ...native, version: discovered.version };
  const env: NodeJS.ProcessEnv = { ...input.env, CLAUDE_CONFIG_DIR: source.root };
  delete env.HUD_CLAUDE_HOOK_CONFIG;
  let helper: ClaudeHelper | null = null;
  let makeHookSettings: HookSettings | null = null;
  if (input.profile.callSource) {
    const record = await mcpModule('hook/record');
    const script = join(installationRoot(), 'packages/hud-mcp/bin/hud-claude-hook.mjs');
    const recordFile = join(installationRoot(), 'packages/hud-mcp/dist/packages/hud-mcp/src/hook/record.js');
    const scriptSha256 = fileHash(script),
      recordSha256 = fileHash(recordFile);
    if (!scriptSha256 || !recordSha256 || executable.version !== record.CLAUDE_VERSION) return reject();
    helper = {
      implementation: record.IMPLEMENTATION,
      claudeVersion: record.CLAUDE_VERSION,
      script,
      scriptSha256,
      record: recordFile,
      recordSha256,
    };
    makeHookSettings = record.makeHookSettings;
  }
  const cwd = await realpath(process.cwd());
  const configurationRequest = {
    sourceRoot: source.root,
    cwd,
    argv: input.command.argv,
    env,
    version: executable.version,
    kernel: startup.kernel,
    settings: input.settings,
  };
  const observeConfiguration = dependencies.configuration ?? observeClaudeConfiguration;
  const configuration = observeConfiguration(configurationRequest).observation;
  if (!configuration) return reject();
  const plan = claudeLaunchPlan({
    ...input,
    source,
    cwd,
    executable,
    startup,
    helper,
    makeHookSettings,
    env,
    configuration,
  });
  const actual = claudeExpectation(plan, dependencies.hudRevision ?? HUD_REVISION);
  if (!matchesCapability((dependencies.manifest ?? shippedManifest)(), actual)) return reject();
  let directory: string | undefined;
  try {
    if (plan.injectSettings) directory = await mkdtemp(join(input.home, 'claude-launch-'));
    const prepared = materializeClaudePlan(plan, directory ?? null, makeHookSettings);
    if (prepared.hook) {
      env.HUD_CLAUDE_HOOK_CONFIG = join(directory!, 'hook.json');
      await writeFile(env.HUD_CLAUDE_HOOK_CONFIG, JSON.stringify(prepared.hook), { mode: 0o600, flag: 'wx' });
    }
    if (plan.injectSettings)
      await writeFile(join(directory!, 'settings.json'), JSON.stringify(prepared.settings), {
        mode: 0o600,
        flag: 'wx',
      });
    // Compare the original identities after all asynchronous preparation, before
    // the single dispatch. No fallback, re-plan or retry is allowed on mismatch.
    const currentExecutable = await discoverExecutable({ argv: [executable.path] }, env);
    const current = await observe(input.env);
    const currentCwd = await realpath(process.cwd());
    const currentEnv = { ...input.env, CLAUDE_CONFIG_DIR: source.root };
    if (
      !sameTmuxStartup(startup, current) ||
      !equal(await sourceReceipt(input.profile.source.root), source) ||
      currentCwd !== cwd ||
      environmentReceipt(currentEnv) !== plan.environmentReceipt ||
      !equal(plan.argv, [executable.path, ...input.command.argv.slice(1)]) ||
      launchProfileDigest(input.profile) !== plan.profileDigest ||
      !sameClaudeConfiguration(
        plan.configuration,
        observeConfiguration({
          ...configurationRequest,
          cwd: currentCwd,
          env: currentEnv,
          argv: input.command.argv,
          settings: input.settings,
        }).observation
      ) ||
      currentExecutable.version !== executable.version ||
      !equal(nativeFile(executable.path), native) ||
      (helper && (fileHash(helper.script) !== helper.scriptSha256 || fileHash(helper.record) !== helper.recordSha256))
    )
      return reject();
    return await (dependencies.launch ?? foreground)(prepared.command, env);
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
