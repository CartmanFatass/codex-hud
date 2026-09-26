/**
 * The HUD's state, in a form something other than a terminal can read.
 *
 * The bar is a picture: it fits itself to a pane, shortens what it says and
 * hides what does not fit. That is the right answer for a reader and the wrong
 * one for a script, a click handler or another program, so the same collection
 * tick also writes what it knows as plain JSON.
 *
 * The rules the display lives by hold here too. Every field is something that
 * was observed; a field with no data is absent rather than zero, so a consumer
 * can tell "no quota snapshot" from "quota at 0%". Dates are ISO strings, so
 * the file compares byte for byte between runs.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { collectAttention } from './render/attention.js';
import { readQuotaWindows } from './render/quota.js';
import { summarizeSubagents } from './collectors/subagent-tree.js';
import { getCodexHome } from './utils/codex-path.js';
import type { BarSegment, VariantLevel } from './render/layout/engine.js';
import type { HudData, SubagentTreeNode } from './types.js';

export const SNAPSHOT_VERSION = 1;

export interface SnapshotAgentNode {
  id: string;
  name: string;
  status: string;
  depth: number;
  model?: string;
  effort?: string;
}

export interface SnapshotSegment {
  id: string;
  level: VariantLevel;
  x: number;
  width: number;
}

export interface HudSnapshot {
  version: typeof SNAPSHOT_VERSION;
  updatedAt: string;
  session?: { id: string; model?: string; effort?: string; cwd?: string };
  /** `repo` names a repository inside the project folder, when that is what `branch` describes. */
  project: { name: string; repo?: string; branch?: string; dirty: boolean; ahead: number; behind: number };
  activity?: { state: string; turnStartedAt?: string; tool?: { name: string; target?: string } };
  context?: { percent: number; used: number; total: number; compactions: number };
  quota: Array<{ label?: string; percent: number; resetsAt?: string }>;
  tokens?: { total: number; cached: number };
  agents: {
    active: number;
    completed: number;
    failed: number;
    unknown: number;
    nodes: SnapshotAgentNode[];
  };
  attention: Array<{ kind: string; label: string; severity: string }>;
  bar: { width: number; segments: SnapshotSegment[] };
}

function flattenAgents(nodes: SubagentTreeNode[], out: SnapshotAgentNode[] = []): SnapshotAgentNode[] {
  for (const node of nodes) {
    out.push({
      id: node.id,
      name: node.name,
      status: node.status,
      depth: node.depth,
      ...(node.model ? { model: node.model } : {}),
      ...(node.effort ? { effort: node.effort } : {}),
    });
    flattenAgents(node.children, out);
  }
  return out;
}

function iso(date: Date | undefined): string | undefined {
  if (!date || !Number.isFinite(date.getTime())) {
    return undefined;
  }
  return date.toISOString();
}

