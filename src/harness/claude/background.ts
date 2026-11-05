import type { SessionRef } from '../../core/types/identity.js';
import type { ReaderCheckpoint, Coverage } from '../../core/types/observation.js';
import type { NativeAction } from '../../core/interfaces/session-evidence.js';

/** Process-local bounds. Overflow is unknown, never a truncated claim of current activity. */
export const MAX_BACKGROUND_IDENTITIES = 10000;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(v);
const terminal = (v: unknown): v is 'completed' | 'failed' | 'killed' =>
  v === 'completed' || v === 'failed' || v === 'killed';

export type ClaudeBackgroundEvent =
  | {
      kind: 'gap';
      reason: 'background_notification_unreadable' | 'background_status_unverified' | 'background_envelope_unverified';
    }
  | {
      kind: 'call';
      callId: string;
      tool: 'Bash' | 'TaskOutput' | 'Other';
      taskId?: string;
      at: number;
      observedTime: boolean;
    }
  | {
      kind: 'result';
      callId: string;
      backgroundTaskId?: string;
      taskId?: string;
      terminal?: true;
      success: boolean;
      at: number;
      observedTime: boolean;
    }
  | { kind: 'terminal'; taskId: string; callId?: string; at: number; observedTime: boolean };

/**
 * Transcript shapes: native Bash toolUseResult.backgroundTaskId and provenance-marked notifications.
 * https://github.com/frederick-douglas-pearce/claude-code-sessions/blob/main/reference/tool-invocation.md
 * https://github.com/happier-dev/happier/blob/dev/docs/claude-feature-matrix.md
 * Never retain commands, stdout, output paths or notification summaries; never trust ordinary copied XML.
 */
