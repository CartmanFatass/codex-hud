import { taskText } from '../utils/task-text.js';
import { extractAgentReport, type AgentReport } from './agent-report.js';
/**
 * Build a multi-level subagent tree from rollout session_meta parent links.
 */

import * as fs from 'fs';
import { sessionParentId } from '../utils/session-parent.js';
import { findRolloutsInDays } from './session-finder.js';
import type { SubagentInfo, SubagentStatus, SubagentTree, SubagentTreeNode } from '../types.js';

// session_meta is the first line and never changes on append, so each rollout
// only needs to be read once. Cache entries re-validate by stat signature and
// re-peek when the file shrank (truncation/rotation rewrites the first line).
interface CachedLink {
  link: SessionLink | null;
  size: number;
  mtimeMs: number;
  ino?: number;
  // Last time the first line was actually read for this entry. Stat signatures
  // cannot detect same-signature rewrites, so entries older than
  // REVALIDATE_INTERVAL_MS get re-peeked (bounded per tick) to bound how long
  // a stale link can survive.
  verifiedAt: number;
  // Byte offset already scanned for model/effort and lifecycle events.
  contextOffset: number;
}

const linkCache = new Map<string, CachedLink>();

// Bound the staleness window of stat-only caching: re-peek at most this many
// known files per build call, oldest verification first.
const REPEEK_BUDGET_PER_TICK = 2;
const REVALIDATE_INTERVAL_MS = 30_000;

export function resetSubagentLinkCache(): void {
  linkCache.clear();
}

interface SessionLink {
  lastReport?: AgentReport;
  task?: string;
  id: string;
  parentId: string | null;
  name: string;
  path: string;
  model?: string;
  effort?: string;
  status?: SubagentStatus;
  statusAt?: Date;
  turnStartedAt?: Date;
  startedAt?: Date;
  modifiedAt: Date;
}

// session_meta lines embed full instructions and can reach hundreds of KB;
// stop well before any rollout grows large, but never truncate the JSON.
const MAX_FIRST_LINE_BYTES = 1024 * 1024;

function readFirstLine(filePath: string): string | null {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(64 * 1024);
    let chunk = '';
    let offset = 0;
    while (chunk.length < MAX_FIRST_LINE_BYTES) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, offset);
      if (bytesRead <= 0) {
        break;
      }
      chunk += buffer.toString('utf8', 0, bytesRead);
      offset += bytesRead;
      const newline = chunk.indexOf('\n');
      if (newline !== -1) {
        return chunk.slice(0, newline);
      }
    }
    return chunk.length > 0 ? chunk : null;
  } finally {
    fs.closeSync(fd);
  }
}

function nicknameFromSource(source: unknown): string | undefined {
  if (!source || typeof source !== 'object') {
    return undefined;
  }
  const subagent = (source as { subagent?: { thread_spawn?: { agent_nickname?: string } } }).subagent;
  return subagent?.thread_spawn?.agent_nickname;
}

function spawnFromSource(source: unknown): { model?: string; effort?: string } | undefined {
  if (!source || typeof source !== 'object') {
    return undefined;
  }
  const spawn = (source as {
    subagent?: { thread_spawn?: Record<string, unknown> };
  }).subagent?.thread_spawn;
  if (!spawn) {
    return undefined;
  }
  const model = typeof spawn.model === 'string' ? spawn.model : undefined;
  const rawEffort = spawn.effort ?? spawn.reasoning_effort;
  const effort = typeof rawEffort === 'string' ? rawEffort : undefined;
  return model || effort ? { model, effort } : undefined;
}

function modelEffortFromPayload(payload: Record<string, unknown>): { model?: string; effort?: string } {
  const settings = (payload.collaboration_mode as { settings?: Record<string, unknown> } | undefined)?.settings
    ?? (payload.thread_settings as Record<string, unknown> | undefined);
  const modelCandidates = [payload.model, settings?.model];
  const effortCandidates = [payload.effort, payload.reasoning_effort, settings?.effort, settings?.reasoning_effort];
  const model = modelCandidates.find((value): value is string => typeof value === 'string' && value.length > 0);
  const effort = effortCandidates.find((value): value is string => typeof value === 'string' && value.length > 0);
  return { model, effort };
}

type RolloutFields = Pick<SessionLink, 'model' | 'effort' | 'status' | 'statusAt' | 'turnStartedAt' | 'task' | 'lastReport'>;

