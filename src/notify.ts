/**
 * Notifications for the things a person would want pulled out of the corner
 * of their eye.
 *
 * Three deliberate limits. It is off unless asked for, because Codex has its
 * own notifier and two pop-ups for one event is worse than none. It never
 * acts on the session: no auto-approval, no keystrokes, no retries; watching
 * and driving are different jobs. And it only reports observed events, so a
 * quiet log never becomes "your agent is stuck".
 */

import { spawn } from 'child_process';
import { collectAttention, type AttentionItem } from './render/attention.js';
import { summarizeSubagents } from './collectors/subagent-tree.js';
import type { HudData } from './types.js';

export interface NotifyEvent {
  kind: string;
  /** Identity of this particular occurrence, for de-duplication. */
  fingerprint: string;
  message: string;
}

export interface NotifierOptions {
  enabled: boolean;
  cooldownMs: number;
  deliver?: (event: NotifyEvent) => void;
}

export function resolveNotifierOptions(env: NodeJS.ProcessEnv = process.env): Omit<NotifierOptions, 'deliver'> {
  const raw = (env.CODEX_HUD_NOTIFY ?? '').trim();
  const seconds = Number(env.CODEX_HUD_NOTIFY_COOLDOWN ?? '');
  return {
    enabled: raw === '1' || raw.toLowerCase() === 'true',
    cooldownMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 300_000,
  };
}

/** Best-effort delivery through tmux; silent when not running under tmux. */
export function tmuxDeliver(event: NotifyEvent): void {
  if (!process.env.TMUX) {
    return;
  }
  try {
    const child = spawn('tmux', ['display-message', `codex-hud: ${event.message}`], { stdio: 'ignore' });
    child.on('error', () => {
      // A missing or busy tmux is not worth crashing the HUD over.
    });
    child.unref();
  } catch {
    // delivery is best-effort
  }
}

export class Notifier {
  private readonly lastFired = new Map<string, { fingerprint: string; at: number }>();
  private lastActiveAgents: number | null = null;
  private lastCompletedAgents = 0;

  constructor(private readonly options: NotifierOptions) {}

  /**
   * Decide what to announce for this snapshot and deliver it. Returns the
   * events that were actually sent, which is what the tests assert on.
   */
  update(data: HudData, nowMs: number = Date.now()): NotifyEvent[] {
    const candidates = [...this.attentionEvents(data, nowMs), ...this.agentEvents(data)];
    if (!this.options.enabled) {
      // Still advance the agent baseline, so enabling mid-session does not
      // immediately replay everything that already happened.
      return [];
    }

    const sent: NotifyEvent[] = [];
    for (const event of candidates) {
      if (!this.shouldFire(event, nowMs)) {
        continue;
      }
      this.lastFired.set(event.kind, { fingerprint: event.fingerprint, at: nowMs });
      (this.options.deliver ?? tmuxDeliver)(event);
      sent.push(event);
    }
    return sent;
  }

  private shouldFire(event: NotifyEvent, nowMs: number): boolean {
    const previous = this.lastFired.get(event.kind);
    if (!previous) {
      return true;
    }
    // The same occurrence never fires twice. A different one waits out the
    // cooldown, so a flapping condition cannot turn into a stream of pop-ups.
    if (previous.fingerprint === event.fingerprint) {
      return false;
    }
    return nowMs - previous.at >= this.options.cooldownMs;
  }

  private attentionEvents(data: HudData, nowMs: number): NotifyEvent[] {
    const items = collectAttention(data, nowMs).filter((item) => item.severity === 'error');
    if (items.length === 0) {
      return [];
    }
    // One message for everything currently wrong, rather than one per item.
    return [
      {
        kind: 'attention',
        fingerprint: items.map((item: AttentionItem) => `${item.kind}:${item.label}`).join('|'),
        message: items.map((item) => item.label).join(', '),
      },
    ];
  }

  private agentEvents(data: HudData): NotifyEvent[] {
    const summary = summarizeSubagents(data.subagentTree?.nodes ?? []);
    const previousActive = this.lastActiveAgents;
    const previousCompleted = this.lastCompletedAgents;
    this.lastActiveAgents = summary.active;
    this.lastCompletedAgents = summary.completed;

    if (previousActive === null || previousActive === 0 || summary.active > 0) {
      return [];
    }

    const finished = summary.completed - previousCompleted;
    const failed = summary.failed;
    if (finished <= 0 && failed === 0) {
      return [];
    }

    const parts: string[] = [];
    if (finished > 0) {
      parts.push(`${finished} agent${finished === 1 ? '' : 's'} finished`);
    }
    if (failed > 0) {
      parts.push(`${failed} failed`);
    }
    return [
      {
        kind: 'agents-idle',
        fingerprint: `${summary.completed}/${summary.failed}`,
        message: parts.join(', '),
      },
    ];
  }
}
