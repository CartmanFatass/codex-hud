import { createConnection } from 'node:net';
import { isAbsolute } from 'node:path';
import { createInterface } from 'node:readline';
import { clearTimeout, setTimeout } from 'node:timers';

interface Reply {
  error?: { code: string; message?: string };
  result?: {
    type?: string;
    version?: string;
    protocol?: number;
    pane?: { pane_id: string; launch_id?: string };
    tab?: { tab_id: string; launch_id?: string };
    root_pane?: { pane_id: string; launch_id?: string };
    argv?: string[];
    pid?: number;
    pid_start_time?: number | string;
    launch_id?: string;
    agent?: { name?: string; pane_id?: string; tab_id?: string; launch_id?: string; agent_status?: string; agent_session?: { kind: string; value: string } };
    process_info?: { pane_id: string; shell_pid: number; foreground_process_group_id?: number; foreground_processes?: { pid: number; name: string }[] };
  };
}

type HerdrTarget = { left?: string; tab?: string; herdrSocket?: string; launchId?: string };
export const TAB_PROBE_INTERVAL_MS = 25;
export const tabProbeBackoff = (failures: number): number => Math.min(30_000, 250 * 2 ** (failures - 1));

export function isHudHerdrVersion(version: unknown): boolean {
  return typeof version === 'string' && /-hud(?:$|[.-])/.test(version);
}

/** Detect the HUD herdr fork via `ping` version suffix `-hud`. Falls back to stock (`false`). */
export async function isHudHerdrFork(signal?: AbortSignal): Promise<boolean> {
  const reply = await request('ping', {}, { timeoutMs: 500, signal }).catch(() => null);
  return isHudHerdrVersion(reply?.result?.version);
}

/** Capture only a literal endpoint that can be compared across processes and round-trip through SESSION. */
export function herdrEndpoint(): string | undefined {
  const path = process.env.HERDR_SOCKET_PATH;
  if (path && isAbsolute(path) && path.trim() === path && !/[\r\n]/.test(path)) return path;
}

export function hasLocalHerdrTarget({ left, tab, herdrSocket }: HerdrTarget): boolean {
  return !!(left || tab) && !!herdrSocket && herdrSocket === herdrEndpoint();
}

/** A push is only a hint on stock herdr. On the fork, launch_id identifies the exact tab instance. */
export async function probeHerdrTarget(target: HerdrTarget, signal?: AbortSignal): Promise<'present' | 'absent' | 'unknown'> {
  if (!hasLocalHerdrTarget(target)) return 'unknown';
  const { left, tab, launchId } = target;
  const byTab = Boolean(launchId && tab) || !left;
  const reply = await (byTab ? request('tab.get', { tab_id: tab }, { signal })
    : request('pane.get', { pane_id: left }, { signal })).catch(() => null);
  if (reply?.error) return reply.error.code === (byTab ? 'tab_not_found' : 'pane_not_found') ? 'absent' : 'unknown';
  const row = byTab ? reply?.result?.tab : reply?.result?.pane;
  const id = byTab ? reply?.result?.tab?.tab_id : reply?.result?.pane?.pane_id;
  if (id !== (byTab ? tab : left)) return 'unknown';
  if (launchId) {
    if (!row?.launch_id) return 'unknown';
    return row.launch_id === launchId ? 'present' : 'absent';
  }
  return 'present';
}

// Herdr subscription sockets cannot carry requests; each query gets its own connection.
export function request(method: string, params: Record<string, unknown>, { timeoutMs = 2000, signal }: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Reply | null> {
  const path = process.env.HERDR_SOCKET_PATH;
  if (!path || signal?.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    const socket = createConnection(path);
    const lines = createInterface({ input: socket });
    let settled = false;
    const done = (body: Reply | null = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      lines.close();
      socket.destroy();
      resolve(body);
    };
    const abort = () => done();
    const timer = setTimeout(done, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    socket.on('connect', () => socket.write(JSON.stringify({ id: 'hud-request', method, params }) + '\n'));
    lines.once('line', (line) => { try { done(JSON.parse(line)); } catch { done(); } });
    lines.on('error', abort);
    socket.on('error', abort);
    socket.on('close', abort);
  });
}
