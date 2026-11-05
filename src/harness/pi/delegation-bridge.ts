import { fileURLToPath } from 'node:url';
import { createPiDelegationContextGuard, PI_EXTENSION_CONTEXT_PROFILE, type PiContext } from './delegation-context.js';
import { PiDelegationChannel, type PiMcpResult } from './delegation-channel.js';

/** Host lifecycle owns the bridge. Model arguments never select a session or channel. */
export class PiDelegationBridge {
  private guard: ReturnType<typeof createPiDelegationContextGuard>;
  private lifecycle: ReturnType<ReturnType<typeof createPiDelegationContextGuard>['start']> | null = null;
  private channel: PiDelegationChannel | null = null;
  private submitted = new Set<string>();
  private closing: Promise<void> = Promise.resolve();
  private generation = 0;
  constructor(private readonly options: { sourceRoot: string; env: NodeJS.ProcessEnv; cwd: string }) {
    this.guard = createPiDelegationContextGuard({
      profile: PI_EXTENSION_CONTEXT_PROFILE,
      canonicalSourceDir: options.sourceRoot,
    });
  }
  /** Synchronous fence first, cleanup second. No awaiting before invalidation. */
  stop(): Promise<void> {
    ++this.generation;
    this.guard.shutdown();
    this.lifecycle = null;
    const channel = this.channel;
    this.channel = null;
    this.closing = Promise.all([this.closing, channel?.close()]).then(() => {});
    return this.closing;
  }
  async start(): Promise<void> {
    const closed = this.stop();
    const generation = this.generation;
    await closed;
    if (this.generation === generation) this.lifecycle = this.guard.start();
  }
  async execute(
    tool: string,
    callId: string,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
    ctx: PiContext
  ): Promise<PiMcpResult> {
    const lifecycle = this.lifecycle;
    if (!lifecycle) throw Error('pi_session_inactive');
    signal?.throwIfAborted();
    const captured = await lifecycle.capture(ctx, callId, tool);
    if (captured.status !== 'ready')
      return {
        content: [{ type: 'text', text: 'Pi session is not persisted yet; delegation identity is pending.' }],
        isError: true,
        structuredContent: { ok: false, code: 'identity_source_missing' },
      };
    // Keep admission history across epochs/reconnects. Never repeat an admitted host call.
    const key = JSON.stringify([captured.sessionDir, captured.sessionId, callId]);
    if (this.submitted.has(key)) throw Error('pi_duplicate_tool_call');
    if (this.submitted.size >= 65536) throw Error('pi_call_history_full');
    if (!this.channel || this.channel.isClosed()) {
      const previous = this.channel;
      this.channel = null;
      // Publish the cleanup barrier before yielding. Concurrent callers and
      // lifecycle restarts must all observe an uncertain close as a hard fence.
      if (previous) this.closing = Promise.all([this.closing, previous.close()]).then(() => {});
      await this.closing;
      if (this.lifecycle !== lifecycle) throw Error('stale_pi_extension_epoch');
      this.channel ??= new PiDelegationChannel({
        entry: fileURLToPath(new URL('../../../packages/hud-mcp/bin/hud-mcp.mjs', import.meta.url)),
        env: this.options.env,
        cwd: this.options.cwd,
        sourceRoot: this.options.sourceRoot,
      });
    }
    const channel = this.channel;
    await channel.ready;
    const checked = await lifecycle.recheck(captured);
    if (this.channel !== channel || this.lifecycle !== lifecycle) throw Error('stale_pi_extension_epoch');
    signal?.throwIfAborted();
    if (this.submitted.has(key)) throw Error('pi_duplicate_tool_call');
    this.submitted.add(key);
    return channel.call(checked, args, signal);
  }
}
