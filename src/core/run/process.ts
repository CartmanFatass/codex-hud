import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { GroupExit, ProcessScope, ProcessStamp } from '../types/supervision.js';
import { GROUP_LEADER_SCRIPT } from './group-leader.js';
import { createGroupPipe } from './group-pipe.js';
export type { GroupExit } from '../types/supervision.js';
import { readProcessDomain } from '../process-domain.js';
import { RUN_NODE_FLAGS } from './runtime.js';

export interface ProcRecord {
  stamp: ProcessStamp;
  state: string;
  flags: number;
  pgid: number;
  sid: number;
}

export interface RunProcessDomainOptions {
  /** Test seam; production uses /etc/machine-id. The run path always follows a final symlink. */
  readonly machineIdPath?: string;
}

let domain: { boot_id: string; pid_domain: string } | undefined;
export function currentDomain(options?: RunProcessDomainOptions): { boot_id: string; pid_domain: string } {
  if (options?.machineIdPath !== undefined) {
    const view = readProcessDomain({ machineIdPolicy: 'follow', machineIdPath: options.machineIdPath });
    return { boot_id: view.bootId, pid_domain: view.runPidDomain };
  }
  if (!domain) {
    // Consult 5 G08: the shared reader validates procfs, machine and boot evidence
    // once; currentDomain stays the single Run-stamp production entry. The run
    // producer historically followed a final /etc/machine-id symlink, so it opts
    // into the follow policy while MCP and the hook keep no-follow.
    const view = readProcessDomain({ machineIdPolicy: 'follow' });
    domain = { boot_id: view.bootId, pid_domain: view.runPidDomain };
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
    flags: Number(fields[6]),
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

export interface ShellWaitDiagnostic {
  source: 'posix_shell_wait';
  observer: ProcessStamp;
  subject: ProcessStamp | null;
  /** Encoded status, never an exact native code or signal. Private diagnostic only. */
  status: number;
}

export interface GroupProcess {
  helper: ProcessStamp;
  command: ProcessStamp | null;
  scope: ProcessScope | null;
  /** Resolves only after helper wait; absent command wait status remains null. */
  exited: Promise<GroupExit>;
  readonly shellDiagnostic?: ShellWaitDiagnostic | null;
  signal(signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL'): Promise<boolean>;
  /** Permanently seals submission; existing command continues after disconnect. */
  close(): void;
}

/** Compatibility waiter, retained for sourced native-result tests; no production switch. */
export async function launchNodeGroup(options: GroupLaunchOptions): Promise<GroupProcess> {
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
      resolveExit(wait ?? { source: 'native_unknown', subject: null, code: null, signal: null, at: Date.now() });
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

const ENV_PATH = '/usr/bin/env';
let envPreflightPassed = false;
/** One cold startup preflight, before submission. Never silently selects Node. */
export function preflightGroupEnvironment(envPath = ENV_PATH): void {
  if (envPath === ENV_PATH && envPreflightPassed) return;
  const expected = '-u=synthetic $\\n ${literal}\n';
  const result = spawnSync(envPath, ['--default-signal=INT,QUIT', '-S', '-i -- ${HUD_ENV_PROBE}', ENV_PATH, '-0'], {
    env: { HUD_ENV_PROBE: expected },
    encoding: 'buffer',
    timeout: 2000,
  });
  if (result.error || result.status !== 0 || !result.stdout?.equals(Buffer.from(`${expected}\0`))) {
    throw new Error('headless_env_features_unavailable');
  }
  if (envPath === ENV_PATH) envPreflightPassed = true;
}

export function preflightGroupLaunch(argv: readonly string[]): void {
  // 待 ARCH 裁决: GNU env treats any executable containing '=' as an assignment.
  // Options: refuse / Node only for this case / require env with --argv0.
  // Refuse BEFORE ticket registration; never let env print the user environment.
  if (argv[0]?.includes('=')) throw new Error('headless_executable_assignment_unsupported');
  preflightGroupEnvironment();
}

/** Original names/values go only through environ. GNU env -S expands references
 * once, without field splitting or recursive interpretation of their contents.
 * The -- terminates option parsing BEFORE even a name beginning '-' is restored.
 */
export function encodeGroupEnvironment(original: NodeJS.ProcessEnv): {
  env: NodeJS.ProcessEnv;
  expansion: string;
} {
  // This unreferenced marker also distinguishes pre-env fork from final exec
  // when the requested workload environment is completely empty.
  const env: NodeJS.ProcessEnv = { HUD_ENV_GUARD: 'bootstrap-only' };
  const entries: string[] = [];
  let index = 0;
  for (const [name, value] of Object.entries(original)) {
    if (value === undefined) continue;
    if (!name || name.includes('=') || name.includes('\0') || value.includes('\0'))
      throw new Error('headless_environment_invalid');
    const entry = `${name}=${value}`;
    // Linux limits each execve argument/environment string to 32 pages. Refuse
    // before starting a helper rather than letting env fail a later harness exec.
    if (Buffer.byteLength(entry) + 1 > 131072) throw new Error('headless_environment_too_large');
    let references = '';
    for (let start = 0; start < entry.length;) {
      let end = Math.min(start + 16000, entry.length);
      // Do not split a surrogate pair before UTF-8 encoding each environ entry.
      if (end < entry.length && /[\uD800-\uDBFF]/.test(entry[end - 1])) end--;
      const transport = `HUD_ENV_${index++}`;
      env[transport] = entry.slice(start, end);
      references += `\${${transport}}`;
      start = end;
    }
    entries.push(references);
  }
  const expansion = `-i -- ${entries.join(' ')}`;
  if (Buffer.byteLength(expansion) > 65536) throw new Error('headless_environment_too_large');
  return { env, expansion };
}

export async function launchGroup(options: GroupLaunchOptions): Promise<GroupProcess> {
  return launchShellGroup(options, { path: '/bin/sh' });
}

/** Trusted test composition only; no helper-shell or backend CLI setting. */
export async function launchShellGroup(
  options: GroupLaunchOptions,
  shell: { path: string; argv0?: string; args?: readonly string[] }
): Promise<GroupProcess> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(options.runId) || options.argv.length === 0 || !options.argv[0])
    throw new Error('invalid group launch');
  currentDomain();
  preflightGroupLaunch(options.argv);
  const transport = encodeGroupEnvironment(options.env ?? process.env);
  const commandArgv = [ENV_PATH, '--default-signal=INT,QUIT', '-S', transport.expansion, ...options.argv];
  const pipe = createGroupPipe();
  let child: ChildProcess;
  try {
    child = spawn(shell.path, [...(shell.args ?? []), '-c', GROUP_LEADER_SCRIPT, 'hud-group-leader', ...commandArgv], {
      argv0: shell.argv0,
      detached: true,
      cwd: options.cwd,
      env: transport.env,
      stdio: ['pipe', options.stdoutFd, options.stderrFd, 'pipe', 'pipe', 'ignore', pipe.read, pipe.write],
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'E2BIG') throw new Error('headless_environment_too_large');
    throw new Error('headless_leader_spawn_failed');
  } finally {
    pipe.close();
  }
  const helperArgv = [
    shell.argv0 ?? shell.path,
    ...(shell.args ?? []),
    '-c',
    GROUP_LEADER_SCRIPT,
    'hud-group-leader',
    ...commandArgv,
  ];
  return connectShellGroup(
    child,
    options,
    Buffer.from(`${commandArgv.join('\0')}\0`),
    Buffer.from(`${helperArgv.join('\0')}\0`)
  );
}

function connectShellGroup(
  child: ChildProcess,
  options: GroupLaunchOptions,
  bootstrapCommandline: Buffer,
  helperCommandline: Buffer
): Promise<GroupProcess> {
  // Snapshot before yielding: mutation of the caller's object cannot move the
  // successful-exec predicate. /proc/environ records the initial exec image;
  // env's userspace clearenv/setenv cannot turn its bootstrap image into this.
  const expectedEnvironment = Object.entries(options.env ?? process.env)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => Buffer.from(`${name}=${value}\0`))
    .sort(Buffer.compare);
  const environmentMatches = (pid: number): boolean => {
    try {
      const argv = readFileSync(`/proc/${pid}/cmdline`);
      if (argv.length === 0 || argv.equals(bootstrapCommandline) || argv.equals(helperCommandline)) return false;
      const raw = readFileSync(`/proc/${pid}/environ`);
      const entries: Buffer[] = [];
      let start = 0;
      for (let end = 0; end < raw.length; end++)
        if (raw[end] === 0) {
          entries.push(raw.subarray(start, end + 1));
          start = end + 1;
        }
      entries.sort(Buffer.compare);
      return (
        start === raw.length &&
        entries.length === expectedEnvironment.length &&
        entries.every((entry, i) => entry.equals(expectedEnvironment[i])) &&
        readFileSync(`/proc/${pid}/cmdline`).equals(argv)
      );
    } catch {
      return false;
    }
  };
  return new Promise((resolve, reject) => {
    const control = child.stdio[3] as Writable;
    const replies = child.stdio[4] as Readable;
    let helper: ProcessStamp | null = null;
    let scope: ProcessScope | null = null;
    let command: ProcessStamp | null = null;
    let waiter: ProcessStamp | null = null;
    let started = false,
      sealed = false,
      childExited = false,
      repliesEnded = false;
    let diagnostic: ShellWaitDiagnostic | null = null;
    let seq = 0,
      buffer = '';
    const pending = new Map<number, (sent: boolean) => void>();
    let resolveExit!: (exit: GroupExit) => void;
    const exited = new Promise<GroupExit>((done) => {
      resolveExit = done;
    });
    const close = () => {
      sealed = true;
      clearTimeout(timer);
      control.end();
      child.stdin?.end();
      for (const done of pending.values()) done(false);
      pending.clear();
    };
    const timer = setTimeout(() => {
      close();
      reject(new Error('group startup unconfirmed; submission must not be retried'));
    }, 10000);
    const finish = () => {
      if (!childExited || !repliesEnded) return;
      clearTimeout(timer);
      close();
      resolveExit({ source: 'native_unknown', subject: null, code: null, signal: null, at: Date.now() });
      if (!started) reject(new Error('group helper exited before confirmed submission'));
    };
    control.on('error', () => close());
    child.stdin?.on('error', () => {});
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      close();
      reject(new Error(error.code === 'E2BIG' ? 'headless_environment_too_large' : 'headless_leader_spawn_failed'));
    });
    child.on('exit', () => {
      childExited = true;
      finish();
    });
    replies.on('end', () => {
      repliesEnded = true;
      finish();
    });
    replies.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('ascii');
      if (buffer.length > 8192) {
        close();
        return;
      }
      let boundary: number;
      while ((boundary = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 1);
        if (line === 'READY' && !helper && !sealed) {
          const record = readProcess(child.pid ?? -1);
          if (!record || record.pgid !== child.pid || record.sid !== child.pid) {
            close();
            continue;
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
          control.write('RUN\n');
        } else if (/^STARTED [0-9]+$/.test(line) && helper && scope && !started) {
          const forked = readProcess(Number(line.slice(8)));
          // STARTED reports the shell fork, not successful exec. Only the kernel
          // initial-environ transition confirms env execed the workload. These
          // finitely scheduled, per-PID startup probes never run at idle.
          void (async () => {
            for (const delayMs of [0, 1, 2, 4, 8, 16, 32, 64]) {
              if (delayMs) await new Promise<void>((done) => setTimeout(done, delayMs));
              if (sealed || childExited || !forked) return;
              const current = readProcess(forked.stamp.pid);
              if (!current || !sameStamp(current.stamp, forked.stamp)) return;
              if (current.state === 'Z' || current.state === 'X') return;
              if (current.flags & 0x44) continue; // Linux PF_FORKNOEXEC / PF_EXITING
              if (!environmentMatches(current.stamp.pid)) continue;
              // Zombie environ is empty too. A live matching stamp on both
              // sides of the read excludes failed-exec death for env={}.
              const confirmed = readProcess(current.stamp.pid);
              if (
                !confirmed ||
                !sameStamp(confirmed.stamp, current.stamp) ||
                confirmed.state === 'Z' ||
                confirmed.state === 'X' ||
                (confirmed.flags & 0x44) !== 0
              )
                return;
              acceptStarted(confirmed);
              return;
            }
            close();
            reject(new Error('group command exec unconfirmed; submission must not be retried'));
          })();
        } else if (/^WAITER [0-9]+$/.test(line) && helper && scope) {
          const record = readProcess(Number(line.slice(7)));
          if (record && record.pgid === scope.pgid && record.sid === scope.sid) waiter = record.stamp;
        } else if (/^ACK [0-9]+$/.test(line)) {
          const request = Number(line.slice(4));
          pending.get(request)?.(true);
          pending.delete(request);
        } else if (/^WAIT [0-9]+$/.test(line) && helper) {
          if (waiter)
            diagnostic = {
              source: 'posix_shell_wait',
              observer: waiter!,
              subject: command,
              status: Number(line.slice(5)),
            };
          close();
        }
      }
    });
    const acceptStarted = (record: ProcRecord) => {
      if (started || sealed || !helper || !scope) return;
      started = true;
      clearTimeout(timer);
      command = record.pgid === scope.pgid && record.sid === scope.sid ? record.stamp : null;
      const fixedScope = command ? scope : null;
      child.stdin?.end(options.stdin ?? undefined);
      resolve({
        helper,
        command,
        scope: fixedScope,
        exited,
        get shellDiagnostic() {
          return diagnostic;
        },
        close,
        signal: (signal) =>
          new Promise<boolean>((done) => {
            const now = readProcess(helper!.pid);
            if (
              sealed ||
              !fixedScope ||
              !now ||
              now.state === 'Z' ||
              !sameStamp(now.stamp, helper!) ||
              now.pgid !== fixedScope.pgid ||
              now.sid !== fixedScope.sid ||
              !sameStamp(fixedScope.group_leader, helper!) ||
              !['SIGINT', 'SIGTERM', 'SIGKILL'].includes(signal)
            ) {
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
            control.write(`${signal.slice(3)} ${request}\n`, (error) => {
              if (error) {
                pending.get(request)?.(false);
                pending.delete(request);
              }
            });
          }),
      });
    };
  });
}
