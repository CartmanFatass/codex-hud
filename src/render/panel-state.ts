/** Retained panel selection and visibility state shared by monitor views. */
export interface PanelState {
  view: 'tree' | 'detail' | 'session' | 'help';
  selectedId: string | null;
  collapsed: ReadonlySet<string>;
  filter: 'all' | 'active' | 'failed' | 'unknown';
  scroll: number;
  /** Bring back the agents the linger window put away. */
  showAll?: boolean;
}

export function initialPanelState(): PanelState {
  return { view: 'tree', selectedId: null, collapsed: new Set(), filter: 'all', scroll: 0 };
}
