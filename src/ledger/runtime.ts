import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';

export const LEDGER_RUNTIME_REQUIREMENT = 'Node 22.x >=22.13 or Node >=24 (Node 23 is unsupported)';

export function ledgerRuntimeSupported(version = process.versions.node): boolean {
  const [major, minor] = version.split('.').map(Number);
  return (major === 22 && minor >= 13) || major >= 24;
}
export function requireLedgerRuntime(version = process.versions.node): void {
  if (!ledgerRuntimeSupported(version))
    throw new Error(`The HUD ledger requires ${LEDGER_RUNTIME_REQUIREMENT}; found ${version}`);
}

/** Probe only a private in-memory database: never open the requested path with unverified flags. */
export function verifyReadOnlyCapability(Constructor: typeof DatabaseSync): void {
  const probe = new Constructor(':memory:', { readOnly: true });
  let readOnly = false;
  try {
    try {
      probe.exec('CREATE TABLE readonly_capability_probe(value)');
    } catch (error) {
      const code = (error as { errcode?: number }).errcode;
      readOnly = typeof code === 'number' && (code & 0xff) === 8; // SQLITE_READONLY
    }
  } finally {
    probe.close();
  }
  if (!readOnly)
    throw new Error('The HUD ledger requires native node:sqlite readOnly support; requested path was not opened');
}

export async function loadLedgerSqlite(): Promise<typeof import('node:sqlite')> {
  requireLedgerRuntime();
  let sqlite: typeof import('node:sqlite');
  // Keep Node 22's SQLite initialization notice off the CLI's stderr, as the panel does.
  // Loading synchronously confines the temporary hook to this initialization, without an await.
  const emit = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === 'string' ? warning : warning?.message;
    const type = typeof warning === 'string' ? rest[0] : warning.name;
    if (type === 'ExperimentalWarning' && text === 'SQLite is an experimental feature and might change at any time')
      return;
    return (emit as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    sqlite = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  } catch (cause) {
    throw new Error(
      `The HUD ledger requires unflagged node:sqlite with readOnly support (${LEDGER_RUNTIME_REQUIREMENT})`,
      { cause }
    );
  } finally {
    process.emitWarning = emit;
  }
  verifyReadOnlyCapability(sqlite.DatabaseSync);
  return sqlite;
}
