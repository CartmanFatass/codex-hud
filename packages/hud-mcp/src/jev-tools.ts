import type { NativeHostPort } from '../../../src/managed/host-ipc.js';
import type { AuthenticatedToolExtension } from './server.js';
import type { CallResolution } from './resolvers.js';
import { JSON_VALUE_SCHEMA, type ToolDefinition } from './tools.js';

const text = { type: 'string', minLength: 1, maxLength: 65536 };
const target = { instanceId: { type: 'string', minLength: 1, maxLength: 4096 } };
function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = []
): ToolDefinition {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties,
      required,
      additionalProperties: false,
      $defs: { jsonValue: JSON_VALUE_SCHEMA },
    },
  };
}
export const JEV_TOOLS: ToolDefinition[] = [
  tool(
    'jev_create',
    'Construct the installed Jev Ultra Fast Agent in the independent host. Returns its instance ID and actual owned CDP target/session. Does not run the agent or close its tab automatically.',
    {
      url: text,
      goals: { ...text, type: ['string', 'array'], minItems: 1, items: text },
      record_dir: { ...text, type: ['string', 'null'] },
      screenshots: { type: 'boolean' },
    },
    ['url', 'goals']
  ),
  tool(
    'jev_run',
    'Call synchronous Agent.run() once and return its yielded native snapshots as an array. jev_list exposes the latest actual yield during run; snapshot/command/close calls wait behind it. Blocked/CAPTCHA, error, caller disconnect and timeout never trigger Agent.close(). Do not retry an uncertain run.',
    target,
    ['instanceId']
  ),
  tool(
    'jev_snapshot',
    'Return Agent.snapshot() unchanged for this source-owned live instance. Agent calls are serial: this waits behind an active run. Use jev_list for the latest previously received native output without calling the busy Agent.',
    target,
    ['instanceId']
  ),
  tool(
    'jev_command',
    'Call Agent.command(name, body) unchanged. Agent calls are serial: this waits behind an active run. Upstream defines supported commands and errors; HUD does not supply browser policy or retries.',
    { ...target, name: text, body: { type: ['object', 'null'], additionalProperties: { $ref: '#/$defs/jsonValue' } } },
    ['instanceId', 'name']
  ),
  tool(
    'jev_close',
    'Explicitly call Agent.close(), which closes its owned browser tab. Agent calls are serial: this waits behind an active run, not an interrupt. Only use when closure is requested; retain blocked/CAPTCHA pages for handoff.',
    target,
    ['instanceId']
  ),
  tool(
    'jev_list',
    'List this native source’s live Jev handles, serial API metadata and latest received native output (source/receivedAt/value), without calling the Agent. An observation is a prior output, not a fresh snapshot request or concurrency guarantee. Historical relations are not a claim of live or recoverable Agents.',
    {}
  ),
];

export class JevTools implements AuthenticatedToolExtension {
  readonly tools = JEV_TOOLS;
  constructor(private readonly host: NativeHostPort) {}
  async invoke(
    source: Extract<CallResolution, { ok: true }>,
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<unknown> {
    if (!JEV_TOOLS.some((tool) => tool.name === name)) throw new Error('unknown_jev_tool');
    try {
      const value = await this.host.invoke(source.sessionRef, name, { ...args, callId: source.callId }, signal);
      if (value && typeof value === 'object' && 'ok' in value && value.ok === false) return value;
      // MCP structuredContent requires an object; the native payload itself stays unchanged.
      return { ok: true, value };
    } catch (error) {
      return { ok: false, code: error instanceof Error ? error.message : 'jev_transport_error' };
    }
  }
}
