import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { notifyFixture } from './b21-fixture.js';
import { insertRecord } from '../../src/ledger/records.js';
import { makeSourceId, sessionRefKey } from '../../src/core/identity.js';
import { createClaudeReader } from '../../src/harness/claude/reader.js';
import { openObservationStore } from '../../src/core/observation-store.js';
import { SessionPublisher } from '../../src/core/link/publisher.js';
import { committedReaderAction, committedReaderProgress } from '../../src/core/link/index.js';
import { PublicationWorker } from '../../src/core/link/publication-worker.js';
import type { PublicationDisplay } from '../../src/core/link/reader-display.js';
import type { CollectedLinkSession } from '../../src/core/link/types.js';
import { HudDelegationCollector } from '../../src/collectors/delegation.js';
import { displayNodeKey } from '../../src/core/observation.js';
import { row, TIME, SESSION } from '../fixtures/claude/transcripts.js';
import { draw, monitorInput } from '../fixtures/b10b-s3.js';
import { delegationView } from '../../src/render/delegation/panel.js';
import { inspectorRows } from '../../src/render/monitor-inspector.js';
import { stripAnsi } from '../../src/render/colors.js';

const launch = () => [
  row('assistant', {
    uuid: 'bash-call-message',
    message: {
      content: [
        { type: 'tool_use', name: 'Bash', id: 'bash-a', input: { command: 'synthetic', run_in_background: true } },
      ],
    },
  }),
  row(
    'user',
    {
      uuid: 'bash-result-message',
      message: { content: [{ type: 'tool_result', tool_use_id: 'bash-a', content: 'Synthetic' }] },
      toolUseResult: { backgroundTaskId: 'task-a', interrupted: false },
    },
    1000
  ),
];
const todo = (empty = false, id = 'todo-a', offset = 2000) => [
  row(
    'assistant',
    {
      uuid: `message-${id}`,
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'TodoWrite',
            id,
            input: {
              todos: empty
                ? []
                : [
                    { content: 'Synthetic done', status: 'completed' },
                    { content: 'Checking synthetic panel', status: 'in_progress' },
                  ],
            },
          },
        ],
      },
    },
    offset
  ),
  row(
    'user',
    { uuid: `result-${id}`, message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'Synthetic' }] } },
    offset + 1000
  ),
];
const finish = () =>
  row(
    'user',
    {
      uuid: 'finish-message',
      origin: { kind: 'task-notification' },
      message: {
        content: '<task-notification><task-id>task-a</task-id><status>completed</status></task-notification>',
      },
    },
    5000
  );
async function fixture(t: test.TestContext) {
  const f = await notifyFixture();
  const root = path.join(f.root, 'synthetic-claude');
  const project = path.join(root, 'projects', 'synthetic-project');
  fs.mkdirSync(project, { recursive: true });
  const file = path.join(project, `${SESSION}.jsonl`);
  const epoch = Date.now() - 10000;
  const retime = (rows: string[]) =>
    rows.map((line) => {
      const value = JSON.parse(line);
      value.timestamp = new Date(epoch + Date.parse(value.timestamp) - TIME).toISOString();
      return JSON.stringify(value);
    });
  fs.writeFileSync(
    file,
    retime([
      ...launch(),
      ...todo(),
      row(
        'assistant',
        {
          uuid: 'synthetic-end',
          message: { content: [{ type: 'text', text: 'Synthetic acknowledged' }], stop_reason: 'end_turn' },
        },
        4000
      ),
    ]).join('\n') + '\n'
  );
  const ref = {
    harness: 'claude' as const,
    sourceId: makeSourceId('claude', root),
    sessionId: SESSION,
    threadId: null,
  };
  fs.writeFileSync(
    path.join(f.root, 'delegate.json'),
    JSON.stringify({
      version: 1,
      profiles: [
        {
          name: 'synthetic-visible',
          harness: 'claude',
          source: { root, label: 'Synthetic' },
          env: {},
          mcpServerName: 'hud',
        },
      ],
    })
  );
  await f.ledger.transaction((tx) => {
    insertRecord(tx, 'sources', { sourceId: ref.sourceId, harness: 'claude', rootPath: root, label: 'Synthetic' });
    tx.run(
      'INSERT INTO sessions(session_ref,harness,source_id,session_id,thread_id) VALUES(?,?,?,?,?)',
      sessionRefKey(ref),
      ref.harness,
      ref.sourceId,
      ref.sessionId,
      ''
    );
    insertRecord(tx, 'links', { ...f.input.link, linkId: 'synthetic-visible-link', parentRef: ref });
  });
  const store = await openObservationStore({ hudHome: f.root, sourceId: ref.sourceId });
  t.after(async () => {
    store.close();
    await f.close();
  });
  return {
    ...f,
    file,
    ref,
    store,
    reader: createClaudeReader({ ref, resolveFile: () => file, serverNames: ['hud'] }),
    append: (rows: string[]) => fs.appendFileSync(file, retime(rows).join('\n') + '\n'),
  };
}

