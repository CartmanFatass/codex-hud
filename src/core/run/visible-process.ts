import { spawn } from 'node:child_process';
import { readlinkSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { isatty } from 'node:tty';
import type { ExitObservation, ProcessScope, ProcessStamp } from '../types/supervision.js';
import { HEARTBEAT_INTERVAL_MS } from '../supervision.js';
import { readProcess, sameStamp, type GroupProcess, type ProcRecord } from './process.js';

/** Trusted profile data, transported with the private ticket, never a name heuristic. */
export interface VisibleProfile {
  expectedExecutable: string;
  shellPath?: string;
  strategy?: 'wrapper';
  capture?: 'tty_passthrough';
  dispatch?: 'fresh';
}
export interface VisibleProcess extends GroupProcess {
  harness: ProcessStamp | null;
  readonly shellExit: ExitObservation | null;
}

export function preflightVisible(profile: VisibleProfile | undefined): void {
  if (
    !profile ||
    !isAbsolute(profile.expectedExecutable ?? '') ||
    (profile.strategy !== undefined && profile.strategy !== 'wrapper') ||
    (profile.capture !== undefined && profile.capture !== 'tty_passthrough') ||
    (profile.dispatch !== undefined && profile.dispatch !== 'fresh')
  )
    throw new Error('unsupported_visible_profile_or_dispatch');
  realpathSync(profile.expectedExecutable);
  const self = readProcess(process.pid);
  if (!isatty(0) || !self || self.tty === 0 || self.foregroundPgid !== self.pgid || self.pgid !== self.stamp.pid)
    throw new Error('unsupported_visible_background_or_no_tty');
}

function descendant(pid: number, root: ProcessStamp, sid: number): boolean {
  const visited = new Set<number>();
  for (
    let current = readProcess(pid);
    current && !visited.has(current.stamp.pid);
    current = readProcess(current.ppid)
  ) {
    if (current.sid !== sid) return false;
    if (sameStamp(current.stamp, root)) return true;
    visited.add(current.stamp.pid);
  }
  return false;
}

/** Bounded startup observation only: foreground ownership plus executable and ancestry.
 * A wrapper in the same group is not silently treated as the harness. */
export function discoverVisibleHarness(
  command: ProcessStamp,
  expectedExecutable: string,
  supervisor: ProcRecord
): ProcRecord | null {
  const shell = readProcess(command.pid);
  if (!shell || !sameStamp(shell.stamp, command) || shell.sid !== supervisor.sid || shell.tty !== supervisor.tty)
    return null;
  // A terminal has one foreground PGID. Since this profile requires the harness
  // to lead that group, the kernel supplies the sole candidate directly: no
  // global procfs scan and no process-name or first-match inference.
  const record = readProcess(shell.foregroundPgid);
  if (
    !record ||
    record.state === 'Z' ||
    record.state === 'X' ||
    record.tty !== supervisor.tty ||
    record.sid !== supervisor.sid ||
    record.foregroundPgid !== record.pgid ||
    record.pgid === supervisor.pgid ||
    record.stamp.pid !== record.pgid ||
    !descendant(record.stamp.pid, command, supervisor.sid)
  )
    return null;
  try {
    if (readlinkSync(`/proc/${record.stamp.pid}/exe`) !== expectedExecutable) return null;
    const checked = readProcess(record.stamp.pid);
    const launcher = readProcess(command.pid);
    if (
      checked &&
      launcher &&
      sameStamp(launcher.stamp, command) &&
      launcher.foregroundPgid === record.pgid &&
      sameStamp(record.stamp, checked.stamp) &&
      checked.pgid === record.pgid &&
      checked.sid === record.sid &&
      checked.foregroundPgid === checked.pgid &&
      readlinkSync(`/proc/${checked.stamp.pid}/exe`) === expectedExecutable
    )
      return checked;
  } catch {
    /* incomplete identity is unknown */
  }
  return null;
}

/** 待 ARCH 裁决: procfs verification followed by kill(-pgid) cannot prevent
 * reuse during a kernel scheduling pause. No stable visible group-delivery
 * mechanism is authorised, so control is unavailable even for a matching live
 * leader. Never deliver to a numeric PGID or fall back to one PID. The existing
 * supervisor records cancel.unconfirmed on this refusal. G01 headless control
 * continues using its immutable in-group sender; it is not weakened here. */
export function signalVisibleScope(_scope: ProcessScope, _signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL'): boolean {
  return false;
}

export async function launchVisible(options: {
  runId: string;
  shellPath: string;
  shellArgs: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  profile: VisibleProfile;
}): Promise<VisibleProcess> {
  preflightVisible(options.profile);
  const supervisor = readProcess(process.pid)!;
  const executable = realpathSync(options.profile.expectedExecutable);
  const child = spawn(options.shellPath, options.shellArgs, { cwd: options.cwd, env: options.env, stdio: 'inherit' });
  // The synchronous stamp capture precedes any asynchronous discovery deadline.
  const command = child.pid ? (readProcess(child.pid)?.stamp ?? null) : null;
  let resolveExit!: (value: Awaited<GroupProcess['exited']>) => void;
  let shellExit: ExitObservation | null = null;
  let ended = false;
  let wakeDiscovery: (() => void) | undefined;
  const exited = new Promise<Awaited<GroupProcess['exited']>>((resolve) => {
    resolveExit = resolve;
  });
  const finish = (code: number | null, signal: string | null) => {
    if (ended) return;
    ended = true;
    const at = Date.now();
    if (command && (code !== null || signal !== null))
      shellExit = {
        process: command,
        subject: 'command_leader',
        observed_at: at,
        exit_code: code,
        signal,
        status_source: 'wait_status',
        evidence_id: `${options.runId}:shell:${at}`,
      };
    resolveExit({ source: 'native_unknown', subject: null, code: null, signal: null, at });
    wakeDiscovery?.();
  };
  child.once('exit', finish);
  child.once('error', () => finish(null, null));
  let harness: ProcRecord | null = null;
  // At most three scans, separated by the production heartbeat. Child exit wakes
  // immediately. No 100/200ms scans and no continuing scope watcher.
  for (let attempt = 0; command && attempt < 3 && !ended; attempt++) {
    harness = discoverVisibleHarness(command, executable, supervisor);
    if (harness) break;
    if (attempt < 2)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          wakeDiscovery = undefined;
          resolve();
        }, HEARTBEAT_INTERVAL_MS);
        wakeDiscovery = () => {
          clearTimeout(timer);
          wakeDiscovery = undefined;
          resolve();
        };
      });
  }
  const scope: ProcessScope | null = harness
    ? {
        scope_id: `${options.runId}:${harness.stamp.boot_id}:${harness.pgid}:${harness.stamp.proc_start}`,
        scope_kind: 'pgid',
        boot_id: harness.stamp.boot_id,
        pid_domain: harness.stamp.pid_domain,
        pgid: harness.pgid,
        sid: harness.sid,
        group_leader: harness.stamp,
      }
    : null;
  return {
    helper: command ?? supervisor.stamp,
    command,
    harness: harness?.stamp ?? null,
    scope,
    exited,
    get shellExit() {
      return shellExit;
    },
    signal: async (signal) => !!scope && signalVisibleScope(scope, signal),
    // There is no restartable submission/control stream in visible mode.
    close() {},
  };
}
