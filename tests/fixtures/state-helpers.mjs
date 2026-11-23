import { initialMonitorState } from '../../dist/render/monitor.js';

export const sliceState = initialMonitorState;

/** Compose nested panel fixture patches while retaining the base view's navigation and preferences. */
export function withState(...parts) {
  return parts.filter(Boolean).reduce((base, patch) => {
    const next = { ...base, ...patch };
    if (patch.prefs) next.prefs = { ...base.prefs, ...patch.prefs };
    if (patch.home) {
      next.home = { ...base.home, ...patch.home };
      if (patch.home.split) next.home.split = { ...base.home?.split, ...patch.home.split };
      if (patch.home.filter) next.home.filter = { query: '', editing: false, ...base.home?.filter, ...patch.home.filter };
    }
    if (patch.project) {
      const { nav, filter } = patch.project;
      next.project = { ...base.project, ...patch.project };
      if (nav) next.project.nav = { ...base.project?.nav, ...nav,
        ...(nav.split ? { split: { ...base.project?.nav?.split, ...nav.split } } : {}) };
      if (filter) next.project.filter = { query: '', editing: false, ...base.project?.filter, ...filter };
    }
    if (patch.subpage && patch.subpage.kind === base.subpage?.kind) next.subpage = { ...base.subpage, ...patch.subpage };
    return next;
  }, {});
}

export const viewFor = (page, index = 0) => page === 'waiting' ? { kind: page, index } : { kind: page ?? 'hub' };
export const splitOf = (state) => state.activeTab === 'project' ? state.project.nav.split : state.home.split;
export const tabState = (state) => state.activeTab === 'project' ? state.project : state.activeTab === 'home' ? state.home : undefined;
