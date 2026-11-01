import { digest, isCanonicalAbsolutePath } from './canonical.js';
import type {
  CapabilityCell,
  CapabilityKey,
  CapabilitySupport,
  CodexConfig,
  HostKind,
  HostSelectionPlan,
  HudLaunchEnv,
  LaunchCommand,
  LaunchProfile,
} from './types/capabilities.js';

const CHECKS = ['identity', 'input', 'scope', 'receipt', 'singleSubmission'] as const;
const HUD_KEYS = ['HUD_CLAIM', 'HUD_RUN', 'HUD_LINK', 'HUD_HOME'] as const;
const VERSION_KEYS = ['hudRevision', 'harness', 'host', 'shell', 'node', 'platform', 'kernel', 'mcpClient'] as const;

export function capabilityKey(key: CapabilityKey): string {
  return JSON.stringify([
    key.harness,
    key.profileDigest,
    key.hostKind,
    key.layout,
    key.mode,
    key.operation,
    key.operation === 'resume' ? key.resumeFrom : null,
  ]);
}

/** Evidence is necessary, and must cover this full product cell, before support is claimed. */
export function capabilitySupport(cell: CapabilityCell | null): CapabilitySupport {
  if (!cell) return 'unverified';
  if (cell.support === 'unsupported') return 'unsupported';
  const evidence = cell.evidence;
  if (
    cell.support !== 'verified' ||
    !cell.versions ||
    VERSION_KEYS.some((key) => typeof cell.versions![key] !== 'string' || !cell.versions![key].trim()) ||
    !cell.topology ||
    !cell.sourceId ||
    !/^[a-f0-9]{64}$/.test(cell.sourceId) ||
    !cell.profileFingerprint ||
    !/^[a-f0-9]{64}$/.test(cell.profileFingerprint) ||
    !/^[a-f0-9]{64}$/.test(cell.key.profileDigest) ||
    !evidence ||
    evidence.scope !== 'product' ||
    evidence.reviewStatus !== 'accepted' ||
    !evidence.script ||
    !evidence.report ||
    !/^[a-f0-9]{64}$/.test(evidence.reportSha256) ||
    !/^[a-f0-9]{64}$/.test(evidence.artifactDigest) ||
    !Number.isFinite(evidence.observedAt) ||
    evidence.observedAt < 0 ||
    cell.incomplete.length > 0 ||
    CHECKS.some((check) => cell.results[check] !== 'passed')
  ) {
    return 'unverified';
  }
  if (
    (cell.key.hostKind === 'none' && (cell.key.mode !== 'headless' || cell.key.layout !== 'none')) ||
    (cell.key.operation === 'resume' && cell.key.resumeFrom !== 'visible' && cell.key.resumeFrom !== 'headless')
  ) {
    return 'unverified';
  }
  return 'verified';
}

export function invalidateCapability(cell: CapabilityCell, changed: Partial<CapabilityKey>): CapabilityCell {
  const affected = Object.entries(changed).every(([key, value]) => cell.key[key as keyof CapabilityKey] === value);
  return affected && cell.support === 'verified' ? { ...cell, support: 'unverified' } : cell;
}

export function validateLaunchCommand(value: unknown): value is LaunchCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const command = value as Record<string, unknown>;
  const argv = Object.hasOwn(command, 'argv');
  const shell = Object.hasOwn(command, 'shell');
  if (argv === shell) return false;
  if (argv) {
    return (
      !Object.hasOwn(command, 'shellPath') &&
      Array.isArray(command.argv) &&
      command.argv.length > 0 &&
      typeof command.argv[0] === 'string' &&
      command.argv[0].length > 0 &&
      command.argv.every((arg) => typeof arg === 'string' && !arg.includes('\0'))
    );
  }
  return (
    typeof command.shell === 'string' &&
    command.shell.trim().length > 0 &&
    !command.shell.includes('\0') &&
    isCanonicalAbsolutePath(command.shellPath)
  );
}

/** Replace declared placeholders per argument, without evaluating argument bytes. */
export function resolveLaunchCommand(command: LaunchCommand, values: Readonly<Record<string, string>>): LaunchCommand {
  if (!validateLaunchCommand(command)) throw new Error('invalid_launch_template');
  const replace = (template: string, quote: boolean): string =>
    template.replace(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g, (_match, name: string) => {
      if (!Object.hasOwn(values, name) || values[name].includes('\0')) {
        throw new Error('undeclared_launch_placeholder');
      }
      return quote ? shellQuote(values[name]) : values[name];
    });
  return command.argv
    ? { argv: command.argv.map((arg) => replace(arg, false)) }
    : { shell: resolveShellPlaceholders(command.shell, values), shellPath: command.shellPath };
}

