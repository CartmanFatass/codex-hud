export interface Delivery {
  status: number | null;
  retry?: boolean;
  guardPending?: boolean;
  detail?: string;
  error?: Error;
}
export function hasAgyEvents(pane: string, home: string): boolean;
export function pushAgyEvents(pane: string, home: string, messages: string[], env: NodeJS.ProcessEnv,
  writePrivateFile: (file: string, text: string, options: { mkdir: boolean }) => void,
  type: ((text: string) => Promise<Delivery>) | null, published?: (accepted: number) => void): Promise<Delivery & { accepted: number }>;
