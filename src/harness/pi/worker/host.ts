/** Narrow host surface. pi supplies the API; no dependency on a particular pi installation. */
export type Counts = Record<'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'total', number>;
interface Message {
  role: string; provider?: string; model?: string; stopReason?: string; errorMessage?: string;
  usage?: Omit<Counts, 'total'> & { totalTokens: number; cost?: Counts };
}
interface Events {
  session_start: unknown; session_shutdown: unknown;
  tool_call: { toolName: string; input: Record<string, unknown> };
  before_agent_start: { systemPromptOptions: { sections: Record<string, string>; skills: { name: string }[] } };
  before_provider_request: { payload: unknown };
  message_start: { message: Message };
  message_update: { message: Message };
  message_end: { message: Message };
  turn_start: unknown; tool_execution_start: unknown;
  turn_end: { toolResults: { toolName: string; isError?: boolean }[] };
  agent_settled: unknown;
}
interface WorkerContext {
  cwd: string;
  model?: { provider: string; id: string; api: string };
  sessionManager: { getSessionId(): string; getSessionFile(): string | undefined };
  abort(): void;
}
export interface WorkerPi {
  on<K extends keyof Events>(name: K, hook: (event: Events[K], ctx: WorkerContext) => unknown): void;
  sendMessage(message: { customType: string; display: boolean; content: string }, options: { triggerTurn: boolean; deliverAs: 'steer' }): void;
  getAllTools(): { name: string }[];
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
  getThinkingLevel(): string;
  appendEntry(type: string, data: unknown): void;
  registerTool<T>(tool: { name: string; label: string; description: string; parameters: object; promptSnippet?: string;
    annotations?: object; execute(id: string, args: T, signal?: AbortSignal): Promise<unknown> }): void;
}
