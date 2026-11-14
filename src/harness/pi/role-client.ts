/** The ordinary pi package speaks plain JSON-RPC to the local thin server. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { PiPackageBinding } from './package-context.js';

type Result = { content: { type: 'text'; text: string }[]; isError?: boolean };
type Connection = {
  child: ChildProcessWithoutNullStreams;
  ready: Promise<unknown>;
  request(method: string, params: unknown): Promise<unknown>;
};
export class PiRoleClient {
  private connection?: Connection;
  private stopped = false;
  constructor(
    private binding: PiPackageBinding,
    private env: NodeJS.ProcessEnv,
    private cwd: string
  ) {}
  private connect(): Connection {
    const child = spawn(this.binding.node, [join(this.binding.release, 'packages/hud-mcp/bin/hud-mcp.mjs')], {
      cwd: this.cwd,
      env: { ...this.env, HUD_HOME: this.binding.hudHome, HUD_MCP_SURFACE: 'roles' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let id = 0;
    const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
    const fail = (error: Error) => {
      for (const call of pending.values()) call.reject(error);
      pending.clear();
    };
    const request = (method: string, params: unknown) =>
      new Promise<unknown>((resolve, reject) => {
        pending.set(++id, { resolve, reject });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    child.stdin.on('error', fail);
    child.on('error', fail);
    child.stderr.resume();
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      try {
        const reply = JSON.parse(line);
        const call = pending.get(reply.id);
        if (!call) return;
        pending.delete(reply.id);
        if (reply.error) call.reject(Error(reply.error.message));
        else call.resolve(reply.result);
      } catch {
        fail(Error('invalid_mcp_response'));
      }
    });
    const connection = {
      child,
      request,
      ready: request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'hud-pi', version: '0.1.4' },
      }),
    };
    child.once('close', () => {
      lines.close();
      fail(Error('hud_mcp_closed'));
      if (this.connection === connection) this.connection = undefined;
    });
    return connection;
  }
  async call(name: string, args: Record<string, unknown>): Promise<Result> {
    if (this.stopped) throw Error('pi_session_inactive');
    if (this.connection && (this.connection.child.exitCode !== null || this.connection.child.signalCode !== null))
      this.connection = undefined;
    const connection = (this.connection ??= this.connect());
    await connection.ready;
    if (this.stopped) throw Error('pi_session_inactive');
    return (await connection.request('tools/call', { name, arguments: args })) as Result;
  }
  stop(): Promise<void> {
    this.stopped = true;
    const child = this.connection?.child;
    if (!child) return Promise.resolve();
    return new Promise((resolve) => {
      child.once('close', () => resolve());
      child.kill();
    });
  }
}

// Mirrored from thin-main.ts so registering the package does not start a child.
const text = { type: 'string' };
const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []) => ({
  name,
  description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
});
export const PI_ROLE_TOOLS = [
  tool(
    'hud_roster',
    "List local roles, their availability, and the dispatch convention in effect. Optional cwd selects the project (default: this server's cwd).",
    { cwd: { ...text, description: "Project directory. Default: the server's cwd." } }
  ),
  tool(
    'hud_create',
    "Dispatch a local role; request_key returns the existing job unchanged on retry. cwd resolves roles for that project (default: this server's cwd). Optional package is a display-only label. Uses the role's first available place (runs_on) unless overridden by on. model and thinking override a pi or CLI role for this job; kind selects image or video for flow; other launch switches and pi_args are pi-only. Omitted switches keep pi-role defaults (split uses the place).",
    {
      role: text,
      request_key: text,
      task: text,
      cwd: { ...text, description: "Job directory. Roles resolve against this project. Default: the server's cwd." },
      package: { ...text, description: 'Display-only package label.' },
      on: {
        ...text,
        description:
          'Override the harness or browser provider for this job only (pi, agy, claude, codex, grok, chatgpt, gemini, argon, flow).',
      },
      kind: { type: 'string', enum: ['image', 'video'], description: 'Flow output kind: image (default) or video.' },
      model: { ...text, description: 'Override the pi or cli role model for this job only.' },
      thinking: { ...text, description: 'Override the pi or cli role thinking for this job only.' },
      lens: { type: 'boolean', description: 'Load pi-lens (--lens / --no-lens).' },
      mcp: { type: 'boolean', description: 'Load MCP adapter (--mcp / --no-mcp).' },
      tps: { type: 'boolean', description: 'Load tokens/s telemetry (--tps / --no-tps).' },
      ui_ext: {
        type: 'boolean',
        description: 'False: --no-ui-ext; true: keep pi-role default UI extensions (no flag).',
      },
      skills: {
        type: 'boolean',
        description: 'True: --skills (personal skills); false: keep pi-role default exclusion (no flag).',
      },
      split: { type: 'boolean', description: 'Reserve a helper pane on the right; primary worker stays left.' },
      pi_args: {
        type: 'array',
        items: { ...text, maxLength: 4096 },
        maxItems: 128,
        description: 'Append pi arguments after -- verbatim, never through a shell; --orchestrator and --notify are reserved for the inherited caller binding.',
      },
    },
    ['role', 'request_key', 'task']
  ),
  tool('hud_read', 'Read a job, optionally waiting for settlement or a question; omit job for the 20 newest.', {
    job: text,
    wait_ms: { type: 'integer', minimum: 0, maximum: 120000 },
  }),
  tool(
    'hud_send',
    'Send a message to a pi or CLI job: queued while it works, a continuation during idle_grace (roles that can continue); message_key deduplicates sends.',
    { job: text, message_key: text, text },
    ['job', 'message_key', 'text']
  ),
  tool('hud_respond', 'Write a question answer once.', { job: text, request_id: text, answer: text }, [
    'job',
    'request_id',
    'answer',
  ]),
  tool('hud_close', 'Reap a job with pi-role-reap; safe to repeat.', { job: text }, ['job']),
];
