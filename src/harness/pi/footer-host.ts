/** Public host projections. The package template supplies pi's own classes and width helpers. */
export interface FooterComponent {
  render(width: number): string[];
  invalidate(): void;
  dispose?(): void;
}
export interface FooterTui {
  requestRender(): void;
}
export interface FooterFrame {
  fg(token: string, text: string): string;
}
export interface FooterEditor extends FooterComponent {
  setWorkingStatusIndicator(indicator: { renderInBorder(width: number): string } | undefined): void;
  renderTopBorder(width: number, hiddenLineCount: number): string;
}
export interface FooterHost {
  CustomEditor: new (
    tui: FooterTui,
    theme: unknown,
    keybindings: unknown,
    options: { embedWorkingStatus: boolean }
  ) => FooterEditor;
  visibleWidth(text: string): number;
  truncateToWidth(text: string, width: number, ellipsis?: string): string;
}
interface EntryUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost?: { total?: number };
}
/** Other native entry kinds are ignored, without closing the host's evolving union. */
export interface FooterEntry {
  type: string;
  customType?: string;
  data?: unknown;
  message?: { role: string; usage?: EntryUsage; model?: string };
  usage?: EntryUsage;
}
export interface FooterContext {
  mode: string;
  hasUI: boolean;
  model?: {
    id: string;
    name?: string;
    provider?: string;
    baseUrl?: string;
    reasoning?: boolean;
    contextWindow?: number;
  };
  sessionManager: {
    getSessionId(): string;
    getLeafId(): string | null;
    getEntries(): readonly FooterEntry[];
    getBranch(): readonly FooterEntry[];
    getCwd(): string;
    getSessionName?(): string | undefined;
  };
  getContextUsage(): { contextWindow: number; percent: number | null } | undefined;
  ui: {
    theme: FooterFrame;
    notify(message: string, type?: 'info' | 'error' | 'warning'): void;
    setEditorComponent(
      factory: ((tui: FooterTui, theme: unknown, keybindings: unknown) => FooterComponent) | undefined
    ): void;
    setFooter(
      factory:
        | ((
            tui: FooterTui,
            theme: FooterFrame,
            data: { getExtensionStatuses(): ReadonlyMap<string, string> }
          ) => FooterComponent)
        | undefined
    ): void;
    setWidget(
      key: string,
      factory: ((tui: FooterTui) => FooterComponent) | undefined,
      options?: { placement: 'aboveEditor' }
    ): void;
  };
}
export interface FooterAPI {
  getThinkingLevel?(): string;
  getAllTools?(): { name: string }[];
  getCommands?(): { source: string }[];
  registerEntryRenderer?(name: string, renderer: () => undefined): void;
  events?: { on(name: string, handler: (data: unknown) => void): () => void };
}
