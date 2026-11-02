import { spawn, type ChildProcess } from 'node:child_process';
import { readProcess, sameStamp, type GroupExit } from '../../src/core/run/process.js';
import type { ProcessScope, ProcessStamp } from '../../src/core/types/supervision.js';

/** One run, one IPC submission, no idle timers and no scope enumeration. */
const self = readProcess(process.pid);
if (!self || self.pgid !== process.pid || self.sid !== process.pid || !process.send) process.exit(1);
let submitted = false;
let disconnected = false;
let scope: ProcessScope | null = null;
let command: ChildProcess | null = null;
let fixed = false;
let subject: ProcessStamp | null = null;
process.on('SIGINT', () => {});
process.on('SIGTERM', () => {});

function send(message: object, after?: () => void): void {
  if (!process.connected || disconnected) {
    after?.();
    return;
  }
  process.send!(message, () => after?.());
}

function targetMatches(helper: ProcessStamp, requested: ProcessScope): boolean {
  const now = readProcess(process.pid);
  return (
    !!now &&
    !!self &&
    sameStamp(now.stamp, self.stamp) &&
    sameStamp(helper, self.stamp) &&
    requested.scope_kind === 'pgid' &&
    requested.pgid === now.pgid &&
    requested.sid === now.sid &&
    requested.pgid === process.pid &&
    requested.boot_id === now.stamp.boot_id &&
    requested.pid_domain === now.stamp.pid_domain &&
    sameStamp(requested.group_leader, self.stamp) &&
    (!scope || JSON.stringify(requested) === JSON.stringify(scope))
  );
}

process.on('disconnect', () => {
  disconnected = true;
  submitted = true; // irrevocable: disconnect never grants a replacement submission
  if (!command) process.exit(0);
});

process.on('message', (raw) => {
  const message = raw as {
    type: string;
    helper: ProcessStamp;
    scope: ProcessScope;
    argv: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    seq: number;
    signal: string;
  };
  if (message.type === 'submit') {
    if (submitted || disconnected) return;
    submitted = true;
    if (!targetMatches(message.helper, message.scope) || !Array.isArray(message.argv) || !message.argv[0]) {
      send({ type: 'failed' }, () => process.exit(1));
      return;
    }
    scope = message.scope;
    try {
      command = spawn(message.argv[0], message.argv.slice(1), {
        cwd: message.cwd,
        env: message.env,
        stdio: ['inherit', 'inherit', 'inherit'],
      });
      command.once('spawn', () => {
        const record = readProcess(command!.pid!);
        fixed = !!record && record.pgid === scope!.pgid && record.sid === scope!.sid;
        subject = fixed ? record!.stamp : null;
        send({ type: 'started', command: fixed ? record!.stamp : null, scope: fixed ? scope : null });
      });
      command.once('error', () => send({ type: 'failed' }, () => process.exit(1)));
      command.once('exit', (code, signal) => {
        const exit: GroupExit = subject
          ? { source: 'verified_wait', subject, code, signal, at: Date.now() }
          : { source: 'native_unknown', subject: null, code: null, signal: null, at: Date.now() };
        send({ type: 'wait', exit }, () => process.exit(0));
      });
    } catch {
      send({ type: 'failed' }, () => process.exit(1));
    }
  } else if (message.type === 'signal') {
    let sent = false;
    if (
      fixed &&
      !disconnected &&
      scope &&
      targetMatches(message.helper, message.scope) &&
      ['SIGINT', 'SIGTERM', 'SIGKILL'].includes(message.signal)
    ) {
      try {
        // The kernel selects OUR still-live group atomically; numeric PGID reuse
        // between parent verification and this syscall cannot target another group.
        process.kill(0, message.signal as NodeJS.Signals);
        sent = true;
      } catch {
        /* loss of control is an unconfirmed cancellation */
      }
    }
    // SIGKILL kills this helper before acknowledgement. Parent reports false,
    // retaining unknown wait status until independent complete scope proof.
    send({ type: 'signal-result', seq: message.seq, sent });
  }
});

send({ type: 'ready', helper: self!.stamp });
