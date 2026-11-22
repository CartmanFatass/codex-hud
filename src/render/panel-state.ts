/** Retained panel selection and visibility state shared by monitor views. */
export interface PanelState {
  selectedId: string | null;
  /** Bring back the agents the linger window put away. */
  showAll?: boolean;
}

export function initialPanelState(): PanelState {
  return { selectedId: null };
}