function applyRolloutLine(line: string, into: RolloutFields): void {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }
  try {
    const entry = JSON.parse(trimmed) as { timestamp?: string; type?: string; payload?: Record<string, unknown> };
    if (!entry.payload) {
      return;
    }
    const report = extractAgentReport(entry);
    if (report && (!into.lastReport || report.at >= into.lastReport.at)) into.lastReport = report;
    if (entry.type === 'response_item' && entry.payload.type === 'message' && entry.payload.role === 'user' && Array.isArray(entry.payload.content)) {
      const text = taskText(entry.payload.content.map((part: { text?: unknown }) => typeof part?.text === 'string' ? part.text : '').filter(Boolean).join('\n'));
      if (text) into.task = text;
    }
    if (entry.type === 'event_msg') {
      const type = entry.payload.type;
      if (type === 'user_message') {
        const task = taskText(entry.payload.message);
        if (task) into.task = task;
      }
      const status = type === 'task_started' || type === 'turn_started' ? 'running'
        : type === 'task_complete' || type === 'turn_complete' ? 'completed'
          : undefined;
      const time = entry.timestamp ? new Date(entry.timestamp) : undefined;
      if (status && time && Number.isFinite(time.getTime())) {
        into.status = status;
        into.statusAt = time;
        if (status === 'running') into.turnStartedAt = time;
      }
    }
    if (entry.type === 'turn_context') {
      const fields = modelEffortFromPayload(entry.payload);
      if (fields.model) into.model = fields.model;
      if (fields.effort) into.effort = fields.effort;
      return;
    }
    if (entry.type === 'event_msg' && entry.payload.type === 'thread_settings_applied') {
      const settings = entry.payload.thread_settings;
      if (settings && typeof settings === 'object') {
        const fields = modelEffortFromPayload(settings as Record<string, unknown>);
        if (fields.model) into.model = fields.model;
        if (fields.effort) into.effort = fields.effort;
      }
    }
  } catch {
    // skip malformed lines
  }
}

function scanRolloutFields(filePath: string, startOffset: number): RolloutFields & { endOffset: number } {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(64 * 1024);
    let offset = Math.max(0, startOffset);
    let leftover: Buffer = Buffer.alloc(0);
    const fields: RolloutFields & { endOffset: number } = { endOffset: offset };
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, offset);
      if (bytesRead <= 0) {
        break;
      }
      leftover = Buffer.concat([leftover, buffer.subarray(0, bytesRead)]);
      offset += bytesRead;
      let newline = leftover.indexOf(10);
      while (newline !== -1) {
        applyRolloutLine(leftover.subarray(0, newline).toString('utf8'), fields);
        leftover = leftover.subarray(newline + 1);
        newline = leftover.indexOf(10);
      }
    }
    // A writer may stop halfway through an event. Re-read its bytes on the
    // next tick instead of permanently skipping the eventual status change.
    fields.endOffset = offset - leftover.length;
    return fields;
  } finally {
    fs.closeSync(fd);
  }
}

function refreshRolloutFields(link: SessionLink): void {
  const cached = linkCache.get(link.path);
  if (!cached?.link) {
    return;
  }
  const start = cached.contextOffset ?? 0;
  if (start >= cached.size) {
    return;
  }
  const extra = scanRolloutFields(link.path, start);
  if (extra.model) {
    link.model = extra.model;
    cached.link.model = extra.model;
  }
  if (extra.effort) {
    link.effort = extra.effort;
    cached.link.effort = extra.effort;
  }
  if (extra.status) {
    link.status = extra.status;
    link.statusAt = extra.statusAt;
  }
  if (extra.turnStartedAt) link.turnStartedAt = extra.turnStartedAt;
  if (extra.task) link.task = extra.task;
  if (extra.lastReport && (!link.lastReport || extra.lastReport.at >= link.lastReport.at)) link.lastReport = extra.lastReport;
  cached.contextOffset = extra.endOffset;
}

