import { createHash } from 'node:crypto';
import { closeSync, constants, openSync, readSync, readlinkSync } from 'node:fs';
import type { CallerPidDomain, ClaudeRegistryPidDomain, ProcessDomainView, RunPidDomain } from './types/identity.js';

/**
 * Consult 5 G08: the one validated set of host facts every pid-domain encoding
 * derives from. A caller must not mix a boot id from one read with a namespace
 * from another.
 */
export interface ProcessDomainInputs {
  readonly machineId: string;
  readonly bootId: string;
  readonly pidNamespace: string;
}

/** MCP and the hook have always refused a final machine-id symlink; hud-run followed it. */
export type MachineIdReadPolicy = 'follow' | 'no-follow';

export interface ProcessDomainReadOptions {
  /** Defaults to no-follow so MCP and the hook keep their existing policy. */
  readonly machineIdPolicy?: MachineIdReadPolicy;
  /** Test seam; production callers use /etc/machine-id. */
  readonly machineIdPath?: string;
}

/** The run form is present here; ProcessDomainView keeps it nullable for explicit unavailability. */
export interface DerivedProcessDomain extends ProcessDomainView {
  readonly runPidDomain: RunPidDomain;
}

export type ProcessDomainFailure = 'unreadable' | 'invalid' | 'contradictory';

export class ProcessDomainError extends Error {
  constructor(
    readonly reason: ProcessDomainFailure,
    message: string
  ) {
    super(message);
    this.name = 'ProcessDomainError';
  }
}

function trimmed(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new ProcessDomainError('invalid', `process_domain_invalid:${field}`);
  const result = value.trim();
  if (result.length === 0) throw new ProcessDomainError('invalid', `process_domain_invalid:${field}`);
  return result;
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0)
    throw new ProcessDomainError('invalid', `process_domain_invalid:${field}`);
  return value;
}

/**
 * Machine and boot ids are trimmed exactly as every previous producer did; the
 * namespace keeps its bytes. Missing or blank evidence is invalid, never guessed.
 */
export function validateProcessDomainInputs(inputs: ProcessDomainInputs): ProcessDomainInputs {
  return {
    machineId: trimmed(inputs.machineId, 'machineId'),
    bootId: trimmed(inputs.bootId, 'bootId'),
    pidNamespace: nonEmpty(inputs.pidNamespace, 'pidNamespace'),
  };
}

/** Caller / ProcessKey form: the JSON domain that already carries boot identity. */
function callerDomain(inputs: ProcessDomainInputs): CallerPidDomain {
  return JSON.stringify(['linux', inputs.machineId, inputs.bootId, inputs.pidNamespace]) as CallerPidDomain;
}

/** Run / ProcessStamp form: machine-id hash plus namespace; boot_id stays a separate field. */
function runDomain(inputs: ProcessDomainInputs): RunPidDomain {
  return `${createHash('sha256').update(inputs.machineId, 'utf8').digest('hex')}:${inputs.pidNamespace}` as RunPidDomain;
}

/** Claude native registry form: only for that adapter's own file verification. */
function claudeDomain(inputs: ProcessDomainInputs): ClaudeRegistryPidDomain {
  return `linux:${inputs.machineId}:${inputs.pidNamespace}` as ClaudeRegistryPidDomain;
}

export function callerPidDomain(inputs: ProcessDomainInputs): CallerPidDomain {
  return callerDomain(validateProcessDomainInputs(inputs));
}

export function runPidDomain(inputs: ProcessDomainInputs): RunPidDomain {
  return runDomain(validateProcessDomainInputs(inputs));
}

export function claudeRegistryPidDomain(inputs: ProcessDomainInputs): ClaudeRegistryPidDomain {
  return claudeDomain(validateProcessDomainInputs(inputs));
}

/** All three forms from one validated input set; never compare one form against another. */
export function deriveProcessDomain(inputs: ProcessDomainInputs): DerivedProcessDomain {
  const validated = validateProcessDomainInputs(inputs);
  return {
    bootId: validated.bootId,
    pidDomain: callerDomain(validated),
    runPidDomain: runDomain(validated),
    claudePidDomain: claudeDomain(validated),
  };
}

function boundedText(path: string, max: number, noFollow = true): string {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (noFollow ? constants.O_NOFOLLOW : 0));
  } catch {
    throw new ProcessDomainError('unreadable', `process_domain_unreadable:${path}`);
  }
  try {
    const buffer = Buffer.alloc(max + 1);
    const n = readSync(fd, buffer, 0, buffer.length, 0);
    if (n > max) throw new ProcessDomainError('unreadable', `process_domain_unreadable:${path}`);
    return buffer.subarray(0, n).toString('utf8');
  } catch (error) {
    if (error instanceof ProcessDomainError) throw error;
    throw new ProcessDomainError('unreadable', `process_domain_unreadable:${path}`);
  } finally {
    closeSync(fd);
  }
}

/**
 * One bounded snapshot of the host facts. A /proc mounted for an ancestor PID
 * namespace cannot identify our numeric PIDs, so its evidence is contradictory
 * rather than a domain for this process. The machine-id policy is explicit:
 * hud-run historically followed a final symlink there, while MCP and the hook
 * have always refused one. The resolved content is validated once and all three
 * forms derive from this same input set.
 */
export function readProcessDomainInputs(options: ProcessDomainReadOptions = {}): ProcessDomainInputs {
  if (process.platform !== 'linux') throw new ProcessDomainError('unreadable', 'process_domain_unavailable:platform');
  const stat = boundedText('/proc/self/stat', 4096);
  if (Number(stat.split(' ', 1)[0]) !== process.pid)
    throw new ProcessDomainError('contradictory', 'process_domain_contradictory:pid');
  let pidNamespace: string;
  try {
    pidNamespace = readlinkSync('/proc/self/ns/pid');
  } catch {
    throw new ProcessDomainError('unreadable', 'process_domain_unreadable:pid_namespace');
  }
  return validateProcessDomainInputs({
    machineId: boundedText(
      options.machineIdPath ?? '/etc/machine-id',
      128,
      (options.machineIdPolicy ?? 'no-follow') !== 'follow'
    ),
    bootId: boundedText('/proc/sys/kernel/random/boot_id', 128),
    pidNamespace,
  });
}

export function readProcessDomain(options: ProcessDomainReadOptions = {}): DerivedProcessDomain {
  return deriveProcessDomain(readProcessDomainInputs(options));
}
