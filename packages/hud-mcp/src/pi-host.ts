import { realpathSync, readlinkSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { piEntrypointPackage, inferHarness, type ProcessInfo, type ProcessReaderPort } from './process.js';
import { Refusal } from './errors.js';
import { PI_EXTENSION_CONTEXT_PROFILE, canonicalPiPath } from '../../../src/harness/pi/delegation-context.js';
import type { PiHostHello } from '../../../src/harness/pi/delegation-channel.js';

/** Verify the installed package's declared Pi entrypoint, independently of its
 * version or directory layout. Private channel ownership and physical process
 * stamps remain the authority; same-UID installed-code replacement is out of scope.
 */
export function piHostTuple(parent: ProcessInfo, hostEntrypoint: string): string {
  const entry = realpathSync(hostEntrypoint);
  if (!['node', 'nodejs', 'pi'].includes(basename(parent.argv[0] ?? ''))) throw new Refusal('unsupported');
  const packagePath = piEntrypointPackage(entry);
  if (!packagePath) throw new Refusal('unsupported');
  const executable = readlinkSync(`/proc/${parent.pid}/exe`);
  // The extension spawns this MCP child with its own process.execPath. Compare
  // their actual executable identities, not a fixed Node installation path.
  if (executable !== readlinkSync('/proc/self/exe')) throw new Refusal('identity_unverified');
  const stat = statSync(entry);
  if (!stat.isFile()) throw new Refusal('unsupported');
  return JSON.stringify([
    entry,
    stat.dev,
    stat.ino,
    stat.size,
    stat.mtimeMs,
    executable,
    packagePath,
    parent.pid,
    parent.procStart,
    parent.pidNamespace,
  ]);
}

/** Pi changes process.title and erases /proc cmdline. The original entrypoint and
 * root are supplied only by its private host channel, never env/args/MCP metadata.
 * Physical process identity + installed host tuple are independently rechecked.
 */
export class PiHostEvidence {
  private constructor(
    readonly rootPath: string,
    readonly entrypoint: string,
    readonly parentPid: number,
    readonly parentStart: string,
    private readonly selfPid: number,
    private readonly selfStart: string,
    private readonly domain: string,
    private readonly tuple: string
  ) {}
  static capture(reader: ProcessReaderPort, hello: PiHostHello): PiHostEvidence {
    const self = reader.get(process.pid),
      parent = reader.get(self.ppid);
    if (
      hello.profile !== PI_EXTENSION_CONTEXT_PROFILE ||
      hello.pid !== parent.pid ||
      inferHarness(parent) !== 'pi' ||
      self.pidNamespace !== parent.pidNamespace ||
      !Array.isArray(hello.argv) ||
      !hello.argv.every((a) => typeof a === 'string' && !a.includes('\0')) ||
      hello.argv[1] !== hello.entrypoint
    )
      throw new Refusal('identity_unverified');
    const root = canonicalPiPath(hello.sourceRoot);
    if (realpathSync(root) !== root || !statSync(root).isDirectory()) throw new Refusal('identity_unverified');
    // The root came from the native extension's sessionManager on the private
    // channel. bindHost independently matches configured sourceRoot; each call
    // rechecks the native context. CLI option position is not source authority.
    const evidence = new PiHostEvidence(
      root,
      canonicalPiPath(realpathSync(hello.entrypoint)),
      parent.pid,
      parent.procStart,
      self.pid,
      self.procStart,
      reader.domain().pidDomain,
      piHostTuple(parent, hello.entrypoint)
    );
    evidence.assertCurrent(reader);
    return evidence;
  }
  assertCurrent(reader: ProcessReaderPort): void {
    const self = reader.get(this.selfPid),
      parent = reader.get(this.parentPid);
    if (
      self.procStart !== this.selfStart ||
      self.ppid !== this.parentPid ||
      parent.procStart !== this.parentStart ||
      parent.pidNamespace !== self.pidNamespace ||
      reader.domain().pidDomain !== this.domain ||
      inferHarness(parent) !== 'pi' ||
      piHostTuple(parent, this.entrypoint) !== this.tuple ||
      realpathSync(this.rootPath) !== this.rootPath
    )
      throw new Refusal('identity_unverified');
  }
}
