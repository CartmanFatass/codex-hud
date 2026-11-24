/** The ordinary pi package speaks plain JSON-RPC to the local thin server. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { PiPackageBinding } from './package-context.js';
import { v8HeapArgs } from '../../../scripts/dist-lock.mjs';

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
    private cwd: string,
    private sessionId: string,
  ) {}
  private connect(): Connection {
    const env = { ...this.env, HUD_HOME: this.binding.hudHome, HUD_MCP_SURFACE: 'roles', HUD_MCP_PI_SESSION_ID: this.sessionId };
    const child = spawn(this.binding.node, [...v8HeapArgs('mcp', env), join(this.binding.release, 'packages/hud-mcp/bin/hud-mcp.mjs')], {
      cwd: this.cwd,
      env,
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
        clientInfo: { name: 'hud-pi', version: '0.2.0' },
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

export { ROLE_TOOLS as PI_ROLE_TOOLS } from '../../roles/tool-definitions.js';
