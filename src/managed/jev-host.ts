import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, opendirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { ownerKey, privateDirectory, type NativeOwner } from './relations.js';

export interface JevBridge {
  invoke(method: string, args: Record<string, unknown>): Promise<unknown>;
  /** Last actual native output, not a concurrent call into the synchronous Agent. */
  observation?(): JevObservation | undefined;
  /** End only the bridge transport after an explicit successful Agent.close(). */
  release(): void;
}
export interface JevObservation {
  source: 'run_yield' | 'snapshot' | 'command';
  receivedAt: number;
  value: unknown;
}
export class JevBridgeError extends Error {
  constructor(readonly nativeError: unknown) {
    super('jev_native_error');
  }
}

function bridgePath(): string {
  // tsc does not copy Python assets. Works for source, root dist and MCP dist layouts.
  let directory = dirname(fileURLToPath(import.meta.url));
  const adjacent = join(directory, 'jev-bridge.py');
  if (existsSync(adjacent)) return adjacent;
  for (;;) {
    const candidate = join(directory, 'src', 'managed', 'jev-bridge.py');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) throw new Error('jev_bridge_asset_missing');
    directory = parent;
  }
}

/** Owned by the detached native host, never by the foreground MCP client. */
export class PythonJevBridge implements JevBridge {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<
    number,
    { method: string; resolve(value: unknown): void; reject(error: Error): void }
  >();
  private nextId = 0;
  private failure?: Error;
  private latestObservation?: JevObservation;
  constructor(options: { python?: string; path?: string; env?: NodeJS.ProcessEnv } = {}) {
    this.child = spawn(
      options.python ?? process.env.HUD_JEV_PYTHON ?? 'python3',
      ['-u', options.path ?? bridgePath()],
      {
        stdio: 'pipe',
        env: options.env ?? process.env,
      }
    );
    const fail = (error: Error) => {
      this.failure = error;
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      // Observing failure is not permission to kill Python or close its browser tab.
    };
    this.child.on('error', fail);
    this.child.stdin.on('error', fail);
    this.child.stdout.on('error', fail);
    this.child.stderr.on('error', fail);
    this.child.once('exit', (code, signal) => fail(new Error(`jev_bridge_exit:${code}:${signal}`)));
    this.child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      try {
        const reply = JSON.parse(line);
        const pending = this.pending.get(reply.id);
        if (!pending) return;
        if (reply.event === 'run_yield' && pending.method === 'run') {
          this.latestObservation = { source: 'run_yield', receivedAt: Date.now(), value: reply.value };
          return;
        }
        this.pending.delete(reply.id);
        if (reply.ok === true) {
          if (pending.method === 'snapshot' || pending.method === 'command')
            this.latestObservation = { source: pending.method, receivedAt: Date.now(), value: reply.value };
          pending.resolve(reply.value);
        } else pending.reject(new JevBridgeError(reply.error));
      } catch {
        fail(new Error('jev_bridge_invalid_json'));
      }
    });
  }
  invoke(method: string, args: Record<string, unknown>): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      this.child.stdin.write(JSON.stringify({ id, method, args }) + '\n', (error) => {
        if (error) {
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }
  observation(): JevObservation | undefined {
    return this.latestObservation;
  }
  release(): void {
    this.child.stdin.end();
  }
}

export interface JevRelation {
  owner: NativeOwner;
  callId: string;
  instanceId: string;
  targetId: string | null;
  sessionId: string | null;
  createdAt: number;
}
interface Instance {
  bridge: JevBridge;
  relation: JevRelation;
  relationWriteError?: string;
  /** Coalesce observations only; a cancelled observer never cancels the upstream read/run. */
  snapshotRead?: Promise<unknown>;
}

/** Only direct ownership facts are persisted. No inferred task state or restart replay. */
export function readJevRelations(
  home: string,
  owner?: NativeOwner,
  maxRecords = Number.POSITIVE_INFINITY
): JevRelation[] {
  const directory = join(home, 'native-relations');
  if (!existsSync(directory)) return [];
  const dir = lstatSync(directory);
  if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid?.() || dir.mode & 0o077)
    throw new Error('unsafe_jev_relation_directory');
  const rows: JevRelation[] = [];
  const cursor = opendirSync(directory);
  let scanned = 0;
  try {
    while (rows.length < maxRecords && scanned < maxRecords * 8) {
      const entry = cursor.readSync();
      if (!entry) break;
      scanned++;
      if (!/^jev-[a-f0-9-]+\.json$/.test(entry.name)) continue;
      const path = join(directory, entry.name);
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.mode & 0o077)
        throw new Error('unsafe_jev_relation_file');
      if (stat.size > 262144) throw new Error('jev_relation_file_too_large');
      const row = JSON.parse(readFileSync(path, 'utf8')) as JevRelation;
      const text = (value: unknown): value is string =>
        typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0');
      if (
        !row ||
        !row.owner ||
        !['codex', 'claude', 'pi'].includes(row.owner.harness) ||
        !text(row.owner.sourceId) ||
        !text(row.owner.sessionId) ||
        !(row.owner.threadId === null || text(row.owner.threadId)) ||
        !text(row.callId) ||
        !text(row.instanceId) ||
        !Number.isFinite(row.createdAt) ||
        !(row.targetId === null || text(row.targetId)) ||
        !(row.sessionId === null || text(row.sessionId))
      )
        throw new Error('invalid_jev_relation');
      if (!owner || ownerKey(row.owner) === ownerKey(owner)) rows.push(row);
    }
  } finally {
    cursor.closeSync();
  }
  return rows;
}

