import type { Readable, Writable } from 'node:stream';
import { object } from './io.js';
import { outcomeCode } from './errors.js';
import type { CallResolution, CurrentCallSourcePort } from './resolvers.js';
import { TOOLS, validateToolArguments } from './tools.js';
export interface RpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: unknown;
}
export class HudMcpServer {
  private readonly requests = new Map<string | number | null, AbortController>();
  private stopped = false;
  private readonly lifetime = new AbortController();
  get shutdownSignal(): AbortSignal {
    return this.lifetime.signal;
  }
  shutdown(): void {
    this.stopped = true;
    this.lifetime.abort(new Error('server_shutdown'));
    for (const controller of this.requests.values()) controller.abort(new Error('server_shutdown'));
  }
  constructor(
    private readonly source: CurrentCallSourcePort,
    private readonly bodies?: {
      parentCall?(): void;
      invoke(
        source: Extract<CallResolution, { ok: true }>,
        tool: string,
        args: Record<string, unknown>,
        started: number,
        signal?: AbortSignal
      ): Promise<unknown>;
    },
    private readonly parentAlive: () => boolean = () => true
  ) {}
  async handle(value: unknown): Promise<unknown | null> {
    const error = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });
    if (!this.parentAlive()) this.shutdown();
    if (this.stopped)
      return object(value) && value.id !== undefined ? error(value.id, -32000, 'server_shutdown') : null;
    if (
      !object(value) ||
      value.jsonrpc !== '2.0' ||
      typeof value.method !== 'string' ||
      (value.id !== undefined && value.id !== null && typeof value.id !== 'string' && typeof value.id !== 'number')
    )
      return error(null, -32600, 'Invalid Request');
    if (value.method === 'notifications/cancelled' && value.id === undefined) {
      const params = object(value.params) ? value.params : {};
      if (typeof params.requestId === 'string' || typeof params.requestId === 'number')
        this.requests.get(params.requestId)?.abort(new Error('request_cancelled'));
      return null;
    }
    if (value.id === undefined) return null;
    this.bodies?.parentCall?.();
    const id = value.id;
    const params = object(value.params) ? value.params : {};
    const reply = (result: unknown) => ({ jsonrpc: '2.0', id, result });
    switch (value.method) {
      case 'initialize': {
        if (typeof params.protocolVersion !== 'string') return error(id, -32602, 'Invalid params');
        const versions = ['2025-06-18', '2025-03-26', '2024-11-05'];
        return reply({
          protocolVersion: versions.includes(params.protocolVersion) ? params.protocolVersion : versions[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'hud-mcp', version: '0.1.0' },
        });
      }
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: TOOLS });
      case 'tools/call': {
        const started = performance.now();
        const definition = TOOLS.find((t) => t.name === params.name);
        if (!definition) return error(id, -32602, 'Unknown tool');
        if (!validateToolArguments(definition, params.arguments === undefined ? {} : params.arguments))
          return error(id, -32602, 'Invalid tool arguments');
        if (this.requests.has(id)) return error(id, -32600, 'Duplicate active request id');
        if (this.requests.size >= 32) return error(id, -32000, 'Server busy');
        const controller = new AbortController();
        this.requests.set(id, controller);
        let outcome: unknown;
        try {
          if (this.stopped) throw new Error('server_shutdown');
          // params.arguments, prompt, claim and env hints cannot select a logical caller.
          const resolution = await this.source.resolve(params._meta, definition.name);
          controller.signal.throwIfAborted();
          outcome = resolution.ok
            ? this.bodies
              ? await this.bodies.invoke(
                  resolution,
                  definition.name,
                  (params.arguments ?? {}) as Record<string, unknown>,
                  started,
                  controller.signal
                )
              : { ok: false, code: 'not_implemented', tool: definition.name }
            : { ok: false, code: resolution.code };
        } catch (error) {
          // A committed intent is returned by its body even if subsequent dispatch fails.
          outcome = { ok: false, code: outcomeCode(error) };
        } finally {
          this.requests.delete(id);
        }
        return reply({
          content: [{ type: 'text', text: JSON.stringify(outcome) }],
          isError: object(outcome) && outcome.ok === false,
          structuredContent: outcome,
        });
      }
      default:
        return error(id, -32601, 'Method not found');
    }
  }
}
/** Bounded concurrent requests keep cancellation notifications readable during long polls. */
export async function serveStdio(server: HudMcpServer, input: Readable, output: Writable): Promise<void> {
  let pending = Buffer.alloc(0);
  const maxLine = 262144;
  const running = new Set<Promise<void>>();
  let writes: Promise<void> = Promise.resolve();
  const write = (value: unknown): Promise<void> => {
    if (value === null) return Promise.resolve();
    writes = writes.then(async () => {
      if (output.destroyed || output.writableEnded) return;
      if (!output.write(JSON.stringify(value) + '\n') && !server.shutdownSignal.aborted) {
        await new Promise<void>((resolve, reject) => {
          const cleanup = () => {
            output.off('drain', done);
            output.off('error', failed);
            server.shutdownSignal.removeEventListener('abort', done);
          };
          const done = () => {
            cleanup();
            resolve();
          };
          const failed = (error: Error) => {
            cleanup();
            reject(error);
          };
          output.once('drain', done);
          output.once('error', failed);
          server.shutdownSignal.addEventListener('abort', done, { once: true });
          if (server.shutdownSignal.aborted) done();
        });
      }
    });
    // Retain failures for the final await without unhandled rejections.
    void writes.catch(() => {});
    return writes;
  };
  const track = (task: Promise<void>) => {
    running.add(task);
    void task.finally(() => running.delete(task)).catch(() => {});
  };
  const overload = async (id: unknown) => {
    // End overloaded connections with at most one extra response. Reading must
    // never wait for output drain while cancellation/EOF remain in the input.
    const refusal = write({ jsonrpc: '2.0', id, error: { code: -32000, message: 'Server busy' } });
    server.shutdown();
    input.destroy();
    await refusal;
  };
  const dispatch = async (message: unknown) => {
    if (object(message) && message.id === undefined) {
      await server.handle(message);
      return;
    }
    if (running.size >= 32) {
      await overload(object(message) ? (message.id ?? null) : null);
      return;
    }
    track(server.handle(message).then(write));
  };
  try {
    for await (const chunk of input) {
      pending = Buffer.concat([pending, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      let index: number;
      while ((index = pending.indexOf(10)) >= 0) {
        if (index > maxLine) throw new Error('MCP input exceeds 256 KiB');
        const line = pending.subarray(0, index).toString('utf8');
        pending = pending.subarray(index + 1);
        if (!line.trim()) continue;
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          if (running.size >= 32) await overload(null);
          else track(write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
          if (server.shutdownSignal.aborted) return;
          continue;
        }
        await dispatch(message);
        if (server.shutdownSignal.aborted) return;
      }
      if (pending.length > maxLine) throw new Error('MCP input exceeds 256 KiB');
    }
  } catch (error) {
    if (!server.shutdownSignal.aborted) throw error;
  } finally {
    server.shutdown();
    await Promise.allSettled([...running]);
    await writes;
  }
}

/** Process lifecycle used by the shipped entry and owned-process tests.
 * If a native stdout write remains blocked, the entry MUST exit after closing
 * its stores; destroying Node's special stdout stream alone cannot cancel it.
 */
export async function serveStdioProcess(
  server: HudMcpServer,
  parentAlive: () => boolean = () => true
): Promise<{ discardPendingOutput: boolean }> {
  let discardPendingOutput = false;
  const stop = () => {
    server.shutdown();
    process.stdin.destroy();
  };
  const outputError = () => stop();
  process.on('SIGTERM', stop);
  process.on('SIGHUP', stop);
  process.stdout.on('error', outputError);
  server.shutdownSignal.addEventListener('abort', stop, { once: true });
  const lifecycle = setInterval(() => {
    if (!parentAlive()) stop();
  }, 30000);
  lifecycle.unref();
  try {
    if (!parentAlive()) stop();
    await serveStdio(server, process.stdin, process.stdout);
  } finally {
    server.shutdown();
    clearInterval(lifecycle);
    server.shutdownSignal.removeEventListener('abort', stop);
    process.off('SIGTERM', stop);
    process.off('SIGHUP', stop);
    // A blocked native stdout WriteWrap can keep Node alive after every waiter
    // has settled. Give normal replies a bounded flush, then discard blocked output.
    await new Promise<void>((resolve) => {
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        process.stdout.off('finish', done);
        process.stdout.once('close', () => process.stdout.off('error', outputError));
        process.stdout.destroy();
        resolve();
      };
      const timer = setTimeout(() => {
        discardPendingOutput = process.stdout.writableLength > 0;
        done();
      }, 100);
      process.stdout.once('finish', done);
      if (process.stdout.destroyed || process.stdout.writableFinished) done();
      else process.stdout.end();
    });
  }
  return { discardPendingOutput };
}
