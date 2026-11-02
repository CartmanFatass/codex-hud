import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { PassThrough, Writable } from 'node:stream';
import { HudMcpServer, serveStdio } from '../../packages/hud-mcp/dist/packages/hud-mcp/src/server.js';
import { DelegationService } from '../../dist-test/packages/hud-mcp/src/delegation.js';
import { HandshakeService } from '../../dist-test/packages/hud-mcp/src/handshake.js';
import { delegationBenchmarkFixture } from '../../dist-test/tests/unit/b45-delegation-fixture.js';
import { handshakeFixture, hashClaim } from '../../dist-test/tests/unit/b45-handshake-fixture.js';
import { scopeSnapshot } from '../../dist-test/src/ledger/call-context.js';
import { ledgerRuntimeSupported, loadLedgerSqlite } from '../../dist-test/src/ledger/runtime.js';

// Explicit standalone benchmark: never discovered by normal unit-test globs.
// Uses already-built outputs. Do not rebuild or run other tests during sampling.
const outputFile = process.argv[2];
if (!outputFile) throw new Error('Usage: node tests/int/b45-mcp-stdio-benchmark.mjs OUTPUT.json');
if (!ledgerRuntimeSupported()) throw new Error('Benchmark requires Node 22 >=22.13 or >=24');
const samplesPerOutcome = 200;
const { DatabaseSync } = await loadLedgerSqlite();
const distributions = [];
const startedAt = new Date().toISOString();
const compiledSha256 = Object.fromEntries(
  [
    '../../packages/hud-mcp/dist/packages/hud-mcp/src/server.js',
    '../../dist-test/packages/hud-mcp/src/delegation.js',
    '../../dist-test/packages/hud-mcp/src/handshake.js',
    '../../dist-test/src/ledger/transaction.js',
    '../../dist-test/tests/unit/b45-delegation-fixture.js',
    '../../dist-test/tests/unit/b45-handshake-fixture.js',
  ].map((file) => [
    file,
    createHash('sha256')
      .update(readFileSync(new URL(file, import.meta.url)))
      .digest('hex'),
  ])
);

function stats(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => Number(sorted[Math.ceil(sorted.length * p) - 1].toFixed(3));
  return {
    n: sorted.length,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: Number(sorted.at(-1).toFixed(3)),
    over30Ms: sorted.filter((value) => value > 30).length,
    atLeast50Ms: sorted.filter((value) => value >= 50).length,
  };
}

function counts(f) {
  return f.ledger.snapshot((tx) => ({
    accepted: Number(tx.get("SELECT count(*) AS n FROM events WHERE kind='intent.accepted'").n),
    reports: Number(tx.get('SELECT count(*) AS n FROM reports').n),
    reportRejections: Number(tx.get("SELECT count(*) AS n FROM events WHERE kind='report.rejected'").n),
    launches: f.launches?.length ?? 0,
  }));
}

async function fixture(tool, outcome) {
  if (tool === 'delegate_spawn' || tool === 'delegate_resume') {
    const f = await delegationBenchmarkFixture(outcome !== 'refusal');
    if (tool === 'delegate_resume') await f.bindAndEnd();
    return { ...f, resolveSource: f.source };
  }
  const f = await handshakeFixture();
  try {
    await f.startup();
    const binder = new HandshakeService({
      ledger: f.ledger,
      registration: f.child.registration,
      reader: f.reader,
      env: { HUD_CLAIM: f.claim },
      now: f.now,
    });
    const bound = await binder.whoami({}, f.child.authority);
    assert.equal(bound.ok && bound.state, 'bound');
    const actor = outcome === 'refusal' ? f.parent : f.child;
    const service = new DelegationService({
      ledger: f.ledger,
      home: f.root,
      config: { version: 1, profiles: [] },
      registration: actor.registration,
      reader: f.reader,
      env: { HUD_CLAIM: f.claim, HUD_RUN: 'run-a', HUD_LINK: 'link-a' },
      capability: { verify: () => ({ ok: false, reason: 'test_only_unused_handshake_verifier' }) },
      hudRunPath: resolve('bin/hud-run'),
      launch: async () => {
        throw new Error('synthetic_handshake_must_not_launch');
      },
    });
    return {
      ...f,
      service,
      resolveSource: () => ({
        ok: true,
        callId: 'synthetic-stdio-call-' + performance.now(),
        sessionRef: actor.ref,
        processKey: actor.authority.evidence.processKey,
        evidenceDigest: hashClaim('synthetic stdio current-source proof'),
        scopePremise: f.ledger.snapshot((tx) =>
          scopeSnapshot(tx, f.ledger.ledgerId, actor.authority.evidence.processKey)
        ),
      }),
    };
  } catch (error) {
    await f.close();
    throw error;
  }
}