export function createJevHost(
  home: string,
  owner: NativeOwner,
  factory: () => JevBridge = () => new PythonJevBridge()
) {
  const instances = new Map<string, Instance>();
  privateDirectory(home);
  const directory = join(home, 'native-relations');
  privateDirectory(directory);
  return {
    hasRetainedHandles: () => instances.size > 0,
    async invoke(method: string, args: Record<string, unknown>, _signal?: AbortSignal): Promise<unknown> {
      if (method === 'jev_list')
        return {
          instances: [...instances.values()].map((item) => ({
            ...item.relation,
            apiExecution: 'serial',
            observation: item.bridge.observation?.() ?? null,
            ...(item.relationWriteError ? { relationWriteError: item.relationWriteError } : {}),
          })),
          relations: readJevRelations(home, owner),
        };
      if (method === 'jev_create') {
        if (typeof args.callId !== 'string' || !args.callId) throw new Error('jev_call_id_required');
        const instanceId = randomUUID();
        const bridge = factory();
        const relation: JevRelation = {
          owner,
          callId: args.callId,
          instanceId,
          targetId: null,
          sessionId: null,
          createdAt: Date.now(),
        };
        const instance: Instance = { bridge, relation };
        // Retain the handle even if creation returns an error after constructing its Agent.
        instances.set(instanceId, instance);
        let target: { targetId: string | null; sessionId: string | null };
        try {
          target = (await bridge.invoke('create', args)) as typeof target;
        } catch (error) {
          return {
            ok: false,
            code: 'jev_create_error',
            instanceId,
            error: error instanceof JevBridgeError ? error.nativeError : { message: String(error) },
          };
        }
        relation.targetId = target.targetId;
        relation.sessionId = target.sessionId;
        try {
          const path = join(directory, `jev-${instanceId}.json`);
          const temporary = `${path}.${process.pid}.tmp`;
          writeFileSync(temporary, JSON.stringify(relation), { flag: 'wx', mode: 0o600 });
          renameSync(temporary, path);
        } catch (error) {
          instance.relationWriteError = error instanceof Error ? error.message : String(error);
        }
        return {
          instanceId,
          ...target,
          ...(instance.relationWriteError ? { relationWriteError: instance.relationWriteError } : {}),
        };
      }
      if (!['jev_run', 'jev_snapshot', 'jev_command', 'jev_close'].includes(method))
        throw new Error('unknown_jev_method');
      const instance = instances.get(args.instanceId as string);
      if (!instance) throw new Error('jev_instance_not_owned_or_not_live');
      // Caller abort/IPC EOF ends only the observation, not the upstream operation.
      let value: unknown;
      try {
        if (method === 'jev_snapshot') {
          const pending = instance.snapshotRead ?? instance.bridge.invoke('snapshot', args);
          instance.snapshotRead = pending;
          try {
            value = await pending;
          } finally {
            if (instance.snapshotRead === pending) instance.snapshotRead = undefined;
          }
        } else value = await instance.bridge.invoke(method.slice(4), args);
      } catch (error) {
        if (error instanceof JevBridgeError) return { ok: false, code: 'jev_native_error', error: error.nativeError };
        throw error;
      }
      if (method === 'jev_close') {
        instances.delete(instance.relation.instanceId);
        instance.bridge.release();
      }
      return value;
    },
  };
}
