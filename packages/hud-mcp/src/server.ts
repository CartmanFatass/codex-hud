import type { Readable, Writable } from 'node:stream';
import { object } from './io.js';
import { outcomeCode } from './errors.js';
import type { CallResolution, CurrentCallSourcePort } from './resolvers.js';
import { TOOLS, validateToolArguments } from './tools.js';
import { CallBudget, ReadCallTiming, monotonicClock, type BudgetClock } from '../../../src/ledger/call-budget.js';
export interface RpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: unknown;
}
export class HudMcpServer {
  private readonly responseBudgets = new WeakMap<object, CallBudget | ReadCallTiming>();
  flushed(response: unknown): void {
    if (!response || typeof response !== 'object') return;
    const budget = this.responseBudgets.get(response);
    if (!budget) return;
    this.responseBudgets.delete(response);
    try {
      budget.note('flush');
      this.timing.observe?.(budget.diagnostics());
    } catch {
      /* Diagnostics only. */
    }
  }
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
        signal?: AbortSignal,
        budget?: CallBudget,
        readTiming?: ReadCallTiming
      ): Promise<unknown>;
      /** Adds tool-owned fields to a sanitized structured failure; its code and fields stay as built. */
      decorateFailure?(tool: string, args: Record<string, unknown>, outcome: { ok: false; code: string }): unknown;
    },
    private readonly parentAlive: () => boolean = () => true,
    private readonly timing: {
      clock?: BudgetClock;
      observe?: (sample: ReturnType<CallBudget['diagnostics'] | ReadCallTiming['diagnostics']>) => void;
    } = {}
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
        const started = (this.timing.clock ?? monotonicClock).now();
        const definition = TOOLS.find((t) => t.name === params.name);
        if (!definition) return error(id, -32602, 'Unknown tool');
        const readOnly = definition.name === 'delegate_status' || definition.name === 'delegate_wait';
        const budget = readOnly ? undefined : new CallBudget(this.timing.clock, started);
        const readTiming = readOnly ? new ReadCallTiming(this.timing.clock, started) : undefined;
        const observation = budget ?? readTiming!;
        if (!validateToolArguments(definition, params.arguments === undefined ? {} : params.arguments))
          return error(id, -32602, 'Invalid tool arguments');
        if (this.requests.has(id)) return error(id, -32600, 'Duplicate active request id');
        if (this.requests.size >= 32) return error(id, -32000, 'Server busy');
        const controller = new AbortController();
        this.requests.set(id, controller);
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        // Every structured failure passes here, including thrown expected refusals;
        // only the body's own decorator may add fields, never change the code.
        const failure = (code: string) => {
          const refusal = { ok: false as const, code };
          return this.bodies?.decorateFailure?.(definition.name, args, refusal) ?? refusal;
        };
        let outcome: unknown;
        try {
          if (this.stopped) throw new Error('server_shutdown');
          // params.arguments, prompt, claim and env hints cannot select a logical caller.
          budget?.check('source');
          readTiming?.note('source');
          const resolution = await this.source.resolve(params._meta, definition.name, budget);
          budget?.check('source');
          readTiming?.note('source');
          controller.signal.throwIfAborted();
          if (resolution.ok && this.bodies) {
            outcome = await this.bodies.invoke(
              resolution,
              definition.name,
              args,
              started,
              controller.signal,
              budget,
              readTiming
            );
            try {
              readTiming?.note('complete');
            } catch {
              /* Optional observation. */
            }
          } else {
            // The source/body refusal decision precedes optional advice and response serialization.
            observation.note('complete');
            outcome = resolution.ok
              ? { ok: false, code: 'not_implemented', tool: definition.name }
              : failure(resolution.code);
          }
        } catch (error) {
          // A committed intent is returned by its body even if subsequent dispatch fails.
          try {
            observation.note('complete');
          } catch {
            /* Keep the original failure. */
          }
          outcome = failure(outcomeCode(error));
        } finally {
          this.requests.delete(id);
        }
        const response = reply({
          content: [{ type: 'text', text: JSON.stringify(outcome) }],
          isError: object(outcome) && outcome.ok === false,
          structuredContent: outcome,
        });
        this.responseBudgets.set(response, observation);
        return response;
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
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const cleanup = () => server.shutdownSignal.removeEventListener('abort', aborted);
        const aborted = () => {
          if (!settled) {
            settled = true;
            cleanup();
            resolve();
          }
        };
        const flushed = (error?: Error | null) => {
          if (settled) return;
          settled = true;
          cleanup();
          if (error) reject(error);
          else {
            server.flushed(value);
            resolve();
          }
        };
        server.shutdownSignal.addEventListener('abort', aborted, { once: true });
        try {
          output.write(JSON.stringify(value) + '\n', flushed);
        } catch (error) {
          flushed(error as Error);
        }
        if (server.shutdownSignal.aborted) aborted();
      });
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