function peekSessionLink(filePath: string, modifiedAt: Date): SessionLink | null {
  try {
    const firstLine = readFirstLine(filePath);
    if (!firstLine) {
      return null;
    }
    const entry = JSON.parse(firstLine.trim()) as {
      type?: string;
      payload?: {
        id?: string;
        session_id?: string;
        parent_thread_id?: string;
        agent_nickname?: string;
        model?: string;
        effort?: string;
        timestamp?: string;
        source?: unknown;
      };
    };
    if (entry.type !== 'session_meta' || !entry.payload) {
      return null;
    }
    const id = entry.payload.id || entry.payload.session_id;
    if (!id) {
      return null;
    }
    const name =
      entry.payload.agent_nickname ||
      nicknameFromSource(entry.payload.source) ||
      id.slice(0, 8);
    const spawn = spawnFromSource(entry.payload.source);
    const payloadModel = typeof entry.payload.model === 'string' ? entry.payload.model : undefined;
    const payloadEffort = typeof (entry.payload as { effort?: unknown }).effort === 'string'
      ? (entry.payload as { effort?: string }).effort
      : undefined;
    return {
      id,
      parentId: sessionParentId(entry.payload) ?? null,
      name,
      path: filePath,
      model: spawn?.model ?? payloadModel,
      effort: spawn?.effort ?? payloadEffort,
      startedAt: entry.payload.timestamp ? new Date(entry.payload.timestamp) : undefined,
      modifiedAt,
    };
  } catch {
    return null;
  }
}

function resolveStatus(known: SubagentInfo | undefined, link: SessionLink | undefined): SubagentStatus {
  // Compare event timestamps, never file mtime: model settings and other
  // writes after completion do not mean the agent has started another turn.
  if (link?.status && (!known || !known.lastActivityAt ||
      (link.statusAt && link.statusAt >= known.lastActivityAt))) {
    return link.status;
  }
  if (known) {
    return known.status;
  }
  // A parent link alone does not establish activity or completion.
  return 'unknown';
}

function newestEvidence(...times: Array<Date | undefined>): Date | undefined {
  let newest: Date | undefined;
  for (const time of times) {
    if (time && (!newest || time > newest)) {
      newest = time;
    }
  }
  return newest;
}

function countNodes(nodes: SubagentTreeNode[]): number {
  return nodes.reduce((sum, node) => sum + 1 + countNodes(node.children), 0);
}

export function collectNodesByDepth(nodes: SubagentTreeNode[]): SubagentTreeNode[][] {
  const levels: SubagentTreeNode[][] = [];
  const walk = (items: SubagentTreeNode[], depth: number) => {
    if (items.length === 0) {
      return;
    }
    if (!levels[depth]) {
      levels[depth] = [];
    }
    levels[depth].push(...items);
    for (const item of items) {
      walk(item.children, depth + 1);
    }
  };
  walk(nodes, 0);
  return levels;
}

export interface SubagentTreeEntry {
  node: SubagentTreeNode;
  // Directory-tree connector fragment (├─ / └─ with │ continuation) locating
  // the node under its ancestors. Depth-1 entries render bare: they all hang
  // directly off the main session.
  prefix: string;
  // id of the depth-1 ancestor owning this entry, for row grouping.
  rootId: string;
}

// One depth-2 agent and the depth-3 agents it spawned. Keeping them together
// lets the renderer align grandchildren under their immediate parent, so the
// same depth can share a row without losing parent identity.
export interface SubagentTreeSlice {
  entry: SubagentTreeEntry;
  children: SubagentTreeEntry[];
}

export interface SubagentTreeLineage {
  root: SubagentTreeEntry;
  slices: SubagentTreeSlice[];
}

function nodeIsActive(node: SubagentTreeNode): boolean {
  return node.status === 'running' || node.status === 'starting';
}

function subtreeHasActive(node: SubagentTreeNode): boolean {
  if (nodeIsActive(node)) {
    return true;
  }
  return node.children.some(subtreeHasActive);
}

function lastDisplayedIndex(nodes: SubagentTreeNode[]): number {
  let last = -1;
  nodes.forEach((node, index) => {
    if (subtreeHasActive(node)) {
      last = index;
    }
  });
  return last;
}

/**
 * Collect ACTIVE agents (running/starting) grouped by lineage. Completed
 * agents stay only when they anchor an active descendant, so connector
 * prefixes keep showing ownership. Depth is capped at 3 levels (root lineage
 * entry + one slice level + one grandchild level); deeper agents are dropped.
 */
