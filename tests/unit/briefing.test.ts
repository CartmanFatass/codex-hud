import { SyntheticModel as SmallModel } from './b17-fixture.test.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Briefer } from '../../src/collectors/briefing.js';
import type { SubagentTree, SubagentTreeNode } from '../../src/types.js';

const now = Date.parse('2026-10-01T10:00:00Z');
const node = (
  id: string,
  name: string,
  status: SubagentTreeNode['status'],
  extra: Partial<SubagentTreeNode> = {}
): SubagentTreeNode => ({ id, name, status, depth: 1, children: [], ...extra });
const tree = (nodes: SubagentTreeNode[], rootId = 'root'): SubagentTree => ({
  rootId,
  nodes,
  totalCount: nodes.length,
  updatedAt: new Date(now),
});

/** Exercise the shared service without binaries, environment changes or network calls. */
function stubModel(reply: string) {
  const asked: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  const response = { status: 200 };
  const model = new SmallModel({
    env: {},
    fetch: (async (_url, init) => {
      asked.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify(
          response.status === 200
            ? { choices: [{ message: { content: reply } }] }
            : {
                error: { message: 'quota exceeded SYNTHETIC_SECRET_BACKEND_QUOTA /private/path?token=synthetic-token' },
              }
        ),
        { status: response.status }
      );
    }) as typeof fetch,
  });
  model.configure({ api: { base: '', model: 'test-model', key: '' } });
  return { model, asked, response };
}

test('a Briefer runs once per change, waits out its interval, and reports a failed run', async () => {
  const { model, asked, response } = stubModel('\x1b[1m{"overall":"worker 正在核对","agents":[]}\x1b[0m\n');
  let changed = 0;
  const briefer = new Briefer(
    () => {
      changed++;
    },
    { model }
  );
  const settle = () =>
    new Promise<void>((resolve) => {
      const poll = () => (briefer.current().running ? setTimeout(poll, 10) : resolve());
      poll();
    });
  const count = () => asked.length;
  const worker = node('c', 'worker', 'running', {
    stages: [{ startedAt: new Date(now - 60_000), status: 'running' }],
    stageCount: 1,
    lastReport: { text: 'one', kind: 'update', at: new Date(now) },
  });
  briefer.update(tree([worker]), 'api', 60_000, 'zh', now);
  assert.equal(briefer.current().running, true);
  await settle();
  assert.equal(briefer.current().overall, 'worker 正在核对', 'colour codes around the JSON are dropped');
  assert.ok(changed >= 2);
  briefer.update(tree([worker]), 'api', 60_000, 'zh', now + 120_000);
  const updated = { ...worker, lastReport: { text: 'two', kind: 'update' as const, at: new Date(now + 1) } };
  briefer.update(tree([updated]), 'api', 60_000, 'zh', now + 130_000);
  assert.equal(count(), 1, 'the same material, or commentary alone before the floor: no call');
  const ended = {
    ...updated,
    status: 'completed' as const,
    statusAt: new Date(now + 2000),
    stages: [
      { startedAt: new Date(now - 60_000), endedAt: new Date(now + 2000), status: 'done' as const, result: 'Found it' },
    ],
  };
  briefer.update(tree([ended]), 'api', 60_000, 'zh', now + 1000);
  assert.equal(count(), 1, 'a stage that ended, too soon: no call');

  response.status = 429;
  briefer.update(tree([ended]), 'api', 60_000, 'zh', now + 140_000);
  await settle();
  assert.match(briefer.current().error ?? '', /api HTTP 429: Rate limited/);
  assert.doesNotMatch(
    briefer.current().error ?? '',
    /SYNTHETIC_SECRET_BACKEND_QUOTA|private\/path|synthetic-token|quota exceeded/
  );
  assert.equal(briefer.current().overall, 'worker 正在核对', 'a failure keeps the last brief');
  response.status = 200;
  briefer.update(tree([ended]), 'api', 60_000, 'zh', now + 240_000);
  await settle();
  assert.equal(briefer.current().error, undefined, 'the same material is tried again after a failure');

  briefer.update(tree([ended], 'other-session'), 'api', 60_000, 'zh', now + 250_000);
  assert.equal(briefer.current().overall, undefined, 'another session starts from an empty brief');
  await settle();
  briefer.update(tree([ended], 'other-session'), 'off', 60_000, 'zh', now + 400_000);
  assert.deepEqual(briefer.current(), {});
});
