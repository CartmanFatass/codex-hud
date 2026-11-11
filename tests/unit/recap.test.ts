import { authorizedSyntheticPreview, syntheticRecapScopes } from './b17-fixture.test.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { type RolloutParseResult, type TranscriptEntry } from '../../src/collectors/rollout.js';
import { Briefer } from '../../src/collectors/briefing.js';
import type { SmallModel, ModelRequest } from '../../src/collectors/small-model.js';
import type { SubagentTree, SubagentTreeNode } from '../../src/types.js';

const now = Date.parse('2026-10-01T10:00:00Z');
const at = (seconds: number) => new Date(now + seconds * 1000);
const tree = (nodes: SubagentTreeNode[], rootId = 'root'): SubagentTree => ({
  rootId,
  nodes,
  totalCount: nodes.length,
  updatedAt: new Date(now),
});
const entry = (
  role: TranscriptEntry['role'],
  kind: TranscriptEntry['kind'],
  text: string,
  seconds: number
): TranscriptEntry => ({ role, kind, text, at: at(seconds) });
const mainResult = (extra: Partial<RolloutParseResult> = {}): RolloutParseResult => ({
  session: null,
  toolActivity: { recentCalls: [], totalCalls: 0, callsByType: {}, lastUpdateTime: new Date(now) },
  planProgress: null,
  tokenUsage: null,
  rateLimits: null,
  pendingApproval: null,
  subagents: [],
  compactCount: 0,
  lastCompactTime: null,
  lastToolActivityTime: null,
  lastAssistantMessageTime: null,
  lastEventTime: null,
  workDirs: [],
  transcript: [],
  events: [],
  quotaSamples: [],
  ...extra,
});

/** A model service that records what it was asked and answers at once. */
function fakeModel(reply: string): { model: SmallModel; asked: ModelRequest[] } {
  const asked: ModelRequest[] = [];
  const model = {
    recapScopes: syntheticRecapScopes,
    configure() {},
    submit(request: ModelRequest) {
      request = authorizedSyntheticPreview(request);
      if (request.materialUnchanged)
        return {
          result: Promise.resolve({ ok: false as const, error: 'unchanged', unchanged: true as const }),
          cancel() {},
        };
      asked.push(request);
      return { result: Promise.resolve({ ok: true as const, text: reply }), cancel() {} };
    },
  } as unknown as SmallModel;
  return { model, asked };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));
const REPLY =
  '{"main":{"goal":"Fix the bug","done":["reproduced"],"now":"waiting on reader","needs":""},"overall":"","agents":[]}';

test('turn end runs the recap at once, subject to the interval', async () => {
  const { model, asked } = fakeModel(REPLY);
  const briefer = new Briefer(() => {}, { model });
  const ctx = (main: RolloutParseResult) => ({ scope: 'main' as const, main, floorMs: 900_000 });
  const base = mainResult({
    transcript: [entry('user', 'prompt', 'Fix the bug', -100)],
    lastUserMessageAt: at(-100),
    activity: { state: 'working', updatedAt: at(-100) },
  });
  briefer.update(tree([]), 'api', 60_000, 'en', now, false, ctx(base));
  await settle();
  assert.equal(asked.length, 1, 'scope main runs with no subagents at all');
  assert.equal(asked[0].feature, 'recap');
  assert.match(asked[0].prompt, /^<previous_recap>\nnone\n<\/previous_recap>\n\n<main>/);
  assert.deepEqual(
    briefer.current().recap && {
      goal: briefer.current().recap!.goal,
      coveredUntil: briefer.current().recap!.coveredUntil,
    },
    { goal: 'Fix the bug', coveredUntil: at(-100).getTime() }
  );
  const ended = {
    ...base,
    transcript: [...base.transcript, entry('assistant', 'reply', 'done', 10)],
    lastReplyAt: at(10),
    activity: { state: 'idle' as const, updatedAt: at(11) },
  };
  briefer.update(tree([]), 'api', 60_000, 'en', now + 20_000, false, ctx(ended));
  assert.equal(asked.length, 1, 'within the interval: not yet');
  briefer.update(tree([]), 'api', 60_000, 'en', now + 61_000, false, ctx(ended));
  await settle();
  assert.equal(asked.length, 2, 'turn end fires as soon as the interval allows');
  assert.match(asked[1].prompt, /"goal":"Fix the bug"/, 'the previous recap is handed back');
  assert.doesNotMatch(asked[1].prompt, /user\] Fix the bug/, 'what it covered is not sent again');
  briefer.update(tree([]), 'api', 60_000, 'en', now + 3_600_000, false, ctx(ended));
  assert.equal(asked.length, 2, 'nothing changed: no run, however long');
});
