import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readlinkSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ProcessScope, ProcessStamp } from '../types/supervision.js';
import { RUN_NODE_FLAGS } from './runtime.js';

export interface ProcRecord {
  stamp: ProcessStamp;
  state: string;
  pgid: number;
  sid: number;
}

let domain: { boot_id: string; pid_domain: string } | undefined;
export function currentDomain(): { boot_id: string; pid_domain: string } {
  if (process.platform !== 'linux') throw new Error('hud-run requires Linux process evidence');
  if (!domain) {
    // A procfs mounted for an ancestor PID namespace cannot identify our numeric
    // PIDs. Do not label observations from that mount as the current domain.
    if (Number(readFileSync('/proc/self/stat', 'utf8').split(' ', 1)[0]) !== process.pid) {
      throw new Error('procfs does not expose the current PID namespace');
    }
    const machine = readFileSync('/etc/machine-id', 'utf8').trim();
    domain = {
      boot_id: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
      pid_domain: `${createHash('sha256').update(machine).digest('hex')}:${readlinkSync('/proc/self/ns/pid')}`,
    };
  }
  return { ...domain };
}

function readRecord(pid: number): ProcRecord {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('invalid pid');
  const text = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = text
    .slice(text.lastIndexOf(')') + 2)
    .trim()
    .split(/\s+/);
  if (!/^\d+$/.test(fields[19] ?? '')) throw new Error('invalid process stat');
  return {
    stamp: { pid, proc_start: fields[19], ...currentDomain() },
    state: fields[0],
    pgid: Number(fields[2]),
    sid: Number(fields[3]),
  };
}

export function readProcess(pid: number): ProcRecord | null {
  try {
    return readRecord(pid);
  } catch {
    return null;
  }
}

export function sameStamp(a: ProcessStamp, b: ProcessStamp): boolean {
  return a.pid === b.pid && a.proc_start === b.proc_start && a.boot_id === b.boot_id && a.pid_domain === b.pid_domain;
}

function visible(stamp: Pick<ProcessStamp, 'boot_id' | 'pid_domain'>): boolean {
  try {
    const here = currentDomain();
    return stamp.boot_id === here.boot_id && stamp.pid_domain === here.pid_domain;
  } catch {
    return false;
  }
}

export function processState(stamp: ProcessStamp): 'alive' | 'dead' | 'unknown' {
  if (!visible(stamp)) return 'unknown';
  try {
    const record = readRecord(stamp.pid);
    return !sameStamp(record.stamp, stamp) || record.state === 'Z' || record.state === 'X' ? 'dead' : 'alive';
  } catch (error) {
    if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return 'unknown';
    try {
      // hidepid and a credential-changing escaped child can make procfs report
      // ENOENT for a living PID. Kernel absence must corroborate a missing stat.
      process.kill(stamp.pid, 0);
      return 'unknown';
    } catch (probeError) {
      return (probeError as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'unknown';
    }
  }
}

export interface GroupInspection {
  result: 'alive' | 'gone' | 'unknown';
  /** A single enumeration never constitutes an atomic complete scope observation. */
  complete: false;
  enumerated: boolean;
  members: ProcRecord[];
}

/** The optional boundary is solely for bounded race tests, never a periodic observer. */
export function inspectGroup(scope: ProcessScope, afterSnapshot?: () => void): GroupInspection {
  const result: GroupInspection = { result: 'unknown', complete: false, enumerated: false, members: [] };
  if (
    !visible(scope) ||
    !visible(scope.group_leader) ||
    scope.scope_kind !== 'pgid' ||
    !Number.isSafeInteger(scope.pgid) ||
    scope.pgid <= 0 ||
    !Number.isSafeInteger(scope.sid) ||
    scope.sid <= 0 ||
    scope.group_leader.pid !== scope.pgid
  )
    return result;
  try {
    const pids = readdirSync('/proc').filter((name) => /^\d+$/.test(name));
    afterSnapshot?.();
    let readable = true;
    for (const name of pids) {
      try {
        const record = readRecord(Number(name));
        if (record.pgid === scope.pgid && record.sid === scope.sid) result.members.push(record);
      } catch (error) {
        if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) readable = false;
      }
    }
    result.enumerated = readable;
    // Numeric PGID/SID membership is not historical-instance identity. If the
    // original leader is gone/replaced, members remain diagnostic and block
    // absence, but cannot become accepted old-scope alive counter-evidence.
    const leader = readProcess(scope.group_leader.pid);
    if (
      leader &&
      sameStamp(leader.stamp, scope.group_leader) &&
      leader.pgid === scope.pgid &&
      leader.sid === scope.sid &&
      result.members.some((member) => member.state !== 'Z' && member.state !== 'X')
    )
      result.result = 'alive';
  } catch {
    // Missing visibility is never absence evidence.
  }
  return result;
}

