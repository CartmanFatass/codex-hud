// Matched synchronous baseline: same bounded collector, synthetic source, render/frame enqueue and legacy parser.
import { HudDelegationCollector } from '../../dist/collectors/delegation.js';
import { buildSubagentTree, buildSubagentTreeYielding } from '../../dist/collectors/subagent-tree.js';
import { findRolloutsInDaysYielding, treeLookbackDays } from '../../dist/collectors/session-finder.js';
import { initialParserState } from '../../dist/core/observation.js';
import { RolloutParser } from '../../dist/collectors/rollout.js';
import { renderHud } from '../../dist/render/header.js';
import { renderMonitor, initialMonitorState } from '../../dist/render/monitor.js';
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
const f = JSON.parse(process.env.B10D_SYNTHETIC_FIXTURE),
  entry = process.argv[2] ?? 'bar';
const c = await HudDelegationCollector.open({ HUD_HOME: f.home }, f.sourceRoot, { publish: true, boundedWorker: true });
const root = new RolloutParser(0);
root.setRolloutPath(f.rootFile);
const data = makeHudData({ subagentTree: treeOf([]) }),
  state = initialMonitorState();
let previous = null,
  sink = 0,
  completed = 0,
  peak = process.memoryUsage().rss;
function paint() {
  data.delegation = c.collector.current();
  const lines =
    entry === 'bar'
      ? renderHud(data, { width: 160, height: 1, layout: { mode: 'compact', showDuration: true } })
      : renderMonitor({ hud: data, tree: data.subagentTree, state, width: 56, height: 40, nowMs: Date.now() }).lines;
  sink += Buffer.byteLength(frameDiff(previous, lines));
  previous = lines;
}
async function step() {
  const start = performance.now();
  const deadline = start + 40;
  const rt = performance.now();
  await root.parse({
    state: root.getReadStats()?.state ?? initialParserState(),
    budget: { maxBytes: 4 * 1024 * 1024, maxRecords: 2000, budgetMs: 20 },
  });
  const rootMs = performance.now() - rt,
    rootStats = root.getReadStats();
  await c.tick(f.parent.sessionId, deadline, 4 * 1024 * 1024);
  const legacyAt = performance.now(),
    cached = root.getCached();
  data.subagentTree =
    entry === 'panel'
      ? await buildSubagentTreeYielding(
          f.parent.sessionId,
          cached?.subagents ?? [],
          3,
          Date.now(),
          await findRolloutsInDaysYielding(
            treeLookbackDays(
              f.parent.sessionId,
              3,
              cached?.subagents?.map((a) => a.id)
            ),
            legacyPriority(data.subagentTree, f.rootFile)
          )
        )
      : buildSubagentTree(f.parent.sessionId, cached?.subagents ?? []);
  const legacyMs = performance.now() - legacyAt;
  const initial = c.collector.stats();
  let renderMs = 0;
  const rp = () => {
    const at = performance.now();
    paint();
    renderMs += performance.now() - at;
  };
  rp();
  await c.afterPaint(rp);
  const final = c.collector.stats(),
    commit = c.takeCommitTraces().at(-1),
    end = performance.now(),
    m = process.memoryUsage();
  peak = Math.max(peak, m.rss);
  completed++;
  return {
    mainCollectionMs: end - start,
    legacyMs,
    legacyNodes: data.subagentTree.totalCount,
    ordinaryPaintMs: renderMs,
    requestId: completed,
    outcome:
      c.publicationStats().error || c.resources().blocked
        ? 'failed'
        : data.delegation?.pendingStatus
          ? 'continued'
          : 'delivered',
    fullOperationMs: end - start,
    operationMs: end - start,
    paintMs: renderMs,
    rootMs,
    b9Ms: final.b9Ms,
    wiringMs: final.wiringMs,
    renderMs,
    serializationMs: 0,
    ipcMs: 0,
    decodeMs: 0,
    workerMs: end - start - renderMs - rootMs,
    commitToPaintLowerMs: commit ? Number(process.hrtime.bigint()) / 1e6 - commit.returnedAt : null,
    commitToPaintUpperMs: commit ? Number(process.hrtime.bigint()) / 1e6 - commit.beforeAt : null,
    bytesRead: initial.bytesRead + (rootStats?.bytesRead ?? 0),
    payloadBytes: 0,
    publication: c.publicationStats().attempted,
    changed: c.publicationStats().changed,
    stages: c.operationStages(),
    readGrant: initial.readGrant ?? null,
    eligibleBacklog: initial.eligibleBacklog ?? 0,
    oldestEligibleWaitMs: initial.oldestEligibleWaitMs ?? 0,
    error: c.publicationStats().error ?? c.resources().blocked,
  };
}
const metrics = () => ({
  workers: 0,
  resources: { ...c.resources(), ...process.memoryUsage(), rssPeak: peak },
  memory: process.memoryUsage(),
  peakRss: process.resourceUsage().maxRSS * 1024,
  cpu: process.cpuUsage(),
  completed,
  sink,
});
process.on('message', async ({ id, command, count }) => {
  try {
    let result;
    if (command === 'warm') {
      for (let i = 0; i < 5000; i++) {
        await step();
        const v = c.collector.current();
        if (
          v?.tree.nodes.length === (count ?? 3) &&
          v.tree.nodes.every((n) => n.loaded) &&
          Object.values(v.details).every((d) => d.statusSource === 'committed')
        )
          break;
        if (i === 4999) throw new Error('sync_warm_failed');
      }
      result = metrics();
    } else if (command === 'step') result = await step();
    else if (command === 'metrics') result = metrics();
    else if (command === 'view') result = c.collector.current();
    else if (command === 'close') {
      c.close();
      process.send?.({ id, result: true }, () => process.exit(0));
      return;
    } else throw new Error('unknown_command');
    process.send?.({ id, result });
  } catch (e) {
    process.send?.({ id, error: String(e) });
  }
});
process.on('disconnect', () => {
  c.close();
  process.exit(0);
});
process.send?.({ type: 'ready' });
