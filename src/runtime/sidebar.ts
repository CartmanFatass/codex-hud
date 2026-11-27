/** Event-driven sidebar publisher for the dock panel and its idle hud-watch fallback. */
import { randomInt } from 'node:crypto';
import { statSync, watch, type FSWatcher } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { readBarSettings } from '../bar-settings.js';
import { readExecutionRuns } from '../collectors/execution-runs.js';
import { HomePortfolioCollector } from '../collectors/home-portfolio.js';
import { buildSidebarProjection, type SidebarFacts, type SidebarProjection } from '../collectors/sidebar-projection.js';
import { statePaths } from '../collectors/state-ledger.js';
import { buildWorkboard } from '../collectors/workboard.js';
import { PanelJobPipeline } from '../panel/job-pipeline.js';
import { sidebarDestination, type SidebarDestination } from '../panel/sidebar-navigation.js';
import { roleIcon } from '../render/model-glyphs.js';
import { settingsPath } from '../settings.js';
import { getJobIndexCache } from '../roles/job-index-cache.js';
import { projectList, type ListedProject } from '../roles/projects.js';
import { herdrEndpoint, request, watchHerdrEvents, type HerdrReply } from './herdr-socket.js';

const LEASE_MS = 15_000;
const homeFiles = new Set(['jobs-revision.json', 'projects.json', 'tries.jsonl', 'flows',
  'unattended.json', 'unattended.pid.json', 'unattended-runs.json', 'unattended-diagnostics.json']);
const events = ['sidebar.hud_activate', 'workspace.created', 'workspace.updated', 'workspace.closed',
  'pane.created', 'pane.updated', 'pane.closed', 'pane.exited'];

/** Watch directories, not replaceable file inodes. Missing paths are followed from their nearest existing parent. */
function watchSidebarInputs(home: string, settings: string, changed: () => void) {
  type Filter = { names: Set<string>; recursive: boolean; all: boolean };
  const watched = new Map<string, { watcher: FSWatcher; recursive: boolean; identity: string }>();
  let filters = new Map<string, Filter>();
  const directory = (path: string) => {
    try {
      const stat = statSync(path, { bigint: true, throwIfNoEntry: false });
      if (stat?.isDirectory()) return `${stat.dev}:${stat.ino}`;
    } catch { /* Follow the path from its parent. */ }
  };
  function sync(projects: readonly ListedProject[]) {
    const next = new Map<string, Filter>();
    const add = (dir: string, name?: string, recursive = false) => {
      while (!directory(dir) && dirname(dir) !== dir) {
        name = basename(dir);
        dir = dirname(dir);
        recursive = false;
      }
      let filter = next.get(dir);
      if (!filter) next.set(dir, filter = { names: new Set(), recursive: false, all: false });
      if (name === undefined) filter.all = true;
      else filter.names.add(name);
      filter.recursive ||= recursive;
    };
    for (const file of homeFiles) add(home, file);
    add(join(home, 'flows'));
    add(dirname(settings), basename(settings));
    for (const { root } of projects) {
      add(root, '.hud');
      add(join(root, '.hud'), undefined, true);
      for (const state of statePaths(root)) {
        add(dirname(state), 'STATE.md');
        // The STATE parent itself can be created or replaced while we are watching it.
        for (let dir = dirname(state); dir !== root; dir = dirname(dir)) add(dirname(dir), basename(dir));
      }
    }
    filters = next;
    for (const [dir, { watcher, recursive, identity }] of watched) {
      if (recursive === filters.get(dir)?.recursive && identity === directory(dir)) continue;
      watcher.close();
      watched.delete(dir);
    }
    for (const [dir, { recursive }] of filters) {
      if (watched.has(dir)) continue;
      const identity = directory(dir);
      if (!identity) continue;
      try {
        const watcher = watch(dir, { recursive, persistent: false }, (event, file) => {
          const filter = filters.get(dir);
          if (!filter || file?.endsWith('.tmp')) return;
          if (event === 'rename' && directory(dir) !== identity) { watcher.close(); changed(); }
          else if (!file || filter.all || filter.names.has(file)) changed();
        });
        watcher.once('close', () => { if (watched.get(dir)?.watcher === watcher) watched.delete(dir); });
        watcher.once('error', () => { watcher.close(); changed(); });
        watched.set(dir, { watcher, recursive, identity });
      } catch { /* A parent watch can pick up creation or replacement. */ }
    }
  }
  return { sync, stop() { filters.clear(); for (const { watcher } of watched.values()) watcher.close(); watched.clear(); } };
}

