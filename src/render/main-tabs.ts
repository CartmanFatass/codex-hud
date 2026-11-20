import type { MonitorState } from './monitor.js';

const MAIN_TABS = [
  { id: 'home', label: 'Home' },
  { id: 'project', label: 'Project' },
  { id: 'exp', label: 'EXP', experimental: true },
] as const;
export type MainTab = (typeof MAIN_TABS)[number]['id'];
export const mainTabs = (state: MonitorState) =>
  MAIN_TABS.filter((tab) => !('experimental' in tab) || state.experiments);
export const mainTabOf = (state: MonitorState): MainTab =>
  mainTabs(state).find((tab) => tab.id === state.mainTab)?.id ?? 'home';
export const expShown = (state: MonitorState): boolean =>
  !!state.experiments && state.mainTab === 'exp' && state.focus === 'agents' && !state.help;
