import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeQuery, ClaudeQueryFactory } from '../../../src/harness/claude/sdk-adapter.js';

export const CLAUDE_NATIVE_ID = '11111111-1111-4111-8111-111111111111';
/** A synthetic peer of the public SDK Query and prompt stream, not a replacement adapter. */
export class SyntheticClaudeQuery implements ClaudeQuery {
  readonly options: Options;
  readonly inputs: SDKUserMessage[] = [];
  readonly answers: unknown[] = [];
  readonly initialization = { native_field: { retained: true } };
  interrupts = 0;
  closes = 0;
  private frames: SDKMessage[] = [];
  private wake?: () => void;
  private ended = false;
  constructor(input: Parameters<ClaudeQueryFactory>[0]) {
    if (typeof input.prompt === 'string') throw new Error('expected_public_streaming_prompt');
    this.options = input.options ?? {};
    this.emit({
      type: 'system',
      subtype: 'init',
      uuid: '22222222-2222-4222-8222-222222222222',
      session_id: this.options.resume ?? CLAUDE_NATIVE_ID,
      apiKeySource: 'none',
      claude_code_version: 'synthetic-current-client',
      cwd: this.options.cwd,
      tools: [],
      mcp_servers: [],
      model: 'synthetic',
      permissionMode: 'default',
      slash_commands: [],
      output_style: 'default',
      skills: [],
      plugins: [],
    });
    void (async () => {
      for await (const message of input.prompt as AsyncIterable<SDKUserMessage>) {
        this.inputs.push(message);
      }
    })();
  }
  emit(frame: Record<string, unknown>) {
    this.frames.push(frame as unknown as SDKMessage);
    this.wake?.();
  }
  async requestPermission() {
    const result = await this.options.canUseTool!(
      'Read',
      { file_path: 'synthetic.txt' },
      {
        signal: new AbortController().signal,
        requestId: 'native-permission-1',
        toolUseID: 'native-tool-1',
      }
    );
    this.answers.push(result);
    return result;
  }
  async initializationResult() {
    return this.initialization as never;
  }
  async interrupt() {
    this.interrupts++;
    return undefined;
  }
  close() {
    this.closes++;
    this.ended = true;
    this.wake?.();
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage, void> {
    while (!this.ended) {
      if (this.frames.length) yield this.frames.shift()!;
      else
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
    }
  }
}