export function collectActiveTreeLineages(
  tree: SubagentTree | null | undefined,
  maxLevels: number = 3
): SubagentTreeLineage[] {
  const lineages: SubagentTreeLineage[] = [];
  for (const root of tree?.nodes ?? []) {
    if (!subtreeHasActive(root)) {
      continue;
    }
    const lineage: SubagentTreeLineage = {
      root: { node: root, prefix: '', rootId: root.id },
      slices: [],
    };
    if (maxLevels >= 2) {
      const rootLast = lastDisplayedIndex(root.children);
      root.children.forEach((kid, index) => {
        if (!subtreeHasActive(kid)) {
          return;
        }
        const kidLast = index === rootLast;
        const slice: SubagentTreeSlice = {
          entry: { node: kid, prefix: kidLast ? '└─ ' : '├─ ', rootId: root.id },
          children: [],
        };
        if (maxLevels >= 3) {
          const kidCont = kidLast ? '   ' : '│  ';
          const kidChildLast = lastDisplayedIndex(kid.children);
          kid.children.forEach((grand, gIndex) => {
            if (!subtreeHasActive(grand)) {
              return;
            }
            slice.children.push({
              node: grand,
              prefix: kidCont + (gIndex === kidChildLast ? '└─ ' : '├─ '),
              rootId: root.id,
            });
          });
        }
        lineage.slices.push(slice);
      });
    }
    lineages.push(lineage);
  }
  return lineages;
}

/** Deepest level actually present (0 when there is nothing to show). */
export function countActiveTreeLevels(lineages: SubagentTreeLineage[]): number {
  if (lineages.length === 0) {
    return 0;
  }
  if (lineages.some((lineage) => lineage.slices.some((slice) => slice.children.length > 0))) {
    return 3;
  }
  if (lineages.some((lineage) => lineage.slices.length > 0)) {
    return 2;
  }
  return 1;
}

