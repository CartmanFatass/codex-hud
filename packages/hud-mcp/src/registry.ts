import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { Caller, Source } from '../../../src/core/types/identity.js';
import { makeSourceId } from '../../../src/core/identity.js';
import type { DelegateProfile } from './config.js';
import { Refusal } from './errors.js';
import { actualSourceRoot, findHarness, type ProcessReaderPort } from './process.js';
import { PiHostEvidence } from './pi-host.js';

/** B2 integration: registration is raw physical evidence, never a binding transaction. */
export interface CallerRegistryPort {
  register(caller: Caller, source: Source | null): Promise<void>;
}
export class MemoryCallerRegistry implements CallerRegistryPort {
  readonly callers: Caller[] = [];
  readonly sources: Source[] = [];
  async register(caller: Caller, source: Source | null): Promise<void> {
    if (this.callers.some((c) => c.callerId === caller.callerId)) throw new Refusal('registration_unverified');
    this.callers.push(structuredClone(caller));
    if (source) this.sources.push(structuredClone(source));
  }
}
/** Diagnostic fake: separate exclusive files per MCP; no ledger/context/alias authority. */
export class FileCallerRegistry implements CallerRegistryPort {
  constructor(private readonly directory: string) {}
  async register(caller: Caller, source: Source | null): Promise<void> {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const directory = lstatSync(this.directory);
    if (
      !directory.isDirectory() ||
      (directory.mode & 0o077) !== 0 ||
      (process.getuid && directory.uid !== process.getuid())
    )
      throw new Refusal('registration_unverified');
    const file = join(this.directory, `${caller.callerId}.json`);
    const temporary = join(this.directory, `.caller-${randomUUID()}.tmp`);
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(fd, JSON.stringify({ caller, source }) + '\n');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      // Atomic publication without overwriting a prior diagnostic instance row.
      linkSync(temporary, file);
    } finally {
      unlinkSync(temporary);
    }
  }
}
export interface Registration {
  caller: Caller;
  source: Source | null;
  harnessPid: number | null;
  harnessProcStart: string | null;
}
export async function registerCaller(input: {
  reader: ProcessReaderPort;
  registry: CallerRegistryPort;
  profile: DelegateProfile | null;
  pid: number;
  cwd: () => string;
  envPane: string | null;
  nowMs: number;
  /** Only a consumed, physically checked private Pi bootstrap can supply this. */
  piHost?: PiHostEvidence;
}): Promise<Registration> {
  let cwd: string;
  try {
    cwd = input.cwd();
    if (!cwd) throw new Error();
  } catch {
    throw new Refusal('cwd_unavailable');
  }
  const self = input.reader.get(input.pid);
  const parent = input.reader.get(self.ppid);
  const domain = input.reader.domain();
  if (self.pidNamespace !== parent.pidNamespace) throw new Refusal('registration_unverified');
  const found = findHarness(input.reader, self.ppid);
  let source: Source | null = null;
  const profile = input.profile;
  if (found && profile && profile.harness === found.harness) {
    const rootPath = realpathSync(profile.source.root);
    const piSource =
      found.harness === 'pi' &&
      profile.callSource?.kind === 'pi_extension_v1' &&
      input.piHost instanceof PiHostEvidence &&
      input.piHost.parentPid === self.ppid &&
      input.piHost.parentPid === found.process.pid &&
      input.piHost.parentStart === found.process.procStart;
    if (piSource) input.piHost!.assertCurrent(input.reader);
    if ((piSource ? input.piHost!.rootPath : actualSourceRoot(found.process, found.harness)) === rootPath)
      source = {
        sourceId: makeSourceId(found.harness, rootPath),
        harness: found.harness,
        rootPath,
        label: profile.source.label,
      };
  }
  // Registration hints carry no logical root identity; per-call resolver gates tools.
  const caller: Caller = {
    callerId: randomUUID(),
    instanceKind: 'dedicated',
    harness: found?.harness ?? null,
    sourceId: source?.sourceId ?? null,
    pid: self.pid,
    procStart: self.procStart,
    ppid: self.ppid,
    parentProcStart: parent.procStart,
    cwd,
    envPane: input.envPane,
    startedAt: input.nowMs,
    lastSeenAt: input.nowMs,
    retiredAt: null,
  };
  if (
    !domain.pidDomain ||
    input.reader.get(self.pid).procStart !== self.procStart ||
    input.reader.get(parent.pid).procStart !== parent.procStart
  )
    throw new Refusal('registration_unverified');
  await input.registry.register(caller, source);
  return { caller, source, harnessPid: found?.process.pid ?? null, harnessProcStart: found?.process.procStart ?? null };
}
