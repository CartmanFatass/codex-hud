import type { MonitorState } from './monitor.js';

export const MAIN_TABS = [
  { id: 'home', label: 'Home' },
  { id: 'project', label: 'Project' },
  { id: 'execution', label: 'Execution' },
  { id: 'control', label: 'Control' },
] as const;
export type MainTab = (typeof MAIN_TABS)[number]['id'];
export const executionShown = (state: MonitorState, modal = false): boolean =>
  state.activeTab === 'execution' && !state.subpage && !state.help && !modal;
export const controlShown = (state: MonitorState, modal = false): boolean =>
  state.activeTab === 'control' && !state.subpage && !state.help && !modal;
export const resourcesShown = (state: MonitorState): boolean =>
  controlShown(state) && state.control.subTab === 'resources';
