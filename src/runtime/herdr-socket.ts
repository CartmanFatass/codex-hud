import { createConnection } from 'node:net';
import { isAbsolute } from 'node:path';
import { createInterface } from 'node:readline';
import { clearTimeout, setTimeout } from 'node:timers';

export interface HerdrReply {
  error?: { code: string; message?: string };
  result?: {
    type?: string;
    version?: string;
    protocol?: number;
    capabilities?: { hidden_tabs?: boolean };
    pane?: { pane_id: string; tab_id?: string; launch_id?: string; terminal_id?: string; label?: string };
    tab?: { tab_id: string; launch_id?: string; terminal_id?: string; label?: string; hidden?: boolean };
    root_pane?: { pane_id: string; tab_id?: string; launch_id?: string; terminal_id?: string };
    argv?: string[];
    pid?: number;
    pid_start_time?: number | string;
    launch_id?: string;
    read?: { text?: string };
    text?: string;
    agent?: {
      name?: string;
      agent?: string;
      pane_id?: string;
      tab_id?: string;
      launch_id?: string;
      terminal_id?: string;
      agent_status?: string;
      interactive_ready?: boolean;
      launch_pending?: boolean;
      agent_session?: { kind: string; value: string };
    };
    process_info?: { pane_id: string; shell_pid?: number; foreground_process_group_id?: number; foreground_processes?: { pid: number; name: string }[] };
  };
}

type HerdrTarget = { left?: string; tab?: string; herdrSocket?: string; launchId?: string; terminalId?: string; directExec?: string };
export const TAB_PROBE_INTERVAL_MS = 25;
export const tabProbeBackoff = (failures: number): number => Math.min(30_000, 250 * 2 ** (failures - 1));

export function isHudHerdrVersion(version: unknown): boolean {
  return typeof version === 'string' && /-hud(?:$|[.-])/.test(version);
}

export const HERDR_FORK_REQUIRED = 'Managed tab workers require the HUD herdr fork (herdr-hud; ping version must contain -hud).';
export const SHELL_WORKER_UNSUPPORTED = 'Legacy shell-launched worker receipt; close the old worker manually before starting a new job.';

/** Browser shell receipts have no managed PRIMARY; split Pi receipts carry DIRECT_EXEC. */
export function isShellLaunchedWorker(fields?: { primary?: string; directExec?: string }): boolean {
  return Boolean(fields?.primary && fields.directExec !== '1');
}

/** Capability must be confirmed by the running server, never by the binary on PATH. */
export async function isHudHerdrFork(signal?: AbortSignal, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (!herdrEndpoint(env)) return false;
  const reply = await request('ping', {}, { timeoutMs: 500, signal, env }).catch(() => null);
  return !reply?.error && isHudHerdrVersion(reply?.result?.version);
}

export async function hasHerdrHiddenTabs(env = process.env): Promise<boolean> {
  const reply = await request('ping', {}, { timeoutMs: 500, env }).catch(() => null);
  return !reply?.error && reply?.result?.capabilities?.hidden_tabs === true;
}

/** Capture only a literal endpoint that can be compared across processes and round-trip through SESSION. */
export function herdrEndpoint(env = process.env): string | undefined {
  const path = env.HERDR_SOCKET_PATH;
  if (path && isAbsolute(path) && path.trim() === path && !/[\r\n]/.test(path)) return path;
}

export function hasLocalHerdrTarget({ left, tab, herdrSocket }: HerdrTarget): boolean {
  return !!(left || tab) && !!herdrSocket && herdrSocket === herdrEndpoint();
}

/** Reconcile a direct-exec receipt against its exact root pane (launch_id + terminal_id).
 * On an endpoint without launch_id capability, identity is always 'unknown', never 'absent'. */
export async function probeDirectRoot(target: HerdrTarget, signal?: AbortSignal, id?: string): Promise<'present' | 'absent' | 'unknown'> {
  if (!hasLocalHerdrTarget(target)) return 'unknown';
  const { left, launchId, terminalId } = target;
  if (!left || !launchId || !terminalId) return 'unknown';
  const reply = await request('pane.get', { pane_id: left }, { signal, id }).catch(() => null);
  if (!reply) return 'unknown';
  if (reply.error) {
    if (reply.error.code !== 'pane_not_found') return 'unknown';
    // Confirm the endpoint supports fork launch_id semantics before treating not_found as absence.
    return (await isHudHerdrFork(signal)) ? 'absent' : 'unknown';
  }
  const row = reply.result?.pane;
  if (!row || row.pane_id !== left) return 'unknown';
  if (!row.launch_id || !row.terminal_id) return 'unknown';
  return row.launch_id === launchId && row.terminal_id === terminalId ? 'present' : 'absent';
}

/** A push is only a hint on stock herdr. On the fork, direct receipts reconcile against exact root (launch_id + terminal_id). */
export async function probeHerdrTarget(target: HerdrTarget, signal?: AbortSignal, id?: string): Promise<'present' | 'absent' | 'unknown'> {
  if (!hasLocalHerdrTarget(target)) return 'unknown';
  if (target.directExec === '1' || target.launchId || target.terminalId) return probeDirectRoot(target, signal, id);
  const { left, tab } = target;
  const reply = await (left ? request('pane.get', { pane_id: left }, { signal, id })
    : request('tab.get', { tab_id: tab }, { signal, id })).catch(() => null);
  if (reply?.error) return reply.error.code === (left ? 'pane_not_found' : 'tab_not_found') ? 'absent' : 'unknown';
  const idMatched = left ? reply?.result?.pane?.pane_id : reply?.result?.tab?.tab_id;
  return idMatched === (left || tab) ? 'present' : 'unknown';
}

// Herdr subscription sockets cannot carry requests; each query gets its own connection.
export function request(method: string, params: Record<string, unknown>, { timeoutMs = 2000, signal, id = 'hud-request', env = process.env }: { timeoutMs?: number; signal?: AbortSignal; id?: string; env?: NodeJS.ProcessEnv } = {}): Promise<HerdrReply | null> {
  const path = env.HERDR_SOCKET_PATH;
  if (!path || signal?.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    const socket = createConnection(path);
    const lines = createInterface({ input: socket });
    let settled = false;
    const done = (body: HerdrReply | null = null) => {
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
    socket.on('connect', () => socket.write(JSON.stringify({ id, method, params }) + '\n'));
    lines.once('line', (line) => { try { done(JSON.parse(line)); } catch { done(); } });
    lines.on('error', abort);
    socket.on('error', abort);
    socket.on('close', abort);
  });
}
