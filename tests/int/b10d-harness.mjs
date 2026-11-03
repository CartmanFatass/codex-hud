import { buildSubagentTree, buildSubagentTreeYielding } from '../../dist/collectors/subagent-tree.js';
import { findRolloutsInDaysYielding, treeLookbackDays } from '../../dist/collectors/session-finder.js';
import { initialParserState } from '../../dist/core/observation.js';
import { RolloutParser } from '../../dist/collectors/rollout.js';
import { monotonicNow } from '../../dist/core/link/worker-protocol.js';
import { DelegationWorkerClient } from '../../dist/core/link/worker-client.js';
import { renderHud } from '../../dist/render/header.js';
import { renderMonitor, initialMonitorState, handleMonitorInput } from '../../dist/render/monitor.js';
import { frameDiff } from '../../dist/render/frame-diff.js';
import { makeHudData, treeOf } from '../../dist-test/tests/fixtures/hud-data.js';

function legacyPriority(tree, rootFile) {
  const paths = new Set([rootFile]),
    queue = [...tree.nodes];
  for (let i = 0; i < queue.length; i++) {
    const n = queue[i];
    if (n.rolloutPath) paths.add(n.rolloutPath);
    queue.push(...n.children);
  }
  return paths;
}
export function workerHarness(f, options = {}) {
  const waiters = new Set();
  const data = makeHudData({ subagentTree: treeOf([]) });
  let mainBookkeepingMs = 0,
    frameMs = 0;
  let client,
    prior = null,
    sink = 0,
    paints = 0;
  const rootParser = options.legacy ? new RolloutParser(0) : null;
  if (rootParser) rootParser.setRolloutPath(f.rootFile);
  let state = initialMonitorState();
  let latestMain = { mainCollectionMs: 0, legacyMs: 0, ordinaryPaintMs: 0, legacyNodes: 0 };
  let warmTrace = null;
  let width = 56,
    height = 40,
    frame = null;
  const paint = () => {
    data.delegation = client.current();
    const frameStarted = performance.now();
    const lines =
      options.entry === 'panel'
        ? (frame = renderMonitor({ hud: data, tree: data.subagentTree, state, width, height, nowMs: Date.now() })).lines
        : renderHud(data, { width: 160, height: 1, layout: { mode: 'compact', showDuration: true } });
    sink += Buffer.byteLength(frameDiff(prior, lines));
    prior = lines;
    frameMs += performance.now() - frameStarted;
    paints++;
    if (options.autoAck !== false) client.painted(data.delegation);
    options.onPaint?.(data.delegation);
  };
  const callbacks = {
    onResult: paint,
    onHealth: (reason) => options.onHealth?.(reason),
    onSample: (sample) => {
      for (const waiter of [...waiters])
        if (sample.requestId >= waiter.id) {
          waiters.delete(waiter);
          clearTimeout(waiter.timer);
          waiter.resolve(sample);
        }
      options.onSample?.(sample);
    },
  };
  client = options.testModule
    ? DelegationWorkerClient.forTesting({ HUD_HOME: f.home }, f.sourceRoot, {
        ...callbacks,
        testModule: options.testModule,
        testData: options.testData,
      })
    : DelegationWorkerClient.open({ HUD_HOME: f.home }, f.sourceRoot, callbacks);
  if (!client) throw new Error('test_client_missing');
  // Per-operation main service time, excluding the measured renderer; includes validation/adoption/freshness.
  for (const method of ['beginCollection', 'submitLegacy', 'message']) {
    const original = client[method].bind(client);
    client[method] = (...args) => {
      const at = performance.now(),
        renderBefore = frameMs;
      try {
        return original(...args);
      } finally {
        mainBookkeepingMs += Math.max(0, performance.now() - at - (frameMs - renderBefore));
        if (method === 'message') {
          const s = client.samples().at(-1);
          if (s) s.mainBookkeepingMs = mainBookkeepingMs;
        }
      }
    };
  }

  const step = async (scope = f.parent.sessionId, root = { bytesRead: 0, recordsRead: 0, elapsedMs: 0 }) => {
    mainBookkeepingMs = 0;
    const mainStarted = performance.now();
    const id = (client.diagnostics().lastSample?.requestId ?? 0) + 1;
    const result = new Promise((resolve, reject) => {
      const waiter = { id, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        waiters.delete(waiter);
        reject(new Error(JSON.stringify(client.diagnostics())));
      }, options.timeoutMs ?? 20000);
      waiters.add(waiter);
    });
    const grant = client.beginCollection(scope);
    let rootDone = Promise.resolve();
    if (grant && rootParser) {
      const at = performance.now();
      rootDone = rootParser
        .parse({
          state: rootParser.getReadStats()?.state ?? initialParserState(),
          budget: { ...grant.budget, budgetMs: Math.max(0, Math.min(20, grant.deadlineAt - monotonicNow())) },
        })
        .then(
          () => {
            const stats = rootParser.getReadStats();
            client.submitLegacy(
              grant,
              stats
                ? { bytesRead: stats.bytesRead, recordsRead: stats.recordsRead, elapsedMs: performance.now() - at }
                : { ...root, elapsedMs: performance.now() - at }
            );
          },
          () =>
            client.submitLegacy(grant, {
              bytesRead: grant.budget.maxBytes,
              recordsRead: grant.budget.maxRecords,
              elapsedMs: performance.now() - at,
              failed: true,
            })
        );
    } else if (grant) client.submitLegacy(grant, root);
    if (options.legacy) {
      await rootDone;
      const at = performance.now(),
        cached = rootParser.getCached(),
        rootId = cached?.session?.id ?? scope;
      if (rootId) {
        if (options.entry === 'panel') {
          const listed = await findRolloutsInDaysYielding(
            treeLookbackDays(
              scope ?? f.parent.sessionId,
              3,
              cached?.subagents?.map((a) => a.id)
            ),
            legacyPriority(data.subagentTree, f.rootFile)
          );
          data.subagentTree = await buildSubagentTreeYielding(rootId, cached?.subagents ?? [], 3, Date.now(), listed);
        } else data.subagentTree = buildSubagentTree(rootId, cached?.subagents ?? []);
      }
      const legacyMs = performance.now() - at,
        paintAt = performance.now();
      paint();
      latestMain = {
        mainCollectionMs: performance.now() - mainStarted,
        legacyMs,
        ordinaryPaintMs: performance.now() - paintAt,
        legacyNodes: data.subagentTree.totalCount,
      };
    }
    const sample = await result;
    return {
      ...sample,
      ...latestMain,
      workerWiringMs: sample.wiringMs,
      mainBookkeepingMs,
      wiringMs: sample.wiringMs + mainBookkeepingMs + latestMain.legacyMs,
      fullOperationMs: Math.max(sample.operationMs, performance.now() - mainStarted),
    };
  };
  return {
    client,
    step,
    paint,
    key(key) {
      state = handleMonitorInput(
        state,
        { type: 'key', key },
        { tree: data.subagentTree, git: null, worktrees: null, frame }
      ).state;
      paint();
      return state;
    },
    resize(w, h) {
      width = w;
      height = h;
      paint();
      return frame;
    },
    get sink() {
      return sink;
    },
    get paints() {
      return paints;
    },
    get data() {
      return data;
    },
    get warmDiagnostics() {
      return warmTrace;
    },
    async warm(count = 3) {
      const started = performance.now();
      warmTrace = { operations: 0, elapsedMs: 0, grants: {}, changed: 0, blocked: {}, progress: [] };
      for (let i = 0; i < 5000; i++) {
        const sample = await step();
        warmTrace.operations++;
        warmTrace.elapsedMs = performance.now() - started;
        if (sample.readGrant) {
          const key = sample.readGrant.key + ':' + sample.readGrant.kind;
          warmTrace.grants[key] = (warmTrace.grants[key] ?? 0) + 1;
        }
        if (sample.changed) warmTrace.changed++;
        const d = client.diagnostics();
        if (d.resources?.blocked)
          warmTrace.blocked[d.resources.blocked] = (warmTrace.blocked[d.resources.blocked] ?? 0) + 1;
        const view = client.current();
        if (i % 100 === 0)
          warmTrace.progress.push({
            operation: i + 1,
            loaded: view?.tree.nodes.filter((n) => n.loaded).length ?? 0,
            committed: Object.values(view?.details ?? {}).filter((x) => x.statusSource === 'committed').length,
            eligible: sample.eligibleBacklog,
            oldestEligibleMs: sample.oldestEligibleWaitMs,
            blocked: d.resources?.blocked ?? null,
          });
        if (
          view?.tree.nodes.length === count &&
          view.tree.nodes.every((n) => n.loaded) &&
          Object.values(view.details).every((d) => d.statusSource === 'committed')
        )
          return view;
      }
      throw new Error(JSON.stringify({ diagnostics: client.diagnostics(), warm: warmTrace }));
    },
    async close() {
      for (const w of waiters) {
        clearTimeout(w.timer);
        w.reject(new Error('test_harness_closed'));
      }
      waiters.clear();
      return client.close();
    },
  };
}
export async function waitUntil(predicate, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('test_wait_timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