export function claudeBackgroundEvents(row: unknown, ref: SessionRef, now: number): ClaudeBackgroundEvent[] {
  if (!object(row)) return [];
  const attachment = row.type === 'attachment' && object(row.attachment) ? row.attachment : null;
  const nativeUserNotice = row.type === 'user' && object(row.origin) && row.origin.kind === 'task-notification';
  const nativeQueuedNotice =
    attachment?.type === 'queued_command' &&
    (attachment.commandMode === 'task-notification' ||
      (object(attachment.origin) && attachment.origin.kind === 'task-notification') ||
      (object(row.origin) && row.origin.kind === 'task-notification')) &&
    !(object(row.origin) && row.origin.kind !== 'task-notification') &&
    !(object(attachment.origin) && attachment.origin.kind !== 'task-notification') &&
    attachment.humanTurn !== true;
  const nativeBackgroundResult =
    row.type === 'user' &&
    object(row.toolUseResult) &&
    (row.toolUseResult.backgroundTaskId !== undefined ||
      (object(row.toolUseResult.task) && row.toolUseResult.task.task_type === 'local_bash'));
  const nativeLifecycle =
    nativeUserNotice || nativeQueuedNotice || attachment?.type === 'task_status' || nativeBackgroundResult;
  // A recognizably native lifecycle notice that cannot be bound must not silently
  // leave an earlier current-action claim looking complete. It cannot settle a task.
  if (
    (row.sessionId !== undefined && row.sessionId !== ref.sessionId) ||
    (row.agentId !== undefined && row.agentId !== (ref.threadId ?? null)) ||
    (ref.threadId === null && row.isSidechain === true)
  )
    return [];
  if (
    (row.isSidechain !== undefined && typeof row.isSidechain !== 'boolean') ||
    (object(row.message) && row.message.role !== undefined && row.message.role !== row.type) ||
    row.sessionId !== ref.sessionId ||
    (ref.threadId !== null && row.agentId !== ref.threadId)
  )
    return nativeLifecycle ? [{ kind: 'gap', reason: 'background_envelope_unverified' }] : [];
  const parsed = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN;
  const observedTime = !Number.isFinite(parsed);
  const at = observedTime ? now : parsed;
  if (!Number.isFinite(at) || at < 0)
    return nativeLifecycle ? [{ kind: 'gap', reason: 'background_envelope_unverified' }] : [];
  if (attachment?.type === 'task_status') return [{ kind: 'gap', reason: 'background_status_unverified' }];
  let notification: unknown;
  let nativeNotification = false;
  if (nativeUserNotice) {
    nativeNotification = true;
    notification = object(row.message) ? row.message.content : undefined;
  } else if (nativeQueuedNotice && attachment) {
    nativeNotification = true;
    notification = attachment.prompt;
  }
  if (nativeNotification) {
    if (
      Array.isArray(notification) &&
      notification.length === 1 &&
      object(notification[0]) &&
      notification[0].type === 'text'
    )
      notification = notification[0].text;
    const value = parseNotification(notification);
    if (!value) return [{ kind: 'gap', reason: 'background_notification_unreadable' }];
    return terminal(value.status)
      ? [
          {
            kind: 'terminal',
            taskId: value.taskId,
            ...(value.callId ? { callId: value.callId } : {}),
            at,
            observedTime,
          },
        ]
      : [];
  }
  if (!object(row.message) || !Array.isArray(row.message.content)) return [];
  const blocks = row.message.content.filter(object);
  if (row.type === 'assistant')
    return blocks.flatMap((block): ClaudeBackgroundEvent[] => {
      if (block.type !== 'tool_use' || !id(block.id)) return [];
      if (block.name === 'Bash') return [{ kind: 'call', callId: block.id, tool: 'Bash', at, observedTime }];
      if (block.name === 'TaskOutput' && object(block.input) && id(block.input.task_id))
        return [{ kind: 'call', callId: block.id, tool: 'TaskOutput', taskId: block.input.task_id, at, observedTime }];
      return typeof block.name === 'string' && block.name.length > 0
        ? [{ kind: 'call', callId: block.id, tool: 'Other', at, observedTime }]
        : [];
    });
  if (row.type !== 'user') return [];
  const results = blocks.filter((block) => block.type === 'tool_result');
  // A line-level sidecar cannot be attributed safely when the line has multiple tool results.
  if (results.length !== 1 || !id(results[0].tool_use_id)) return [];
  const block = results[0];
  if (block.is_error !== undefined && typeof block.is_error !== 'boolean') return [];
  const success = block.is_error === undefined || block.is_error === false;
  const result = object(row.toolUseResult) ? row.toolUseResult : null;
  const event: ClaudeBackgroundEvent = {
    kind: 'result',
    callId: block.tool_use_id as string,
    success,
    at,
    observedTime,
  };
  if (!success || !result) return [event];
  if (id(result.backgroundTaskId) && (result.interrupted === undefined || result.interrupted === false))
    event.backgroundTaskId = result.backgroundTaskId;
  if (
    result.retrieval_status === 'success' &&
    object(result.task) &&
    result.task.task_type === 'local_bash' &&
    id(result.task.task_id) &&
    terminal(result.task.status)
  ) {
    event.taskId = result.task.task_id;
    event.terminal = true;
  }
  return [event];
}

function parseNotification(value: unknown): { taskId: string; callId?: string; status: string } | null {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 8192) return null;
  const text = value.trim();
  if (!text.startsWith('<task-notification>')) return null;
  const end = text.indexOf('</task-notification>');
  if (end < 0 || text.indexOf('<task-notification>', 1) >= 0) return null;
  let body = text.slice('<task-notification>'.length, end).trim();
  const fields = new Map<string, string>();
  while (body) {
    const field = /^<([a-z][a-z0-9-]*)>([\s\S]*?)<\/\1>/.exec(body);
    if (!field || fields.has(field[1])) return null;
    fields.set(field[1], field[2].trim());
    body = body.slice(field[0].length).trim();
  }
  const taskId = fields.get('task-id'),
    callId = fields.get('tool-use-id');
  const status = fields.get('status');
  if (
    !id(taskId) ||
    !(terminal(status) || status === 'running' || status === 'pending') ||
    (callId !== undefined && !id(callId))
  )
    return null;
  return { taskId, ...(callId ? { callId } : {}), status: fields.get('status')! };
}

