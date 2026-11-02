import { closeSync, constants, openSync, readSync, readlinkSync, realpathSync } from 'node:fs';
import { basename } from 'node:path';
import {
  deriveProcessDomain,
  readProcessDomainInputs,
  type ProcessDomainInputs,
} from '../../../../src/core/process-domain.js';
import type { CallerPidDomain, ClaudeRegistryPidDomain } from '../../../../src/core/types/identity.js';
import { hash, type HookConfig } from './record.js';

function bounded(path: string, max: number): string {
  // /proc pseudo-files report size zero. readFileSync would permit an unbounded env read.
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const buffer = Buffer.alloc(max + 1);
    const n = readSync(fd, buffer, 0, buffer.length, 0);
    if (n > max) throw new Error('Process evidence exceeds bound');
    return buffer.subarray(0, n).toString('utf8');
  } finally {
    closeSync(fd);
  }
}
export function proc(pid: number) {
  const stat = bounded(`/proc/${pid}/stat`, 4096).split(') ').at(-1)!.trim().split(/\s+/);
  if (!stat[19] || !/^\d+$/.test(stat[19])) throw new Error('Invalid process stat');
  return { pid, ppid: Number(stat[1]), start: stat[19], namespace: readlinkSync(`/proc/${pid}/ns/pid`) };
}
/** /proc starttime and uptime use BOOTTIME; hrtime uses MONOTONIC. Map the
 * rounded-down kernel start to a conservative monotonic lower bound. Both
 * /proc values have 10ms resolution; bracket the uptime read to bound its cost.
 */
export function bootStartToMonotonic(
  bootStartMs: number,
  uptimeFloorMs: number,
  monoBeforeMs: number,
  monoAfterMs: number
): { hookStartMonoMs: number; hookStartUncertaintyMs: number } {
  if (
    ![bootStartMs, uptimeFloorMs, monoBeforeMs, monoAfterMs].every(Number.isFinite) ||
    bootStartMs < 0 ||
    uptimeFloorMs < bootStartMs ||
    monoAfterMs < monoBeforeMs
  )
    throw new Error('Invalid process clock sample');
  return {
    hookStartMonoMs: monoBeforeMs + bootStartMs - uptimeFloorMs - 10,
    hookStartUncertaintyMs: 20 + monoAfterMs - monoBeforeMs,
  };
}
function hookStart(bootStartMs: number) {
  const before = Number(process.hrtime.bigint()) / 1e6;
  const uptime = Number(bounded('/proc/uptime', 128).split(' ')[0]) * 1000;
  const after = Number(process.hrtime.bigint()) / 1e6;
  return bootStartToMonotonic(bootStartMs, uptime, before, after);
}
/** The hook's only domain construction: shared derivation plus chain-namespace agreement. */
export function verifiedLaunchDomain(
  inputs: ProcessDomainInputs,
  chainNamespace: string
): { pidDomain: CallerPidDomain; claudePidDomain: ClaudeRegistryPidDomain } {
  if (inputs.pidNamespace !== chainNamespace) throw new Error('Wrong Claude source/domain');
  const domain = deriveProcessDomain(inputs);
  return { pidDomain: domain.pidDomain, claudePidDomain: domain.claudePidDomain };
}
/** Env/config locate the source; live ancestry, executable and instance prove it. */
export function verifyLaunch(config: HookConfig, startPid = process.pid) {
  const first = proc(startPid);
  const chain = [first];
  let current = first;
  for (let depth = 0; depth < 8; depth++) {
    if (current.ppid <= 1) break;
    current = proc(current.ppid);
    chain.push(current);
    const args = bounded(`/proc/${current.pid}/cmdline`, 32768).split('\0').filter(Boolean);
    if (basename(args[0] ?? '') !== 'claude') continue;
    if (
      args.some((a) =>
        /^(--agent(?:=|$)|--teammate-mode(?:=|$)|--agent-id(?:=|$)|--bare$|--safe-mode$|daemon$)/.test(a)
      )
    )
      throw new Error('Unsupported Claude launch profile');
    if (readlinkSync(`/proc/${current.pid}/exe`) !== config.claudeExecutable)
      throw new Error('Wrong Claude executable');
    const entries = bounded(`/proc/${current.pid}/environ`, 131072).split('\0');
    const env: Record<string, string> = {};
    for (const item of entries) {
      const at = item.indexOf('=');
      if (['HOME', 'CLAUDE_CONFIG_DIR'].includes(item.slice(0, at))) env[item.slice(0, at)] = item.slice(at + 1);
    }
    const root = realpathSync(env.CLAUDE_CONFIG_DIR || `${env.HOME}/.claude`);
    if (root !== config.sourceRoot || chain.some((p) => p.namespace !== first.namespace))
      throw new Error('Wrong Claude source/domain');
    let inputs: ProcessDomainInputs;
    try {
      inputs = readProcessDomainInputs();
    } catch {
      throw new Error('Wrong Claude source/domain');
    }
    const domain = verifiedLaunchDomain(inputs, first.namespace);
    for (const entry of chain) {
      const after = proc(entry.pid);
      if (after.start !== entry.start || after.ppid !== entry.ppid) throw new Error('Launch chain changed');
    }
    const sourceId = hash(['claude', root]);
    return {
      processKey: JSON.stringify(['claude', sourceId, domain.pidDomain, current.pid, current.start]),
      sourceId,
      bootId: inputs.bootId,
      harnessPid: current.pid,
      harnessStart: current.start,
      claudePidDomain: domain.claudePidDomain,
      ...hookStart(Number(chain[chain.length - 2].start) * (1000 / config.clockTicksPerSecond)),
    };
  }
  throw new Error('No verified Claude ancestor');
}
