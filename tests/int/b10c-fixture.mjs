import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { runtimeFixture, runtimeRow } from './b10a-runtime-fixture.mjs';
import { HudDelegationCollector } from '../../dist/collectors/delegation.js';
import { openObservationStore } from '../../dist/core/observation-store.js';
import { displayNodeKey } from '../../dist/core/observation.js';

export async function publishFixture(count = 3, history = 8) {
  const f = await runtimeFixture(count, history);
  f.runtime.close();
  for (const ref of [f.parent, ...f.targets]) {
    const row = JSON.parse(readFileSync(f.file(ref.sessionId), 'utf8').trim());
    Object.assign(row.payload, { timestamp: row.timestamp, cwd: '/synthetic/project', cli_version: 'synthetic' });
    writeFileSync(f.file(ref.sessionId), JSON.stringify(row) + '\n');
  }
  const runtime = await HudDelegationCollector.open(
    { HUD_HOME: f.home },
    f.file(f.parent.sessionId).split('/sessions/')[0],
    { publish: true }
  );
  const fixture = {
    ...f,
    runtime,
    cleanup() {
      fixture.runtime.close();
      f.cleanup();
    },
  };
  return fixture;
}
export async function cycle(f) {
  let view = await f.runtime.tick(f.parent.sessionId);
  await f.runtime.afterPaint((next) => {
    view = next;
  });
  return view;
}
export async function settle(f) {
  let view;
  for (let i = 0; i < 200; i++) {
    view = await cycle(f);
    if (
      view?.tree.nodes.length === 3 &&
      view.tree.nodes.every((n) => n.loaded) &&
      Object.values(view.details).every((d) => d.statusSource === 'committed')
    )
      return view;
  }
  assert.fail(
    JSON.stringify({
      nodes: view?.tree.nodes.map((n) => ({ id: n.identity, loaded: n.loaded })),
      stats: f.runtime.publicationStats(),
    })
  );
}
