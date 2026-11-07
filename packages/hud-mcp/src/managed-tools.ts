import { ownerKey } from '../../../src/managed/relations.js';
import type { NativeHostPort } from '../../../src/managed/host-ipc.js';
import type { AuthenticatedToolExtension } from './server.js';
import type { CallResolution } from './resolvers.js';
import { JSON_VALUE_SCHEMA, type ToolDefinition } from './tools.js';
type NativeResolution = Extract<CallResolution, { ok: true }>;
const text = { type: 'string', minLength: 1, maxLength: 4096 };
const options = { type: 'object', additionalProperties: { $ref: '#/$defs/jsonValue' } };
const nativeRef = {
  type: 'object',
  properties: {
    harness: { type: 'string', enum: ['codex', 'claude', 'pi'] },
    threadId: text,
    sessionId: text,
    sessionFile: text,
  },
  required: ['harness'],
  additionalProperties: false,
};
const target = { connectionId: text, nativeRef };
function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = []
): ToolDefinition {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties,
      required,
      additionalProperties: false,
      $defs: { jsonValue: JSON_VALUE_SCHEMA },
    },
  };
}
export const MANAGED_TOOLS: ToolDefinition[] = [
  tool(
    'managed_create',
    'Create a native session or explicitly resume/fork a previously owned native session. No input is sent implicitly. Before the provider supplies an ID, connectionId addresses the live connection.',
    {
      profileId: text,
      workspace: text,
      origin: {
        type: 'object',
        properties: { kind: { type: 'string', enum: ['new', 'resume', 'fork'] }, source: nativeRef },
        required: ['kind'],
        additionalProperties: false,
      },
      options,
    },
    ['profileId', 'workspace']
  ),
  tool(
    'managed_send',
    'Send input once to the official session. options selects explicit native behavior such as steer. A transport receipt is not a task verdict.',
    { ...target, text: { type: 'string', minLength: 1, maxLength: 65536 }, options },
    ['text']
  ),
  tool(
    'managed_ask',
    'Send once and wait for native events or requests. Timeout or caller disconnection never cancels native work.',
    {
      ...target,
      text: { type: 'string', minLength: 1, maxLength: 65536 },
      options,
      waitMs: { type: 'integer', minimum: 0, maximum: 120000 },
    },
    ['text']
  ),
  tool(
    'managed_wait',
    'Observe bounded live native events and pending requests without resending. Use native read for durable history. Omit target to observe all children of this native owner.',
    { ...target, afterSeq: { type: 'integer', minimum: 0 }, waitMs: { type: 'integer', minimum: 0, maximum: 120000 } }
  ),
  tool(
    'managed_read',
    'Read official native history or state. options expresses backend read parameters; HUD does not infer success.',
    { ...target, options }
  ),
  tool('managed_status', 'Read this owned native connection and its official state.', target),
  tool(
    'managed_list',
    'List only this native owner’s live connections and direct relations. Relation records are not running-state claims.',
    {}
  ),
  tool('managed_requests', 'Read pending official callbacks belonging to this native owner.', target),
  tool(
    'managed_respond',
    'Forward result unchanged to the exact native request on an owned connection. The caller and native harness decide its meaning.',
    { ...target, requestId: text, result: { $ref: '#/$defs/jsonValue' } },
    ['requestId', 'result']
  ),
  tool(
    'managed_cancel',
    'Explicitly invoke the native interrupt API. Supply nativeTurnId when the backend requires it. This is not a process-tree kill.',
    { ...target, nativeTurnId: text }
  ),
  tool(
    'managed_close',
    'Explicitly release the owned native connection using its public close API. Does not claim that all background work stopped.',
    target
  ),
];
export function nativeManagedPrincipal(source: NativeResolution): string {
  return 'native:' + ownerKey(source.sessionRef);
}
/** The native source is resolved on every call; model arguments cannot select the owner. */
export class NativeManagedTools implements AuthenticatedToolExtension {
  readonly tools = MANAGED_TOOLS;
  constructor(private readonly host: NativeHostPort) {}
  async invoke(
    source: NativeResolution,
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<unknown> {
    try {
      const method = name.replace(/^managed_/, '');
      if (!['list', 'create', 'wait', 'requests'].includes(method) && !args.connectionId && !args.nativeRef)
        throw new Error('native_target_required');
      if (method === 'create') {
        const origin = (args.origin ?? { kind: 'new' }) as { kind: string; source?: unknown };
        if (origin.kind !== 'new' && !origin.source) throw new Error('native_resume_source_required');
        if (origin.kind === 'new' && origin.source) throw new Error('native_new_source_forbidden');
      }
      const input = {
        ...args,
        callId: source.callId,
        ...(method === 'create' ? { origin: args.origin ?? { kind: 'new' } } : {}),
      };
      let value: unknown;
      if (method === 'ask') {
        const cursor = (await this.host.invoke(source.sessionRef, 'wait', { ...args, waitMs: 0 }, signal)) as {
          throughSeq: number;
        };
        const receipt = await this.host.invoke(source.sessionRef, 'send', input, signal);
        const observation = await this.host.invoke(
          source.sessionRef,
          'wait',
          { ...args, afterSeq: cursor.throughSeq },
          signal
        );
        value = { receipt, observation };
      } else value = await this.host.invoke(source.sessionRef, method, input, signal);
      return { ok: true, value };
    } catch (error) {
      return {
        ok: false,
        code: error instanceof Error ? error.message : 'native_transport_error',
        ...((error as { nativeError?: unknown })?.nativeError
          ? { nativeError: (error as { nativeError: unknown }).nativeError }
          : {}),
      };
    }
  }
}
