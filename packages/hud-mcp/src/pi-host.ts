import { realpathSync, readlinkSync, statSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { piSourceRootFromArgv, inferHarness, type ProcessInfo, type ProcessReaderPort } from './process.js';
import { object, readJson } from './io.js';
import { Refusal } from './errors.js';
import {
  PI_EXTENSION_VERSION,
  PI_EXTENSION_CONTEXT_PROFILE,
  canonicalPiPath,
} from '../../../src/harness/pi/delegation-context.js';
import type { PiHostHello } from '../../../src/harness/pi/delegation-channel.js';

/** Pin the actual npm entrypoint/package, not an env/version assertion or argv0 alone.
 * This does not promise integrity against an attacker who can replace installed same-UID code.
 */
export function piHostTuple(parent: ProcessInfo, hostEntrypoint: string): string {
  const entry = realpathSync(hostEntrypoint);
  if (
    !['node', 'pi'].includes(basename(parent.argv[0] ?? '')) ||
    !entry.endsWith('/pi-coding-agent/dist/bundle/cli.js')
  )
    throw new Refusal('unsupported');
  const pkg = readJson(join(dirname(dirname(dirname(entry))), 'package.json'), 16384);
  if (
    !object(pkg) ||
    pkg.name !== '@earendil-works/pi-coding-agent' ||
    pkg.version !== PI_EXTENSION_VERSION ||
    !object(pkg.bin) ||
    pkg.bin.pi !== 'dist/bundle/cli.js'
  )
    throw new Refusal('unsupported');
  const executable = readlinkSync(`/proc/${parent.pid}/exe`);
  if (executable !== readlinkSync('/proc/self/exe')) throw new Refusal('unsupported');
  const stat = statSync(entry);
  if (!stat.isFile()) throw new Refusal('unsupported');
  return JSON.stringify([
    entry,
    stat.dev,
    stat.ino,
    stat.size,
    stat.mtimeMs,
    executable,
    pkg.name,
    pkg.version,
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
      hello.version !== PI_EXTENSION_VERSION ||
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
    // Parse the host's original argv separately. Never fabricate a ProcessReader observation.
    if (piSourceRootFromArgv(hello.argv) !== root) throw new Refusal('identity_unverified');
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
