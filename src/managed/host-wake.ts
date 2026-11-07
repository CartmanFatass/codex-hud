import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { dirname, isAbsolute, join } from 'node:path';
import type { NativeSessionHost } from './host.js';
import type { NativeOwner } from './relations.js';
import { nativeWakeDetails, nativeWakeMessage, type NativeWakeDetails } from './wake-message.js';

export type NativeWakeTarget =
  | { adapter: 'codex_queue'; executable: string; codexHome: string; threadId: string }
  | { adapter: 'pi_extension'; socketPath: string }
  | { adapter: 'claude_background_wait' }
  | { adapter: 'none'; reason: string };
export interface NativeWakeReceipt {
  result: 'accepted' | 'rejected' | 'unknown';
  reason?: string;
  code?: number | null;
  signal?: string | null;
  stdout?: string;
  stderr?: string;
}
const safe = (value: unknown): value is string =>
  typeof value === 'string' && !!value && !/[\x00-\x1f\x7f]/.test(value);
/** Metadata is supplied by trusted source composition, never arbitrary model arguments. */
export function validateNativeWakeTarget(home: string, owner: NativeOwner, value: unknown): NativeWakeTarget {
  const target = value as NativeWakeTarget;
  if (!target || typeof target !== 'object') throw new Error('invalid_native_wake_target');
  if (target.adapter === 'none' && safe(target.reason)) return target;
  if (target.adapter === 'claude_background_wait' && owner.harness === 'claude') return target;
  if (
    target.adapter === 'codex_queue' &&
    owner.harness === 'codex' &&
    safe(target.executable) &&
    isAbsolute(target.executable) &&
    safe(target.codexHome) &&
    isAbsolute(target.codexHome) &&
    target.threadId === (owner.threadId ?? owner.sessionId)
  )
    return target;
  if (
    target.adapter === 'pi_extension' &&
    owner.harness === 'pi' &&
    safe(target.socketPath) &&
    dirname(target.socketPath) === join(home, 'wake') &&
    /^pi-\d+-\d+\.sock$/.test(target.socketPath.slice(target.socketPath.lastIndexOf('/') + 1))
  )
    return target;
  throw new Error('invalid_native_wake_target');
}

/** One existing native transport invocation. Acceptance never means the model read it. */
export function sendNativeWake(
  target: NativeWakeTarget,
  owner: NativeOwner,
  details: NativeWakeDetails,
  timeoutMs = 2000
): Promise<NativeWakeReceipt> {
  const content = nativeWakeMessage(details);
  if (target.adapter === 'claude_background_wait')
    return Promise.resolve({ result: 'unknown', reason: 'native_background_waiter_required' });
  if (target.adapter === 'none') return Promise.resolve({ result: 'rejected', reason: target.reason });
  if (target.adapter === 'codex_queue')
    return new Promise((resolve) => {
      const child = spawn(target.executable, ['queue', '--thread', target.threadId, '--message', content], {
        env: { ...process.env, CODEX_HOME: target.codexHome },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let stdout = '',
        stderr = '',
        stopped: string | undefined,
        done = false;
      const finish = (receipt: NativeWakeReceipt) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        child.stdout.destroy();
        child.stderr.destroy();
        resolve({ ...receipt, stdout, stderr });
      };
      const stop = (reason: string) => {
        if (done || stopped) return;
        stopped = reason;
        // Only this short-lived queue helper, never the native backend or its process tree.
        child.kill('SIGKILL');
        child.stdout.destroy();
        child.stderr.destroy();
      };
      const timer = setTimeout(() => stop('timeout'), timeoutMs);
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
        if (Buffer.byteLength(stdout) > 4096) {
          stdout = Buffer.from(stdout).subarray(0, 4096).toString();
          stop('output_limit');
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
        if (Buffer.byteLength(stderr) > 4096) {
          stderr = Buffer.from(stderr).subarray(0, 4096).toString();
          stop('output_limit');
        }
      });
      child.once('error', (error) => finish({ result: 'rejected', reason: error.message }));
      child.once('exit', (code, signal) => {
        if (stopped) finish({ result: 'unknown', reason: stopped, code, signal });
      });
      child.once('close', (code, signal) =>
        finish({
          result: stopped ? 'unknown' : code === 0 ? 'accepted' : 'rejected',
          ...(stopped ? { reason: stopped } : {}),
          code,
          signal,
        })
      );
    });
  return new Promise((resolve) => {
    const socket = createConnection(target.socketPath);
    let input = '',
      connected = false,
      done = false;
    const finish = (receipt: NativeWakeReceipt) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(receipt);
    };
    const timer = setTimeout(() => finish({ result: 'unknown', reason: 'timeout' }), timeoutMs);
    socket.once('connect', () => {
      connected = true;
      socket.write(
        JSON.stringify({ parentSessionId: owner.sessionId, content, details, command: 'read native session' }) + '\n'
      );
    });
    socket.on('data', (chunk) => {
      input += chunk.toString('utf8');
      if (Buffer.byteLength(input) > 4096) return finish({ result: 'unknown', reason: 'output_limit' });
      if (!input.includes('\n')) return;
      try {
        const value = JSON.parse(input.slice(0, input.indexOf('\n')));
        if (
          !value ||
          !['accepted', 'rejected', 'unknown'].includes(value.result) ||
          (value.reason !== undefined && typeof value.reason !== 'string')
        )
          throw new Error();
        finish({ result: value.result, ...(value.reason ? { reason: value.reason } : {}) });
      } catch {
        finish({ result: 'unknown', reason: 'invalid_response' });
      }
    });
    socket.once('error', () => finish({ result: connected ? 'unknown' : 'rejected', reason: 'no_endpoint' }));
    socket.once('close', () => finish({ result: 'unknown', reason: 'no_response' }));
  });
}

/** Ephemeral endpoint + last transport fact only; no wake ledger, retry, expiry or backend control. */
export function attachNativeWake(
  home: string,
  host: Pick<NativeSessionHost, 'owner' | 'subscribe'>,
  send = sendNativeWake
) {
  let target: NativeWakeTarget = { adapter: 'none', reason: 'native_wake_not_registered' };
  let last: { eventSeq: number; receipt: NativeWakeReceipt } | undefined;
  const off = host.subscribe((message) => {
    const details = nativeWakeDetails(message);
    if (!details) return;
    void send(target, host.owner, details).then(
      (receipt) => {
        last = { eventSeq: message.seq, receipt };
      },
      (error) => {
        last = {
          eventSeq: message.seq,
          receipt: { result: 'unknown', reason: error instanceof Error ? error.message : String(error) },
        };
      }
    );
  });
  return {
    async invoke(method: string, args: Record<string, unknown>): Promise<unknown> {
      if (method === 'wake_register') target = validateNativeWakeTarget(home, host.owner, args.target);
      else if (method !== 'wake_status') throw new Error('unknown_native_wake_method');
      return {
        adapter: target.adapter,
        ...(target.adapter === 'none' ? { reason: target.reason } : {}),
        last,
        modelReadAcknowledged: false,
      };
    },
    register(value: unknown) {
      target = validateNativeWakeTarget(home, host.owner, value);
      return { adapter: target.adapter, modelReadAcknowledged: false };
    },
    status() {
      return {
        adapter: target.adapter,
        ...(target.adapter === 'none' ? { reason: target.reason } : {}),
        last,
        modelReadAcknowledged: false,
      };
    },
    close: off,
  };
}