interface Task {
  id: string;
  callId: string;
  startedAt: number;
  confirmedAt: number;
  observedTime: boolean;
}
interface Pending {
  tool: 'Bash' | 'TaskOutput' | 'Other';
  taskId?: string;
  at: number;
  observedTime: boolean;
}
interface State {
  fileId?: ReaderCheckpoint['fileId'];
  generation?: number;
  fullHistory: boolean;
  pending: Map<string, Pending>;
  seen: Map<
    string,
    { tool: Pending['tool'] | 'conflict'; taskId?: string; result?: string; backgroundTaskId?: string }
  >;
  tasks: Map<string, Task>;
  terminals: Map<string, string | null>;
  ambiguous: Set<string>;
  overflow: boolean;
  gaps: Set<string>;
  asOf: number | null;
}
export interface ClaudeBackgroundView {
  source: 'claude.background.last_confirmed';
  /** Confirmed launch without observed native terminal evidence, not a live process check. */
  tasks: readonly Task[];
  coverage: 'complete' | 'partial' | 'catching_up';
  gaps: readonly string[];
  asOf: number | null;
}
const empty = (fullHistory: boolean): State => ({
  fullHistory,
  pending: new Map(),
  seen: new Map(),
  tasks: new Map(),
  terminals: new Map(),
  ambiguous: new Set(),
  overflow: false,
  gaps: new Set(),
  asOf: null,
});

