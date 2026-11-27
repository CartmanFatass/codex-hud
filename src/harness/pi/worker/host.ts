/** Narrow host surface. pi supplies the API; no dependency on a particular pi installation. */
export type Counts = Record<'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'total', number>;
export interface WorkerModel {
  provider: string;
  id: string;
  api?: string;
  promptCache?: { short?: number; long?: number };
}
interface Message {
  role: string;
  provider?: string;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  customType?: string;
  details?: unknown;
  content?: unknown;
  usage?: Omit<Counts, 'total'> & { totalTokens: number; cost?: Counts };
}
export interface WorkerAgentQueue {
  followUp(message: Message): void;
}
interface Events {
  session_start: { reason?: string } | undefined;
  session_shutdown: { reason?: string } | undefined;
  session_tree: unknown;
  session_before_switch: unknown;
  session_before_fork: unknown;
  session_before_tree: unknown;
  session_compact: unknown;
  session_compact_failed: unknown;
  session_info_changed: unknown;
  context: unknown;
  agent_start: unknown;
  agent_end: unknown;
  tool_call: { toolName: string; input: Record<string, unknown> };
  before_agent_start: { messageType?: 'user' | 'custom'; systemPromptOptions?: { sections: Record<string, string>; skills: { name: string }[] } };
  before_provider_request: { payload: unknown };
  after_provider_response: unknown;
  provider_stream_event: unknown;
  message_start: { message: Message };
  message_update: { message: Message };
  message_end: { message: Message };
  turn_start: unknown;
  tool_execution_start: { toolName?: string; toolCallId?: string };
  tool_execution_end: { toolName?: string; toolCallId?: string; isError?: boolean };
  turn_end: { toolResults: { toolName: string; isError?: boolean }[] };
  agent_settled: { aborted?: boolean } | undefined;
  cache_warming_decision: { warmCost: number; action: 'warm' | 'stop' };
  model_select: { model?: WorkerModel };
  thinking_level_select: { level?: string };
}
export interface WorkerContext {
  cwd: string;
  mode?: string;
  hasUI?: boolean;
  model?: WorkerModel;
  signal?: AbortSignal;
  sessionManager: { getSessionId(): string; getSessionFile(): string | undefined };
  isIdle?(): boolean;
  hasPendingMessages?(): boolean;
  abort(): void;
  shutdown?(): void;
  ui?: {
    theme: { fg(token: string, text: string): string };
    setStatus?(key: string, text: string | undefined): void;
    notify?(message: string, type?: 'info' | 'error' | 'warning'): void;
  };
}
export interface WorkerPi {
  on<K extends keyof Events>(name: K, hook: (event: Events[K], ctx: WorkerContext) => unknown): (() => void) | void;
  sendMessage(
    message: { customType: string; display: boolean; content: string; details?: unknown },
    options: { triggerTurn: boolean; deliverAs: 'steer' | 'followUp' | 'nextTurn' }
  ): void;
  getAllTools(): { name: string }[];
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
  getThinkingLevel(): string;
  appendEntry(type: string, data: unknown): void;
  registerTool<T>(tool: {
    name: string;
    label: string;
    description: string;
    parameters: object;
    promptSnippet?: string;
    promptGuidelines?: string[];
    annotations?: object;
    execute(id: string, args: T, signal?: AbortSignal, onUpdate?: unknown, ctx?: WorkerContext): Promise<unknown>;
  }): void;
}
