#!/usr/bin/env node
// Owned, IPC-only helper for p065-budget-benchmark.mjs. Never opens a live HUD home.
import assert from 'node:assert/strict';
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { openLedger } from '../../dist-test/src/ledger/ledger.js';
import { readRun } from '../../dist-test/src/ledger/records.js';
import { createHeartbeatWriter } from '../../dist-test/src/ledger/supervisor.js';
import { openObservationStore } from '../../dist-test/src/core/observation-store.js';
import { checkpointBoundary, witnessObservationBoundary } from '../../dist-test/src/core/checkpoint.js';
import { initialParserState, projectFreshness } from '../../dist-test/src/core/observation.js';

const [sandboxArgument, token] = process.argv.slice(2);
assert.ok(process.send && sandboxArgument && token, 'holder_requires_owned_ipc');
const sandbox = realpathSync(sandboxArgument);
assert.match(basename(sandbox), /^p065-budget-/);
assert.equal(resolve(process.env.HOME ?? ''), sandbox);
assert.equal(resolve(process.env.HUD_HOME ?? ''), sandbox);
assert.equal(resolve(process.env.TMPDIR ?? ''), sandbox);
const marker = join(sandbox, '.p065-owner');
assert.equal(readFileSync(marker, 'utf8'), token);
for (const path of [sandbox, marker]) {
  const stat = lstatSync(path);
  assert.equal(stat.uid, process.getuid?.());
  assert.equal(stat.mode & 0o077, 0);
  assert.equal(stat.isSymbolicLink(), false);
}
const instant = () => performance.timeOrigin + performance.now();
let ledger, blocker, observation, ref, lease, root, writers = [];
let running = false, loop = Promise.resolve(), held = false, holdTimer, stopping = false;
let sequence = 0, metrics = [], missedMetrics = 0, monotonicBase = 0, epochBase = 0;
const append = (row) => {
  // Bound malformed/stalled parent memory. Overflow fails evidence, never drops silently.
  if (metrics.length >= 100000) missedMetrics++;
  else metrics.push(row);
};
const safeError = (error) => String(error?.code ?? error?.message ?? error).replaceAll(sandbox, '<temporary>');
const send = (value) => new Promise((resolveSend, reject) => {
  if (!process.connected) return reject(new Error('holder_parent_disconnected'));
  process.send(value, (error) => error ? reject(error) : resolveSend());
});
function temporary(path) {
  const actual = realpathSync(path);
  const tail = relative(sandbox, actual);
  assert.ok(tail && tail !== '..' && !tail.startsWith('..' + sep) && !tail.startsWith(sep));
  assert.equal(actual, resolve(path), 'holder_refuses_symlink_path');
  const stat = lstatSync(actual);
  assert.equal(stat.uid, process.getuid?.());
  assert.equal(stat.mode & 0o077, 0);
  return actual;
}
function observationCommit(seq) {
  const at = Date.now();
  const stamp = { ref, sourceGeneration: 1, seqDomain: 'p065-storage-load', commitSeq: seq, inputLedgerSeq: null };
  return {
    ref, sourceGeneration: 1, leaseGeneration: lease.generation, seqDomain: stamp.seqDomain,
    commitSeq: seq, observationStamp: stamp,
    checkpoint: {
      schemaVersion: 1, readerVersion: 'p065-synthetic-reader-1', ref,
      fileId: { dev: 1, inode: 2 }, offset: seq * 64, sourceGeneration: 1, parserState: initialParserState(),
    },
    summary: {
      nodeIdentity: { kind: 'session', ref },
      statusProjection: {
        activity: 'working', pendingReason: 'none', lastTurnOutcome: 'none', liveness: 'alive',
        freshness: projectFreshness([], [], at), stateKey: 'working', stateSince: epochBase,
        stateSinceBasis: 'event', isRunTerminal: null, asOfSeq: null, observationStamp: stamp,
        asOf: at, observedAt: at, lastEvidenceAt: at,
      },
      conflict: null,
      spent: {
        tokens: { value: { input: seq, output: 0 }, quality: 'reported', source: 'synthetic', asOf: at },
        costUsd: { value: null, quality: 'unknown', source: 'synthetic', asOf: at },
      },
      workspace: null, coverage: { state: 'complete', skipped: {}, gaps: [], loaded: true },
      loaded: true, depth: 0, evidenceStamp: 'p065-synthetic-' + seq,
    },
    continuity: {
      nodeIdentity: { kind: 'session', ref }, ruleVersion: 'p065-synthetic-1', sourceGeneration: 1,
      episodeAnchor: 'p065-storage', stateKey: 'working', stateSince: epochBase, stateSinceBasis: 'event',
    },
    notices: [{ seq, seqDomain: stamp.seqDomain, created_at: at, ref, kind: 'pending', inputStamp: 'synthetic-' + seq }],
  };
}
async function tick(load) {
  for (const entry of writers) {
    const began = instant();
    try {
      const elapsed = Math.max(1, Math.floor(performance.now() - monotonicBase));
      const result = await entry.writer.tick(epochBase + elapsed, entry.initialMono + elapsed);
      append({ kind: 'heartbeat', runId: entry.runId, began, ended: instant(), result });
      if (!result) throw new Error('heartbeat_cas_lost');
    } catch (error) {
      append({ kind: 'heartbeat_error', runId: entry.runId, began, ended: instant(), error: safeError(error) });
    }
  }
  if (load) {
    const began = instant();
    try {
      lease = observation.renew(ref, lease);
      const commit = observationCommit(sequence + 1);
      const result = observation.publish({
        commit, previousCommitSeq: sequence,
        boundary: witnessObservationBoundary(commit.checkpoint, commit.summary, checkpointBoundary(commit.checkpoint)),
      }, lease);
      assert.equal(result.changed, true);
      sequence = result.commitSeq;
      assert.equal(observation.readProjection(ref).commitSeq, sequence);
      append({ kind: 'observation', began, ended: instant(), result });
    } catch (error) {
      append({ kind: 'observation_error', began, ended: instant(), error: safeError(error) });
    }
  }
}
function release() {
  clearTimeout(holdTimer);
  holdTimer = undefined;
  if (held) {
    blocker.exec('ROLLBACK');
    held = false;
    append({ kind: 'lock_released', at: instant() });
  }
}
async function halt() {
  running = false;
  release();
  await loop;
}
async function close() {
  await halt();
  if (observation) {
    try { observation.release(ref, lease); } finally { observation.close(); }
    observation = undefined;
  }
  blocker?.close();
  blocker = undefined;
  await ledger?.close();
  ledger = undefined;
  writers = [];
}
async function command(message) {
  assert.ok(message && Number.isSafeInteger(message.id));
  const { action } = message;
  if (action === 'configure') {
    await close();
    root = temporary(message.root);
    assert.ok(lstatSync(root).isDirectory());
    const file = temporary(join(root, 'ledger.sqlite'));
    assert.ok(lstatSync(file).isFile());
    assert.equal(lstatSync(file).nlink, 1);
    metrics = []; missedMetrics = 0; sequence = 0;
    ledger = await openLedger(file);
    blocker = new DatabaseSync(file);
    blocker.exec('PRAGMA busy_timeout=0');
    const ids = message.baselineIds;
    assert.ok(Array.isArray(ids) && [1, 10].includes(ids.length) && new Set(ids).size === ids.length);
    epochBase = Date.now(); monotonicBase = performance.now();
    writers = ids.map((runId) => {
      const run = ledger.snapshot((tx) => readRun(tx, runId));
      assert.ok(run.supervisor);
      return {
        runId, initialMono: run.heartbeatMonoMs,
        writer: createHeartbeatWriter(ledger, runId, run.supervisor, run),
      };
    });
    if (message.load) {
      ref = { harness: 'codex', sourceId: message.sourceId, sessionId: 'p065-observation', threadId: null };
      observation = await openObservationStore({ hudHome: root, sourceId: ref.sourceId });
      assert.equal(statSync(observation.databasePath).dev, statSync(file).dev, 'observation_and_ledger_storage_differ');
      lease = observation.acquire(ref, 'p065-owned-holder');
    }
    await tick(Boolean(message.load));
    assert.ok(!metrics.some((row) => row.kind.endsWith('_error')), 'holder_initial_traffic_failed');
    return {
      ready: true, root: relative(sandbox, root), ledgerId: ledger.ledgerId,
      sqlite: blocker.prepare('SELECT sqlite_version() AS v').get().v,
      busyTimeoutMs: Number(blocker.prepare('PRAGMA busy_timeout').get().timeout),
      observationPath: observation ? relative(sandbox, observation.databasePath) : null,
      device: String(statSync(file).dev), baselineIds: ids, readyAt: instant(),
    };
  }
  assert.ok(ledger, 'holder_not_configured');
  if (action === 'cold-cli') {
    assert.equal(running, false);
    assert.equal(held, false);
    // These imports match reusable CLI process initialization. The independently
    // built MCP config/delegation lazy imports remain INSIDE each original clock.
    const initialization = instant();
    const { runCommand } = await import('../../dist/cli/run.js');
    const { privateHome } = await import('../../dist/cli/runtime.js');
    const { CallBudget } = await import('../../dist/ledger/call-budget.js');
    const initializationMs = instant() - initialization;
    assert.ok(typeof message.linkId === 'string' && typeof message.runId === 'string');
    const result = [];
    for (const phase of ['first-request', 'second-request']) {
      const budget = new CallBudget();
      const began = instant();
      const output = [];
      let error = null, exitCode = null;
      try {
        const home = privateHome({ HUD_HOME: root }, budget);
        exitCode = await runCommand([
          'resume', message.linkId, '--request-key', 'p065-cold-cli-' + phase,
          '--expected-run', message.runId, '--mode', 'headless', '--json',
        ], home, {
          env: { HOME: sandbox, HUD_HOME: root, PATH: process.env.PATH },
          stdout: async (text) => { output.push(text); },
          stderr: (text) => { output.push(text); },
        }, {
          budget,
          // Real refusal after production preparation. Never launch a harness,
          // manufacture capability success, or pre-import the MCP writer.
          capability: { verify: () => ({ ok: false, reason: 'capability_unverified' }) },
        });
      } catch (caught) { error = safeError(caught); }
      budget.note('complete');
      const diagnostics = budget.diagnostics();
      result.push({ phase, began, ended: instant(), diagnostics, error, exitCode, output });
    }
    return { initializationMs, result, scope: 'real compiled CLI privateHome/runCommand to independently built MCP; refusal-only capability seam' };
  }
  if (action === 'start') {
    assert.equal(running, false);
    running = true;
    loop = (async () => {
      while (running) { await tick(Boolean(observation)); if (running) await sleep(1); }
    })();
    return { started: true, at: instant() };
  }
  if (action === 'hold') {
    assert.equal(held, false);
    assert.ok(Number.isFinite(message.ms) && message.ms >= 1 && message.ms <= 500);
    blocker.exec('BEGIN IMMEDIATE');
    held = true;
    const acquiredAt = instant();
    append({ kind: 'lock_acquired', at: acquiredAt, requestedMs: message.ms });
    holdTimer = setTimeout(() => { try { release(); } catch (error) { append({ kind: 'release_error', error: safeError(error) }); } }, message.ms);
    return { acquired: true, acquiredAt, requestedMs: message.ms };
  }
  if (action === 'stop') {
    await halt();
    const result = { stopped: true, at: instant(), metrics, missedMetrics, observationCommits: sequence };
    metrics = []; missedMetrics = 0;
    return result;
  }
  if (action === 'close') {
    await close();
    return { closed: true };
  }
  throw new Error('holder_unknown_command');
}
let chain = Promise.resolve();
process.on('message', (message) => {
  chain = chain.then(async () => {
    try { await send({ id: message.id, ok: true, result: await command(message) }); }
    catch (error) { await send({ id: message.id, ok: false, error: safeError(error) }); }
  }).catch(() => shutdown(1));
});
async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  try { await close(); } catch { code = 1; }
  process.exitCode = code;
  if (process.connected) process.disconnect();
}
process.on('disconnect', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(1); });
// A wedged/missing parent can never leave an indefinite writer lock or helper.
setTimeout(() => { void shutdown(1); }, 3_650_000).unref();
await send({ ready: true, pid: process.pid, protocol: 1 });