export function buildSubagentTree(
  rootId: string,
  knownSubagents: SubagentInfo[] = [],
  maxDaysBack: number = 3,
  nowMs: number = Date.now()
): SubagentTree {
  const known = new Map(knownSubagents.map((agent) => [agent.id, agent]));
  const links = new Map<string, SessionLink>();

  const files = findRolloutsInDays(maxDaysBack);
  const seen = new Set<string>();
  // Same-signature rewrites are invisible to stat; force a re-read of entries
  // whose content has not been verified recently, oldest verification first,
  // bounded per tick.
  const revalidatePaths = new Set<string>();
  {
    const staleCandidates: Array<{ path: string; verifiedAt: number }> = [];
    for (const [entryPath, entry] of linkCache) {
      if (nowMs - entry.verifiedAt > REVALIDATE_INTERVAL_MS) {
        staleCandidates.push({ path: entryPath, verifiedAt: entry.verifiedAt });
      }
    }
    staleCandidates.sort((a, b) => a.verifiedAt - b.verifiedAt);
    for (const candidate of staleCandidates) {
      if (revalidatePaths.size >= REPEEK_BUDGET_PER_TICK) {
        break;
      }
      revalidatePaths.add(candidate.path);
    }
  }
  for (const file of files) {
    seen.add(file.path);
    const modifiedMs = file.modifiedAt.getTime();
    const cached = linkCache.get(file.path);
    let link: SessionLink | null;

    const unchanged = Boolean(
      cached &&
        cached.size === file.size &&
        cached.mtimeMs === modifiedMs &&
        (cached.ino === undefined || file.ino === undefined || cached.ino === file.ino)
    );
    // Append-only growth keeps the first line intact, so the cached metadata
    // stays valid. Anything else (shrink, same-size rewrite with a newer
    // mtime, inode replacement, or a previously failed peek) re-peeks.
    const appended = Boolean(
      cached &&
        cached.link &&
        cached.size < file.size &&
        cached.mtimeMs <= modifiedMs &&
        (cached.ino === undefined || file.ino === undefined || cached.ino === file.ino)
    );
    const revalidate = revalidatePaths.has(file.path);

    if (cached && cached.link && (unchanged || appended) && !revalidate) {
      link = cached.link;
      link.modifiedAt = file.modifiedAt;
      // Track the latest observation so later shrinks are detected against
      // the most recent size, not the size at first cache time.
      cached.size = file.size;
      cached.mtimeMs = modifiedMs;
      cached.ino = file.ino ?? cached.ino;
    } else if (cached && !cached.link && unchanged && !revalidate) {
      // Negative cache: the file has not changed since the last failed peek,
      // so there is nothing new to read yet.
      link = null;
    } else {
      // First sight, previously failed peek with new bytes, shrink, same-size
      // rewrite, or a scheduled revalidation: read the first line again.
      const previous = cached;
      link = peekSessionLink(file.path, file.modifiedAt);
      const keepContext = Boolean(revalidate && previous?.link && link && unchanged);
      if (keepContext && previous?.link && link) {
        link.model = previous.link.model ?? link.model;
        link.effort = previous.link.effort ?? link.effort;
        link.status = previous.link.status;
        link.statusAt = previous.link.statusAt;
        link.turnStartedAt = previous.link.turnStartedAt;
        link.task = previous.link.task;
        link.lastReport = previous.link.lastReport;
      }
      linkCache.set(file.path, {
        link,
        size: file.size,
        mtimeMs: modifiedMs,
        ino: file.ino,
        verifiedAt: nowMs,
        contextOffset: keepContext ? (previous?.contextOffset ?? 0) : 0,
      });
    }
    if (!link) {
      continue;
    }
    const existing = links.get(link.id);
    if (!existing || link.modifiedAt > existing.modifiedAt) {
      links.set(link.id, link);
    }
  }
  for (const key of Array.from(linkCache.keys())) {
    if (!seen.has(key)) {
      linkCache.delete(key);
    }
  }

  const children = new Map<string, string[]>();
  for (const link of links.values()) {
    if (!link.parentId) {
      continue;
    }
    const siblings = children.get(link.parentId) ?? [];
    siblings.push(link.id);
    children.set(link.parentId, siblings);
  }

  // Collab-spawned agents may not have their own rollout peeked yet.
  for (const agent of knownSubagents) {
    if (links.has(agent.id)) {
      continue;
    }
    const siblings = children.get(rootId) ?? [];
    if (!siblings.includes(agent.id)) {
      siblings.push(agent.id);
      children.set(rootId, siblings);
    }
  }

  const visiting = new Set<string>();

  const buildNode = (id: string, depth: number): SubagentTreeNode => {
    visiting.add(id);
    const link = links.get(id);
    if (link) {
      refreshRolloutFields(link);
    }
    const knownAgent = known.get(id);
    const childIds = (children.get(id) ?? []).filter((childId) => !visiting.has(childId));
    const node: SubagentTreeNode = {
      id,
      name: knownAgent?.name || link?.name || id.slice(0, 8),
      status: resolveStatus(knownAgent, link),
      startedAt: knownAgent?.startedAt ?? link?.startedAt,
      turnStartedAt: link?.turnStartedAt,
      rolloutPath: link?.path,
      lastReport: link?.lastReport,
      task: taskText(link?.task) ?? taskText(knownAgent?.task),
      statusAt: knownAgent?.lastActivityAt && (!link?.statusAt || knownAgent.lastActivityAt > link.statusAt)
        ? knownAgent.lastActivityAt : link?.statusAt,
      // Child turn_context is the live model/effort; spawn events are fallback.
      model: link?.model ?? knownAgent?.model,
      effort: link?.effort ?? knownAgent?.effort,
      lastActivityAt: knownAgent?.lastActivityAt,
      // Newest evidence of any kind: a main-to-agent exchange, or the agent's
      // own rollout growing. This is data freshness, not a status.
      lastEventAt: newestEvidence(knownAgent?.lastActivityAt, link?.modifiedAt),
      depth,
      children: childIds.map((childId) => buildNode(childId, depth + 1)),
    };
    visiting.delete(id);
    return node;
  };

  const nodes = (children.get(rootId) ?? []).map((id) => buildNode(id, 1));
  return {
    rootId,
    nodes,
    totalCount: countNodes(nodes),
    updatedAt: new Date(nowMs),
  };
}

/**
 * Counts for the bar and the panel header.
 *
 * Finished and failed are separate numbers on purpose: a single "done" count
 * reads a failure as work completed. Agents with no observed state are counted
 * as unknown rather than folded into either side.
 */
export interface SubagentSummary {
  total: number;
  running: number;
  starting: number;
  completed: number;
  failed: number;
  unknown: number;
  /** Agents that still need something to happen before the session can finish. */
  active: number;
}

export function summarizeSubagents(nodes: SubagentTreeNode[]): SubagentSummary {
  const summary: SubagentSummary = {
    total: 0,
    running: 0,
    starting: 0,
    completed: 0,
    failed: 0,
    unknown: 0,
    active: 0,
  };

  const walk = (items: SubagentTreeNode[]): void => {
    for (const node of items) {
      summary.total += 1;
      switch (node.status) {
        case 'running':
          summary.running += 1;
          summary.active += 1;
          break;
        case 'starting':
          summary.starting += 1;
          summary.active += 1;
          break;
        case 'completed':
          summary.completed += 1;
          break;
        case 'error':
          summary.failed += 1;
          break;
        default:
          summary.unknown += 1;
          break;
      }
      walk(node.children);
    }
  };

  walk(nodes);
  return summary;
}
