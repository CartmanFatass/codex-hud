import { readlinkSync, realpathSync } from 'node:fs';
import { basename } from 'node:path';
import type { Harness, ProcessDomainView } from '../../../src/core/types/identity.js';
import { readProcessDomain, type DerivedProcessDomain } from '../../../src/core/process-domain.js';
import { readBounded } from './io.js';
import { Refusal } from './errors.js';
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
  /** One validated read supplies the caller, run and Claude registry forms; the run form is explicit. */
  domain(): ProcessDomainView;
}
export class LinuxProcessReader implements ProcessReaderPort {
  constructor(private readonly readDomain: () => DerivedProcessDomain = readProcessDomain) {}
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
  domain(): ProcessDomainView {
    try {
      // ProcessStamp and ProcessKey intentionally use distinct domain encodings.
      // Both derive from this one validated read; never convert a persisted identity string.
      return this.readDomain();
    } catch {
      throw new Refusal('registration_unverified');
    }
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
