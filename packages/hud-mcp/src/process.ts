import { readlinkSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, isAbsolute } from 'node:path';
import type { Harness, ProcessDomainView } from '../../../src/core/types/identity.js';
import { readProcessDomain, type DerivedProcessDomain } from '../../../src/core/process-domain.js';
import { readBounded, readJson, object } from './io.js';
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
    const argv = readBounded(`${prefix}/cmdline`, 32768, false, true).split('\0');
    // Preserve empty arguments: dropping one can turn an option's later argument into its value.
    if (argv.at(-1) === '') argv.pop();
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
  if (
    name === 'pi' ||
    (['node', 'nodejs'].includes(name) && process.argv.slice(1, 3).some((a) => /\/pi-coding-agent\//.test(a))) ||
    (['node', 'nodejs'].includes(name) && piEntrypoint(process.argv) !== null)
  )
    return 'pi';
  return null;
}
/** Locate the installed package through its declared bin, not a release's layout.
 * Package metadata is discovery evidence, not per-session authority.
 */
export function piEntrypointPackage(hostEntrypoint: string): string | null {
  const entry = realpathSync(hostEntrypoint);
  let directory = dirname(entry);
  for (let depth = 0; depth < 128; depth++) {
    const candidate = join(directory, 'package.json');
    try {
      const pkg = readJson(candidate, 65536);
      if (object(pkg) && pkg.name === '@earendil-works/pi-coding-agent') {
        const bin = typeof pkg.bin === 'string' ? pkg.bin : object(pkg.bin) ? pkg.bin.pi : null;
        return typeof bin === 'string' && realpathSync(join(directory, bin)) === entry ? candidate : null;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const next = dirname(directory);
    if (next === directory) break;
    directory = next;
  }
  return null;
}
function piEntrypoint(argv: readonly string[]): string | null {
  try {
    const entry = realpathSync(argv[1] ?? '');
    return piEntrypointPackage(entry) ? entry : null;
  } catch {
    return null;
  }
}

export function findHarness(
  reader: ProcessReaderPort,
  ppid: number
): { process: ProcessInfo; harness: Harness } | null {
  let pid = ppid;
  for (let depth = 0; depth < 8 && pid > 1; depth++) {
    let process: ProcessInfo;
    try {
      process = reader.get(pid);
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error.code === 'EACCES' || error.code === 'EPERM')
      )
        // Optional discovery has no usable evidence; never look past a denied ancestor.
        return null;
      throw error;
    }
    const harness = inferHarness(process);
    if (harness) return { process, harness };
    if (process.ppid === pid) break;
    pid = process.ppid;
  }
  return null;
}
export function actualSourceRoot(process: ProcessInfo, harness: Harness): string | null {
  if (harness === 'pi') return piSourceRootFromArgv(process.argv);
  const explicit = process.env[harness === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'];
  const home = process.env.HOME;
  if (!explicit && !home) return null;
  try {
    return realpathSync(explicit || `${home}/${harness === 'codex' ? '.codex' : '.claude'}`);
  } catch {
    return null;
  }
}

/** Original host argv parsing, distinct from a physical process observation. */
export function piSourceRootFromArgv(argv: readonly string[]): string | null {
  // This is only a source hint for an already identified Pi process, not session authority.
  // Refuse an option terminator rather than interpret possible prompt text as an option.
  if (argv.includes('--')) return null;
  // The source selector uses the public split form. Require it first, so a preceding option cannot
  // consume the selector as its value; do not emulate the rest of Pi's argument parser.
  const executable = basename(argv[0] ?? '');
  const entrypoint = argv[1] ?? '';
  const selectorIndex =
    executable === 'pi'
      ? 1
      : ['node', 'nodejs'].includes(executable) &&
          isAbsolute(entrypoint) &&
          (/\/pi-coding-agent\//.test(entrypoint) || piEntrypoint(argv))
        ? 2
        : -1;
  if (selectorIndex < 0 || argv[selectorIndex] !== '--session-dir') return null;
  const root = argv[selectorIndex + 1];
  if (!root || !isAbsolute(root)) return null;
  if (argv.slice(selectorIndex + 2).some((arg) => arg === '--session-dir' || arg.startsWith('--session-dir=')))
    return null;
  try {
    // No cwd/HOME fallback, normalization, or symlink resolution may change the supplied root.
    return realpathSync(root) === root && statSync(root).isDirectory() ? root : null;
  } catch {
    return null;
  }
}
