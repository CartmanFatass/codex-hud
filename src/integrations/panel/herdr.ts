/** Bounded herdr adapter. No tab/job/agent lifecycle operations are exposed. */
import * as fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { commandText } from '../herdr/host.js';
import { HerdrClient } from '../herdr/client.js';
import { CliHerdrTransport, object, type HerdrTransport } from '../herdr/transport.js';
import { runCommand } from '../../roles/herdr-run.js';
import { readProcess, sameStamp } from '../../core/run/process.js';
import type { ProcessStamp } from '../../core/types/supervision.js';
import { absolute, clean, type PaneIdentity, type PanelReceipt } from './receipt.js';

export class PanelDeadline {
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  readonly end: number;
  constructor(ms: number) {
    this.end = performance.now() + Math.min(Math.max(ms, 1), 4000);
    this.timer = setTimeout(() => this.controller.abort(), Math.min(Math.max(ms, 1), 4000));
  }
  get signal(): AbortSignal {
    return this.controller.signal;
  }
  remaining(cap = 500): number {
    const n = Math.min(cap, this.end - performance.now());
    if (this.signal.aborted || n <= 0) throw new Error('panel_deadline');
    return n;
  }
  async run<T>(body: () => Promise<T>): Promise<T> {
    this.remaining(Infinity);
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(new Error('panel_deadline'));
      this.signal.addEventListener('abort', abort, { once: true });
      body()
        .then(resolve, reject)
        .finally(() => this.signal.removeEventListener('abort', abort));
    });
  }
  dispose(): void {
    clearTimeout(this.timer);
    this.controller.abort();
  }
}
export interface PanelHerdr {
  preflight(d: PanelDeadline): Promise<string>;
  instance(d: PanelDeadline): Promise<string | null>;
  observe(pane: string, d: PanelDeadline, workspace?: string): Promise<PaneIdentity | null>;
  split(
    r: PanelReceipt,
    env: Record<string, string>,
    d: PanelDeadline
  ): Promise<string | Pick<PaneIdentity, 'pane' | 'workspace'>>;
  start(pane: string, argv: string[], d: PanelDeadline): Promise<void>;
  close(pane: string, d: PanelDeadline): Promise<void>;
}
export class CliPanelHerdr implements PanelHerdr {
  private readonly raw: CliHerdrTransport;
  constructor(
    private readonly options: { socket: string; server: ProcessStamp; env: NodeJS.ProcessEnv; binary?: string }
  ) {
    this.raw = new CliHerdrTransport(options.socket, options.env, options.binary ?? 'herdr', 400, options.server);
  }
  private transport(d: PanelDeadline): HerdrTransport {
    return {
      instance: () => this.instance(d),
      request: (m, p) => d.run(() => this.raw.request(m, p)),
      command: (args) => this.command(args, d),
    };
  }
  private async command(argv: readonly string[], d: PanelDeadline): Promise<unknown> {
    const out = await runCommand(
      this.options.binary ?? 'herdr',
      argv,
      { ...this.options.env, HERDR_SOCKET_PATH: this.options.socket, HERDR_SOCKET: undefined },
      { budgetMs: d.remaining(), signal: d.signal }
    );
    if (!out.ok) throw new Error(out.reason === 'unavailable' ? 'herdr_unavailable' : `herdr_${out.reason}`);
    if (argv[0] === '--version' || (argv[0] === 'pane' && argv[2] === '--help')) return out.stdout.trim();
    if (!out.stdout.trim()) return {};
    try {
      return JSON.parse(out.stdout) as unknown;
    } catch {
      throw new Error('herdr_invalid_response');
    }
  }
  async preflight(d: PanelDeadline): Promise<string> {
    // Preserve the existing compatibility gate, then additionally verify our two effects.
    const client = new HerdrClient(this.transport(d), { ...this.options.env, HERDR_ENV: '1' });
    const instance = await client.require();
    const schema = object(await this.command(['api', 'schema', '--json'], d));
    const req = object(object(schema.schemas).request);
    const methods = Array.isArray(req.oneOf)
      ? req.oneOf.map((v) => object(object(object(v).properties).method).const)
      : [];
    const split = object(object(req.$defs).PaneSplitParams);
    const props = object(split.properties);
    const runHelp = await this.command(['pane', 'run', '--help'], d);
    if (
      !methods.includes('pane.close') ||
      !methods.includes('pane.split') ||
      !['env', 'focus', 'target_pane_id'].every((k) => k in props) ||
      typeof runHelp !== 'string' ||
      !runHelp.includes('Run a command in a pane')
    )
      throw new Error('panel_launch_unsupported');
    return instance;
  }
  instance(d: PanelDeadline): Promise<string | null> {
    return d.run(() => this.raw.instance());
  }
  async observe(pane: string, d: PanelDeadline, workspace?: string): Promise<PaneIdentity | null> {
    const instance = await this.instance(d);
    if (!instance) throw new Error('herdr_instance_changed');
    let raw: Record<string, unknown>;
    try {
      raw = object((await d.run(() => this.raw.request('pane.get', { pane_id: pane }))).pane);
    } catch (error) {
      // ONLY failed gets may establish absence; positive metadata must never be
      // overridden by an excluding inventory (q7). An omitted scope may follow focus.
      const scope = workspace;
      if (!clean(scope, 256)) throw new Error('panel_workspace_unknown');
      const ids = (rows: unknown, key: string): string[] | null => {
        if (
          !Array.isArray(rows) ||
          rows.length > 4096 ||
          !rows.every((p) => p && typeof p === 'object' && clean(p[key], 256))
        )
          return null;
        const values = rows.map((p) => String(p[key]));
        return new Set(values).size === values.length ? values : null;
      };
      let panes: string[] | null = null;
      try {
        panes = ids((await d.run(() => this.raw.request('pane.list', { workspace_id: scope }))).panes, 'pane_id');
      } catch {
        /* A missing workspace must be corroborated below, never guessed. */
      }
      if ((await this.instance(d)) !== instance) throw new Error('herdr_instance_changed');
      if (panes?.includes(pane)) throw error;
      const workspaces = ids((await d.run(() => this.raw.request('workspace.list', {}))).workspaces, 'workspace_id');
      if ((await this.instance(d)) !== instance) throw new Error('herdr_instance_changed');
      if (workspaces && (!workspaces.includes(scope) || panes !== null)) return null;
      throw error;
    }
    const reportedWorkspace = raw.workspace_id;
    if (!clean(reportedWorkspace, 256)) throw new Error('panel_workspace_unknown');
    if (workspace && reportedWorkspace !== workspace) throw new Error('panel_workspace_changed');
    const info = object((await d.run(() => this.raw.request('pane.process_info', { pane_id: pane }))).process_info);
    if (raw.pane_id !== pane || info.pane_id !== pane || !clean(raw.tab_id, 256) || !clean(raw.terminal_id, 256))
      throw new Error('panel_pane_unknown');
    const shell = readProcess(Number(info.shell_pid));
    const fg = readProcess(Number(info.foreground_process_group_id));
    if (
      !shell ||
      !fg ||
      !shell.tty ||
      fg.pgid !== shell.foregroundPgid ||
      fg.tty !== shell.tty ||
      fg.sid !== shell.sid ||
      ['Z', 'X'].includes(fg.state)
    )
      throw new Error('panel_occupant_unknown');
    if ((await this.instance(d)) !== instance) throw new Error('herdr_instance_changed');
    return {
      pane,
      tab: raw.tab_id,
      terminal: raw.terminal_id,
      process: fg.stamp,
      shell: shell.stamp,
      workspace: reportedWorkspace,
      atPrompt: sameStamp(shell.stamp, fg.stamp) && !raw.agent,
    };
  }
  async split(
    r: PanelReceipt,
    env: Record<string, string>,
    d: PanelDeadline
  ): Promise<string | Pick<PaneIdentity, 'pane' | 'workspace'>> {
    const args = ['pane', 'split', r.origin.pane, '--direction', 'right', '--no-focus', '--cwd', r.target.source];
    for (const [k, v] of Object.entries(env)) {
      if (!/^[A-Z_]+$/.test(k) || !clean(v)) throw new Error('panel_env_invalid');
      args.push('--env', `${k}=${v}`);
    }
    const result = object(object(await this.command(args, d)).result);
    const pane = object(result.pane).pane_id;
    if (!clean(pane, 256) || pane === r.origin.pane) throw new Error('panel_split_unknown');
    const workspace = object(result.pane).workspace_id;
    return clean(workspace, 256) ? { pane, workspace } : pane;
  }
  async start(pane: string, argv: string[], d: PanelDeadline): Promise<void> {
    if (!clean(pane, 256) || !argv.every((v) => clean(v)) || !absolute(argv[0])) throw new Error('panel_argv_invalid');
    await this.command(['pane', 'run', pane, commandText({ argv })], d);
  }
  async close(pane: string, d: PanelDeadline): Promise<void> {
    if (!clean(pane, 256)) throw new Error('panel_pane_invalid');
    await this.command(['pane', 'close', pane], d);
  }
}
export function samePane(a: PaneIdentity, b: PaneIdentity): boolean {
  return (
    a.pane === b.pane &&
    a.tab === b.tab &&
    a.terminal === b.terminal &&
    a.workspace === b.workspace &&
    sameStamp(a.process, b.process)
  );
}
export function panelArgv(r: PanelReceipt): string[] {
  return [
    r.runtime.node,
    r.runtime.entry,
    'panel',
    '--harness',
    r.target.harness,
    '--session',
    r.target.ref.sessionId,
    '--source',
    r.target.source,
  ];
}
/** A registration file alone is not occupant proof. Corroborate the live process image. */
export function registeredProcess(r: PanelReceipt, pane: PaneIdentity): boolean {
  try {
    const before = readProcess(pane.process.pid);
    if (!before || !sameStamp(before.stamp, pane.process)) return false;
    const argv = fs.readFileSync(`/proc/${pane.process.pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
    const env = fs.readFileSync(`/proc/${pane.process.pid}/environ`, 'utf8').split('\0');
    return (
      JSON.stringify(argv) === JSON.stringify(panelArgv(r)) &&
      env.includes(`HUD_PANEL_TOKEN=${r.token}`) &&
      env.includes(`HUD_PANEL_GENERATION=${r.generation}`) &&
      !!readProcess(pane.process.pid) &&
      sameStamp(readProcess(pane.process.pid)!.stamp, pane.process)
    );
  } catch {
    return false;
  }
}