type Panes = NonNullable<NonNullable<HerdrReply['result']>['panes']>;
type Topology = { panes?: Panes; workspaces?: NonNullable<NonNullable<HerdrReply['result']>['workspaces']> };
function spacesProjects(projects: readonly ListedProject[], { panes, workspaces }: Topology) {
  if (!panes || !workspaces) return;
  const paths = [...workspaces.flatMap(({ worktree }) => worktree ? [worktree.repo_root, worktree.checkout_path] : []),
    ...panes.flatMap(({ cwd, foreground_cwd }) => [cwd, foreground_cwd])];
  return new Set(projects.filter(({ root }) => paths.some(path => path === root || path?.startsWith(root + sep))).map(p => p.root));
}

function sidebarCollector(home: string, endpoint: string, env: NodeJS.ProcessEnv) {
  const portfolio = new HomePortfolioCollector(home);
  const jobs = new Map<string, PanelJobPipeline>();
  const noAgents = { rootId: '', totalCount: 0, nodes: [], updatedAt: new Date() };
  const emptyBoard = buildWorkboard(noAgents);
  const cache = getJobIndexCache(home);
  const noWorkers = new Map();
  let stopped = false;
  return {
    async read(registered: ListedProject[], topology: Topology, now: number): Promise<SidebarFacts | undefined> {
      const facts = await portfolio.read(registered, emptyBoard, now);
      if (stopped) return;
      const runs = [], retained = new Set<string>(), live = new Set<string>();
      // Prefer active-today projects at the wire's graph cap without losing open runs in other registered projects.
      const projects = [...facts.projects.filter(p => p.activeToday), ...facts.projects.filter(p => !p.activeToday)];
      for (const { root, name: group, unavailable } of projects) {
        if (unavailable || !readExecutionRuns(home, { root, pane: null }, noWorkers, now).some(run => run.endedAt === undefined)) continue;
        let pipeline = jobs.get(root);
        if (!pipeline) jobs.set(root, pipeline = new PanelJobPipeline(home, { project: root, pane: null, within: root }));
        retained.add(root);
        const ok = await pipeline.refresh();
        if (stopped) return;
        const workers = ok ? new Map(pipeline.workboard(noAgents).workers.map(w => [w.id.replace(/^thin-job:/, ''), w])) : noWorkers;
        for (const [id, worker] of workers) if (worker.settledAt === null && !worker.headless) live.add(id);
        for (const run of readExecutionRuns(home, { root, pane: null }, workers, now)) {
          if (run.endedAt === undefined) runs.push({ root, group, run });
        }
      }
      for (const [root, pipeline] of jobs) if (!retained.has(root)) { pipeline.dispose(); jobs.delete(root); }
      const panes = new Map(topology.panes?.map(pane => [pane.pane_id, pane]));
      const icons = readBarSettings(env)?.icons;
      return buildSidebarProjection(facts, runs, spacesProjects(registered, topology), (id) => {
        if (!live.has(id)) return;
        const receipt = cache.readSession(id)?.fields;
        if (!receipt?.left || receipt.herdrSocket !== endpoint || !receipt.launchId || !receipt.terminalId) return;
        const pane = panes.get(receipt.left);
        if (pane?.launch_id === receipt.launchId && pane.terminal_id === receipt.terminalId) return pane.pane_id;
      }, now, role => roleIcon(role, icons));
    },
    stop() { stopped = true; for (const job of jobs.values()) job.dispose(); jobs.clear(); },
  };
}

/** The fork renews the lease without repainting when the same generation and payload are resent. */
export function createSidebarPublisher(send: (params: { gen: number; lease_ms: number; projection: SidebarProjection }) => Promise<boolean>) {
  type Version = { gen: number; facts: SidebarFacts };
  let current: Version | undefined, pending: Version | undefined;
  return {
    reset() { current = pending = undefined; },
    destination(gen: unknown, data: Record<string, unknown>) {
      if (current && current.gen === gen) return sidebarDestination(data, current.facts);
    },
    async update(facts: SidebarFacts | undefined, renew = false) {
      if (facts && facts.revision !== pending?.facts.revision) {
        pending = facts.revision === current?.facts.revision ? undefined : { gen: randomInt(2 ** 48 - 1), facts };
      }
      const next = pending ?? (renew ? current : undefined);
      if (next && await send({ gen: next.gen, lease_ms: LEASE_MS, projection: next.facts.projection })) {
        current = next;
        pending = undefined;
      }
    },
  };
}

