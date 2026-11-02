import test from 'node:test';
import assert from 'node:assert/strict';
import { openLedger, type Ledger } from '../../src/ledger/ledger.js';
import { insertRecord } from '../../src/ledger/records.js';
import { authorizeRootCall, scopeSnapshot } from '../../src/ledger/call-context.js';
import { currentAuthority } from '../../src/ledger/intents.js';
import { HudMcpServer } from '../../packages/hud-mcp/src/server.js';
import type { CallResolution } from '../../packages/hud-mcp/src/resolvers.js';

const sid = 'a'.repeat(64),
  processKey = JSON.stringify(['codex', sid, 'synthetic-domain', 41001, 'start']);
const ref = (id: string) => ({ harness: 'codex' as const, sourceId: sid, sessionId: id, threadId: null });
async function fixture() {
  const ledger = await openLedger(':memory:');
  await ledger.transaction((tx) => {
    insertRecord(tx, 'sources', { sourceId: sid, harness: 'codex', rootPath: '/synthetic/source', label: 'Synthetic' });
    for (const callerId of ['one', 'two'])
      insertRecord(tx, 'callers', {
        callerId,
        instanceKind: 'dedicated',
        harness: 'codex',
        sourceId: sid,
        pid: 41002,
        procStart: 'mcp-start',
        ppid: 41001,
        parentProcStart: 'start',
        cwd: '/synthetic/work',
        envPane: null,
        startedAt: 1,
        lastSeenAt: 1,
        retiredAt: null,
      });
  });
  return ledger;
}
function call(ledger: Ledger, id: string, callerId = 'one') {
  return {
    callerId,
    processKey,
    sessionRef: ref(id),
    evidenceDigest: 'b'.repeat(64),
    premise: ledger.snapshot((tx) => scopeSnapshot(tx, ledger.ledgerId, processKey)),
    at: Date.now(),
  };
}
test('refuse-first missing ambiguous stale source and native-child never invoke authorization or a tool', async () => {
  let calls = 0;
  for (const code of ['identity_source_missing', 'identity_unverified', 'stale_context', 'unsupported'] as const) {
    const server = new HudMcpServer(
      { resolve: async () => ({ ok: false, code }) },
      {
        invoke: async () => {
          calls++;
          throw new Error('body');
        },
      }
    );
    const result = (await server.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'delegate_whoami', arguments: { claim: 'synthetic' } },
    })) as { result: { structuredContent: unknown } };
    assert.deepEqual(result.result.structuredContent, { ok: false, code });
  }
  assert.equal(calls, 0);
});
test('dual MCP instance shares scope and owner; stale first-bind CAS refuses', async () => {
  const ledger = await fixture();
  try {
    const first = call(ledger, 'A'),
      loser = call(ledger, 'A', 'two');
    const a = await authorizeRootCall(ledger, first);
    await assert.rejects(authorizeRootCall(ledger, loser), /stale_context/);
    const b = await authorizeRootCall(ledger, call(ledger, 'A', 'two'));
    assert.equal(a.generation, b.generation);
    assert.notEqual(a.contextId, b.contextId);
    const owners = await ledger.transaction((tx) => [currentAuthority(tx, a), currentAuthority(tx, b)]);
    assert.deepEqual(
      owners.map((o) => (o.kind === 'mcp' && o.selection.ok ? o.selection.ownerKey : null)),
      Array(2).fill(JSON.stringify(['session', JSON.stringify(['codex', sid, 'A', null])]))
    );
    assert.equal(
      ledger.snapshot((tx) => tx.all('SELECT * FROM caller_scopes WHERE closed_at IS NULL').length),
      1
    );
  } finally {
    await ledger.close();
  }
});
test('/clear rekeys shared generation; in-flight old authority and A→B→A evidence cannot revive A', async () => {
  const ledger = await fixture();
  try {
    const a = await authorizeRootCall(ledger, call(ledger, 'A'));
    const oldSource = call(ledger, 'A', 'two');
    const b = await authorizeRootCall(ledger, call(ledger, 'B'));
    assert.equal(b.generation, 2);
    await assert.rejects(
      ledger.transaction((tx) => currentAuthority(tx, a)),
      /stale_context/
    );
    await assert.rejects(authorizeRootCall(ledger, oldSource), /stale_context/);
    await assert.rejects(authorizeRootCall(ledger, call(ledger, 'A', 'two')), /stale_context/);
    assert.equal((await authorizeRootCall(ledger, call(ledger, 'B', 'two'))).generation, 2);
    assert.equal(
      ledger.snapshot((tx) => tx.all('SELECT * FROM caller_scopes').length),
      2
    );
  } finally {
    await ledger.close();
  }
});
test('wrong generation is refused before currentAuthority can authorize an intent', async () => {
  const ledger = await fixture();
  try {
    const a = await authorizeRootCall(ledger, call(ledger, 'A'));
    await assert.rejects(
      ledger.transaction((tx) => currentAuthority(tx, { ...a, generation: 42 })),
      /context_not_found|stale_context/
    );
    assert.equal(
      ledger.snapshot((tx) => tx.all('SELECT * FROM idempotency').length),
      0
    );
    assert.equal(
      ledger.snapshot((tx) => tx.all('SELECT * FROM claims').length),
      0
    );
  } finally {
    await ledger.close();
  }
});
