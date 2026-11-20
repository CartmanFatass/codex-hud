import type { MonitorState } from './monitor.js';

// The shared list/Split engines use these fields. Give Control its own copy without
// changing the Project or Home state they currently use. The Split ratio is global.
const NAV = ['projectCursor', 'projectScroll', 'projectFolded', 'boardRevealed',
  'splitFocus', 'splitList', 'splitSub', 'splitScroll', 'splitListScroll', 'splitFor'] as const;
export type ControlNavigation = Pick<MonitorState, (typeof NAV)[number]>;
export const CONTROL_FOLDS = ['healthy', 'usage', 'files', 'agents'] as const;

function take(state: ControlNavigation): ControlNavigation {
  return Object.fromEntries(NAV.map((key) => [key, state[key]]));
}
export function controlNavigation(state: MonitorState): MonitorState {
  return { ...state, ...take(state.controlNav ?? {}) };
}
export function storeControlNavigation(state: ControlNavigation, view: MonitorState): MonitorState {
  return { ...view, ...take(state), controlNav: take(view) };
}

export const controlRoleOf = (item?: string) => /^project:role:([^:]+)(?::\d+)?$/.exec(item ?? '')?.[1];
export const controlRoleItem = (role: string) => `project:role:${role}`;
