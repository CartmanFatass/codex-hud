/** One-shot unmanaged child transport; no managed run, capability or identity is granted. */
import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { CodexExecJsonReader, type ExecObservation } from './exec-json.js';

export interface CodexExecTransportInput {
  executable: string;
  cwd: string;
  /** Explicit environment only; HUD authority variables are removed. */
  env: NodeJS.ProcessEnv;
  prompt: string;
  resumeThreadId?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}
export interface CodexExecTransportResult {
  outcome: 'not_started' | 'observed_complete' | 'uncertain';
  reason:
    | 'pre_aborted'
    | 'spawn_failed'
    | 'completed'
    | 'child_exit'
    | 'timeout'
    | 'aborted'
    | 'stdout_limit'
    | 'stderr_limit'
    | 'stdin_error'
    | 'io_error'
    | 'close_unconfirmed';
  spawned: boolean;
  /** Direct-child close only, never proof that a process group or external task ended. */
  closeObserved: boolean;
  exit: { code: number | null; signal: NodeJS.Signals | null } | null;
  stderrBytes: number;
  observation: ExecObservation;
}
const canonicalThreadId = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const STDERR_LIMIT = 1024 * 1024;
const PROMPT_LIMIT = 1024 * 1024;

/** A single instance can attempt at most one spawn, including after errors or uncertain results. */
export class CodexExecTransport {
  private used = false;
  async run(input: CodexExecTransportInput): Promise<CodexExecTransportResult> {
    if (this.used) throw new Error('codex_exec_transport_already_used');
    this.used = true;
    if (
      !isAbsolute(input.executable) ||
      !isAbsolute(input.cwd) ||
      input.executable.includes('\0') ||
      input.cwd.includes('\0') ||
      typeof input.prompt !== 'string' ||
      Buffer.byteLength(input.prompt) > PROMPT_LIMIT ||
      !Number.isSafeInteger(input.timeoutMs) ||
      input.timeoutMs < 1 ||
      input.timeoutMs > 120000 ||
      (input.resumeThreadId !== undefined && !canonicalThreadId(input.resumeThreadId))
    )
      throw new Error('codex_exec_transport_invalid_input');
    const reader = new CodexExecJsonReader(input.resumeThreadId);
    if (input.signal?.aborted)
      return {
        outcome: 'not_started',
        reason: 'pre_aborted',
        spawned: false,
        closeObserved: false,
        exit: null,
        stderrBytes: 0,
        observation: reader.finish({ code: null }),
      };
    const env = { ...input.env };
    for (const name of Object.keys(env)) if (name.startsWith('HUD_')) delete env[name];
    const argv = ['exec', '--json', ...(input.resumeThreadId ? ['resume', input.resumeThreadId] : [])];
    return await new Promise((resolve) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(input.executable, argv, { cwd: input.cwd, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch {
        resolve({
          outcome: 'not_started',
          reason: 'spawn_failed',
          spawned: false,
          closeObserved: false,
          exit: null,
          stderrBytes: 0,
          observation: reader.finish({ code: null }),
        });
        return;
      }
      let spawned = false,
        exited = false,
        resolved = false,
        stderrBytes = 0;
      let reason: CodexExecTransportResult['reason'] | null = null;
      let forceTimer: NodeJS.Timeout | undefined, closeTimer: NodeJS.Timeout | undefined;
      const cleanup = () => {
        clearTimeout(deadline);
        if (forceTimer) clearTimeout(forceTimer);
        if (closeTimer) clearTimeout(closeTimer);
        input.signal?.removeEventListener('abort', onAbort);
      };
      const complete = (closeObserved: boolean, code: number | null, signal: NodeJS.Signals | null) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        if (!closeObserved) {
          child.stdout?.destroy();
          child.stderr?.destroy();
          child.stdin?.destroy();
        }
        const observation = reader.finish({ code: closeObserved ? code : null, signal });
        const success = spawned && closeObserved && !reason && observation.complete;
        resolve({
          outcome: !spawned ? 'not_started' : success ? 'observed_complete' : 'uncertain',
          reason: !spawned
            ? 'spawn_failed'
            : success
              ? 'completed'
              : (reason ?? (closeObserved ? 'child_exit' : 'close_unconfirmed')),
          spawned,
          closeObserved,
          exit: closeObserved ? { code, signal } : null,
          stderrBytes,
          observation,
        });
      };
      const terminate = (why: CodexExecTransportResult['reason']) => {
        if (reason || resolved) return;
        reason = why;
        child.stdin?.destroy();
        if (!exited) child.kill('SIGTERM');
        forceTimer = setTimeout(() => {
          if (!exited) child.kill('SIGKILL');
        }, 500);
        closeTimer = setTimeout(() => complete(false, null, null), 1500);
      };
      const onAbort = () => terminate('aborted');
      const deadline = setTimeout(() => terminate('timeout'), input.timeoutMs);
      input.signal?.addEventListener('abort', onAbort, { once: true });
      if (input.signal?.aborted) onAbort();
      child.once('spawn', () => {
        spawned = true;
        if (reason && !exited) child.kill('SIGTERM');
      });
      child.once('exit', () => {
        exited = true;
      });
      child.once('error', () => {
        if (spawned) terminate('io_error');
      });
      child.once('close', (code, signal) => complete(true, code, signal));
      child.stdout!.on('data', (chunk: Buffer) => {
        if (reason) return;
        try {
          reader.push(chunk);
          if (reader.snapshot().transport === 'interrupted') terminate('stdout_limit');
        } catch {
          terminate('io_error');
        }
      });
      child.stdout!.on('error', () => terminate('io_error'));
      child.stderr!.on('data', (chunk: Buffer) => {
        stderrBytes = Math.min(STDERR_LIMIT + 1, stderrBytes + chunk.length);
        if (stderrBytes > STDERR_LIMIT) terminate('stderr_limit');
      });
      child.stderr!.on('error', () => terminate('io_error'));
      child.stdin!.on('error', () => terminate('stdin_error'));
      child.stdin!.end(input.prompt, 'utf8');
    });
  }
}
