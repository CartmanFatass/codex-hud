import { isAbsolute, join } from 'node:path';
import { canonicalJson, digest } from '../core/canonical.js';
import { productionWindowsPolicyPorts } from './claude-windows-host.js';
import { InteropUnverified, type InteropDiagnostic } from './claude-wsl-interop.js';

/** The default host adapter pins a built HUD helper and uses Win32 system APIs.
 * WSL transport/mapping and installed artifact identity are bracketed separately;
 * POSIX owner bits never stand in for Windows ACL attestation.
 */
export interface WindowsPolicySystem {
  observerExe: string;
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
  registry(hive: 'HKLM' | 'HKCU'): RegistryResult;
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
  interop?: InteropDiagnostic;
  observation: WindowsPolicyObservation | null;
  reason: string | null;
}
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** Numeric Win32 statuses, never localized command diagnostics. */
export type RegistryResult =
  | { state: 'value'; code: 0; kind: 1 | 2; data: string }
  | { state: 'missing'; code: 2 }
  | { state: 'denied'; code: 5 }
  | { state: 'error'; code: number };

function registry(ports: WindowsPolicyPorts, _system: WindowsPolicySystem, hive: 'HKLM' | 'HKCU') {
  const result = ports.registry(hive);
  if (!result || typeof result !== 'object') throw new Error('configuration_windows_registry_shape');
  if (result.state === 'missing' && result.code === 2)
    return { value: null, receipt: { hive, state: 'missing' as const, fingerprint: null } };
  if (result.state === 'denied' && result.code === 5) throw new Error('configuration_windows_registry_denied');
  if (result.state !== 'value' || result.code !== 0 || ![1, 2].includes(result.kind) || typeof result.data !== 'string')
    throw new Error('configuration_windows_registry_unknown');
  if (Buffer.byteLength(result.data) > 262144) throw new Error('configuration_windows_registry_limit');
  if (result.kind === 2 && /%[^%]+%/.test(result.data))
    throw new Error('configuration_windows_registry_expansion_unknown');
  const value: unknown = JSON.parse(result.data);
  if (!object(value)) throw new Error('configuration_windows_registry_shape');
  return { value, receipt: { hive, state: 'value' as const, fingerprint: digest({ type: result.kind, value }) } };
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
export function observeWindowsPolicy(version: string, supplied?: WindowsPolicyPorts): WindowsPolicyResult {
  const ports =
    supplied ??
    productionWindowsPolicyPorts(() => {
      throw new Error('configuration_windows_local_reader_unavailable');
    });
  try {
    if (version !== '2.1.305') throw new Error('configuration_windows_version_uncovered');
    const observed = ports.system();
    if (!observed) throw new Error('configuration_windows_system_identity_unobserved');
    const system = structuredClone(observed);
    if (
      !isAbsolute(system.observerExe) ||
      !system.observerExe.endsWith('.exe') ||
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
      ...(error instanceof InteropUnverified ? { interop: error.diagnostic } : {}),
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