/** One actual serialized MCP stream pair, with backpressure through the flush callback. */
function stdioClient(f) {
  const input = new PassThrough();
  let active = null;
  let pending = null;
  let nextId = 0;
  let servingError = null;
  const output = new Writable({
    // Every response exceeds this, exercising serveStdio's drain branch.
    highWaterMark: 1,
    write(chunk, _encoding, callback) {
      const bytes = Buffer.from(chunk);
      setImmediate(() => {
        // This is the sink's flush acknowledgement, not merely handle() return.
        const flushedAt = performance.now();
        callback();
        const request = pending;
        pending = null;
        if (request) {
          clearTimeout(request.timer);
          request.resolve({ bytes, flushedAt });
        }
      });
    },
  });
  const server = new HudMcpServer(
    {
      resolve: async () => {
        const start = performance.now();
        try {
          const source = f.resolveSource();
          if (active) active.sourceCalls++;
          return source;
        } finally {
          if (active) active.sourceAdapterMs += performance.now() - start;
        }
      },
    },
    {
      invoke: async (...args) => {
        const start = performance.now();
        try {
          return await f.service.invoke(...args);
        } finally {
          if (active) active.handlerMs += performance.now() - start;
        }
      },
    }
  );
  const serving = serveStdio(server, input, output).catch((error) => {
    servingError = error;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      pending = null;
    }
  });
  return {
    async rpc(method, params, measurement = null) {
      assert.equal(pending, null, 'Requests must be sequential');
      if (servingError) throw servingError;
      active = measurement;
      const id = ++nextId;
      let begin;
      const result = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('stdio_response_deadline_exceeded')), 5000);
        pending = { resolve, reject, timer };
        begin = performance.now();
        input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
      const flushed = await result;
      active = null;
      // Client decode/assertions are outside the requested input-write → flush timer.
      const response = JSON.parse(flushed.bytes.toString('utf8'));
      assert.equal(response.jsonrpc, '2.0');
      assert.equal(response.id, id);
      assert.ok(!response.error, JSON.stringify(response.error));
      return { response, wallMs: flushed.flushedAt - begin };
    },
    async close() {
      input.end();
      await serving;
      await new Promise((resolve) => output.end(resolve));
      if (servingError) throw servingError;
    },
  };
}

async function openClient(f) {
  const client = stdioClient(f);
  await client.rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'synthetic-stdio-benchmark', version: '1' },
  });
  return client;
}

