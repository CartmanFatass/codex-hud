import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { writeFileSync, readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import { handshakeFixture, hashClaim } from '../../dist-test/tests/unit/b45-handshake-fixture.js';
import { launchDigest } from '../../dist-test/src/core/run/control.js';
import { RUN_NODE_FLAGS } from '../../dist-test/src/core/run/runtime.js';
import { createRunFactPort } from '../../dist-test/src/core/run/ledger-port.js';
import { readProcess, processState } from '../../dist-test/src/core/run/process.js';
import { acceptIntent } from '../../dist-test/src/ledger/intents.js';
import { ReadOnlyScopeSnapshot } from '../../dist-test/src/core/ledger-scope-read.js';
import { DelegationService } from '../../dist-test/packages/hud-mcp/src/delegation.js';
import { HudMcpServer } from '../../dist-test/packages/hud-mcp/src/server.js';
import { until } from './fixture.mjs';
export async function performanceRun(samples = 1000) {
  const f = await handshakeFixture();
  const input = {
    runId: 'run-real',
    mode: 'headless',
    launch: { argv: [process.execPath, '-e', 'setTimeout(()=>{},600000)'] },
    cwd: f.root,
    sourceId: f.source.sourceId,
    profileDigest: 'a'.repeat(64),
    stdin: 'closed',
    orphanPolicy: 'continue',
  };
  const prepared = structuredClone(f.input),
    at = Date.now(),
    ticket = 'synthetic-perf-ticket';
  prepared.requestKey = 'perf';
  prepared.link.linkId = 'link-real';
  prepared.link.createdAt = at;
  prepared.run = {
    ...prepared.run,
    runId: input.runId,
    linkId: 'link-real',
    createdAt: at,
    launchDigest: launchDigest(input),
    launchTokenHash: hashClaim(ticket),
  };
  prepared.claim = {
    ...prepared.claim,
    runId: input.runId,
    claimHash: hashClaim('synthetic-perf-claim'),
    issuedAt: at,
    expiresAt: at + 1800000,
  };
  await acceptIntent(f.ledger, prepared);
  const child = spawn(process.execPath, [...RUN_NODE_FLAGS, 'bin/hud-run', 'start'], {
    cwd: resolve('.'),
    env: { ...process.env, HUD_HOME: f.root, HUD_RUN_PORT_MODULE: '' },
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  const done = once(child, 'exit');
  let errors = '';
  child.stderr.on('data', (x) => {
    errors += x;
  });
  child.stdin.end(JSON.stringify({ input, ticket }));
  const port = await createRunFactPort(f.root);
  let meta;
  const writers = [];
  const service = new DelegationService({
    ledger: f.ledger,
    home: f.root,
    config: { version: 1, profiles: [] },
    registration: f.parent.registration,
    reader: f.reader,
    capability: { verify: () => ({ ok: false, reason: 'capability_unverified' }) },
    hudRunPath: resolve('bin/hud-run'),
  });
  const scopes = new ReadOnlyScopeSnapshot(join(f.root, 'ledger.sqlite'));
  const source = () => ({
    ok: true,
    callId: 'perf',
    sessionRef: f.parent.ref,
    processKey: f.parent.authority.evidence.processKey,
    evidenceDigest: hashClaim('synthetic-source'),
    scopePremise: scopes.read(f.parent.authority.evidence.processKey),
  });
  const server = new HudMcpServer({ resolve: async () => source() }, service);
  let request = 0;
  const invoke = async (tool) => {
    const start = performance.now();
    const r = await server.handle({
      jsonrpc: '2.0',
      id: ++request,
      method: 'tools/call',
      params: {
        name: tool,
        arguments: tool === 'delegate_cancel' ? { runId: input.runId, grace: 60000 } : { runId: input.runId },
      },
    });
    const bytes = JSON.stringify(r) + '\n'; // response serialization included
    assert.ok(bytes.length > 0);
    return { elapsed: performance.now() - start, outcome: r.result.structuredContent };
  };
  try {
    meta = await until(async () => {
      const s = await port.read(input.runId);
      return s.run.state === 'running' && s.meta;
    });
    for (let i = 0; i < 4; i++) {
      const child = fork(resolve('tests/int/b6-writer.mjs'), [join(f.root, 'ledger.sqlite')], {
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      const done = once(child, 'exit');
      let stderr = '';
      child.stderr.on('data', (x) => {
        stderr += x;
      });
      const ready = Promise.race([
        once(child, 'message'),
        done.then(() => {
          throw new Error('writer exited during startup: ' + stderr);
        }),
      ]);
      writers.push({ child, done, stderr: () => stderr });
      const [message] = await ready;
      if (message.error) throw new Error(message.error);
      console.error('B6 writer ready', i + 1);
    }
    const cursor = f.ledger.snapshot((tx) => Number(tx.get('SELECT max(seq) AS n FROM events').n));
    const changes = f.ledger.snapshot((tx) => tx.get('SELECT total_changes() AS n').n);
    const waitStart = performance.now();
    const waiting = service.invoke(source(), 'delegate_wait', {
      runId: input.runId,
      afterSeq: cursor,
      until: [],
      timeoutMs: 100,
    });
    await service.invoke(source(), 'delegate_status', { runId: input.runId });
    const wait = await waiting;
    assert.equal(wait.timedOut, true);
    assert.equal(wait.nextSeq, cursor);
    assert.equal(wait.events.length, 0);
    assert.equal(
      f.ledger.snapshot((tx) => tx.get('SELECT total_changes() AS n').n),
      changes
    );
    const waitEvidence = {
      fourWriters: true,
      elapsedMs: performance.now() - waitStart,
      events: 0,
      writes: 0,
      cursorUnchanged: true,
    };
    const result = {};
    for (const tool of ['delegate_status', 'delegate_cancel']) {
      console.error('B6 measuring', tool);
      for (let i = 0; i < 50; i++) await invoke(tool);
      const buckets = { success: [], busy: [], refusal: [] };
      for (let i = 0; i < samples; i++) {
        const r = await invoke(tool);
        buckets[r.outcome.ok ? 'success' : r.outcome.code === 'busy' ? 'busy' : 'refusal'].push(r.elapsed);
      }
      result[tool] = Object.fromEntries(
        Object.entries(buckets).map(([kind, values]) => {
          values.sort((a, b) => a - b);
          const percentile = (p) =>
            values.length ? values[Math.min(values.length - 1, Math.floor(p * values.length))] : null;
          return [
            kind,
            {
              n: values.length,
              p50: percentile(0.5),
              p95: percentile(0.95),
              p99: percentile(0.99),
              max: values.at(-1) ?? null,
            },
          ];
        })
      );
      assert.ok(result[tool].success.n > 0);
      assert.ok(result[tool].success.p95 < 50, tool + ' p95 >=50ms');
      assert.equal(result[tool].refusal.n, 0);
    }
    return {
      waitEvidence,
      environment: {
        node: process.version,
        platform: os.platform(),
        release: os.release(),
        cpus: os.cpus().length,
        cpu: os.cpus()[0]?.model,
        memory: os.totalmem(),
        writers: 4,
        samples,
        ledger: 'SQLite WAL FULL',
        revision: 'B6 uncommitted',
      },
      result,
    };
  } finally {
    server.shutdown();
    service.close();
    for (const w of writers) {
      if (w.child.connected) w.child.send('stop');
    }
    for (const w of writers) await w.done;
    for (const stamp of [meta?.scope?.group_leader, meta?.harness])
      if (stamp && processState(stamp) === 'alive') {
        try {
          process.kill(-stamp.pid, 'SIGKILL');
        } catch {}
      }
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await done;
    await port.close();
    await f.close();
  }
}
if (process.argv[1] === resolve('tests/int/b6-performance.mjs'))
  console.log(JSON.stringify(await performanceRun(), null, 2));
