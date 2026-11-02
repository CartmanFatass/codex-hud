import { once } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import { object } from './io.js';
import type { CallResolution, CurrentCallSourcePort } from './resolvers.js';
import { TOOLS, validateToolArguments } from './tools.js';
export interface RpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: unknown;
}
export class HudMcpServer {
  constructor(
    private readonly source: CurrentCallSourcePort,
    private readonly bodies?: {
      invoke(
        source: Extract<CallResolution, { ok: true }>,
        tool: string,
        args: Record<string, unknown>,
        started: number
      ): Promise<unknown>;
    }
  ) {}
  async handle(value: unknown): Promise<unknown | null> {
    const error = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });
    if (
      !object(value) ||
      value.jsonrpc !== '2.0' ||
      typeof value.method !== 'string' ||
      (value.id !== undefined && value.id !== null && typeof value.id !== 'string' && typeof value.id !== 'number')
    )
      return error(null, -32600, 'Invalid Request');
    if (value.id === undefined) return null;
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
        // params.arguments, prompt, claim and env hints cannot select a logical caller.
        const resolution = await this.source.resolve(params._meta, definition.name);
        let outcome: unknown;
        try {
          outcome = resolution.ok
            ? this.bodies
              ? await this.bodies.invoke(
                  resolution,
                  definition.name,
                  (params.arguments ?? {}) as Record<string, unknown>,
                  started
                )
              : { ok: false, code: 'not_implemented', tool: definition.name }
            : { ok: false, code: resolution.code };
        } catch (error) {
          // Committed acceptance is returned by the body even if the subsequent
          // launch fails. Only an uncommitted lock exhaustion is a busy result.
          outcome = {
            ok: false,
            code:
              error instanceof Error && 'code' in error && error.code === 'ledger_busy'
                ? 'busy'
                : error instanceof Error
                  ? error.message
                  : 'internal_error',
          };
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
/** MCP stdio framing; one bounded serial request queue, natural stream backpressure. */
export async function serveStdio(server: HudMcpServer, input: Readable, output: Writable): Promise<void> {
  let pending = Buffer.alloc(0);
  const maxLine = 262144;
  const write = async (value: unknown) => {
    if (value === null) return;
    const line = JSON.stringify(value) + '\n';
    if (!output.write(line)) await once(output, 'drain');
  };
  for await (const chunk of input) {
    pending = Buffer.concat([pending, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    let index: number;
    while ((index = pending.indexOf(10)) >= 0) {
      if (index > maxLine) throw new Error('MCP input exceeds 256 KiB');
      const line = pending.subarray(0, index);
      pending = pending.subarray(index + 1);
      if (line.toString('utf8').trim() === '') continue;
      let message: unknown;
      try {
        message = JSON.parse(line.toString('utf8'));
      } catch {
        await write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        continue;
      }
      await write(await server.handle(message));
    }
    if (pending.length > maxLine) throw new Error('MCP input exceeds 256 KiB');
  }
}