function resolveShellPlaceholders(template: string, values: Readonly<Record<string, string>>): string {
  // Interpolation is restricted to standalone arguments in single-line shell text.
  // These contexts need a real shell grammar: quotes inserted into a heredoc/comment,
  // expansion, or compound construct are not necessarily parsed as argument quotes.
  // Reject conservatively, including such text in literals, rather than guessing context.
  const staticText = template.replace(/\{\{[A-Za-z][A-Za-z0-9_]*\}\}/g, '');
  if (template !== staticText && /[$;|&<>\r\n`#(){}\[\]]/.test(staticText)) {
    throw new Error('unsupported_shell_template_context');
  }
  let result = '';
  let quote: string | null = null;
  let escaped = false;
  for (let index = 0; index < template.length; index++) {
    const char = template[index];
    const placeholder = template.slice(index).match(/^\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/);
    if (placeholder) {
      const before = index === 0 ? '' : template[index - 1];
      const after = template[index + placeholder[0].length] ?? '';
      const boundary = (value: string) => value === '' || /[\s;|&<>()]/.test(value);
      if (quote !== null || escaped || !boundary(before) || !boundary(after)) {
        throw new Error('unsafe_shell_placeholder_boundary');
      }
      if (!Object.hasOwn(values, placeholder[1])) throw new Error('undeclared_launch_placeholder');
      result += shellQuote(values[placeholder[1]]);
      index += placeholder[0].length - 1;
      continue;
    }
    result += char;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote === null && (char === "'" || char === '"' || char === '`')) quote = char;
    else if (char === quote) quote = null;
  }
  return result;
}

export function shellQuote(value: string): string {
  if (value.includes('\0')) throw new Error('invalid_argument');
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function launchProfileUsable(
  profile: LaunchProfile,
  operation: 'launch' | 'spawn' | 'resume',
  mode: 'visible' | 'headless'
): { usable: boolean; reason: string | null; command: LaunchCommand | null } {
  const command =
    operation === 'resume'
      ? mode === 'visible'
        ? profile.resume
        : profile.resumeHeadless
      : mode === 'visible'
        ? profile.launch
        : profile.headless;
  if (!isCanonicalAbsolutePath(profile.source.root)) {
    return { usable: false, reason: 'source_unavailable', command: null };
  }
  if (!command || !validateLaunchCommand(command)) {
    return { usable: false, reason: 'invalid_launch_template', command: null };
  }
  if (command.shell !== undefined && !profile.managedShellVerified) {
    return { usable: false, reason: 'capability_unverified', command: null };
  }
  return { usable: true, reason: null, command };
}

export function launchProfileDigest(profile: LaunchProfile): string {
  // The run credential is never fingerprint input. Callers supply non-secret profile config.
  const env = Object.fromEntries(
    Object.entries(profile.env).filter(([key]) => key !== 'HUD_CLAIM' && key !== 'HUD_RUN' && key !== 'HUD_LINK')
  );
  return digest({ ...profile, env });
}

function tomlString(value: string): string {
  // TOML rejects surrogate code points, even when escaped; reject them before encoding.
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('invalid_toml_string');
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error('invalid_toml_string');
    }
  }
  return JSON.stringify(value).replace(/\x7f/g, '\\u007f');
}

export function codexHudOverrides(serverName: string, env: HudLaunchEnv): string[] {
  if (!serverName || serverName.includes('\0')) throw new Error('invalid_mcp_server_name');
  if (!isCanonicalAbsolutePath(env.HUD_HOME)) throw new Error('invalid_hud_home');
  if (HUD_KEYS.some((name) => typeof env[name] !== 'string')) throw new Error('invalid_hud_env');
  const key = /^[A-Za-z0-9_-]+$/.test(serverName) ? serverName : tomlString(serverName);
  return HUD_KEYS.flatMap((name) => ['-c', `mcp_servers.${key}.env.${name}=${tomlString(env[name])}`]);
}

/** Model the same leaf updates as the argv, without writing any user configuration. */
export function injectCodexHudEnv<T extends CodexConfig>(
  config: T,
  serverName: string,
  env: HudLaunchEnv
): { config: T; argv: string[] } {
  const server = Object.hasOwn(config.mcp_servers, serverName) ? config.mcp_servers[serverName] : null;
  if (!server || typeof server.command !== 'string' || !server.command || 'url' in server) {
    throw new Error('hud_stdio_server_unavailable');
  }
  const argv = codexHudOverrides(serverName, env);
  const leaves = Object.fromEntries(HUD_KEYS.map((name) => [name, env[name]]));
  return {
    config: {
      ...config,
      mcp_servers: {
        ...config.mcp_servers,
        [serverName]: { ...server, env: { ...server.env, ...leaves } },
      },
    },
    argv,
  };
}

/** A selection plan has no host imports, dispatch, or retry side effects. */
export function planHostSelection(input: {
  finalProfileDigest: string;
  hostKind: HostKind;
  preflight: 'ready' | 'failed' | 'unknown';
  neverSubmitted: boolean;
  dispatchMayHaveOccurred: boolean;
  runId: string;
  fallback?: { profileDigest: string; hostKind: HostKind; support: CapabilitySupport };
  accepted?: { paramsDigest: string; profileDigest: string; result: unknown };
  paramsDigest: string;
}): HostSelectionPlan {
  if (input.accepted) {
    if (input.accepted.paramsDigest !== input.paramsDigest) {
      return { action: 'reject', reason: 'idempotency_conflict' };
    }
    return {
      action: 'replay',
      profileDigest: input.accepted.profileDigest,
      result: input.accepted.result,
    };
  }
  if (input.dispatchMayHaveOccurred) return { action: 'reconcile', runId: input.runId };
  if (input.preflight === 'ready') {
    return { action: 'select', profileDigest: input.finalProfileDigest, hostKind: input.hostKind };
  }
  if (input.preflight === 'failed' && input.neverSubmitted && input.fallback?.support === 'verified') {
    return {
      action: 'select',
      profileDigest: input.fallback.profileDigest,
      hostKind: input.fallback.hostKind,
    };
  }
  return { action: 'reject', reason: 'host_preflight_unavailable' };
}
