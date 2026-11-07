import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { ScopeSnapshot } from '../../../../src/core/ledger-scope-read.js';
import type { DelegateProfile } from '../config.js';
import { MANAGED_TOOLS } from '../managed-tools.js';
import { JEV_TOOLS } from '../jev-tools.js';

export const IMPLEMENTATION = 'claude-hook-2';
// Historical probe fixture label only. Never a consumer-version admission requirement.
export const CLAUDE_VERSION = '2.1.305';
export const MAX_RECORD_BYTES = 8192;
export const HUD_TOOLS = [
  ...MANAGED_TOOLS.map((tool) => tool.name),
  ...JEV_TOOLS.map((tool) => tool.name),
  'delegate_spawn',
  'delegate_resume',
  'delegate_report',
  'delegate_whoami',
  'delegate_status',
  'delegate_list',
  'delegate_wait',
  'delegate_cancel',
  'delegate_close',
] as const;
export interface HookConfig {
  version: 1;
  implementation: typeof IMPLEMENTATION;
  /** Optional diagnostic supplied by the launcher, never identity evidence. */
  claudeVersion?: string;
  claudeExecutable: string;
  sourceRoot: string;
  /** Historical hook fixtures only; native source evidence does not read a ledger. */
  ledgerPath?: string;
  directory: string;
  serverName: string;
  profileFingerprint: string;
  clockTicksPerSecond: 100;
}
export interface HookRecord {
  version: 1;
  implementation: typeof IMPLEMENTATION;
  /** Optional diagnostic supplied by the launcher, never identity evidence. */
  claudeVersion?: string;
  profileFingerprint: string;
  sourceId: string;
  processKey: string;
  bootId: string;
  serverName: string;
  toolUseId: string;
  toolName: string;
  sessionId: string;
  agent: { kind: 'root'; id: null } | { kind: 'native_child'; id: string };
  /** Optional legacy experiment evidence; never emitted by the native hook. */
  premise?: ScopeSnapshot;
  hookStartMonoMs: number;
  hookStartUncertaintyMs: number;
  publishedMonoMs: number;
  fingerprint: string;
}
export const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
export const text = (v: unknown, max = 256): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= max && !v.includes('\0');
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value))
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`;
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return JSON.stringify(value);
  throw new Error('Invalid JSON');
}
export const hash = (v: unknown): string => createHash('sha256').update(canonical(v)).digest('hex');
export function hookProfileFingerprint(profile: DelegateProfile): string {
  // Match core launchProfileDigest without loading the writer/capability graph.
  // Callers supply non-secret config; per-run credentials/anchors are excluded.
  const env = Object.fromEntries(
    Object.entries(profile.env).filter(([key]) => key !== 'HUD_CLAIM' && key !== 'HUD_RUN' && key !== 'HUD_LINK')
  );
  return hash({ ...profile, env });
}
export function selectsClaudeHook(profile: DelegateProfile): boolean {
  const source = (profile as unknown as Record<string, unknown>).callSource;
  return (
    profile.harness === 'claude' &&
    object(source) &&
    source.kind === 'claude_pre_tool_use_v1' &&
    Object.keys(source).length === 1
  );
}
export function privateDirectory(path: string): void {
  const st = lstatSync(path);
  if (!st.isDirectory() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0 || realpathSync(path) !== path)
    throw new Error('Private canonical directory required');
}
export function privateRead(path: string, max: number, requirePrivate = true): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (
      !before.isFile() ||
      before.uid !== process.getuid?.() ||
      (requirePrivate && (before.mode & 0o077) !== 0) ||
      before.size > max
    )
      throw new Error('Invalid private file');
    const buffer = Buffer.alloc(before.size + 1);
    const n = readSync(fd, buffer, 0, buffer.length, 0);
    const after = fstatSync(fd);
    if (
      n !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw new Error('File changed during read');
    return buffer.subarray(0, n).toString('utf8');
  } finally {
    closeSync(fd);
  }
}
export function readHookConfig(path: string): HookConfig {
  const value: unknown = JSON.parse(privateRead(path, MAX_RECORD_BYTES));
  if (
    !object(value) ||
    Object.keys(value)
      .filter((key) => key !== 'claudeVersion' && key !== 'ledgerPath')
      .sort()
      .join(',') !==
      [
        'version',
        'implementation',
        'claudeExecutable',
        'sourceRoot',
        'directory',
        'serverName',
        'profileFingerprint',
        'clockTicksPerSecond',
      ]
        .sort()
        .join(',') ||
    value.version !== 1 ||
    value.implementation !== IMPLEMENTATION ||
    value.clockTicksPerSecond !== 100 ||
    !text(value.serverName) ||
    !text(value.profileFingerprint) ||
    !/^[a-f0-9]{64}$/.test(value.profileFingerprint)
  )
    throw new Error('Unsupported hook config');
  for (const key of ['claudeExecutable', 'sourceRoot', 'directory'])
    if (!text(value[key], 4096) || !(value[key] as string).startsWith('/'))
      throw new Error('Absolute hook path required');
  const config = value as unknown as HookConfig;
  if (
    realpathSync(config.sourceRoot) !== config.sourceRoot ||
    realpathSync(config.claudeExecutable) !== config.claudeExecutable
  )
    throw new Error('Canonical hook source required');
  privateDirectory(config.directory);
  return config;
}
export function recordPaths(
  config: HookConfig,
  source: { processKey: string; bootId: string; sessionId: string } | ScopeSnapshot,
  callId: string
): { directory: string; record: string; seen: string; conflict: string } {
  // Native one-shot evidence is scoped to this actual process and MCP server.
  // The ledgerId branch only supports explicit historical experiment callers.
  const namespace = !('ledgerId' in source)
    ? hash(['native-hook-v1', source.bootId, source.processKey, source.sessionId, config.serverName])
    : hash([
        source.ledgerId,
        source.ledgerId === null ? config.ledgerPath : null,
        source.processKey,
        config.serverName,
      ]);
  const directory = join(config.directory, namespace);
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  privateDirectory(directory);
  const key = join(directory, hash(callId));
  return { directory, record: key + '.json', seen: key + '.seen', conflict: key + '.conflict' };
}
export function marker(path: string): void {
  const fd = openSync(path, 'wx', 0o600);
  closeSync(fd);
}
export function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
}
export function publishRecord(config: HookConfig, record: HookRecord): void {
  const paths = recordPaths(config, record.premise ?? record, record.toolUseId);
  const bytes = JSON.stringify(record) + '\n';
  if (Buffer.byteLength(bytes) > MAX_RECORD_BYTES) throw new Error('Hook record too large');
  if (exists(paths.seen) || exists(paths.conflict)) throw new Error('Call already attempted');
  const tmp = join(paths.directory, '.' + randomUUID() + '.tmp');
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeFileSync(fd, bytes);
  } finally {
    closeSync(fd);
  }
  try {
    // Ephemeral evidence needs visibility atomicity, not crash durability. All
    // bytes are written and closed before link; loss after a crash fails closed.
    try {
      linkSync(tmp, paths.record);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
        try {
          marker(paths.conflict);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
      }
      throw e;
    }
  } finally {
    unlinkSync(tmp);
  }
}
export function makeHookSettings(
  config: HookConfig,
  command: string,
  settings: Record<string, unknown> = {}
): Record<string, unknown> {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const hooks = object(settings.hooks) ? settings.hooks : {};
  if (settings.hooks !== undefined && !object(settings.hooks)) throw new Error('Invalid existing hooks');
  if (hooks.PreToolUse !== undefined && !Array.isArray(hooks.PreToolUse))
    throw new Error('Invalid existing PreToolUse');
  return {
    ...settings,
    hooks: {
      ...hooks,
      PreToolUse: [
        ...((hooks.PreToolUse as unknown[]) ?? []),
        {
          matcher: `^mcp__${escape(config.serverName)}__(?:${HUD_TOOLS.join('|')})$`,
          hooks: [{ type: 'command', command, timeout: 2 }],
        },
      ],
    },
  };
}
