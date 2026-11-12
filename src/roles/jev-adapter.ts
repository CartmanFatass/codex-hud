/**
 * Maps a role-facade Jev launch onto one runtime job.
 * The facade writes the receipt before `createJob`. This module does not.
 * One runtime handle per facade context. The handle reconnects on its own.
 */

import { createHash } from 'node:crypto';
import { createJevExecutor } from '../jev/runtime/index.js';
import {
  recoverableOracleResult,
  type JevJobInput,
  type JevJobState,
  type JevReadOptions,
} from '../jev/runtime/types.js';
import type { JevExecutor as RuntimeHandle } from '../jev/runtime/types.js';
import type { RosterRoot } from './selection.js';
import type { RoleName, OraclePhase } from './roles.js';
import type { backendJson } from './routing.js';

export interface JevStatement {
  readonly name: string;
  readonly statement: string;
}
export interface JevInput {
  readonly kind: 'ask' | 'browse' | 'judge';
  readonly text: string | null;
  readonly url: string | null;
  readonly statements: readonly JevStatement[];
}
export interface JevLaunchRequest {
  readonly root: RosterRoot;
  readonly role: RoleName;
  readonly phase: OraclePhase | null;
  readonly requestKey: string;
  readonly fingerprint: string;
  readonly preset: string;
  readonly routingRevision: string;
  readonly binding: ReturnType<typeof backendJson>;
  readonly input: JevInput | null;
  /** Oracle prompt. Null for a `jev` role; that prompt is `input.text`. */
  readonly task: string | null;
  readonly cwd: string | null;
  readonly jevDecisions: { id: string; provider: 'gemini' | 'typesafe' | 'openai'; model: string | null };
}

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

export function facadeState(state: JevJobState, result?: unknown): 'open' | 'done' | 'error' | 'closed' {
  if (state === 'completed' && recoverableOracleResult(result)) return 'open';
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
  { ok: true; tag: 'ask' | 'browse' | 'judge'; input: JevJobInput } | { ok: false; field: string };

/**
 * Oracle on a web target and `jev` ask become `ask`.
 * Browse and judge need a URL. Ask on a browser binding is `invalid_arguments`.
 * Target model and mode stay on the binding for R4.
 */
export function mapJevLaunch(request: JevLaunchRequest): JevMapped {
  const target = request.binding.target;
  const web = target === 'chatgpt-pro' || target === 'aistudio';
  const key = runtimeRequestKey(`${request.root.namespace}/${request.root.sessionId}`, request.requestKey);
  const targetOptions = {
    ...(request.binding.model ? { model: request.binding.model } : {}),
    ...(request.binding.mode
      ? target === 'aistudio'
        ? { thinking: request.binding.mode }
        : { effortWord: request.binding.mode }
      : {}),
  };
  if (request.role === 'oracle') {
    if (!web || !request.task) return { ok: false, field: web ? 'task' : 'target' };
    return {
      ok: true,
      tag: 'ask',
      input: { tag: 'ask', target, label: askLabel(key), prompt: request.task, ...targetOptions },
    };
  }
  const input = request.input;
  if (request.role !== 'jev' || !input) return { ok: false, field: 'input' };
  if (input.kind === 'ask') {
    if (!web || !input.text) return { ok: false, field: 'input' };
    return {
      ok: true,
      tag: 'ask',
      input: { tag: 'ask', target, label: askLabel(key), prompt: input.text, ...targetOptions },
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

export { readStoredJevInput } from './job-receipt.js';

/** hud_read recovers an interrupted browser ask, but never turns a plain runtime read into a send. */
export async function readRoleJevJob(runtime: JevRuntimeHandle, jobId: string, options: JevReadOptions) {
  const observed = await runtime.readJob(jobId, options);
  if (
    observed.tag === 'ask' &&
    !observed.closed &&
    (observed.state === 'interrupted' || (observed.state === 'completed' && recoverableOracleResult(observed.result)))
  ) {
    return runtime.readJob(jobId, { ...options, resume: true });
  }
  return observed;
}

/**
 * One handle for this facade context. An injected handle is used as-is.
 * Otherwise the real runtime starts on the first call and is reused after that.
 * A failed start is not cached: the next call tries again.
 */
export function connectRoleRuntime(home: string, injected?: JevRuntimeHandle | null): () => Promise<JevRuntimeHandle> {
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