/** Only the dock publishes while it is running, even when hidden. The watcher serves (and can open) a closed dock. */
export function runSidebar(home: string, root: string, hooks: {
  fallback?: boolean;
  activate(destination: SidebarDestination): void | Promise<void>;
}, env = process.env): () => void {
  const endpoint = herdrEndpoint(env);
  if (!endpoint) return () => {};
  const abort = new AbortController();
  const call = (method: string, params = {}) => request(method, params, { env, signal: abort.signal, timeoutMs: 500 });
  const dockClosed = async () => {
    const status = (await call('dock.status'))?.result;
    return status?.type === 'dock' && status.shown === false && status.hidden !== true;
  };
  const publisher = createSidebarPublisher(async params => {
    // The dock may have opened during an async collection. Let its panel take over.
    if (hooks.fallback && !await dockClosed()) return false;
    return (await call('sidebar.set_hud', params))?.result?.type === 'ok';
  });
  const collector = sidebarCollector(home, endpoint, env);
  const inputs = watchSidebarInputs(home, resolve(settingsPath(env)), () => schedule(true));
  let timer: NodeJS.Timeout | undefined, pending: NodeJS.Immediate | undefined;
  let connected = false, collecting = false, dirty = true, renew = false, topology: Topology | undefined;
  let generation = 0;
  function schedule(change = false, extend = false) {
    dirty ||= change;
    renew ||= extend;
    if (connected && !collecting && !pending && !abort.signal.aborted) pending = setImmediate(() => {
      pending = undefined;
      void flush();
    });
  }
  async function flush() {
    if (!connected || abort.signal.aborted) return;
    collecting = true;
    const epoch = generation, collect = dirty, extend = renew;
    dirty = renew = false;
    let standby = false;
    const current = () => connected && epoch === generation && !abort.signal.aborted;
    try {
      if (hooks.fallback && !await dockClosed()) {
        publisher.reset();
        inputs.stop();
        topology = undefined;
        dirty = standby = true;
        return;
      }
      if (!current()) return;
      let facts: SidebarFacts | undefined;
      if (collect) {
        const projects = projectList(home, root);
        inputs.sync(projects);
        if (!topology) {
          const [panes, workspaces] = await Promise.all([call('pane.list'), call('workspace.list')]);
          if (!current()) return;
          // An event that arrived during these requests must still invalidate this sample.
          const sample = { panes: panes?.result?.panes, workspaces: workspaces?.result?.workspaces };
          if (!dirty && sample.panes && sample.workspaces) topology = sample;
          facts = await collector.read(projects, sample, Date.now());
        } else facts = await collector.read(projects, topology, Date.now());
      }
      if (current()) await publisher.update(facts, extend);
    } catch { /* Keep the last lease; a later change or reconnect can recover. */ }
    finally {
      collecting = false;
      if (connected && !abort.signal.aborted) {
        // Renew only the cached payload, not the filesystem facts. A standby watcher rechecks dock ownership here.
        timer ??= setTimeout(() => { timer = undefined; schedule(false, true); }, LEASE_MS / 3).unref();
        if (renew || (dirty && (!standby || epoch !== generation))) schedule();
      }
    }
  }
  const stopEvents = watchHerdrEvents(env, events, {
    ready() { connected = true; topology = undefined; schedule(true, true); },
    dropped() { connected = false; generation++; clearTimeout(timer); timer = undefined; },
    event(kind, data) {
      if (kind === 'sidebar_hud_activate') {
        const destination = publisher.destination(data.gen, data);
        if (destination) void (async () => {
          if (!hooks.fallback || await dockClosed()) await hooks.activate(destination);
        })().catch(() => {});
      } else {
        topology = undefined;
        schedule(true);
      }
    },
  });
  return () => {
    abort.abort();
    clearImmediate(pending);
    clearTimeout(timer);
    stopEvents();
    inputs.stop();
    collector.stop();
  };
}
