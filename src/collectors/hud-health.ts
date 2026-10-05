/**
 * Whether the HUD can read, as opposed to whether there is anything to read.
 *
 * A failed collection leaves the display as it was: the last good values stay
 * on screen, which is right for a reader and indistinguishable from a quiet
 * session. This keeps the two facts that tell them apart: when the main
 * collection (session lookup and rollout read) last went through, and the
 * most recent failure of any collection, with where and when it happened. One
 * error, its message cut short: the record is bounded however long the HUD
 * runs. Nothing is recorded until something happens, and nothing is guessed.
 */
import type { HudHealthState } from '../types.js';

export type HealthSource = 'session' | 'rollout' | 'tree' | 'status' | 'git' | 'worktrees';

const MESSAGE_LIMIT = 160;

/** The first line of an error's message, cut to a size a status row can carry. */
export function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const line = (raw.split(/\r?\n/).find((part) => part.trim()) ?? '').trim().replace(/\s+/g, ' ');
  const text = line || (error instanceof Error ? error.name : 'unknown error');
  return text.length > MESSAGE_LIMIT ? `${text.slice(0, MESSAGE_LIMIT - 1)}…` : text;
}

export class HudHealth {
  private state: HudHealthState = {};

  /** The main collection went through: the session was looked up and its rollout read, or found unchanged. */
  read(at: Date = new Date()): void {
    this.state = { ...this.state, lastReadAt: at };
  }

  fail(source: HealthSource, error: unknown, at: Date = new Date()): void {
    this.state = { ...this.state, lastError: { source, message: errorText(error), at } };
  }

  current(): HudHealthState {
    return this.state;
  }
}
