import { sidebarRunKey, type SidebarFacts } from '../collectors/sidebar-projection.js';
import { switchProject, transitionTab, type MonitorState } from '../render/monitor-state.js';

export type SidebarDestination = { page: 'home' | 'project' | 'execution' | 'control'; root?: string; flow?: string; step?: string };

/** The fork currently emits bare launcher pages. Graph hits can add the projected run key and step ID. */
export function sidebarDestination(data: Record<string, unknown>, facts: SidebarFacts): SidebarDestination | undefined {
  const page = data.target;
  if (page !== 'home' && page !== 'project' && page !== 'execution' && page !== 'control') return;
  if (page !== 'execution' || (data.hud_group === undefined && data.hud_subgroup === undefined && data.step === undefined)) return { page };
  if (typeof data.hud_group !== 'string' || typeof data.hud_subgroup !== 'string') return;
  const run = facts.targets.get(sidebarRunKey(data.hud_group, data.hud_subgroup));
  if (!run || (data.step !== undefined && (typeof data.step !== 'string' || !run.steps.has(data.step)))) return;
  return { page, root: run.root, flow: run.flow, step: data.step as string | undefined };
}

/** Apply explicit navigation, without reusing transient Help/Inspector state from the previous page. */
export function openSidebarDestination(state: MonitorState, destination: SidebarDestination): MonitorState {
  const selected = destination.root ? switchProject(state, destination.root) : state;
  const next = transitionTab({ ...selected, help: undefined }, destination.page);
  if (destination.page === 'project') next.project = { ...next.project, view: { kind: 'hub' } };
  if (destination.page === 'execution' && destination.flow) {
    next.subpage = destination.step
      ? { kind: 'station-detail', flow: destination.flow, stationId: destination.step, scroll: 0 }
      : { kind: 'run-detail', flow: destination.flow, scroll: 0 };
  }
  return next;
}

/** A dock opened by hud-watch receives only the already resolved display destination. */
export function initialSidebarDestination(value: string | undefined, roots: readonly { root: string }[]): SidebarDestination | undefined {
  if (!value) return;
  try {
    const { page, root, flow, step } = JSON.parse(value);
    if (page === 'home' || page === 'project' || page === 'control') return { page };
    if (page !== 'execution') return;
    if (typeof flow === 'string' && typeof root === 'string' && roots.some((project) => project.root === root))
      return { page, root, flow, ...(typeof step === 'string' && { step }) };
    return { page };
  } catch { return undefined; }
}
