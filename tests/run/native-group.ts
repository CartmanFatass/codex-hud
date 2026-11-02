import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  currentDomain,
  readProcess,
  sameStamp,
  type GroupLaunchOptions,
  type GroupProcess,
} from '../../src/core/run/process.js';
import type { GroupExit, ProcessScope, ProcessStamp } from '../../src/core/types/supervision.js';
import { RUN_NODE_FLAGS } from '../../src/core/run/runtime.js';
// Include the test-only subprocess entry in build:test without executing it here.
import type {} from './group-helper.js';

/** Test-only real ChildProcess waiter for the production native-result projection seam. */
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