/** Not checkpointed: a mid-file recovery must never invent a background inventory. */
export class ClaudeBackgroundProjection {
  private state: State;
  constructor(fromStart: boolean) {
    this.state = empty(fromStart);
  }
  fork(): ClaudeBackgroundProjection {
    const next = new ClaudeBackgroundProjection(false);
    next.state = structuredClone(this.state);
    return next;
  }
  apply(checkpoint: ReaderCheckpoint, events: readonly ClaudeBackgroundEvent[], physicalReset: boolean): void {
    let s = this.state;
    if (
      physicalReset ||
      (s.fileId && (s.fileId.dev !== checkpoint.fileId.dev || s.fileId.inode !== checkpoint.fileId.inode))
    )
      s = this.state = empty(true);
    if (checkpoint.fileId.inode === 0) return;
    s.fileId = { ...checkpoint.fileId };
    s.generation = checkpoint.sourceGeneration;
    for (const event of events) {
      if (s.overflow) break;
      const size = s.pending.size + s.seen.size + s.tasks.size + s.terminals.size + s.ambiguous.size;
      if (size >= MAX_BACKGROUND_IDENTITIES) {
        s.overflow = true;
        s.fullHistory = false;
        s.tasks.clear();
        s.gaps.add('background_identity_limit');
        break;
      }
      if (event.kind === 'gap') {
        s.gaps.add(event.reason);
      } else if (event.kind === 'call') {
        const accepted = s.seen.get(event.callId);
        if (accepted !== undefined) {
          if (accepted.tool === 'conflict') continue;
          if (accepted.tool !== event.tool || accepted.taskId !== event.taskId) this.conflictCall(event.callId);
          continue;
        }
        const prior = s.pending.get(event.callId);
        if (prior && (prior.tool !== event.tool || prior.taskId !== event.taskId)) {
          this.conflictCall(event.callId);
        } else if (!prior)
          s.pending.set(event.callId, {
            tool: event.tool,
            taskId: event.taskId,
            at: event.at,
            observedTime: event.observedTime,
          });
      } else if (event.kind === 'terminal') {
        this.finish(event.taskId, event.callId, event.at);
      } else {
        const resultIdentity = JSON.stringify([
          event.success,
          event.backgroundTaskId ?? null,
          event.taskId ?? null,
          event.terminal === true,
        ]);
        const accepted = s.seen.get(event.callId);
        if (accepted) {
          if (accepted.tool !== 'conflict' && accepted.result !== resultIdentity) this.conflictCall(event.callId);
          continue;
        }
        const pending = s.pending.get(event.callId);
        if (!pending) continue;
        s.pending.delete(event.callId);
        s.seen.set(event.callId, {
          tool: pending.tool,
          taskId: pending.taskId,
          result: resultIdentity,
          ...(pending.tool === 'Bash' && event.success && event.backgroundTaskId
            ? { backgroundTaskId: event.backgroundTaskId }
            : {}),
        });
        if (!event.success) continue;
        if (pending.tool === 'Bash' && event.backgroundTaskId) {
          const taskId = event.backgroundTaskId;
          if (s.ambiguous.has(taskId)) continue;
          const prior = s.tasks.get(taskId);
          const ended = s.terminals.get(taskId);
          if (
            (prior && prior.callId !== event.callId) ||
            (ended !== undefined && ended !== null && ended !== event.callId)
          ) {
            s.tasks.delete(taskId);
            s.ambiguous.add(taskId);
            s.gaps.add('background_task_conflict');
            continue;
          }
          if (ended !== undefined) {
            if (ended === null) s.terminals.set(taskId, event.callId);
            continue;
          }
          if (!prior) {
            s.tasks.set(taskId, {
              id: taskId,
              callId: event.callId,
              startedAt: pending.at,
              confirmedAt: event.at,
              observedTime: pending.observedTime || event.observedTime,
            });
            s.asOf = event.at;
          }
        } else if (pending.tool === 'TaskOutput' && event.terminal && event.taskId && event.taskId === pending.taskId)
          this.finish(event.taskId, undefined, event.at);
      }
    }
  }
  private conflictCall(callId: string): void {
    const s = this.state;
    const accepted = s.seen.get(callId);
    if (accepted?.tool === 'conflict') return;
    s.pending.delete(callId);
    if (accepted?.backgroundTaskId && s.tasks.get(accepted.backgroundTaskId)?.callId === callId)
      s.tasks.delete(accepted.backgroundTaskId);
    s.seen.set(callId, { tool: 'conflict' });
    s.gaps.add('background_call_conflict');
  }
  private finish(taskId: string, callId: string | undefined, at: number): void {
    const s = this.state,
      task = s.tasks.get(taskId),
      prior = s.terminals.get(taskId);
    if (
      (task && callId && task.callId !== callId) ||
      (prior !== undefined && prior !== null && callId && prior !== callId)
    ) {
      s.tasks.delete(taskId);
      s.ambiguous.add(taskId);
      s.gaps.add('background_task_conflict');
      return;
    }
    const owner = callId ?? task?.callId ?? prior ?? null;
    if (!s.terminals.has(taskId) || (prior === null && owner !== null)) s.terminals.set(taskId, owner);
    if (s.tasks.delete(taskId)) s.asOf = at;
  }
  view(coverage: Coverage, now = Date.now()): { background: ClaudeBackgroundView; action?: NativeAction } {
    const s = this.state;
    const gaps = [...s.gaps];
    if (!s.fullHistory) gaps.push('background_history_unconfirmed');
    if (coverage.state === 'partial') gaps.push('background_source_partial');
    const tasks = [...s.tasks.values()].map((task) => ({ ...task }));
    let selected: Task | undefined;
    for (const task of tasks)
      if (
        !selected ||
        task.confirmedAt > selected.confirmedAt ||
        (task.confirmedAt === selected.confirmedAt &&
          (task.startedAt > selected.startedAt ||
            (task.startedAt === selected.startedAt && task.id.localeCompare(selected.id) < 0)))
      )
        selected = task;
    const complete = s.fullHistory && !gaps.length && coverage.state === 'complete';
    return {
      background: {
        source: 'claude.background.last_confirmed',
        tasks,
        coverage: coverage.state === 'catching_up' ? 'catching_up' : complete ? 'complete' : 'partial',
        gaps,
        asOf: s.asOf,
      },
      ...(complete && selected && selected.startedAt <= now && selected.confirmedAt <= now
        ? {
            action: {
              id: selected.callId,
              name: 'Bash (background)',
              target: `task ${selected.id}`,
              startedAt: selected.startedAt,
            },
          }
        : {}),
    };
  }
}