async function measure(f, client, tool, expected, index, blocker) {
  const args =
    tool === 'delegate_whoami'
      ? {}
      : tool === 'delegate_report'
        ? { runId: 'run-a', status: 'completed', summary: 'Synthetic framed benchmark report' }
        : {
            ...(tool === 'delegate_spawn' ? f.spawnArgs : f.resumeArgs),
            request_key: `synthetic-stdio-${tool}-${expected}-${index}`,
          };
  const before = counts(f);
  const metrics = { handlerMs: 0, sourceAdapterMs: 0, sourceCalls: 0, transactionWallMs: 0, transactionCount: 0 };
  const originalTransaction = f.ledger.transaction;
  f.ledger.transaction = function (...args) {
    const begin = performance.now();
    metrics.transactionCount++;
    return originalTransaction.apply(this, args).finally(() => {
      metrics.transactionWallMs += performance.now() - begin;
    });
  };
  let held = false;
  let framed;
  try {
    if (expected === 'busy') {
      blocker.exec('BEGIN IMMEDIATE');
      held = true;
    }
    framed = await client.rpc('tools/call', { name: tool, arguments: args }, metrics);
  } finally {
    if (held) blocker.exec('ROLLBACK');
    f.ledger.transaction = originalTransaction;
  }
  assert.equal(metrics.sourceCalls, 1);
  const result = framed.response.result;
  const value = result.structuredContent;
  assert.deepEqual(JSON.parse(result.content[0].text), value);
  const after = counts(f);
  const noNewExecution = () => {
    assert.equal(after.accepted, before.accepted);
    assert.equal(after.launches, before.launches);
    assert.equal(after.reports, before.reports);
  };
  let actualOutcome = expected;
  if (value.ok === false && value.code === 'busy') {
    assert.equal(result.isError, true);
    noNewExecution();
    assert.equal(after.reportRejections, before.reportRejections);
    if (expected !== 'busy') actualOutcome = 'uncontended_busy';
  } else if (expected === 'success') {
    assert.equal(result.isError, false, JSON.stringify(value));
    assert.equal(value.ok, true, JSON.stringify(value));
    if (tool === 'delegate_spawn' || tool === 'delegate_resume') {
      assert.equal(value.status, 'accepted');
      assert.equal(after.accepted, before.accepted + 1);
      assert.equal(after.launches, before.launches + 1);
      const row = f.ledger.snapshot((tx) => tx.get('SELECT operation,run_seq FROM runs WHERE run_id=?', value.runId));
      assert.equal(row.operation, tool === 'delegate_spawn' ? 'spawn' : 'resume');
      assert.equal(row.run_seq, tool === 'delegate_spawn' ? 1 : 2);
    } else if (tool === 'delegate_whoami') {
      assert.equal(value.state, 'bound');
      assert.equal(value.runId, 'run-a');
      noNewExecution();
    } else {
      assert.equal(value.runId, 'run-a');
      assert.equal(after.reports, before.reports + 1);
    }
  } else {
    assert.notEqual(expected, 'busy', 'A held writer lock must produce busy, never acceptance or another refusal');
    assert.equal(result.isError, true, JSON.stringify(value));
    assert.equal(value.ok, false);
    const allowed =
      tool === 'delegate_whoami'
        ? ['claim_anchor_mismatch']
        : tool === 'delegate_report'
          ? ['unauthorized', 'stale_binding']
          : ['capability_unverified'];
    assert.ok(allowed.includes(value.code), `${tool} unexpected refusal ${JSON.stringify(value)}`);
    noNewExecution();
    if (tool === 'delegate_report') assert.equal(after.reportRejections, before.reportRejections + 1);
  }
  return {
    ...metrics,
    authorizationPlusTransactionMs: metrics.sourceAdapterMs + metrics.handlerMs,
    wallMs: framed.wallMs,
    actualOutcome,
  };
}

