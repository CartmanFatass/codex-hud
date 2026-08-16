/**
 * Build a multi-level subagent tree from rollout session_meta parent links.
 */

import * as fs from 'fs';
import { findRolloutsInDays } from './session-finder.js';
import type { SubagentInfo, SubagentStatus, SubagentTree, SubagentTreeNode } from '../types.js';

const ACTIVE_WINDOW_MS = 45_000;

interface SessionLink {
  id: string;
  parentId: string | null;
  name: string;
  startedAt?: Date;
  modifiedAt: Date;
}

function readFirstLine(filePath: string): string | null {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(4096);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (bytesRead <= 0) {
      return null;
    }
    const chunk = buffer.toString('utf8', 0, bytesRead);
    const newline = chunk.indexOf('\n');
    return newline === -1 ? chunk : chunk.slice(0, newline);
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
    return {
      id,
      parentId: entry.payload.parent_thread_id ?? null,
      name,
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

export function desiredHudHeight(tree?: SubagentTree | null): number {
  const levels = collectNodesByDepth(tree?.nodes ?? []);
  return Math.max(1, Math.min(12, 1 + levels.length));
}

export function buildSubagentTree(
  rootId: string,
  knownSubagents: SubagentInfo[] = [],
  maxDaysBack: number = 3,
  nowMs: number = Date.now()
): SubagentTree {
  const known = new Map(knownSubagents.map((agent) => [agent.id, agent]));
  const links = new Map<string, SessionLink>();

  for (const file of findRolloutsInDays(maxDaysBack)) {
    const link = peekSessionLink(file.path, file.modifiedAt);
    if (!link) {
      continue;
    }
    const existing = links.get(link.id);
    if (!existing || link.modifiedAt > existing.modifiedAt) {
      links.set(link.id, link);
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
