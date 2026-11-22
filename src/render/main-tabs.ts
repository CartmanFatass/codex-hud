import type { MonitorState } from './monitor.js';

const MAIN_TABS = [
  { id: 'home', label: 'Home' },
  { id: 'project', label: 'Project' },
  { id: 'control', label: 'Control' },
  { id: 'exp', label: 'EXP', experimental: true },
] as const;
export type MainTab = (typeof MAIN_TABS)[number]['id'];
export const mainTabs = (state: MonitorState) =>
  MAIN_TABS.filter((tab) => !('experimental' in tab) || state.prefs.experiments);
export const mainTabOf = (state: MonitorState): MainTab =>
  state.activeTab === 'exp' && !state.prefs.experiments ? 'home' : state.activeTab;
export const controlShown = (state: MonitorState, modal = false): boolean =>
  state.activeTab === 'control' && !state.subpage && !state.help && !modal;
export const expShown = (state: MonitorState): boolean =>
  state.prefs.experiments && state.activeTab === 'exp' && !state.subpage && !state.help;
