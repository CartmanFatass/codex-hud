/**
 * Build a multi-level subagent tree from rollout session_meta parent links.
 */

import * as fs from 'fs';
import { findRolloutsInDays } from './session-finder.js';
import type { SubagentInfo, SubagentStatus, SubagentTree, SubagentTreeNode } from '../types.js';

const ACTIVE_WINDOW_MS = 45_000;

// session_meta is the first line and never changes on append, so each rollout
// only needs to be read once. Cache entries re-validate by stat signature and
// re-peek when the file shrank (truncation/rotation rewrites the first line).
interface CachedLink {
  link: SessionLink | null;
  size: number;
  mtimeMs: number;
  ino?: number;
}

const linkCache = new Map<string, CachedLink>();

export function resetSubagentLinkCache(): void {
  linkCache.clear();
}

interface SessionLink {
  id: string;
  parentId: string | null;
  name: string;
  model?: string;
  effort?: string;
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
      parentId: entry.payload.parent_thread_id ?? null,
      name,
      model: spawn?.model ?? payloadModel,
      effort: spawn?.effort ?? payloadEffort,
      startedAt: entry.payload.timestamp ? new Date(entry.payload.timestamp) : undefined,
      modifiedAt,
    };
  } catch {
    return null;
  }
}

function resolveStatus(
  known: SubagentInfo | undefined,
  modifiedAt: Date,
  nowMs: number
): SubagentStatus {
  if (known) {
    return known.status;
  }
  return nowMs - modifiedAt.getTime() <= ACTIVE_WINDOW_MS ? 'running' : 'completed';
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
    // Known limits: a truncate-and-regrow that lands at or above the last
    // observed size still looks like an append, and a same-signature rewrite
    // is undetectable from stat alone.
    const appended = Boolean(
      cached &&
        cached.link &&
        cached.size < file.size &&
        cached.mtimeMs <= modifiedMs &&
        (cached.ino === undefined || file.ino === undefined || cached.ino === file.ino)
    );

    if (cached && cached.link && (unchanged || appended)) {
      link = cached.link;
      link.modifiedAt = file.modifiedAt;
      // Track the latest observation so later shrinks are detected against
      // the most recent size, not the size at first cache time.
      cached.size = file.size;
      cached.mtimeMs = modifiedMs;
      cached.ino = file.ino ?? cached.ino;
    } else if (cached && !cached.link && unchanged) {
      // Negative cache: the file has not changed since the last failed peek,
      // so there is nothing new to read yet.
      link = null;
    } else {
      // First sight, previously failed peek with new bytes, shrink, or
      // same-size rewrite: read the first line again.
      link = peekSessionLink(file.path, file.modifiedAt);
      linkCache.set(file.path, { link, size: file.size, mtimeMs: modifiedMs, ino: file.ino });
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
    const knownAgent = known.get(id);
    const childIds = (children.get(id) ?? []).filter((childId) => !visiting.has(childId));
    const node: SubagentTreeNode = {
      id,
      name: knownAgent?.name || link?.name || id.slice(0, 8),
      status: resolveStatus(knownAgent, link?.modifiedAt ?? new Date(0), nowMs),
      startedAt: knownAgent?.startedAt ?? link?.startedAt,
      model: knownAgent?.model ?? link?.model,
      effort: knownAgent?.effort ?? link?.effort,
      lastActivityAt: knownAgent?.lastActivityAt,
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
