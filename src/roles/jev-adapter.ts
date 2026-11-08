/**
 * Maps a role-facade Jev launch onto one runtime job.
 * The facade writes the receipt before `createJob`. This module does not.
 * One runtime handle per facade context. The handle reconnects on its own.
 */

import { createHash } from 'node:crypto';
import { createJevExecutor } from '../jev/runtime/index.js';
import type { JevJobInput, JevJobState } from '../jev/runtime/types.js';
import type { JevExecutor as RuntimeHandle } from '../jev/runtime/types.js';
import type { JevLaunchRequest } from './facade.js';

export type JevRuntimeHandle = Pick<RuntimeHandle, 'createJob' | 'readJob' | 'sendFollowUp' | 'closeJob'>;

const START_CODES = new Set([
  'jev_credentials_missing',
  'jev_state_dir_missing',
  'jev_env_perms',
  'jev_env_empty',
  'config',
  'runtime_start_failed',
]);

const LOST_ACK = new Set(['runtime_timeout', 'ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE']);

/** R3 keys are global and at most 81 characters. Fold the parent into the key. */
export function runtimeRequestKey(parent: string, requestKey: string): string {
  return `r2-${sha256(`${parent}\n${requestKey}`).slice(0, 40)}`;
}

/** Stable ask label. The same parent and request key always produce the same slug. */
export function askLabel(runtimeKey: string): string {
  return `o-${sha256(runtimeKey).slice(0, 12)}`;
}

export function facadeState(state: JevJobState): 'open' | 'done' | 'error' | 'closed' {
  if (state === 'queued' || state === 'running') return 'open';
  if (state === 'completed') return 'done';
  if (state === 'closed') return 'closed';
  return 'error';
}

export function jevErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.length > 0 ? code : 'internal';
}

/** The runtime did not accept the job. Surface this as `backend_unavailable`. */
export function isRuntimeStartError(error: unknown): boolean {
  return START_CODES.has(jevErrorCode(error));
}

/** The call may have landed. Retry `createJob` with the same key. Never mint another. */
export function isLostAck(error: unknown): boolean {
  return LOST_ACK.has(jevErrorCode(error));
}

export type JevMapped =
  | { ok: true; tag: 'ask' | 'browse' | 'judge'; input: JevJobInput }
  | { ok: false; field: string };

/**
 * Oracle on a web target and `jev` ask become `ask`.
 * Browse and judge need a URL. Ask on a browser binding is `invalid_arguments`.
 * Target model and mode stay on the binding for R4.
 */
export function mapJevLaunch(request: JevLaunchRequest): JevMapped {
  const target = request.binding.target;
  const web = target === 'chatgpt-pro' || target === 'aistudio';
  const key = runtimeRequestKey(`${request.root.namespace}/${request.root.sessionId}`, request.requestKey);
  if (request.role === 'oracle') {
    if (!web || !request.task) return { ok: false, field: web ? 'task' : 'target' };
    return {
      ok: true,
      tag: 'ask',
      input: { tag: 'ask', target, label: askLabel(key), prompt: request.task },
    };
  }
  const input = request.input;
  if (request.role !== 'jev' || !input) return { ok: false, field: 'input' };
  if (input.kind === 'ask') {
    if (!web || !input.text) return { ok: false, field: 'input' };
    return {
      ok: true,
      tag: 'ask',
      input: { tag: 'ask', target, label: askLabel(key), prompt: input.text },
    };
  }
  if (input.kind === 'browse') {
    if (!input.text || !input.url || input.text.length > 8000) return { ok: false, field: 'input' };
    return { ok: true, tag: 'browse', input: { tag: 'browse', goal: input.text.trim(), url: input.url } };
  }
  if (!input.url || input.statements.length === 0) return { ok: false, field: 'input' };
  return {
    ok: true,
    tag: 'judge',
    input: {
      tag: 'judge',
      url: input.url,
      statements: input.statements.map((statement) => ({ name: statement.name, statement: statement.statement })),
    },
  };
}

/** The runtime body stored on a receipt. A retry sends this object again. */
export function readStoredJevInput(value: unknown): JevJobInput | null {
  if (!isRecord(value)) return null;
  if (value.tag === 'ask') {
    if (
      (value.target !== 'chatgpt-pro' && value.target !== 'aistudio') ||
      typeof value.label !== 'string' ||
      typeof value.prompt !== 'string'
    ) {
      return null;
    }
    return value.confirmResend === true
      ? { tag: 'ask', target: value.target, label: value.label, prompt: value.prompt, confirmResend: true }
      : { tag: 'ask', target: value.target, label: value.label, prompt: value.prompt };
  }
  if (value.tag === 'browse') {
    if (typeof value.goal !== 'string' || typeof value.url !== 'string') return null;
    return { tag: 'browse', goal: value.goal, url: value.url };
  }
  if (value.tag !== 'judge' || typeof value.url !== 'string' || !Array.isArray(value.statements)) return null;
  const statements: Array<{ name: string; statement: string }> = [];
  for (const item of value.statements) {
    if (!isRecord(item) || typeof item.name !== 'string' || typeof item.statement !== 'string') return null;
    statements.push({ name: item.name, statement: item.statement });
  }
  return { tag: 'judge', url: value.url, statements };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * One handle for this facade context. An injected handle is used as-is.
 * Otherwise the real runtime starts on the first call and is reused after that.
 * A failed start is not cached: the next call tries again.
 */
export function connectRoleRuntime(
  home: string,
  injected?: JevRuntimeHandle | null
): () => Promise<JevRuntimeHandle> {
  if (injected) return () => Promise.resolve(injected);
  let handle: JevRuntimeHandle | null = null;
  let opening: Promise<JevRuntimeHandle> | null = null;
  return () => {
    if (handle) return Promise.resolve(handle);
    opening ??= createJevExecutor(home)
      .then((value) => {
        handle = value;
        return value;
      })
      .catch((error: unknown) => {
        opening = null;
        throw error;
      });
    return opening;
  };
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
