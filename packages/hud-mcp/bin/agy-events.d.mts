export interface Delivery {
  status: number | null;
  retry?: boolean;
  detail?: string;
  error?: Error;
}
export function hasAgyEvents(pane: string, home: string): boolean;
export function pushAgyEvents(pane: string, home: string, messages: string[], env: NodeJS.ProcessEnv,
  type: ((text: string) => Promise<Delivery>) | null): Promise<Delivery & { accepted: number }>;