/** Caller must additionally prove its single submission channel is permanently sealed. */
export function proveGroupGone(
  scope: ProcessScope,
  harness: ProcessStamp,
  launchers: readonly ProcessStamp[]
): boolean {
  if (!visible(scope) || !launchers.some((stamp) => sameStamp(stamp, scope.group_leader))) return false;
  if (processState(harness) !== 'dead' || launchers.some((stamp) => processState(stamp) !== 'dead')) return false;
  const inspection = inspectGroup(scope);
  if (!inspection.enumerated || inspection.members.length !== 0) return false;
  try {
    // Signal zero is an existence query only. Deliverable signals exclusively use
    // the live helper's own process group, never a parent-side numeric PGID.
    process.kill(-scope.pgid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

export interface GroupLaunchOptions {
  runId: string;
  argv: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdin: Buffer | null;
  stdoutFd: number;
  stderrFd: number;
}

export interface GroupExit {
  code: number | null;
  signal: string | null;
  at: number;
}

export interface GroupProcess {
  helper: ProcessStamp;
  command: ProcessStamp | null;
  scope: ProcessScope | null;
  /** Resolves only after helper wait; absent command wait status remains null. */
  exited: Promise<GroupExit>;
  signal(signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL'): Promise<boolean>;
  /** Permanently seals submission; existing command continues after disconnect. */
  close(): void;
}

export async function launchGroup(options: GroupLaunchOptions): Promise<GroupProcess> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(options.runId) || options.argv.length === 0 || !options.argv[0]) {
    throw new Error('invalid group launch');
  }
  currentDomain();
  const child = spawn(
    process.execPath,
    [...RUN_NODE_FLAGS, fileURLToPath(new URL('./group-helper.js', import.meta.url))],
    {
      detached: true,
      cwd: options.cwd,
      stdio: ['pipe', options.stdoutFd, options.stderrFd, 'ipc'],
    }
  );
  return connectGroup(child, options);
}

function connectGroup(child: ChildProcess, options: GroupLaunchOptions): Promise<GroupProcess> {
  return new Promise((resolve, reject) => {
    let helper: ProcessStamp | null = null;
    let scope: ProcessScope | null = null;
    let started = false;
    let childExited = false;
    let ipcClosed = false;
    let wait: GroupExit | null = null;
    let seq = 0;
    const pending = new Map<number, (sent: boolean) => void>();
    let resolveExit!: (exit: GroupExit) => void;
    const exited = new Promise<GroupExit>((done) => {
      resolveExit = done;
    });
    const timer = setTimeout(() => {
      close();
      reject(new Error('group startup unconfirmed; submission must not be retried'));
    }, 10_000);
    const close = () => {
      if (child.connected) child.disconnect();
      child.stdin?.end();
      for (const done of pending.values()) done(false);
      pending.clear();
    };
    child.stdin?.on('error', () => {});
    child.on('error', (error) => {
      clearTimeout(timer);
      close();
      reject(error);
    });
    const finish = () => {
      if (!childExited || !ipcClosed) return;
      clearTimeout(timer);
      close();
      resolveExit(wait ?? { code: null, signal: null, at: Date.now() });
      if (!started) reject(new Error('group helper exited before confirmed submission'));
    };
    child.on('disconnect', () => {
      ipcClosed = true;
      for (const done of pending.values()) done(false);
      pending.clear();
      finish();
    });
    // Wait for both kernel wait and IPC EOF, without waiting on inherited stdin
    // descriptors that an escaped descendant may retain.
    child.on('exit', () => {
      childExited = true;
      finish();
    });
    child.on('message', (raw) => {
      const message = raw as {
        type: string;
        helper?: ProcessStamp;
        command?: ProcessStamp | null;
        scope?: ProcessScope | null;
        exit?: GroupExit;
        seq?: number;
        sent?: boolean;
      };
      if (message.type === 'ready' && !helper && message.helper) {
        const record = readProcess(child.pid ?? -1);
        if (
          !record ||
          !sameStamp(record.stamp, message.helper) ||
          record.pgid !== child.pid ||
          record.sid !== child.pid
        ) {
          close();
          return;
        }
        helper = record.stamp;
        scope = {
          scope_id: `${options.runId}:${helper.boot_id}:${helper.pid}:${helper.proc_start}`,
          scope_kind: 'pgid',
          boot_id: helper.boot_id,
          pid_domain: helper.pid_domain,
          pgid: record.pgid,
          sid: record.sid,
          group_leader: helper,
        };
        child.send({
          type: 'submit',
          helper,
          scope,
          argv: options.argv,
          cwd: options.cwd,
          env: options.env ?? process.env,
        });
      } else if (message.type === 'started' && helper && !started) {
        started = true;
        clearTimeout(timer);
        const fixedScope = message.command && message.scope ? scope : null;
        child.stdin?.end(options.stdin ?? undefined);
        resolve({
          helper,
          command: message.command ?? null,
          scope: fixedScope,
          exited,
          signal: (signal) =>
            new Promise<boolean>((done) => {
              if (!fixedScope || !child.connected) {
                done(false);
                return;
              }
              const request = ++seq;
              const deadline = setTimeout(() => {
                pending.delete(request);
                done(false);
              }, 2000);
              pending.set(request, (sent) => {
                clearTimeout(deadline);
                done(sent);
              });
              child.send({ type: 'signal', seq: request, helper, scope: fixedScope, signal }, (error) => {
                if (error) {
                  pending.get(request)?.(false);
                  pending.delete(request);
                }
              });
            }),
          close,
        });
      } else if (message.type === 'wait' && message.exit) {
        wait = message.exit;
      } else if (message.type === 'signal-result' && message.seq !== undefined) {
        pending.get(message.seq)?.(message.sent === true);
        pending.delete(message.seq);
      } else if (message.type === 'failed') {
        clearTimeout(timer);
        close();
        reject(new Error('command spawn failed; submission is permanently sealed'));
      }
    });
  });
}
