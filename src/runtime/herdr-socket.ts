import { createConnection } from 'node:net';
import { isAbsolute } from 'node:path';
import { createInterface } from 'node:readline';
import { clearTimeout, setTimeout } from 'node:timers';

export type PaneStripPosition = 'top' | 'bottom';
export type DockMode = 'overlay' | 'push';

export interface PaneStripReservation {
  position: PaneStripPosition;
  line?: string;
  lease_ms?: number;
}

export interface PaneStripInfo {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  width: number;
  height: number;
  cols: number;
  rows: number;
  top: boolean;
  bottom: boolean;
  top_lease_remaining_ms?: number | null;
  bottom_lease_remaining_ms?: number | null;
}

export interface HerdrReply {
  error?: { code: string; message?: string };
  result?: {
    type?: string;
    version?: string;
    protocol?: number;
    shown?: boolean;
    action?: 'opened' | 'closed' | 'unchanged';
    capabilities?: { hidden_tabs?: boolean; hidden_tabs_peek?: boolean; pane_strip?: boolean; guarded_prompt?: boolean; agy_background_work?: boolean; dock?: boolean };
    strip?: PaneStripInfo;
    pane?: {
      pane_id: string;
      tab_id?: string;
      workspace_id?: string;
      launch_id?: string;
      terminal_id?: string;
      label?: string;
      cwd?: string;
      foreground_cwd?: string;
      agent?: string;
      agent_status?: string;
      agent_session?: { kind?: string; value?: string };
    };
    panes?: Array<{
      pane_id: string;
      tab_id?: string;
      workspace_id?: string;
      launch_id?: string;
      terminal_id?: string;
      label?: string;
      cwd?: string;
      foreground_cwd?: string;
      agent?: string;
      agent_status?: string;
      agent_session?: { kind?: string; value?: string };
    }>;
    tab?: { tab_id: string; launch_id?: string; terminal_id?: string; label?: string; hidden?: boolean; peek?: boolean };
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

async function pingHudHerdr(env: NodeJS.ProcessEnv, signal?: AbortSignal) {
  if (!herdrEndpoint(env)) return null;
  const reply = await request('ping', {}, { signal, env }).catch(() => null);
  const pong = reply?.result;
  return !reply?.error && pong && isHudHerdrVersion(pong.version) ? pong : null;
}

export async function isHudHerdrFork(signal?: AbortSignal, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  return (await pingHudHerdr(env, signal)) !== null;
}

/** New worker launches require native turn status from the running server, not the binary on PATH. */
export async function herdrWorkerPreflight(env = process.env): Promise<string | null> {
  const pong = await pingHudHerdr(env);
  if (!pong) return HERDR_FORK_REQUIRED;
  if (pong.capabilities?.agy_background_work !== true)
    return 'Upgrade the running HUD herdr fork (herdr-hud) to one with ping capability agy_background_work.';
  return null;
}

export async function hasHerdrHiddenTabs(env = process.env): Promise<boolean> {
  const reply = await request('ping', {}, { env }).catch(() => null);
  return !reply?.error && reply?.result?.capabilities?.hidden_tabs === true;
}

export async function hasHerdrHiddenTabsPeek(env = process.env): Promise<boolean> {
  const reply = await request('ping', {}, { env }).catch(() => null);
  return !reply?.error && reply?.result?.capabilities?.hidden_tabs_peek === true;
}

export async function hasHerdrDock(env = process.env): Promise<boolean> {
  const reply = await request('ping', {}, { timeoutMs: 500, env });
  return !reply?.error && reply?.result?.capabilities?.dock === true;
}

export async function probeHerdrPaneStrip(env = process.env): Promise<{
  supported: boolean;
  reachable: boolean;
  version?: string;
}> {
  const reply = await request('ping', {}, { timeoutMs: 500, env }).catch(() => null);
  if (!reply || reply.error) return { supported: false, reachable: false };
  return {
    supported: reply.result?.capabilities?.pane_strip === true,
    reachable: true,
    version: reply.result?.version,
  };
}

export function setPaneStrip(
  paneId: string,
  opts: { position: PaneStripPosition; line: string; leaseMs?: number },
  reqOpts: { timeoutMs?: number; signal?: AbortSignal; id?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<HerdrReply | null> {
  const params: Record<string, unknown> = {
    pane_id: paneId,
    position: opts.position,
    line: opts.line,
  };
  if (opts.leaseMs !== undefined) params.lease_ms = opts.leaseMs;
  return request('pane.strip.set', params, reqOpts);
}

export function clearPaneStrip(
  paneId: string,
  position?: PaneStripPosition,
  reqOpts: { timeoutMs?: number; signal?: AbortSignal; id?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<HerdrReply | null> {
  const params: Record<string, unknown> = { pane_id: paneId };
  if (position) params.position = position;
  return request('pane.strip.clear', params, reqOpts);
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

/** Change hints only, while a guarded notice is pending. Never read or retain the prompt contents. */
export function watchHerdrPane(pane: string, env: NodeJS.ProcessEnv, changed: () => void, ended: () => void): () => void {
  const path = env.HERDR_SOCKET_PATH;
  if (!path) return () => {};
  const socket = createConnection(path).unref();
  const lines = createInterface({ input: socket });
  const stop = () => { lines.close(); socket.destroy(); };
  const subscriptions = [
    { type: 'pane.agent_status_changed', pane_id: pane }, { type: 'pane.scroll_changed', pane_id: pane },
    ...['pane.updated', 'pane.resized', 'pane.exited', 'pane.closed'].map(type => ({ type })),
  ];
  socket.on('connect', () => socket.write(JSON.stringify({ id: 'hud-prompt-retry', method: 'events.subscribe', params: { subscriptions } }) + '\n'));
  lines.on('line', line => {
    try {
      const { event, data, error } = JSON.parse(line);
      if (error?.code === 'pane_not_found') { ended(); return; }
      if ((data?.pane_id ?? data?.pane?.pane_id) !== pane) return;
      const kind = String(event).replaceAll('.', '_');
      if (kind === 'pane_closed' || kind === 'pane_exited') ended();
      else changed();
    } catch { stop(); }
  });
  lines.on('error', stop);
  socket.on('error', stop);
  socket.on('close', stop);
  return stop;
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