test('D1 live display receipts require this successfully published prepared reading and detach values', async (t) => {
  const f = await fixture(t);
  const publisher = new SessionPublisher(f.store, f.ref, 'synthetic-display');
  t.after(() => publisher.close());
  const now = Date.now();
  assert.equal(publisher.claim(now), 'acquired');
  const read = await f.reader.read({ maxBytes: 4 * 1024 * 1024, maxRecords: 2000, budgetMs: 60000 });
  const facts = {
    target: {
      nodeIdentity: { kind: 'session' as const, ref: f.ref },
      sourceGeneration: read.checkpoint.sourceGeneration,
    },
    sources: [],
    asOfSeq: 0,
    observationStamp: null,
    ledgerFacts: [],
    history: { continuity: 'unknown' as const },
  };
  publisher.capture(read);
  publisher.prepare(facts.target);
  const old = read.evidence.action!.name;
  read.evidence.action!.name = 'Caller mutation';
  read.evidence.progress!.value!.current = 'Caller mutation';
  const committed = publisher.publish(facts, 'display', now)!;
  const action = publisher.committedAction(committed)!;
  const progress = publisher.committedProgress(committed)!;
  assert.equal(action.action.name, old);
  assert.equal(progress.progress.value!.current, 'Checking synthetic panel');
  const session = {
    evidence: { ref: f.ref },
    loaded: true,
    committedOnly: true,
    sourceGeneration: read.checkpoint.sourceGeneration,
    committedAction: action,
    committedProgress: progress,
  } as CollectedLinkSession;
  assert.ok(committedReaderAction(session, committed.summary, now, true));
  assert.ok(committedReaderProgress(session, committed.summary, now, true));
  for (const stamp of [
    { ...progress.stamp, commitSeq: 99 },
    { ...progress.stamp, seqDomain: 'other' },
    { ...progress.stamp, sourceGeneration: 99 },
    { ...progress.stamp, runId: 'other' },
    { ...progress.stamp, bindingGeneration: 99 },
    { ...progress.stamp, inputLedgerSeq: 99 },
    { ...progress.stamp, ref: { ...f.ref, sessionId: 'other' } },
  ]) {
    assert.equal(
      committedReaderProgress({ ...session, committedProgress: { ...progress, stamp } }, committed.summary, now, true),
      undefined
    );
    assert.equal(
      committedReaderAction({ ...session, committedAction: { ...action, stamp } }, committed.summary, now, true),
      undefined
    );
  }
  assert.equal(committedReaderProgress(session, committed.summary, now, false), undefined);
  assert.equal(
    committedReaderProgress(
      { ...session, committedProgress: { ...progress, progress: { ...progress.progress, asOf: now + 1 } } },
      committed.summary,
      now,
      true
    ),
    undefined
  );
  assert.equal(
    committedReaderAction(
      { ...session, committedAction: { ...action, action: { ...action.action, asOf: now + 1 } } },
      committed.summary,
      now,
      true
    ),
    undefined
  );

  assert.equal(committedReaderProgress({ ...session, loaded: false }, committed.summary, now, true), undefined);
  publisher.capture(read);
  publisher.prepare(facts.target);
  assert.equal(
    publisher.committedAction(committed),
    null,
    'preparing identical checkpoint cannot mint an old-commit receipt'
  );
  assert.equal(publisher.committedProgress(committed), null);
  const mock = t.mock.method(f.store, 'publishPrepared', () => {
    throw new Error('synthetic publication rejection');
  });
  assert.throws(() => publisher.publish(facts, 'display', now), /synthetic publication rejection/);
  mock.mock.restore();
  assert.equal(publisher.committedProgress(committed), null);
});

test('D1 ordinary identity-less reader cannot pin a publication generation before the real file', async (t) => {
  const f = await fixture(t);
  const publisher = new SessionPublisher(f.store, f.ref, 'synthetic-placeholder');
  t.after(() => publisher.close());
  const now = Date.now();
  assert.equal(publisher.claim(now), 'acquired');
  const empty = await f.reader.read({ maxBytes: 0, maxRecords: 0, budgetMs: 0 });
  assert.equal(empty.checkpoint.fileId.inode, 0);
  publisher.capture(empty);
  assert.equal(publisher.hasReading(), false);
  assert.equal(publisher.hasPending(), false);
  assert.equal(f.store.readProjection(f.ref), null);
  const read = await f.reader.read({ maxBytes: 4 * 1024 * 1024, maxRecords: 2000, budgetMs: 60000 });
  const facts = {
    target: {
      nodeIdentity: { kind: 'session' as const, ref: f.ref },
      sourceGeneration: read.checkpoint.sourceGeneration,
    },
    sources: [],
    asOfSeq: 0,
    observationStamp: null,
    ledgerFacts: [],
    history: { continuity: 'unknown' as const },
  };
  publisher.capture(read);
  const committed = publisher.publish(facts, 'real-file', now)!;
  assert.equal(committed.commitSeq, 1);
  assert.ok(publisher.committedAction(committed));
});

