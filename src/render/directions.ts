/**
 * The agents as research directions: each L1 agent (one the main session
 * started) with the agents under it is a direction, and a colour marks it
 * on the timeline and the cards. An L1 with no subtasks of its own that
 * exchanged most of its messages with one that has them works for that one
 * (a critic, an oracle): it takes that direction's colour.
 *
 * Read from the tree alone: the stages and message counts each agent's
 * rollout recorded (src/collectors/agent-stages.ts). Nothing is guessed from
 * names.
 */
import type { AgentStage, SubagentTree, SubagentTreeNode } from '../types.js';
import type { AgentLogEntry } from '../collectors/agent-log.js';
import { isGuardian } from './panel-state.js';
import { palette, type Paint } from './palette.js';
import { isLive, finishedAt } from './monitor-labels.js';

/** Fewest messages, both ways, that make an L1 another's helper. */
export const TALK_MIN = 3;

export interface Directions {
  /** Each agent's L1, by id; an L1 is its own. */
  family: ReadonlyMap<string, string>;
  /** A helper L1's coordinator, by id. */
  serves: ReadonlyMap<string, string>;
  /** Each agent by id, with its level: 0 for an L1, 1 for its subtasks, and so on. */
  node: ReadonlyMap<string, { node: SubagentTreeNode; level: number }>;
  /** Agent ids by task path (`/root/a/b`), for a message's sender. */
  byPath: ReadonlyMap<string, string>;
  /** The colour of the direction an agent is in; none for the main session or an unknown id. */
  paint(id?: string): Paint;
}

/** An L1's subtasks: the agents it started, guardian reviews aside, in the order they started. */
export function subtasks(node: SubagentTreeNode): SubagentTreeNode[] {
  return node.children.filter(child => !isGuardian(child)).sort((a, b) => (a.startedAt?.getTime() ?? 0) - (b.startedAt?.getTime() ?? 0));
}

/** Messages two agents exchanged over the session, both ways, as each one's rollout counted what it was sent. */
export function talk(a: SubagentTreeNode, b: SubagentTreeNode): number {
  return (a.agentPath ? b.peers?.[a.agentPath] ?? 0 : 0) + (b.agentPath ? a.peers?.[b.agentPath] ?? 0 : 0);
}

const plain: Paint = text => text;
let memo: { tree: SubagentTree; theme: string; value: Directions } | undefined;

/**
 * The directions and their colours. Colours go to the directions in the
 * order they started, each the colour least used among those still at work
 * when it started, so directions running side by side are told apart; a
 * direction that starts later never changes an earlier one's colour. (An L1
 * found to be a helper, which happens in its first exchanges, gives its
 * colour up for its lead's.)
 */
export function directions(tree: SubagentTree): Directions {
  if (memo && memo.tree === tree && memo.theme === palette().name) return memo.value;
  const family = new Map<string, string>();
  const node = new Map<string, { node: SubagentTreeNode; level: number }>();
  const byPath = new Map<string, string>();
  const walk = (items: readonly SubagentTreeNode[], level: number, l1?: string) => {
    for (const item of items) {
      node.set(item.id, { node: item, level });
      family.set(item.id, l1 ?? item.id);
      if (item.agentPath) byPath.set(item.agentPath, item.id);
      walk(item.children, level + 1, l1 ?? item.id);
    }
  };
  walk(tree.nodes, 0);
  const l1s = tree.nodes.filter(n => !isGuardian(n));
  const leads = l1s.filter(n => subtasks(n).length);
  const serves = new Map<string, string>();
  for (const helper of l1s) {
    if (subtasks(helper).length) continue;
    let best: SubagentTreeNode | undefined;
    let most = TALK_MIN - 1;
    for (const lead of leads) {
      const count = talk(helper, lead);
      if (count > most) { most = count; best = lead; }
    }
    if (best) serves.set(helper.id, best.id);
  }
  const started = (n: SubagentTreeNode) => n.startedAt?.getTime() ?? 0;
  // A direction is at work while its L1 or any subtask is; then until the last of them finished.
  const ended = (n: SubagentTreeNode) => isLive(n) || subtasks(n).some(isLive) ? Infinity
    : Math.max(finishedAt(n)?.getTime() ?? started(n), ...subtasks(n).map(kid => finishedAt(kid)?.getTime() ?? 0));
  const colours = palette().directions;
  const index = new Map<string, number>();
  const placed: SubagentTreeNode[] = [];
  for (const n of l1s.filter(n => !serves.has(n.id)).sort((a, b) => started(a) - started(b) || a.id.localeCompare(b.id))) {
    const uses = new Array<number>(colours.length).fill(0);
    for (const other of placed) if (ended(other) > started(n)) uses[index.get(other.id)!]++;
    index.set(n.id, uses.indexOf(Math.min(...uses)));
    placed.push(n);
  }
  const value: Directions = {
    family, serves, node, byPath,
    paint(id?: string): Paint {
      const l1 = id ? family.get(id) : undefined;
      if (!l1) return plain;
      const at = index.get(serves.get(l1) ?? l1);
      return at === undefined ? plain : colours[at];
    },
  };
  memo = { tree, theme: palette().name, value };
  return value;
}

/**
 * Whom a helper L1's stage was for: the agent that set it, where that is a
 * lead with subtasks, else the lead that sent it the most messages during
 * the stage. Nothing for an agent that is no helper.
 */
export function stageServes(dirs: Directions, id: string, stage: AgentStage): string | undefined {
  if (!dirs.serves.has(id)) return undefined;
  const lead = (path: string | undefined) => {
    const other = path ? dirs.byPath.get(path) : undefined;
    const hit = other ? dirs.node.get(other) : undefined;
    return hit && hit.level === 0 && subtasks(hit.node).length ? other : undefined;
  };
  const by = lead(stage.by?.sender);
  if (by) return by;
  let best: string | undefined;
  let most = 0;
  for (const [path, count] of Object.entries(stage.peers ?? {})) {
    const other = lead(path);
    if (other && count > most) { most = count; best = other; }
  }
  return best ?? dirs.serves.get(id);
}

/** Subtasks by state: running, failed and done. */
export function tally(kids: readonly SubagentTreeNode[]): { running: number; failed: number; done: number } {
  return {
    running: kids.filter(isLive).length,
    failed: kids.filter(kid => kid.status === 'error').length,
    done: kids.filter(kid => kid.status === 'completed').length,
  };
}

/**
 * Whether an L2's comings and goings are worth a line of their own: it
 * failed, it is in a role the reader named (one whose results matter, a
 * critic's verdict), or the brief flagged it.
 */
export function isImportant(node: SubagentTreeNode, log: readonly AgentLogEntry[] | undefined, roles: ReadonlySet<string>): boolean {
  return node.status === 'error' || Boolean(node.role && roles.has(node.role)) || Boolean(log?.at(-1)?.attention);
}

/** The roles named in the setting: a comma list, spaces ignored. */
export function roleSet(text: string | undefined): ReadonlySet<string> {
  return new Set((text ?? '').split(',').map(role => role.trim()).filter(Boolean));
}
