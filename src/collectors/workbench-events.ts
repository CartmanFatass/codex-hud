import type { RolloutParseResult } from './rollout.js';
import type { SubagentTree, SubagentTreeNode } from '../types.js';
import type { WorkbenchEvent } from '../render/workbench-state.js';

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
  values(): WorkbenchEvent[] {
    return [...this.entries.values()].sort((a,b)=>b.at.getTime()-a.at.getTime() || a.id.localeCompare(b.id));
  }
}
