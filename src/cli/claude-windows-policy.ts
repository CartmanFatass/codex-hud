import { execFileSync } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import { canonicalJson, digest } from '../core/canonical.js';

/** A host adapter must attest the native Windows system executable, its Windows
 * access controls, the WSL interop endpoint and the mapped managed-policy root.
 * POSIX owner bits, a /mnt/c guess and environment variables cannot attest these.
 */
export interface WindowsPolicySystem {
  regExe: string;
  managedRoot: string;
  executableIdentity: string;
  interopIdentity: string;
}
export interface WindowsPolicyFile {
  receipt: { state: 'missing' | 'file' | 'directory'; fingerprint: string | null };
  value: Record<string, unknown> | null;
  entries: string[] | null;
}
export interface WindowsPolicyPorts {
  system(): WindowsPolicySystem | null;
  query(
    executable: string,
    args: string[],
    limits: { timeout: number; maxBuffer: number }
  ): {
    status: number | null;
    stdout: string;
    stderr: string;
  };
  read(path: string): WindowsPolicyFile;
}
export interface WindowsPolicyObservation {
  schema: 'claude-wsl-windows-policy-v1';
  version: '2.1.305';
  inheritance: boolean;
  localChain: 'linux' | 'windows-admin';
  /** Eligibility only. Linux/remote policy presence can still exclude HKCU. */
  hkcuEligible: boolean;
  registry: { hive: 'HKLM' | 'HKCU'; state: 'missing' | 'value'; fingerprint: string | null }[];
  files: { role: string; receipt: WindowsPolicyFile['receipt'] }[];
  system: WindowsPolicySystem;
}
export interface WindowsPolicyResult {
  observation: WindowsPolicyObservation | null;
  reason: string | null;
}
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** The only command is read-only `query <fixed hive> /v Settings`. No shell,
 * credential queries, environment expansion, registry writes or helper programs.
 * This adapter is reached only after a trusted host supplies system identity.
 */