function save(complete) {
  const report = {
    schemaVersion: 1,
    kind: 'synthetic_in_process_mcp_stdio',
    complete,
    startedAt,
    generatedAt: new Date().toISOString(),
    runtime: { node: process.versions.node, platform: process.platform, arch: process.arch },
    compiledSha256,
    samplesPerOutcome,
    totalSamples: distributions.reduce((sum, row) => sum + row.mcpStdioRoundtripMs.n, 0),
    totalAttempts: distributions.reduce((sum, row) => sum + row.allAttemptMs.n, 0),
    distributions,
    limitations: [
      'Actual HudMcpServer + serveStdio run over PassThrough input and an asynchronously acknowledged Writable with highWaterMark=1; timing starts before serializing/writing JSON-RPC input and ends at the sink flush callback. This includes framing, argument validation, source-adapter invocation, the real body, response serialization, scheduling and stream backpressure.',
      'In-process streams do not measure kernel pipe transport, a separate CLI process, MCP cold startup, real client transport, vendor resolver I/O, paid model execution or Claude required-hook joint latency.',
      'The source adapter freshly reads scopeSnapshot inside every timed RPC but injects independently consistent synthetic process/session/source facts. It does not invoke the native current-source resolver or read live rollout/Claude hook files.',
      'Capability verification is explicitly test-only; production capability cells remain unverified. Captured synthetic launch callbacks start no harness or supervisor process.',
      'Whoami/report fixtures use real startup/binding APIs with synthetic proof and fixture time before measurement; timed production DelegationService uses real time. Bound whoami tests idempotent recovery of the already-redeemed binding after claim TTL, not fresh redemption latency.',
      'MCP initialize, fixture setup, resume terminal reconciliation, external writer-lock acquisition/release and result assertions are outside timed tool calls. Genuine SQLite lock waits inside authorization are included.',
      'Handler, source adapter and summed ledger transaction wall times are separately instrumented. The authorization+transaction upper bound sums the source-adapter and handler durations for each individual call, including preparation/proof I/O. Transaction wall sums include lock/commit/queue time and instrumentation overhead.',
      'Resume success uses a fresh real SQLite ledger with a properly bound/ended prior run for every attempt; spawn success accumulates independent pending intents in one ledger. Long-history resume scaling is not characterized.',
      'Each bucket collects 200 actual outcomes within 400 attempts. Additional uncontended busy calls are retained explicitly; no warmup tool samples or committed results are relabelled. Timing misses are reported rather than made into a passing timing assertion.',
      'Earlier direct service.invoke reports measure a narrower boundary and do not retroactively demonstrate MCP framing or stdio flush latency.',
    ],
  };
  writeFileSync(outputFile, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  return report;
}

try {
  for (const tool of ['delegate_spawn', 'delegate_resume', 'delegate_whoami', 'delegate_report']) {
    for (const outcome of ['success', 'refusal', 'busy']) {
      const samples = [];
      const attempts = [];
      const extraBusy = [];
      const freshEachAttempt = tool === 'delegate_resume' && outcome === 'success';
      let shared;
      let sharedClient;
      let blocker;
      try {
        if (!freshEachAttempt) {
          shared = await fixture(tool, outcome);
          sharedClient = await openClient(shared);
          if (outcome === 'busy') {
            blocker = new DatabaseSync(join(shared.root, 'ledger.sqlite'));
            blocker.exec('PRAGMA busy_timeout=0');
          }
        }
        for (let attempt = 0; samples.length < samplesPerOutcome && attempt < samplesPerOutcome * 2; attempt++) {
          const f = freshEachAttempt ? await fixture(tool, outcome) : shared;
          const client = freshEachAttempt ? await openClient(f) : sharedClient;
          try {
            const measurement = await measure(f, client, tool, outcome, attempt, blocker);
            attempts.push(measurement);
            if (measurement.actualOutcome === 'uncontended_busy') extraBusy.push(measurement);
            else samples.push(measurement);
          } finally {
            if (freshEachAttempt) {
              await client.close();
              await f.close();
            }
          }
        }
        assert.equal(
          samples.length,
          samplesPerOutcome,
          `${tool}/${outcome}: need 200 actual outcomes within 400 attempts`
        );
        const summary = (field) => stats(samples.map((sample) => sample[field]));
        const row = {
          kind: 'synthetic_in_process_mcp_stdio',
          tool,
          outcome,
          mcpStdioRoundtripMs: summary('wallMs'),
          handlerMs: summary('handlerMs'),
          authorizationPlusTransactionUpperBoundMs: summary('authorizationPlusTransactionMs'),
          sourceAdapterMs: summary('sourceAdapterMs'),
          summedLedgerTransactionWallMs: summary('transactionWallMs'),
          transactionsPerSample: {
            min: Math.min(...samples.map((sample) => sample.transactionCount)),
            max: Math.max(...samples.map((sample) => sample.transactionCount)),
          },
          allAttemptMs: stats(attempts.map((sample) => sample.wallMs)),
          uncontendedBusyAttempts: {
            n: extraBusy.length,
            mcpStdioRoundtripMs: stats(extraBusy.map((sample) => sample.wallMs)),
            handlerMs: stats(extraBusy.map((sample) => sample.handlerMs)),
            summedLedgerTransactionWallMs: stats(extraBusy.map((sample) => sample.transactionWallMs)),
          },
          genuineWriterContention: outcome === 'busy',
          budgetChecks: {
            mcpStdioP95Below50Ms: summary('wallMs').p95 < 50,
            authPlusTxUpperBoundP95AtMost30Ms: summary('authorizationPlusTransactionMs').p95 <= 30,
            authPlusTxUpperBoundEverySampleAtMost30Ms:
              Math.max(...samples.map((sample) => sample.authorizationPlusTransactionMs)) <= 30,
          },
        };
        distributions.push(row);
        save(false);
        process.stdout.write(JSON.stringify(row) + '\n');
      } finally {
        blocker?.close();
        if (sharedClient) await sharedClient.close();
        if (shared) await shared.close();
      }
    }
  }
} catch (error) {
  save(false);
  throw error;
}
const report = save(true);
process.stdout.write(
  JSON.stringify({
    kind: 'synthetic-stdio-summary',
    totalSamples: report.totalSamples,
    totalAttempts: report.totalAttempts,
    output: outputFile,
  }) + '\n'
);