test('D1 real worker carries exact committed action/Todo to read-only panel and clears completion', async (t) => {
  const f = await fixture(t);
  const panel = await HudDelegationCollector.open({ HUD_HOME: f.root });
  assert.ok(panel);
  t.after(() => panel.close());
  let settle: ((error: string | null, displays: readonly PublicationDisplay[]) => void) | undefined;
  const worker = new PublicationWorker(f.root, undefined, (_changed, error, displays) =>
    settle?.(error, displays ?? [])
  );
  t.after(() => worker.close());
  let receipts: readonly PublicationDisplay[] = [];
  const collect = async () => {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('synthetic display worker timeout')), 8000);
      settle = (error, values) => {
        clearTimeout(timer);
        settle = undefined;
        if (error) reject(new Error(error));
        else {
          receipts = values;
          panel.acceptPublicationDisplays(values);
          resolve();
        }
      };
      worker.request();
    });
    return panel.tick(undefined);
  };
  let view;
  const key = displayNodeKey({ kind: 'session', ref: f.ref });
  for (let i = 0; i < 50; i++) {
    view = await collect();
    if (view?.details[key]?.action && view.details[key]?.progress) break;
  }
  assert.ok(view?.details[key]?.action, JSON.stringify({ receipts, details: view?.details }));
  assert.equal(view.details[key].progress?.value?.done, 1);
  const commit = f.store.readProjection(f.ref)!;
  const delivered = receipts.find((r) => r.stamp.ref.sourceId === f.ref.sourceId)!;
  assert.deepEqual(delivered.checkpointIdentity, commit.checkpointIdentity);
  assert.deepEqual(delivered.stamp, commit.observationStamp);
  const frame = draw(view, { width: 100, height: 40, showAll: true, selected: key, now: Date.now() });
  assert.match(frame.lines.map(stripAnsi).join('\n'), /Bash \(background\)/);
  const input = monitorInput(view, { width: 160, height: 60, selected: key, now: Date.now() });
  input.state.preview = 'agent';
  const displayView = delegationView(view, { nowMs: Date.now(), style: 'compact', showHistory: true });
  const inspector = inspectorRows(input, input.state, 160, Date.now(), displayView)
    .map((r) => stripAnsi(r.text))
    .join('\n');
  assert.match(inspector, /Tasks: 1\/2 · last confirmed/);
  assert.match(inspector, /Current task: Checking synthetic panel/);
  // Consumer must not trust a transported matching stamp with the wrong committed checkpoint identity.
  panel.acceptPublicationDisplays([
    {
      ...delivered,
      checkpointIdentity: {
        ...delivered.checkpointIdentity,
        contentIdentity: '0'.repeat(64) as typeof delivered.checkpointIdentity.contentIdentity,
      },
    },
  ]);
  const wrong = await panel.tick(undefined);
  assert.equal(wrong?.details[key]?.action, undefined);
  assert.equal(wrong?.details[key]?.progress, undefined);
  panel.acceptPublicationDisplays(receipts);
  view = await panel.tick(undefined);
  assert.ok(view?.details[key]?.action);
  panel.acceptPublicationDisplays([{ ...delivered, sourceIdentity: 'different-store-inode' }]);
  view = await panel.tick(undefined);
  assert.equal(view?.details[key]?.action, undefined);
  panel.acceptPublicationDisplays(receipts);
  view = await panel.tick(undefined);
  assert.ok(view?.details[key]?.action);
  panel.acceptPublicationDisplays([]);
  view = await panel.tick(undefined);
  assert.equal(view?.details[key]?.action, undefined);
  assert.equal(view?.details[key]?.progress, undefined);
  assert.doesNotMatch(
    draw(view, { width: 100, height: 40, selected: key, now: Date.now() }).lines.map(stripAnsi).join('\n'),
    /Bash \(background\)/
  );
  panel.acceptPublicationDisplays(receipts);
  view = await panel.tick(undefined);
  assert.ok(view?.details[key]?.action);

  f.append([finish(), ...todo(true, 'todo-empty', 6000)]);
  for (let i = 0; i < 50; i++) {
    view = await collect();
    if (!view?.details[key]?.action && view?.details[key]?.progress?.value?.total === 0) break;
  }
  assert.equal(view?.details[key]?.action, undefined);
  assert.deepEqual(view?.details[key]?.progress?.value, { done: 0, total: 0 });
  assert.ok(panel.acceptPublicationDisplays([]));
  view = await panel.tick(undefined);
  assert.equal(view?.details[key]?.progress, undefined);
  // Known physical reset cannot be undone by a queued old worker receipt or same-head refresh.
  const port = (panel as any).port;
  const reading = port.readings.get(key);
  fs.copyFileSync(f.file, f.file + '.replacement');
  fs.renameSync(f.file + '.replacement', f.file);
  port.begin(Infinity);
  port.pending(f.ref);
  assert.equal(reading.resetPending, true, 'actual inode replacement establishes the reset fence');
  panel.acceptPublicationDisplays(receipts);
  port.begin(Infinity);
  const fenced = port.sessions().find((entry: CollectedLinkSession) => entry.evidence.ref.sourceId === f.ref.sourceId);
  assert.equal(fenced?.loaded, false);
  assert.equal(fenced?.committedProgress, undefined);
  assert.equal(fenced?.committedAction, undefined);
  assert.equal(await worker.close(), true);
});