export const queryWindowsRegistry: WindowsPolicyPorts['query'] = (executable, args, limits) => {
  try {
    return {
      status: 0,
      stdout: execFileSync(executable, args, { ...limits, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
      stderr: '',
    };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string; code?: string };
    if (failure.code || typeof failure.status !== 'number') throw new Error('configuration_windows_interop_unknown');
    return { status: failure.status, stdout: String(failure.stdout ?? ''), stderr: String(failure.stderr ?? '') };
  }
};

function registry(ports: WindowsPolicyPorts, system: WindowsPolicySystem, hive: 'HKLM' | 'HKCU') {
  const result = ports.query(system.regExe, ['query', `${hive}\\SOFTWARE\\Policies\\ClaudeCode`, '/v', 'Settings'], {
    timeout: 500,
    maxBuffer: 262144,
  });
  if (Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > 262144)
    throw new Error('configuration_windows_registry_limit');
  // reg.exe uses the same error status for denial and absence. Accept only its
  // exact English missing-key/value diagnostic; localized/other failures remain
  // unknown, never silently missing.
  if (
    result.status === 1 &&
    result.stdout.trim() === '' &&
    result.stderr.trim() === 'ERROR: The system was unable to find the specified registry key or value.'
  )
    return { value: null, receipt: { hive, state: 'missing' as const, fingerprint: null } };
  if (result.status !== 0 || result.stderr.trim()) throw new Error('configuration_windows_registry_unknown');
  const fullHive = hive === 'HKLM' ? 'HKEY_LOCAL_MACHINE' : 'HKEY_CURRENT_USER';
  const lines = result.stdout.trim().split(/\r?\n/);
  if (lines.length !== 2 || lines[0] !== `${fullHive}\\SOFTWARE\\Policies\\ClaudeCode`)
    throw new Error('configuration_windows_registry_shape');
  const row = /^\s+Settings\s+(REG_SZ|REG_EXPAND_SZ)\s+(.+)$/.exec(lines[1]);
  if (!row || (row[1] === 'REG_EXPAND_SZ' && /%[^%]+%/.test(row[2])))
    throw new Error('configuration_windows_registry_expansion_unknown');
  const value: unknown = JSON.parse(row[2]);
  if (!object(value)) throw new Error('configuration_windows_registry_shape');
  return { value, receipt: { hive, state: 'value' as const, fingerprint: digest({ type: row[1], value }) } };
}

function inheritance(value: Record<string, unknown> | null): boolean | null {
  const flag = value?.wslInheritsWindowsSettings;
  if (flag === undefined || flag === null) return null;
  if (flag === true || flag === 'true') return true;
  if (flag === false || flag === 'false') return false;
  throw new Error('configuration_windows_inheritance_unknown');
}
const hasPolicy = (value: Record<string, unknown> | null) =>
  value !== null &&
  Object.entries(value).some(
    ([key, field]) => !['wslInheritsWindowsSettings', 'managedSourcesBehavior'].includes(key) && field !== null
  );

/** Version-bounded source observation, never proof of a verified capability or
 * effective settings merge. Unknown Windows host trust remains a production
 * blocker until a host adapter can establish it without guessed paths.
 * Selection: https://code.claude.com/docs/en/settings-reference#wslinheritswindowssettings
 * and https://code.claude.com/docs/en/managed-settings (accessed 2026-11-05).
 */
export function observeWindowsPolicy(version: string, ports?: WindowsPolicyPorts): WindowsPolicyResult {
  try {
    if (version !== '2.1.305') throw new Error('configuration_windows_version_uncovered');
    const observed = ports?.system();
    if (!ports || !observed) throw new Error('configuration_windows_system_identity_unobserved');
    const system = structuredClone(observed);
    if (
      !isAbsolute(system.regExe) ||
      !system.regExe.endsWith('/reg.exe') ||
      !isAbsolute(system.managedRoot) ||
      !system.executableIdentity ||
      !system.interopIdentity
    )
      throw new Error('configuration_windows_system_identity_unobserved');
    const hklm = registry(ports, system, 'HKLM');
    const hkcu = registry(ports, system, 'HKCU');
    const files: WindowsPolicyObservation['files'] = [];
    const values: (Record<string, unknown> | null)[] = [hklm.value];
    const read = (role: string, path: string, directory = false) => {
      const result = ports.read(path);
      if (result.receipt.state !== 'missing' && result.receipt.state !== (directory ? 'directory' : 'file'))
        throw new Error('configuration_windows_file_shape');
      files.push({ role, receipt: result.receipt });
      return result;
    };
    values.push(read('windows-managed-settings', join(system.managedRoot, 'managed-settings.json')).value);
    const dropins = read('windows-managed-dropins', join(system.managedRoot, 'managed-settings.d'), true);
    if ((dropins.entries?.length ?? 0) > 128) throw new Error('configuration_windows_directory_limit');
    const selected = (dropins.entries ?? []).filter((name) => !name.startsWith('.') && name.endsWith('.json')).sort();
    if (selected.length > 16) throw new Error('configuration_windows_dropin_limit');
    for (const name of selected) {
      if (name.includes('/') || name.includes('\\') || name.includes('\0'))
        throw new Error('configuration_windows_file_shape');
      values.push(read(`windows-managed-dropin:${name}`, join(system.managedRoot, 'managed-settings.d', name)).value);
    }
    read('windows-managed-mcp', join(system.managedRoot, 'managed-mcp.json'));
    const flags = values.map(inheritance).filter((flag): flag is boolean => flag !== null);
    // Do not invent precedence for conflicting enable/disable controls.
    if (flags.includes(true) && flags.includes(false)) throw new Error('configuration_windows_inheritance_conflict');
    const inherits = flags.includes(true);
    const windowsAdmin = inherits && values.some(hasPolicy);
    const hkcuEligible = inherits && !windowsAdmin && inheritance(hkcu.value) === true;
    if (!equal(system, ports.system())) throw new Error('configuration_windows_system_changed');
    return {
      observation: {
        schema: 'claude-wsl-windows-policy-v1',
        version: '2.1.305',
        inheritance: inherits,
        localChain: windowsAdmin ? 'windows-admin' : 'linux',
        hkcuEligible,
        registry: [hklm.receipt, hkcu.receipt],
        files,
        system,
      },
      reason: null,
    };
  } catch (error) {
    return {
      observation: null,
      reason:
        error instanceof Error && error.message.startsWith('configuration_')
          ? error.message
          : 'configuration_windows_policy_unknown',
    };
  }
}

export function sameWindowsPolicy(
  original: WindowsPolicyObservation,
  current: WindowsPolicyObservation | null
): boolean {
  return current !== null && equal(original, current);
}
