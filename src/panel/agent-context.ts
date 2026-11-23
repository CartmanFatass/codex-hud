import { readAgentTokens, type AgentTokens } from '../collectors/agent-context.js';
import type { MonitorFrame } from '../render/monitor.js';
import type { SubagentTreeNode } from '../types.js';

/** At most one tail read per agent per this long, however often we repaint. */
const AGENT_CONTEXT_INTERVAL_MS = 3000;

export function walkNodes(nodes: SubagentTreeNode[], visit: (node: SubagentTreeNode) => void): void {
  for (const node of nodes) {
    visit(node);
    walkNodes(node.children, visit);
  }
}

/** Rollouts the current tree already shows, so a quiet one that starts writing is stat'd at once. */
export function treePaths(nodes: SubagentTreeNode[]): Set<string> {
  const paths = new Set<string>();
  walkNodes(nodes, (node) => {
    if (node.rolloutPath) paths.add(node.rolloutPath);
  });
  return paths;
}

export function createAgentContext(isClosed: () => boolean) {
  // The tree is rebuilt from the rollout on every collection and would otherwise lose these facts.
  const agentContext = new Map<string, AgentTokens>();
  const agentContextReadAt = new Map<string, number>();
  let readingAgentContext = false;
  return {
    clear() {
      agentContext.clear();
      agentContextReadAt.clear();
    },
    apply(nodes: SubagentTreeNode[]) {
      walkNodes(nodes, (node) => {
        const tokens = agentContext.get(node.id);
        node.contextUsage = tokens?.usage;
        node.outputRate = tokens?.rate;
        node.tokensSpent = tokens?.spent;
      });
    },
    /** The native Inspector reads only agents on screen or still running. */
    async refresh(nodes: SubagentTreeNode[], frame: MonitorFrame | undefined, onChange: () => void) {
      if (isClosed() || readingAgentContext) return;
      readingAgentContext = true;
      try {
        const pane = frame?.panes.find((p) => p.id === 'details');
        const wanted = new Set<string>();
        if (pane) {
          for (let i = pane.offset; i < pane.offset + (pane.visible ?? pane.height); i++) {
            const item = pane.rows[i]?.item;
            if (item?.startsWith('native:')) wanted.add(item.slice('native:'.length));
          }
        }
        const byId = new Map<string, SubagentTreeNode>();
        walkNodes(nodes, (node) => {
          byId.set(node.id, node);
          if (node.status === 'running' || node.status === 'starting') wanted.add(node.id);
        });
        const now = Date.now();
        let changed = false;
        for (const id of wanted) {
          const path = byId.get(id)?.rolloutPath;
          if (!path || byId.get(id)?.ref?.harness === 'claude') continue;
          if (now - (agentContextReadAt.get(id) ?? 0) < AGENT_CONTEXT_INTERVAL_MS) continue;
          agentContextReadAt.set(id, now);
          const tokens = await readAgentTokens(path);
          if (isClosed()) return;
          if (tokens.usage || tokens.rate || tokens.spent) agentContext.set(id, tokens);
          else agentContext.delete(id);
          changed = true;
        }
        // Entries for agents no longer in the tree would otherwise accumulate.
        for (const id of [...agentContext.keys()])
          if (!byId.has(id)) {
            agentContext.delete(id);
            agentContextReadAt.delete(id);
          }
        if (changed) onChange();
      } catch {
        /* A rollout that cannot be read has no fill to report. */
      } finally {
        readingAgentContext = false;
      }
    },
  };
}
