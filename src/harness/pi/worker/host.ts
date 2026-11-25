/** Narrow host surface. pi supplies the API; no dependency on a particular pi installation. */
export type Counts = Record<'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'total', number>;
interface Message {
  role: string; provider?: string; model?: string; stopReason?: string; errorMessage?: string;
  usage?: Omit<Counts, 'total'> & { totalTokens: number; cost?: Counts };
}
interface Events {
  session_start: unknown;
  before_agent_start: { systemPromptOptions: { sections: Record<string, string>; skills: { name: string }[] } };
  before_provider_request: { payload: unknown };
  message_start: { message: Message };
  message_update: { message: Message };
  message_end: { message: Message };
  turn_start: unknown; tool_execution_start: unknown; turn_end: unknown; agent_settled: unknown;
}
export interface WorkerPi {
  on<K extends keyof Events>(name: K, hook: (event: Events[K], ctx: { model?: { provider: string; id: string; api: string }; abort(): void }) => unknown): void;
  getAllTools(): { name: string }[];
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
  getThinkingLevel(): string;
  appendEntry(type: string, data: unknown): void;
  registerTool<T>(tool: { name: string; label: string; description: string; parameters: object; promptSnippet?: string;
    annotations?: object; execute(id: string, args: T, signal?: AbortSignal): Promise<unknown> }): void;
}
