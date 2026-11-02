import { readlinkSync, realpathSync } from 'node:fs';
import { basename } from 'node:path';
import type { Harness } from '../../../src/core/types/identity.js';
import { readBounded } from './io.js';
import { Refusal } from './errors.js';
import { currentDomain } from '../../../src/core/run/process.js';
export interface ProcessInfo {
  pid: number;
  ppid: number;
  procStart: string;
  argv: string[];
  env: Record<string, string>;
  pidNamespace: string;
}
export interface ProcessReaderPort {
  get(pid: number): ProcessInfo;
  domain(): { bootId: string; pidDomain: string; claudePidDomain: string; runPidDomain?: string };
}
export class LinuxProcessReader implements ProcessReaderPort {
  get(pid: number): ProcessInfo {
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Refusal('registration_unverified');
    const prefix = `/proc/${pid}`;
    const stat = () => readBounded(`${prefix}/stat`, 4096, false, true).split(') ').at(-1)!.trim().split(/\s+/);
    const first = stat();
    const argv = readBounded(`${prefix}/cmdline`, 32768, false, true).split('\0').filter(Boolean);
    const env: Record<string, string> = {};
    for (const entry of readBounded(`${prefix}/environ`, 131072, false, true).split('\0')) {
      const index = entry.indexOf('=');
      const key = entry.slice(0, index);
      if (['HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR'].includes(key)) env[key] = entry.slice(index + 1);
    }
    const pidNamespace = readlinkSync(`${prefix}/ns/pid`);
    const second = stat();
    if (!first[19] || first[19] !== second[19] || first[1] !== second[1]) throw new Refusal('registration_unverified');
    return { pid, ppid: Number(first[1]), procStart: first[19], argv, env, pidNamespace };
  }
  domain(): { bootId: string; pidDomain: string; claudePidDomain: string; runPidDomain: string } {
    const bootId = readBounded('/proc/sys/kernel/random/boot_id', 128, false, true).trim();
    const machineId = readBounded('/etc/machine-id', 128).trim();
    const namespace = readlinkSync('/proc/self/ns/pid');
    if (!bootId || !machineId || !namespace) throw new Refusal('registration_unverified');
    return {
      bootId,
      pidDomain: JSON.stringify(['linux', machineId, bootId, namespace]),
      claudePidDomain: `linux:${machineId}:${namespace}`,
      // ProcessStamp and ProcessKey intentionally use distinct domain encodings.
      // Use the run writer's producer; never convert a persisted identity string.
      runPidDomain: currentDomain().pid_domain,
    };
  }
}
export function inferHarness(process: ProcessInfo): Harness | null {
  const name = basename(process.argv[0] ?? '');
  if (name === 'claude') return 'claude';
  if (name === 'codex') return 'codex';
  if (name === 'pi' || (name === 'node' && process.argv.slice(1, 3).some((a) => /\/pi-coding-agent\//.test(a))))
    return 'pi';
  return null;
}
export function findHarness(
  reader: ProcessReaderPort,
  ppid: number
): { process: ProcessInfo; harness: Harness } | null {
  let pid = ppid;
  for (let depth = 0; depth < 8 && pid > 1; depth++) {
    const process = reader.get(pid);
    const harness = inferHarness(process);
    if (harness) return { process, harness };
    if (process.ppid === pid) break;
    pid = process.ppid;
  }
  return null;
}
export function actualSourceRoot(process: ProcessInfo, harness: Harness): string | null {
  const explicit = process.env[harness === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'];
  // pi needs an explicit configured root and precise cmdline; no guessed home.
  if (harness === 'pi') return null;
  const home = process.env.HOME;
  if (!explicit && !home) return null;
  try {
    return realpathSync(explicit || `${home}/${harness === 'codex' ? '.codex' : '.claude'}`);
  } catch {
    return null;
  }
}
