// Owned bar/panel collector + real renderer process. The parent always reaps it.
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { HudDelegationCollector } from '../../dist/collectors/delegation.js';
import { ObservationStore } from '../../dist/core/observation-store.js';
import { renderHud } from '../../dist/render/header.js';
import { renderMonitor, initialMonitorState } from '../../dist/render/monitor.js';
import { makeHudData, treeOf } from '../../dist-test/tests/fixtures/hud-data.js';
let runtime, root, clockFile, entry, cut;
const actualNow = Date.now;
Date.now = () => (clockFile ? Number(readFileSync(clockFile, 'utf8')) : actualNow());
let armed = false;
const stop = (point) => {
  process.send({ point });
  process.kill(process.pid, 'SIGSTOP');
};
const originalPublish = ObservationStore.prototype.publishPrepared;
ObservationStore.prototype.publishPrepared = function (candidate, lease) {
  const selected = cut && candidate.commit.ref.sessionId === cut.sessionId;
  if (selected && cut.point === 'before_publish') {
    const point = cut.point;
    cut = null;
    stop(point);
  }
  armed = selected;
  try {
    return originalPublish.call(this, candidate, lease);
  } finally {
    armed = false;
  }
};
const originalExec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function (sql) {
  if (armed && sql === 'COMMIT' && cut?.point === 'before_commit') {
    cut = null;
    stop('before_commit');
  }
  const value = originalExec.call(this, sql);
  if (armed && sql === 'COMMIT' && cut?.point === 'after_commit') {
    cut = null;
    stop('after_commit');
  }
  return value;
};
const data = makeHudData({ subagentTree: treeOf([]) }),
  state = initialMonitorState();
let paints = 0;
const errors = [];
function paint(view) {
  data.delegation = view;
  if (entry === 'bar') renderHud(data, { width: 160, height: 1, layout: { mode: 'compact', showDuration: true } });
  else renderMonitor({ hud: data, tree: data.subagentTree, state, width: 56, height: 40, nowMs: Date.now() });
  paints++;
}
let queue = Promise.resolve();
process.on('message', (message) => {
  queue = queue.then(async () => {
    try {
      if (message.cmd === 'init') {
        clockFile = message.clockFile;
        entry = message.entry;
        root = message.root;
        runtime = await HudDelegationCollector.open({ HUD_HOME: message.home }, message.sourceRoot, { publish: true });
      } else if (message.cmd === 'cut') cut = message.cut;
      else if (message.cmd === 'tick') paint(await runtime.tick(root));
      else if (message.cmd === 'tail') await runtime.afterPaint(paint);
      else if (message.cmd === 'cycles')
        for (let i = 0; i < message.n; i++) {
          paint(await runtime.tick(root));
          await runtime.afterPaint(paint);
          if (runtime.publicationStats().error) errors.push(runtime.publicationStats().error);
        }
      else if (message.cmd === 'close') {
        runtime.close();
        process.send({ id: message.id, closed: true });
        process.disconnect();
        return;
      }
      process.send({
        id: message.id,
        paints,
        errors,
        stats: runtime?.publicationStats(),
        details: Object.values(runtime?.collector.current()?.details ?? {}).map((d) => ({
          source: d.statusSource,
          stamp: d.status?.observationStamp,
        })),
      });
    } catch (error) {
      process.send({ id: message.id, error: error.stack });
    }
  });
});
