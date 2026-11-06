import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MeteredCodexTopology } from '../../src/core/link/native-topology.js';
import { projectLinkTree } from '../../src/core/link/index.js';
import { initialParserState } from '../../src/core/observation.js';
import { makeSourceId } from '../../src/core/identity.js';
import type { CollectedLinkSession } from '../../src/core/link/types.js';
import { JsonVersion, sessionMemoInput } from '../../src/core/link/memo.js';

test('B10C production rollout header supplies native title without another read; absent local kind stays null', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'hud-b10c-native-'));
  const dir = join(home, 'sessions');
  mkdirSync(dir);
  const catalog = new MeteredCodexTopology(home);
  t.after(() => {
    catalog.close();
    rmSync(home, { recursive: true, force: true });
  });
  const ref = {
    harness: 'codex' as const,
    sourceId: makeSourceId('codex', home),
    sessionId: 'synthetic-root',
    threadId: null,
  };
  const header = (id: string, extra = {}) =>
    JSON.stringify({ type: 'session_meta', timestamp: '2026-11-02T12:00:00Z', payload: { id, ...extra } }) + '\n';
  writeFileSync(join(dir, 'root.jsonl'), header(ref.sessionId));
  writeFileSync(
    join(dir, 'child.jsonl'),
    header('synthetic-child', {
      parent_thread_id: ref.sessionId,
      source: {
        subagent: {
          thread_spawn: { agent_path: '/root/audit/check_paths', agent_nickname: 'Nick', agent_role: 'explorer' },
        },
      },
    })
  );
  let topology = await catalog.collect(ref, { maxBytes: 4 * 1024 * 1024, maxRecords: 2000, budgetMs: 20 });
  for (let i = 0; !topology.loaded && i < 100; i++)
    topology = await catalog.collect(ref, { maxBytes: 4 * 1024 * 1024, maxRecords: 2000, budgetMs: 20 });
  assert.equal(topology.loaded, true);
  assert.deepEqual(topology.nativeMetadata!['synthetic-child'], {
    title: 'check_paths',
    kind: null,
    pickerLabel: '/root/audit/check_paths',
  });
  const view = {
    nodeIdentity: { kind: 'session', ref },
    statusProjection: { lastEvidenceAt: 1000 },
    coverage: { state: 'complete', skipped: {}, gaps: [], loaded: true },
  };
  const session = {
    evidence: { ref, observation: view, linkEvidence: [] },
    sourceGeneration: 1,
    linkEvidenceCurrent: true,
    loaded: true,
    bytesRead: 0,
    recordsRead: 0,
    topology: { ...topology, ref, sourceGeneration: 1 },
  } as unknown as CollectedLinkSession;
  const tree = projectLinkTree({
    ledger: { state: 'degraded', snapshot: null, reason: 'synthetic' },
    roots: [{ kind: 'session', ref }],
    sessions: [session],
    nowMs: 1000,
  });
  assert.equal(tree.nodes[0].native, null);
  assert.deepEqual(tree.nodes[1].native, {
    title: 'check_paths',
    kind: null,
    pickerLabel: '/root/audit/check_paths',
  });
  const memo = new JsonVersion();
  const before = memo.update(sessionMemoInput(session));
  session.topology!.nativeMetadata = { 'synthetic-child': { title: 'renamed', kind: 'review' } };
  assert.notEqual(memo.update(sessionMemoInput(session)), before);
  // The catalog's only read is the already charged header path.
  const again = await catalog.collect(ref, { maxBytes: 4 * 1024 * 1024, maxRecords: 2000, budgetMs: 20 });
  assert.equal(again.bytesRead, 0);
  assert.deepEqual(initialParserState().pendingBytes, []);
});
