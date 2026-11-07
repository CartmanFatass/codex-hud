import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { notifyFixture } from './b21-fixture.js';
import { insertRecord } from '../../src/ledger/records.js';
import { makeSourceId, sessionRefKey } from '../../src/core/identity.js';
import { displayNodeKey } from '../../src/core/observation.js';
import { HudDelegationCollector } from '../../src/collectors/delegation.js';
import { PiAdapter } from '../../src/harness/pi/index.js';
import { draw, monitorInput } from '../fixtures/b10b-s3.js';
import { inspectorRows } from '../../src/render/monitor-inspector.js';
import { delegationView } from '../../src/render/delegation/panel.js';
import { stripAnsi } from '../../src/render/colors.js';
import type { DelegationViewModel } from '../../src/core/link/view-model.js';

async function fixture(t: test.TestContext, headerId = 'synthetic-pi', publish = false) {
  const f = await notifyFixture();
  const root = path.join(f.root, 'pi-source');
  fs.mkdirSync(root);
  const file = path.join(root, 'synthetic-pi.jsonl');
  const timestamp = new Date().toISOString();
  const message = (id: string, input: number) => ({
    type: 'message',
    id,
    parentId: null,
    timestamp,
    message: {
      role: 'assistant',
      model: 'synthetic-pi-model',
      provider: 'synthetic',
      content: [{ type: 'text', text: 'PRIVATE_SYNTHETIC_BODY' }],
      usage: { input, output: 5, cacheRead: 2, cacheWrite: 0, cost: { total: 0.125 } },
      stopReason: 'stop',
    },
  });
  fs.writeFileSync(
    file,
    [{ type: 'session', version: 3, id: headerId, timestamp, cwd: '/synthetic/project' }, message('m1', 20)]
      .map((value) => JSON.stringify(value))
      .join('\n') + '\n'
  );
  const ref = { harness: 'pi' as const, sourceId: makeSourceId('pi', root), sessionId: 'synthetic-pi', threadId: null };
  fs.writeFileSync(
    path.join(f.root, 'delegate.json'),
    JSON.stringify({
      version: 1,
      profiles: [
        { name: 'synthetic-pi', harness: 'pi', source: { root, label: 'Synthetic pi' }, env: {}, mcpServerName: 'hud' },
      ],
    })
  );
  await f.ledger.transaction((tx) => {
    insertRecord(tx, 'sources', { sourceId: ref.sourceId, harness: 'pi', rootPath: root, label: 'Synthetic pi' });
    tx.run(
      'INSERT INTO sessions(session_ref,harness,source_id,session_id,thread_id) VALUES(?,?,?,?,?)',
      sessionRefKey(ref),
      'pi',
      ref.sourceId,
      ref.sessionId,
      ''
    );
    insertRecord(tx, 'links', { ...f.input.link, linkId: 'pi-observed-parent', parentRef: ref });
  });
  const panel = await HudDelegationCollector.open({ HUD_HOME: f.root }, undefined, { publish });
  assert.ok(panel);
  t.after(async () => {
    panel.close();
    await f.close();
  });
  const key = displayNodeKey({ kind: 'session', ref });
  async function collect(until: (view: DelegationViewModel | null) => boolean) {
    let view: DelegationViewModel | null = null;
    for (let i = 0; i < 30; i++) {
      view = await panel!.tick(undefined, performance.now() + 1000);
      if (publish)
        await panel!.afterPaint((updated) => {
          view = updated;
        });
      if (until(view)) return view;
    }
    return view;
  }
  return { ...f, root, file, ref, panel, key, message, collect };
}
test('ordinary collector and actual panel expose Pi source/session usage and coverage without capability promotion', async (t) => {
  const f = await fixture(t);
  const view = await f.collect((v) => !!v?.tree.nodes.find((n) => n.key === f.key)?.observation);
  assert.ok(view);
  const node = view.tree.nodes.find((n) => n.key === f.key)!;
  assert.deepEqual(node.identity, { kind: 'session', ref: f.ref });
  assert.equal(node.observation?.coverage.state, 'complete');
  assert.equal(node.observation?.spent.tokens.value?.input, 20);
  assert.equal(node.observation?.spent.costUsd.value, 0.125);
  assert.equal(view.details[f.key].resumable?.resumable, false);
  assert.deepEqual(new PiAdapter().capabilities, {});
  const frame = draw(view, { width: 120, height: 40, showAll: true, selected: f.key, now: Date.now() });
  const text = frame.lines.map(stripAnsi).join('\n');
  assert.match(text, /pi|π/i);
  assert.ok(!text.includes('PRIVATE_SYNTHETIC_BODY'));
  const input = monitorInput(view, { width: 180, height: 60, selected: f.key, now: Date.now() });
  input.state.preview = 'agent';
  const inspector = inspectorRows(
    input,
    input.state,
    180,
    Date.now(),
    delegationView(view, { nowMs: Date.now(), style: 'compact', showHistory: true })
  )
    .map((row) => stripAnsi(row.text))
    .join('\n');
  assert.ok(inspector.includes(`Source: ${f.ref.sourceId}`));
  assert.match(inspector, /Session: pi · synthetic-pi/);
  assert.match(inspector, /Observation coverage: complete/);
  assert.match(inspector, /Tokens: 20 in · 5 out/);
  assert.match(inspector, /Session cost: \$0.125/);

  fs.appendFileSync(f.file, JSON.stringify(f.message('m2', 30)) + '\n');
  const updated = await f.collect(
    (v) => v?.tree.nodes.find((n) => n.key === f.key)?.observation?.spent.tokens.value?.input === 50
  );
  assert.equal(updated?.tree.nodes.find((n) => n.key === f.key)?.observation?.spent.tokens.value?.input, 50);
});
test('same filename with wrong session header never becomes an observed Pi session', async (t) => {
  const f = await fixture(t, 'other-pi');
  const view = await f.collect(() => false);
  assert.ok(
    !view?.tree.nodes.find((n) => n.key === f.key)?.observation ||
      view.tree.nodes.find((n) => n.key === f.key)?.observation?.coverage.state !== 'complete'
  );
});

test('ordinary Pi publisher uses existing lease/stamp publication and keeps managed resume unavailable', async (t) => {
  const f = await fixture(t, 'synthetic-pi', true);
  const view = await f.collect(
    (v) => !!v?.tree.nodes.find((n) => n.key === f.key)?.observation?.statusProjection.observationStamp
  );
  const node = view?.tree.nodes.find((n) => n.key === f.key);
  assert.ok(node?.observation?.statusProjection.observationStamp);
  assert.deepEqual(node.observation.statusProjection.observationStamp.ref, f.ref);
  assert.equal(node.observation.spent.tokens.value?.input, 20);
  assert.equal(view?.details[f.key].resumable?.reason, 'capability_unverified');
});
