import { sameSessionRef } from '../identity.js';
import type { ReaderResult } from '../interfaces/harness-adapter.js';
import type { NativeAction, SessionEvidence } from '../interfaces/session-evidence.js';
import type { SessionRef } from '../types/identity.js';
import type { ObservationStamp } from '../types/observation.js';
import type { PreparedCheckpoint } from '../types/checkpoint.js';
import { validClaudeTodoProgress } from '../../harness/claude/todos.js';

export const MAX_PUBLICATION_DISPLAYS = 16;
export interface PublicationDisplay {
  sourceIdentity: string;
  checkpointIdentity: PreparedCheckpoint['identity'];
  stamp: ObservationStamp;
  action?: NativeAction;
  progress?: NonNullable<SessionEvidence['progress']>;
}
const time = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const bounded = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 2048;
export function validClaudeAction(value: unknown, now = Infinity): value is NativeAction {
  if (!value || typeof value !== 'object') return false;
  const v = value as NativeAction;
  return (
    v.source === 'claude.background.last_confirmed' &&
    bounded(v.id) &&
    v.name === 'Bash (background)' &&
    bounded(v.target) &&
    time(v.startedAt) &&
    v.startedAt <= now &&
    time(v.asOf) &&
    v.asOf >= v.startedAt &&
    v.asOf <= now
  );
}
export function validClaudeProgress(value: unknown, now = Infinity): value is NonNullable<SessionEvidence['progress']> {
  if (!value || typeof value !== 'object') return false;
  const v = value as NonNullable<SessionEvidence['progress']>;
  return (
    v.quality === 'reported' &&
    ['claude.TodoWrite.last_confirmed', 'claude.TodoWrite.last_confirmed.observed-time'].includes(v.source) &&
    time(v.asOf) &&
    v.asOf <= now &&
    validClaudeTodoProgress(v.value)
  );
}
/** Detached live additions captured beside the exact prepared checkpoint. No recovery I/O. */
export function readerDisplay(result: ReaderResult, ref: SessionRef): Pick<PublicationDisplay, 'action' | 'progress'> {
  const evidence = result.evidence;
  if (ref.harness !== 'claude' || !evidence) return {};
  try {
    if (!sameSessionRef(evidence.ref, ref) || !sameSessionRef(result.checkpoint.ref, ref)) return {};
  } catch {
    return {};
  }
  return {
    ...(validClaudeAction(evidence.action) && !result.continuation && result.observation.coverage.state === 'complete'
      ? {
          action: {
            id: evidence.action.id,
            name: evidence.action.name,
            target: evidence.action.target,
            startedAt: evidence.action.startedAt,
            source: evidence.action.source,
            asOf: evidence.action.asOf,
          },
        }
      : {}),
    ...(validClaudeProgress(evidence.progress)
      ? {
          progress: {
            source: evidence.progress.source,
            quality: 'reported' as const,
            asOf: evidence.progress.asOf,
            value: { ...evidence.progress.value! },
          },
        }
      : {}),
  };
}
