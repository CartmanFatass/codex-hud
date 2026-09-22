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
  /** Also raise a notification outside the terminal. Off unless asked for. */
  desktop?: boolean;
  deliver?: (event: NotifyEvent) => void;
}

function truthy(value: string | undefined): boolean {
  const raw = (value ?? '').trim();
  return raw === '1' || raw.toLowerCase() === 'true';
}

export function resolveNotifierOptions(env: NodeJS.ProcessEnv = process.env): Omit<NotifierOptions, 'deliver'> {
  const seconds = Number(env.CODEX_HUD_NOTIFY_COOLDOWN ?? '');
  return {
    enabled: truthy(env.CODEX_HUD_NOTIFY),
    // A second opt-in: leaving the terminal is a bigger ask than a tmux
    // message, so turning notifications on does not turn these on too.
    desktop: truthy(env.CODEX_HUD_NOTIFY_DESKTOP),
    cooldownMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 300_000,
  };
}

const ESC = '\x1b';
const BEL = '\x07';

/**
 * The bytes that ask a terminal to raise a notification.
 *
 * Two spellings, because terminals disagree: OSC 9 is the one iTerm2 and
 * Windows Terminal read, OSC 777 the one most Linux terminals read. A terminal
 * that understands neither discards both, which is why this is safe to write
 * onto a pane that is otherwise drawing a status bar.
 *
 * `text` is stripped of every control character first. Notification text comes
 * from a rollout, so it is data, and data that could carry an ESC could close
 * the sequence and have the rest of itself executed as terminal commands.
 */
export function desktopNotificationSequence(text: string, options: { tmux: boolean }): string {
  const safe = text.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').trim();
  const payload = `${ESC}]9;${safe}${BEL}${ESC}]777;notify;codex-hud;${safe}${BEL}`;
  if (!options.tmux) {
    return payload;
  }
  // tmux only forwards an unknown sequence to the outer terminal when it is
  // wrapped in its passthrough DCS, and only with every ESC inside doubled.
  return `${ESC}Ptmux;${payload.split(ESC).join(ESC + ESC)}${ESC}\\`;
}

/**
 * Best-effort desktop notification: the terminal sequence, plus the platform's
 * own notifier. Both are fire-and-forget; neither is allowed to fail loudly or
 * to hold up a frame.
 */
export function desktopDeliver(event: NotifyEvent): void {
  const text = `codex-hud: ${event.message}`;
  try {
    process.stdout.write(desktopNotificationSequence(text, { tmux: Boolean(process.env.TMUX) }));
  } catch {
    // A closed or full stdout is not worth crashing the HUD over.
  }

  const command: [string, string[]] | null =
    process.platform === 'linux'
      ? ['notify-send', ['codex-hud', event.message]]
      : process.platform === 'darwin'
        ? ['osascript', ['-e', `display notification ${JSON.stringify(event.message)} with title "codex-hud"`]]
        : null;
  if (!command) {
    return;
  }
  try {
    const child = spawn(command[0], command[1], { stdio: 'ignore' });
    child.on('error', () => {
      // notify-send or osascript missing: the terminal sequence still stands.
    });
    child.unref();
  } catch {
    // delivery is best-effort
  }
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
    const candidates = [
      ...this.approvalEvents(data),
      ...this.attentionEvents(data, nowMs),
      ...this.agentEvents(data),
    ];
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
      if (this.options.desktop) {
        desktopDeliver(event);
      }
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

  /**
   * One message per request. The fingerprint is the call and the moment it
   * was recorded, so a request that stays open across many ticks announces
   * itself once, and a second request for the same call does announce again.
   */
  private approvalEvents(data: HudData): NotifyEvent[] {
    const pending = data.pendingApproval;
    if (!pending) {
      return [];
    }
    const label = pending.kind === 'patch' ? 'patch approval needed'
      : pending.kind === 'input' ? 'input needed'
      : 'approval needed';
    return [
      {
        kind: 'approval',
        fingerprint: `${pending.callId ?? ''}:${pending.since.getTime()}`,
        message: pending.summary ? `${label}: ${pending.summary}` : label,
      },
    ];
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
