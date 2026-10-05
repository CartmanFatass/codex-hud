import type { RolloutParseResult } from './rollout.js';
import type { SubagentTree, SubagentTreeNode } from '../types.js';
import type { WorkbenchEvent, TimelineKind } from '../render/workbench-state.js';
import type { AgentLogEntry } from './agent-log.js';
import { directions, stageServes } from '../render/directions.js';
import { actionText } from './agent-stages.js';

/**
 * Events the timeline keeps of what it saw happen (the session's events, the
 * agents' log); the oldest go first. Stages are read from the tree each time,
 * as many as each agent's ledger keeps.
 */
export const TIMELINE_LIMIT = 500;
const AGENT_KINDS: Partial<Record<AgentLogEntry['kind'], TimelineKind>> = { started: 'agent-started', finished: 'agent-finished', failed: 'agent-failed' };

/** Bounded observed history; polling never invents a new event. */
export class WorkbenchHistory {
  private rootId = '';
  private entries = new Map<string, WorkbenchEvent>();
  update(tree: SubagentTree, main: RolloutParseResult | null, agent?: RolloutParseResult | null): void {
    if (tree.rootId !== this.rootId) { this.rootId = tree.rootId; this.entries.clear(); }
    const visit = (nodes: SubagentTreeNode[]) => {
      for (const node of nodes) {
        const at = node.statusAt;
        if (at) {
          const id = `${node.id}:${node.status}:${at.getTime()}`;
          this.entries.set(id, {id,at,title:`${node.name} ${node.status}`,status:node.status === 'starting' ? 'running' : node.status,
            detail:[`Agent: ${node.name}`, `Status: ${node.status}`, ...(node.task ? [`Task: ${node.task}`] : [])]});
        }
        visit(node.children);
      }
    };
    visit(tree.nodes);
    for (const result of [main,agent]) {
      if (!result) continue;
      const owner = result.session?.id ?? tree.rootId;
      for (const call of result.toolActivity.recentCalls) {
        const id = `${owner}:${call.id}:${call.status}`;
        const command = typeof call.arguments?.code === 'string' ? call.arguments.code : typeof call.arguments?.cmd === 'string' ? call.arguments.cmd
          : typeof call.arguments?.command === 'string' ? call.arguments.command : call.target ?? call.name;
        this.entries.set(id, {id,at:new Date(call.timestamp.getTime()+(call.duration ?? 0)),status:call.status,
          title:`${owner === tree.rootId ? 'main' : owner.slice(0,8)} ${call.name} ${call.status}`,
          detail:[command.slice(0,4000), ...(call.exitCode !== undefined ? [`Exit code: ${call.exitCode}`] : []), ...(call.output ? [call.output] : [])]});
      }
    }
    const latest = this.values().slice(0,100);
    this.entries = new Map(latest.map(event => [event.id,event]));
  }
  /**
   * The session timeline, newest first: what the rollout recorded
   * (approvals asked and answered, compaction, quota crossings, turns ending
   * with what they said, failed tool calls), each agent's stages as its own
   * rollout recorded them (a running one at its start, an ended one at its
   * end, with what it returned), and its failures from the agent log. An
   * agent whose rollout gave no stages has the log's starts and finishes
   * instead. What was seen is kept in one bounded, de-duplicated list.
   */
  timeline(tree: SubagentTree, main: RolloutParseResult | null, logs: ReadonlyMap<string, readonly AgentLogEntry[]>): WorkbenchEvent[] {
    if (tree.rootId !== this.rootId) { this.rootId = tree.rootId; this.entries.clear(); }
    const add = (event: Omit<WorkbenchEvent, 'title' | 'detail'> & { detail?: string[] }) => {
      if (!this.entries.has(event.id)) this.entries.set(event.id, { title: `${event.kind} ${event.subject ?? ''}`.trim(), detail: [], ...event });
    };
    for (const recorded of main?.events ?? []) {
      // A finished turn's text is its answer, not what the event is about: the same event twice stays one line.
      const answer = recorded.kind === 'turn-finished';
      add({ id: `session:${recorded.kind}:${recorded.at.getTime()}:${recorded.threshold ?? ''}:${answer ? '' : recorded.text ?? ''}`, at: recorded.at, kind: recorded.kind,
        status: recorded.kind === 'turn-failed' ? 'error' : 'completed', subject: recorded.kind === 'quota' || answer ? undefined : recorded.text,
        ...(answer && recorded.text ? { summary: recorded.text } : {}),
        ...(recorded.threshold !== undefined ? { threshold: recorded.threshold } : {}),
        ...(recorded.windowMinutes !== undefined ? { windowMinutes: recorded.windowMinutes } : {}) });
    }
    for (const call of main?.toolActivity.recentCalls ?? []) {
      if (call.status !== 'error') continue;
      // What failed, in a few words: the command it ran (an `exec` script's first one), not the tool's name.
      const code = call.arguments?.code;
      add({ id: `tool:${call.id}`, at: new Date(call.timestamp.getTime() + (call.duration ?? 0)), kind: 'tool-failed', status: 'error',
        subject: call.target ?? actionText(call.name, typeof code === 'string' ? code : call.arguments), detail: call.output ? [call.output] : [] });
    }
    const names = new Map<string, SubagentTreeNode>();
    const visit = (nodes: SubagentTreeNode[]) => { for (const node of nodes) { names.set(node.id, node); visit(node.children); } };
    visit(tree.nodes);
    for (const [id, entries] of logs) {
      const node = names.get(id);
      // Its stages say when it started and finished; a failure the log saw stays.
      const staged = Boolean(node?.stages?.length);
      for (const entry of entries) {
        const kind = AGENT_KINDS[entry.kind];
        if (!kind || (staged && kind !== 'agent-failed')) continue;
        add({ id: `agent:${id}:${entry.kind}:${entry.at}`, at: new Date(entry.at), kind, agentId: id, subject: node?.name ?? id.slice(0, 8),
          status: kind === 'agent-failed' ? 'error' : kind === 'agent-started' ? 'running' : 'completed' });
      }
    }
    const latest = this.values().slice(0, TIMELINE_LIMIT);
    this.entries = new Map(latest.map(event => [event.id, event]));
    const stages: WorkbenchEvent[] = [];
    const dirs = directions(tree);
    for (const node of names.values()) {
      for (const stage of node.stages ?? []) {
        const ended = stage.status !== 'running' && stage.endedAt;
        const serves = stageServes(dirs, node.id, stage);
        stages.push({ id: `stage:${node.id}:${stage.startedAt.getTime()}`, at: ended || stage.startedAt, kind: 'agent-stage', agentId: node.id,
          subject: node.name, title: `${node.name} ${stage.status}`, detail: [],
          status: stage.status === 'running' ? 'running' : stage.status === 'failed' ? 'error' : 'completed',
          stage: stage.status, startedAt: stage.startedAt, ...(stage.result ? { summary: stage.result } : {}), ...(serves ? { serves } : {}),
          ...(stage.status === 'running' && stage.intent ? { intent: stage.intent } : {}) });
      }
    }
    return [...latest.filter(event => event.kind !== undefined), ...stages].sort((a, b) => b.at.getTime() - a.at.getTime() || a.id.localeCompare(b.id));
  }

  values(): WorkbenchEvent[] {
    return [...this.entries.values()].sort((a,b)=>b.at.getTime()-a.at.getTime() || a.id.localeCompare(b.id));
  }
}
