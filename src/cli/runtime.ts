import { lstatSync, realpathSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installationRoot } from './compat.js';
export { installationRoot } from './compat.js';
import { Ledger, openLedger } from '../ledger/ledger.js';
import { PrivateLedgerGate } from '../ledger/local-manager.js';
import { loadLedgerSqlite, requireLedgerRuntime } from '../ledger/runtime.js';
import type { DelegateConfig } from '../core/types/capabilities.js';
import type { LocalResumeRequest } from '../core/types/lifecycle.js';
import type { CapabilityVerifier } from '../core/launch/capability.js';
import type { ExecutableIdentity } from '../core/launch/fingerprint.js';

export class CliError extends Error {
  constructor(
    readonly reason: string,
    readonly exitCode = 2
  ) {
    super(reason);
  }
}

/** Validate before opening a store, loading configuration, or creating any files. */
export function privateHome(env: NodeJS.ProcessEnv): string {
  const requested = env.HUD_HOME ?? join(homedir(), '.hud');
  if (!isAbsolute(requested) || requested.includes('\0')) throw new CliError('invalid_hud_home', 3);
  const home = requested.replace(/(?:\/\.?)+$/, '') || '/';
  try {
    const info = lstatSync(home);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      realpathSync(home) !== home ||
      process.getuid?.() !== process.geteuid?.() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0
    )
      throw new Error('unsafe');
    return home;
  } catch {
    throw new CliError('invalid_hud_home', 3);
  }
}

/** Root tsc builds src only; load the existing independently-built MCP writer at runtime. */
interface McpLibraries {
  config: { loadDelegateConfig(file: string): DelegateConfig };
  delegation: { DelegationService: new (options: ResumeServiceOptions) => LocalResumeService };
  'hook/record': {
    IMPLEMENTATION: string;
    CLAUDE_VERSION: string;
    makeHookSettings(config: object, command: string, settings: Record<string, unknown>): Record<string, unknown>;
  };
}
export interface ResumeServiceOptions {
  ledger: Ledger;
  home: string;
  config: DelegateConfig;
  env: NodeJS.ProcessEnv;
  hudRunPath: string;
  capability: CapabilityVerifier;
  executableIdentity?: ExecutableIdentity;
}
export async function mcpModule<N extends keyof McpLibraries>(name: N): Promise<McpLibraries[N]> {
  const file = join(installationRoot(), 'packages/hud-mcp/dist/packages/hud-mcp/src', `${name}.js`);
  if (!existsSync(file)) throw new CliError('hud_mcp_unbuilt_run_npm_run_build_hud_mcp', 1);
  try {
    return await import(pathToFileURL(file).href);
  } catch (error) {
    if (['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND'].includes(String((error as NodeJS.ErrnoException).code)))
      throw new CliError('hud_mcp_unbuilt_run_npm_run_build_hud_mcp', 1);
    throw error;
  }
}

export async function delegateConfig(home: string): Promise<DelegateConfig> {
  const { loadDelegateConfig } = await mcpModule('config');
  return loadDelegateConfig(join(home, 'delegate.json'));
}

export interface LocalResumeService {
  resumeLocal(request: LocalResumeRequest): Promise<unknown>;
  close(): void;
}

/** No initialization/migration on CLI reads, including wait. Gate pins both inodes. */
export async function existingLedger(home: string, writable = false) {
  requireLedgerRuntime();
  let gate: PrivateLedgerGate;
  try {
    gate = new PrivateLedgerGate(home);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new CliError('ledger_missing', 4);
    throw error;
  }
  const { DatabaseSync } = await loadLedgerSqlite();
  const db = new DatabaseSync(gate.path, { readOnly: true });
  let ledger: Ledger;
  try {
    db.exec('PRAGMA busy_timeout=0');
    if (db.prepare('PRAGMA user_version').get()?.user_version !== 1) throw new CliError('unsupported_ledger_schema', 5);
    const id = db.prepare('SELECT ledger_id FROM ledger_metadata WHERE singleton=1').get()?.ledger_id;
    if (typeof id !== 'string' || !id) throw new CliError('invalid_ledger', 4);
    ledger = new Ledger(db, id, 20);
  } catch (error) {
    db.close();
    throw error;
  }
  try {
    gate.check();
    if (writable) {
      await ledger.close();
      ledger = await openLedger(gate.path);
      gate.check();
    }
    return { ledger, gate };
  } catch (error) {
    await ledger.close();
    throw error;
  }
}

export function identifier(value: string | undefined): string {
  if (!value || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new CliError('invalid_target');
  return value;
}

export function integer(value: string | undefined, maximum: number): number {
  if (value === undefined || !/^(0|[1-9]\d*)$/.test(value)) throw new CliError('invalid_number');
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number > maximum) throw new CliError('invalid_number');
  return number;
}

export function options(args: readonly string[], booleans: readonly string[], values: readonly string[]) {
  const result = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if ((!booleans.includes(flag) && !values.includes(flag)) || result.has(flag))
      throw new CliError('invalid_arguments');
    if (booleans.includes(flag)) result.set(flag, true);
    else {
      const value = args[++i];
      if (value === undefined || value.includes('\0')) throw new CliError('missing_option_value');
      result.set(flag, value);
    }
  }
  return result;
}
