import * as fs from 'node:fs';
import { join } from 'node:path';
import { fixture, root, child } from './b9-fixture.mjs';
import { makeSourceId } from '../../dist/core/identity.js';
import { HudDelegationCollector } from '../../dist/collectors/delegation.js';
export const runtimeRow = (type, payload, at = 0) =>
  JSON.stringify({ type, timestamp: new Date(1772366400000 + at * 1000).toISOString(), payload }) + '\n';
export async function runtimeFixture(count = 200, history = 20000) {
  const f = await fixture({ links: 0 }),
    sourceRoot = join(f.home, 'codex'),
    dir = join(sourceRoot, 'sessions', '2026', '11', '02');
  fs.mkdirSync(dir, { recursive: true });
  const sourceId = makeSourceId('codex', sourceRoot),
    parent = { ...root, sourceId };
  const file = (id) => join(dir, id + '.jsonl');
  fs.writeFileSync(file(parent.sessionId), runtimeRow('session_meta', { id: parent.sessionId }));
  const targets = [];
  for (let i = 1; i < count; i++) {
    const target = { ...child, sourceId, sessionId: `synthetic-worker-${i}` };
    targets.push(target);
    f.addLink(`n${i}`, parent, target);
    fs.writeFileSync(
      file(target.sessionId),
      runtimeRow('session_meta', { id: target.sessionId, parent_thread_id: parent.sessionId })
    );
  }
  for (let i = count; i < history; i++)
    fs.writeFileSync(file(`synthetic-history-${i}`), runtimeRow('session_meta', { id: `synthetic-history-${i}` }));
  const runtime = await HudDelegationCollector.open({ HUD_HOME: f.home }, sourceRoot);
  return {
    ...f,
    runtime,
    parent,
    targets,
    file,
    cleanup: () => {
      runtime.close();
      f.cleanup();
    },
  };
}