export function buildSnapshot(
  data: HudData,
  bar: { width: number; segments: BarSegment[] },
  nowMs: number = Date.now()
): HudSnapshot {
  const agents = summarizeSubagents(data.subagentTree?.nodes ?? []);
  const running = [...(data.toolActivity?.recentCalls ?? [])]
    .reverse()
    .find((call) => call.status === 'running');
  const usage = data.tokenUsage?.total_token_usage ?? data.tokenUsage?.last_token_usage;

  const snapshot: HudSnapshot = {
    version: SNAPSHOT_VERSION,
    updatedAt: new Date(nowMs).toISOString(),
    project: {
      name: data.project.projectName,
      ...(data.git.isGitRepo && data.git.branch && data.git.repo ? { repo: data.git.repo } : {}),
      ...(data.git.isGitRepo && data.git.branch ? { branch: data.git.branch } : {}),
      dirty: data.git.isDirty,
      ahead: data.git.ahead,
      behind: data.git.behind,
    },
    quota: readQuotaWindows(data.rateLimits, nowMs).map((window) => ({
      ...(window.label ? { label: window.label } : {}),
      percent: window.percent,
      // A reset time that has passed is still what was reported; the consumer
      // gets the time, not a claim that the window came back.
      ...(window.resetsAt ? { resetsAt: window.resetsAt.toISOString() } : {}),
    })),
    agents: {
      active: agents.active,
      completed: agents.completed,
      failed: agents.failed,
      unknown: agents.unknown,
      nodes: flattenAgents(data.subagentTree?.nodes ?? []),
    },
    attention: collectAttention(data, nowMs).map((item) => ({
      kind: item.kind,
      label: item.label,
      severity: item.severity,
    })),
    bar: {
      width: bar.width,
      segments: bar.segments.map((segment) => ({
        id: segment.id,
        level: segment.level,
        x: segment.x,
        width: segment.width,
      })),
    },
  };

  const session = data.session;
  if (session) {
    snapshot.session = {
      id: session.id,
      ...(session.model ? { model: session.model } : {}),
      ...(session.reasoningEffort ? { effort: session.reasoningEffort } : {}),
      ...(session.cwd ? { cwd: session.cwd } : {}),
    };
  }

  if (data.activity) {
    const turnStartedAt = iso(data.activity.turnStartedAt);
    snapshot.activity = {
      state: data.activity.state,
      ...(turnStartedAt ? { turnStartedAt } : {}),
      ...(running ? { tool: { name: running.name, ...(running.target ? { target: running.target } : {}) } } : {}),
    };
  }

  if (data.contextUsage) {
    snapshot.context = {
      percent: data.contextUsage.percent,
      used: data.contextUsage.used,
      total: data.contextUsage.total,
      compactions: data.contextUsage.compactCount,
    };
  }

  if (usage) {
    snapshot.tokens = {
      total: usage.total_tokens ?? 0,
      cached: usage.cached_input_tokens ?? 0,
    };
  }

  return snapshot;
}

/**
 * A tmux session name can hold anything a shell can quote; a filename cannot.
 * Both the writer and the readers (the toggle script, `codex-hud --json`)
 * apply this, so they agree on where the file is.
 */
export function snapshotFileName(sessionName: string): string {
  const safe = sessionName.replace(/[^A-Za-z0-9._-]/g, '_');
  return `${safe || 'unnamed'}.json`;
}

export function snapshotDirectory(codexHome: string = getCodexHome()): string {
  return path.join(codexHome, 'hud', 'state');
}

export function snapshotPath(env: NodeJS.ProcessEnv = process.env, pid: number = process.pid): string {
  // The session name is what a click or a script can look up. Without tmux
  // there is nothing to look the file up by, so it is named after this
  // process instead and is only useful to whoever already knows the pid.
  const session = (env.CODEX_HUD_TMUX_SESSION ?? '').trim() || `pid-${pid}`;
  return path.join(snapshotDirectory(), snapshotFileName(session));
}

const MIN_WRITE_INTERVAL_MS = 1000;

/**
 * Keeps the snapshot file up to date without writing it for the sake of it.
 *
 * Two guards. The file is rewritten only when something other than the clock
 * changed, because a status bar that has said the same thing for ten minutes
 * should not have cost ten minutes of disk writes. And never more than once a
 * second, so a burst of repaints cannot turn into a burst of writes.
 *
 * The write itself is a temporary file and a rename, so a reader either sees
 * the previous snapshot or the next one and never half of either.
 */
export class SnapshotWriter {
  private readonly file: string;
  private signature: string | null = null;
  private lastWriteAt = 0;

  constructor(file: string = snapshotPath()) {
    this.file = file;
  }

  get path(): string {
    return this.file;
  }

  write(snapshot: HudSnapshot, nowMs: number = Date.now()): boolean {
    const body = JSON.stringify(snapshot, null, 2);
    // The timestamp moves every tick by construction, so it cannot be part of
    // the question "did anything change?".
    const signature = JSON.stringify({ ...snapshot, updatedAt: '' });
    if (signature === this.signature || nowMs - this.lastWriteAt < MIN_WRITE_INTERVAL_MS) {
      return false;
    }

    const temporary = `${this.file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(temporary, body, { mode: 0o600 });
      fs.renameSync(temporary, this.file);
      this.signature = signature;
      this.lastWriteAt = nowMs;
      return true;
    } catch {
      try {
        fs.unlinkSync(temporary);
      } catch {
        // Nothing to clean up, or nothing we can do about it.
      }
      return false;
    }
  }

  /** The HUD is gone; so is its state. A stale file is worse than none. */
  remove(): void {
    try {
      fs.unlinkSync(this.file);
    } catch {
      // Already gone, or never written.
    }
  }
}
