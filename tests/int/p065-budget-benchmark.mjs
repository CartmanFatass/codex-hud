#!/usr/bin/env node
/**
 * P065 standalone evidence driver. Uses already-built outputs; never builds or
 * discovers tests. Default is the complete declared matrix, not a smoke mode.
 *
 * node tests/int/p065-budget-benchmark.mjs OUTPUT.json
 *
 * Run three isolated series on each supported Node family. This file does not
 * claim six-run or formal WSL/Claude qualification from one invocation.
 */
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fork, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync, closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync,
  readFileSync, readdirSync, realpathSync, rmSync, statfsSync, statSync, writeFileSync,
} from 'node:fs';
import { availableParallelism, cpus, freemem, hostname, release, tmpdir, totalmem, type } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { PassThrough, Writable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const bootAt = performance.now();
const instant = () => performance.timeOrigin + performance.now();
const self = fileURLToPath(import.meta.url);
const repository = resolve(dirname(self), '../..');
const outputFile = process.argv[2] ? resolve(process.argv[2]) : null;
assert.ok(outputFile, 'Usage: node tests/int/p065-budget-benchmark.mjs OUTPUT.json');
assert.equal(process.argv.length, 3, 'No reduced-population or hidden qualification switches');
const [major, minor] = process.versions.node.split('.').map(Number);
assert.ok((major === 22 && minor >= 13) || major === 24, 'Requires Node 22 >=22.13 or Node 24');
const WARMUPS = 50, MEASURED = 1000, RESPONSE_MS = 5000, HELPER_MS = 10000, OUTER_MS = 3_600_000;
const tools = ['delegate_status', 'delegate_spawn', 'delegate_resume', 'delegate_cancel', 'delegate_whoami', 'delegate_report'];
const profiles = [{ h: 1, r: 1 }, { h: 2, r: 10 }];
const operational = ['first-use', 'success', 'refusal', 'short-lock', 'long-lock', 'queued-expiry', 'storage-load', 'response-loss'];
const forced = ['callback-overrun', 'commit-overrun', 'commit-uncertain'];
const planned = profiles.flatMap((profile) => tools.flatMap((tool) => [
  ...operational.map((scenario) => ({ ...profile, tool, scenario, bank: 'operational' })),
  ...(tool === 'delegate_status' ? [] : forced.map((scenario) => ({ ...profile, tool, scenario, bank: 'forced' }))),
])).map((cell) => ({ ...cell, id: [cell.h, cell.r, cell.tool, cell.scenario].join('/'), warmups: WARMUPS, measured: MEASURED,
  lossCoverageRequired: cell.scenario === 'response-loss' ? {
    successfulLostMeasuredPerParticipant: 1,
    checkedRecoveryMeasuredPerParticipant: cell.tool === 'delegate_report' ? 0 : 1,
    durableInspectionMeasuredPerParticipant: 1,
  } : null,
}));
const startedAt = new Date().toISOString();
const sandbox = mkdtempSync(join(tmpdir(), 'p065-budget-'));
const token = randomUUID();
writeFileSync(join(sandbox, '.p065-owner'), token, { mode: 0o600 });
const originalEnv = { ...process.env };
const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(HUD_|CODEX_|CLAUDE|PI_|HERDR|TMUX|STY|NODE_OPTIONS|NO_COLOR|FORCE_COLOR|XDG_)/.test(key)
  && !/(TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL|AUTH)/i.test(key)
));
Object.assign(childEnv, { HOME: sandbox, HUD_HOME: sandbox, TMPDIR: sandbox, TMP: sandbox, TEMP: sandbox });
for (const key of Object.keys(process.env)) {
  if (/^(HUD_|CODEX_|CLAUDE|PI_|HERDR|TMUX|STY|NODE_OPTIONS|NO_COLOR|FORCE_COLOR|XDG_)/.test(key)) delete process.env[key];
}
Object.assign(process.env, { HOME: sandbox, HUD_HOME: sandbox, TMPDIR: sandbox, TMP: sandbox, TEMP: sandbox });
assert.equal(tmpdir(), sandbox);
const rawFile = outputFile + '.samples.jsonl';
const supportFile = outputFile + '.support.jsonl';
const distributions = [];
const failures = [];
const coldCli = [];
let calls = 0, stopped = false, fixtureOrdinal = 0, helper, current = null;
let moduleStartupMs = null, sqliteVersion = null;
const redact = (value) => JSON.parse(JSON.stringify(value, (_key, item) =>
  typeof item === 'bigint' ? String(item) : typeof item === 'string' ? item.replaceAll(sandbox, '<temporary>') : item
));
const errorText = (error) => String(error?.stack ?? error).replaceAll(sandbox, '<temporary>');
const raw = (row) => appendFileSync(rawFile, JSON.stringify(redact(row)) + '\n', { mode: 0o600 });
const support = (row) => appendFileSync(supportFile, JSON.stringify(redact(row)) + '\n', { mode: 0o600 });
const checkOuter = () => {
  if (stopped || performance.now() - bootAt >= OUTER_MS) throw new Error('p065_outer_timeout_incomplete');
};
function readOptional(path) { try { return readFileSync(path, 'utf8').trim(); } catch { return 'unavailable'; } }
function git(...args) {
  return execFileSync('git', ['--no-optional-locks', ...args], { cwd: repository, encoding: 'utf8', timeout: 5000, env: childEnv }).trim();
}
function digestFile(path) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
function hashTree(root) {
  const entries = {};
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && /\.(js|json)$/.test(entry.name)) entries[relative(repository, path)] = digestFile(path);
      else if (entry.isSymbolicLink()) throw new Error('compiled_output_symlink');
    }
  };
  visit(root);
  return entries;
}
function stats(values) {
  if (!values.length) return { n: 0, p50: null, p95: null, p99: null, max: null, over30Count: 0, over30MaximumMs: null };
  assert.ok(values.every(Number.isFinite), 'nonfinite_timing');
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (fraction) => sorted[Math.ceil(sorted.length * fraction) - 1];
  const overs = sorted.filter((value) => value > 30);
  return {
    n: sorted.length, p50: rank(.5), p95: rank(.95), p99: rank(.99), max: sorted.at(-1),
    over30Count: overs.length, over30MaximumMs: overs.length ? overs.at(-1) : null,
  };
}
let identity;
let checkerControls = { executed: false, passed: false, checks: [], scope: 'pure evidence-checker controls only; never benchmark samples or performance evidence' };
function snapshotReport(complete = false) {
  const coldCliComplete = coldCli.length === profiles.length && coldCli.every((entry) => entry.samples.length === 2 && entry.semantic && entry.samples.every(validColdTiming));
  const coldCliNumerical = coldCliComplete && coldCli.every((entry) => entry.samples.every((sample) =>
    validColdTiming(sample) && sample.diagnostics.authorizationMs <= 30 && sample.diagnostics.waitMs <= 20));
  const populationComplete = complete && checkerControls.passed && coldCliComplete && distributions.length === planned.length &&
    distributions.every((row) => row.warmups === WARMUPS && row.measured === MEASURED && row.complete);
  const operationalNumericalQualification = populationComplete && checkerControls.passed && coldCliNumerical &&
    distributions.every((row) => row.operationalNumerical && row.operationalSemantics);
  const forcedControlSemanticCompletion = populationComplete &&
    distributions.filter((row) => row.bank === 'forced').every((row) => row.semantics);
  const inclusiveAllSamplesNumericalStatus = populationComplete && coldCliNumerical && distributions.every((row) => row.numerical);
  const report = {
    schemaVersion: 2, kind: 'p065-real-sqlite-synthetic-cloud-surrogate',
    startedAt, endedAt: new Date().toISOString(), complete, populationComplete, calls, planned,
    identity, sqliteVersion, moduleStartupMs, checkerControls, distributions, failures, coldCli, coldCliComplete, coldCliNumerical,
    resourceUsage: process.resourceUsage(), freeMemoryAtSnapshot: freemem(), cpuStatAtSnapshot: readOptional('/sys/fs/cgroup/cpu.stat'),
    results: {
      operationalNumericalQualification, forcedControlSemanticCompletion, inclusiveAllSamplesNumericalStatus,
      overallQualified: inclusiveAllSamplesNumericalStatus && forcedControlSemanticCompletion && failures.length === 0,
      acceptanceChecks: operationalNumericalQualification && forcedControlSemanticCompletion && failures.length === 0,
    },
    settings: {
      warmups: WARMUPS, measured: MEASURED, responseDeadlineMs: RESPONSE_MS, holderDeadlineMs: HELPER_MS,
      outerDeadlineMs: OUTER_MS, ledgerBusyTimeoutMs: 0, writeWallBoundMs: 30, cumulativeWaitBoundMs: 20,
      responseP95StrictlyBelowMs: 50, responseGateScopes: ['allAttempts', 'primaryMeasured', 'primaryWarmups', 'recoveryMeasured', 'recoveryWarmups'],
      numericalExemption: 'only evidenced deliberate 40 ms callback/COMMIT overruns; zero-delay commit uncertainty stays operational', shortLockMs: 5, longLockMs: 100, forcedSynchronousDelayMs: 40,
      limits: { maxActiveRuns: 12, maxActiveRunsPerOwner: 12 }, scenarioOrder: 'profile, tool, listed scenario, warmups, measured',
    },
    artifacts: { samples: basename(rawFile), support: basename(supportFile) },
    scope: [
      'Actual HudMcpServer/serveStdio frames and asynchronous Writable callback acknowledgement. H=2 means two registered server/stream compositions in one OS process, not two real harnesses.',
      'R is valid baseline active runs with slots, claims, supervisor registrations and real heartbeat CAS. Fresh fixture per wave; foreground spawn/resume can increase active count from R to R+H.',
      'Source snapshots and process/session facts are visibly synthetic; current authority and production ledger checks still execute. Capability and launch seams are the approved synthetic fixture, not real harness or capability evidence.',
      'Real production monotonic clock and SQLite. Status has no P065 write deadline; full-response p95<50 ms still applies. No subtraction of injection time or removal of busy/refused/slow samples.',
      'First-use means new private store and new server/service caches. Fresh-process compiled CLI refusal probes separately retain first and second requests with original privateHome/runCommand timing, including lazy MCP imports. They do not claim positive capability, real harness launch, OS page-cache eviction, or complete cold-path safety coverage.',
      'Forced controls are predeclared and sequentially isolated across H participants. Operational H=2 waves issue both frames before awaiting either response. All attempts, warmups, recoveries and failed/uncompleted calls are retained.',
      'Response loss discards actual flushed response bytes at the client. Canonical spawn/resume/cancel/whoami recovery and read-only status are checked only after independent durable inspection; a lost report is inspected and never automatically resubmitted. Unknown COMMIT uses a fresh connection, without redispatch.',
      'Observation load uses accepted source-local ObservationStore publish/lease APIs on the same filesystem/device, separate from the ledger. No B10D code.',
      'One invocation is one host-labeled series. Three isolated series each on exact Node 22 and 24 remain required. No real-Claude joint 150 ms, formal WSL, Herdr/tmux, B14 or capability qualification is implied.',
      'Phase intervals are production checkpoints, not kernel-only CPU/lock durations. Transaction traces retain actual BEGIN/COMMIT/ROLLBACK intervals. Wait includes queue and acquisition/backoff; backoff is separately observed without changing the clock.',
    ],
  };
  writeFileSync(outputFile, JSON.stringify(redact(report), null, 2) + '\n', { mode: 0o600 });
  return report;
}
function ownedHelper() {
  const child = fork(join(repository, 'tests/int/p065-ledger-holder.mjs'), [sandbox, token], {
    cwd: repository, execPath: process.execPath, env: childEnv, execArgv: [],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let next = 0, exited = false, readyResolve, readyReject, stderr = '', stdout = '';
  const pending = new Map();
  const ready = new Promise((yes, no) => { readyResolve = yes; readyReject = no; });
  const readyTimer = setTimeout(() => readyReject(new Error('holder_ready_timeout')), HELPER_MS);
  child.stdout.on('data', (chunk) => { stdout += chunk; if (stdout.length > 1000000) child.kill('SIGTERM'); });
  child.stderr.on('data', (chunk) => { stderr += chunk; if (stderr.length > 1000000) child.kill('SIGTERM'); });
  child.on('error', (error) => { readyReject(error); for (const p of pending.values()) p.reject(error); });
  const done = new Promise((resolveDone) => child.once('exit', (code, signal) => {
    exited = true;
    clearTimeout(readyTimer);
    const error = new Error('holder_exited:' + code + ':' + signal);
    readyReject(error);
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); }
    pending.clear();
    support({ kind: 'holder_exit', code, signal, stdout, stderr });
    resolveDone({ code, signal });
  }));
  child.on('message', (message) => {
    if (message.ready) { clearTimeout(readyTimer); readyResolve(message); return; }
    const p = pending.get(message.id);
    if (!p) return;
    pending.delete(message.id); clearTimeout(p.timer);
    if (message.ok) p.resolve(message.result); else p.reject(new Error(message.error));
  });
  return {
    ready,
    async request(action, fields = {}) {
      checkOuter();
      await ready;
      if (exited) throw new Error('holder_unavailable');
      const id = ++next;
      return new Promise((resolveRequest, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('holder_command_timeout:' + action));
        }, HELPER_MS);
        pending.set(id, { resolve: resolveRequest, reject, timer });
        child.send({ id, action, ...fields }, (error) => {
          if (error) { clearTimeout(timer); pending.delete(id); reject(error); }
        });
      });
    },
    async close() {
      if (!exited) child.kill('SIGTERM');
      const timer = setTimeout(() => { if (!exited) child.kill('SIGKILL'); }, 2000);
      try { await done; } finally { clearTimeout(timer); }
    },
  };
}
let HudMcpServer, serveStdio, DelegationService, scopeSnapshot, p065WorkloadFixture, openLedger, monotonicClock;
function framedClient(f, index, readLedger, service, mode) {
  const input = new PassThrough();
  let nextId = 0, pending = null, observed = null, servingError = null;
  const output = new Writable({
    highWaterMark: 1,
    write(chunk, _encoding, callback) {
      const bytes = Buffer.from(chunk);
      setImmediate(() => {
        const flushedAt = instant();
        const item = pending;
        callback(); // Production server.flushed observes this exact callback.
        if (item) {
          pending = null; clearTimeout(item.timer);
          item.resolve({ bytes: item.lose ? null : bytes, serverOutcome: JSON.parse(bytes.toString('utf8')).result?.structuredContent ?? null,
            discardedBytes: item.lose ? bytes.length : 0, flushedAt, diagnostics: observed });
        }
      });
    },
  });
  const source = {
    async resolve() {
      const actor = f.actors[index];
      const premise = await readLedger.readSnapshot((tx) => scopeSnapshot(tx, readLedger.ledgerId, actor.authority.evidence.processKey));
      return {
        ok: true, callId: 'p065-' + randomUUID(), sessionRef: mode === 'refusal' ? { ...actor.ref, sourceId: actor.ref.sourceId === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64) } : actor.ref,
        processKey: actor.authority.evidence.processKey,
        evidenceDigest: createHash('sha256').update('synthetic current P065 source').digest('hex'),
        scopePremise: premise,
      };
    },
  };
  let measurement = null;
  const bodies = {
    invoke: (...args) => callScope.run(measurement, () => {
      const budget = args[5];
      if (budget && measurement) {
        const backoff = budget.backoff.bind(budget);
        budget.backoff = async (ms) => {
          const began = instant();
          try { return await backoff(ms); }
          finally { measurement.backoffs.push({ requestedMs: ms, began, ended: instant() }); }
        };
      }
      return service.invoke(...args);
    }),
    decorateFailure: (...args) => service.decorateFailure(...args),
  };
  const server = new HudMcpServer(source, bodies, () => true, {
    // Real immutable production clock, never a fake now()/shortened sleep().
    clock: monotonicClock, observe: (sample) => { observed = sample; },
  });
  const serving = serveStdio(server, input, output).catch((error) => {
    servingError = error;
    if (pending) { clearTimeout(pending.timer); pending.reject(error); pending = null; }
  });
  return {
    busyTimeoutMs: Number(service.options.ledger.db.prepare('PRAGMA busy_timeout').get().timeout),
    setMeasurement(value) { measurement = value; },
    async rpc(method, params, lose = false) {
      assert.equal(pending, null);
      if (servingError) throw servingError;
      observed = null;
      const id = ++nextId, began = instant();
      const response = await new Promise((yes, no) => {
        const timer = setTimeout(() => {
          pending = null;
          no(new Error('framed_response_timeout'));
          server.shutdown(); input.destroy(); output.destroy();
        }, RESPONSE_MS);
        pending = { resolve: yes, reject: no, timer, lose };
        input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
      const frame = response.bytes ? JSON.parse(response.bytes.toString('utf8')) : null;
      if (frame) {
        assert.equal(frame.id, id); assert.equal(frame.jsonrpc, '2.0');
        assert.ok(!frame.error, JSON.stringify(frame.error));
        if (method === 'tools/call') assert.deepEqual(JSON.parse(frame.result.content[0].text), frame.result.structuredContent);
      }
      return { ...response, began, responseMs: response.flushedAt - began, frame, mode, participant: index };
    },
    async initialize() {
      return this.rpc('initialize', {
        protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'p065-synthetic', version: '1' },
      });
    },
    async close() {
      input.end();
      await serving;
      if (!output.destroyed) await new Promise((done) => output.end(done));
      if (servingError) throw servingError;
    },
  };
}

const callScope = new AsyncLocalStorage();
function targetResult(tool, result) {
  if (!result || typeof result !== 'object') return false;
  if (tool === 'delegate_spawn' || tool === 'delegate_resume') return typeof result.replayed === 'boolean';
  if (tool === 'delegate_cancel') return result.committed === true && result.result?.accepted === true;
  if (tool === 'delegate_whoami') return result.ok === true && result.state === 'bound';
  if (tool === 'delegate_report') return result.ok === true && typeof result.reportId === 'string';
  return false;
}
function synchronousStall(ms) {
  // Deliberate uninterruptible test work, never an altered deadline/clock.
  const start = performance.now();
  while (performance.now() - start < ms) { /* predeclared forced control */ }
}
function instrument(ledger) {
  const transaction = ledger.transaction.bind(ledger), db = ledger.db, exec = db.exec.bind(db);
  let armed = null;
  db.exec = (sql) => {
    const sample = callScope.getStore();
    const began = instant();
    let error = null;
    try {
      const result = exec(sql);
      if (sql === 'COMMIT' && armed) {
        const injection = armed;
        armed = null;
        injection.sample.injection = {
          point: 'after_actual_target_COMMIT', requestedMs: injection.scenario === 'commit-overrun' ? 40 : 0,
          began: instant(), durableSqlReturned: true,
        };
        if (injection.scenario === 'commit-overrun') synchronousStall(40);
        injection.sample.injection.ended = instant();
        if (injection.scenario === 'commit-uncertain') throw new Error('p065_forced_commit_acknowledgement_loss');
      }
      return result;
    } catch (caught) { error = String(caught?.code ?? caught?.message ?? caught); throw caught; }
    finally {
      if (sample && /^(BEGIN|COMMIT|ROLLBACK)/.test(sql))
        sample.sql.push({ operation: sql, began, ended: instant(), error });
    }
  };
  ledger.transaction = (callback, budget) => {
    const sample = callScope.getStore();
    const began = instant();
    const entry = sample ? { began, ended: null, callbackEntered: false, callbackMs: null, error: null } : null;
    if (entry) sample.transactions.push(entry);
    return transaction((tx) => {
      const callbackAt = instant();
      if (entry) entry.callbackEntered = true;
      try {
        const result = callback(tx);
        if (sample && sample.bank === 'forced' && !sample.injection && targetResult(sample.tool, result)) {
          if (sample.scenario === 'callback-overrun') {
            sample.injection = { point: 'after_target_callback_before_COMMIT', requestedMs: 40, began: instant() };
            synchronousStall(40);
            sample.injection.ended = instant();
          } else armed = { sample, scenario: sample.scenario };
        }
        return result;
      } finally { if (entry) entry.callbackMs = instant() - callbackAt; }
    }, budget).catch((error) => {
      if (entry) entry.error = String(error?.code ?? error?.message ?? error);
      throw error;
    }).finally(() => {
      armed = null;
      if (entry) entry.ended = instant();
    });
  };
  return () => { ledger.transaction = transaction; db.exec = exec; };
}
function countState(ledger, launches) {
  return ledger.snapshot((tx) => ({
    runs: Number(tx.get('SELECT count(*) AS n FROM runs').n),
    slots: Number(tx.get('SELECT count(*) AS n FROM slots').n),
    accepted: Number(tx.get("SELECT count(*) AS n FROM events WHERE kind='intent.accepted'").n),
    reports: Number(tx.get('SELECT count(*) AS n FROM reports').n),
    cancel: Number(tx.get("SELECT count(*) AS n FROM events WHERE kind='cancel.accepted'").n),
    bindings: Number(tx.get('SELECT count(*) AS n FROM child_bindings').n),
    active: Number(tx.get("SELECT count(*) AS n FROM runs WHERE state IN ('starting','running','cancelling','uncertain')").n),
    launches: launches.length,
  }));
}
function durableFor(ledger, tool, args, actor, expectedRunId) {
  return ledger.snapshot((tx) => {
    if (tool === 'delegate_spawn' || tool === 'delegate_resume') {
      const row = tx.get('SELECT run_id,link_id,outcome FROM idempotency WHERE request_key=?', args.request_key);
      return row ? { ...row, outcome: JSON.parse(row.outcome) } : null;
    }
    if (tool === 'delegate_report')
      return tx.get('SELECT report_id,run_id FROM reports WHERE summary=? AND run_id=?', args.summary, args.runId) ?? null;
    if (tool === 'delegate_whoami') {
      return tx.get(
        'SELECT b.binding_id,b.run_id,r.link_id,b.caller_id,b.caller_context_id,b.context_generation,b.session_ref ' +
        'FROM child_bindings b JOIN runs r ON r.run_id=b.run_id ' +
        'JOIN caller_contexts c ON c.context_id=b.caller_context_id AND c.generation=b.context_generation ' +
        'WHERE b.caller_context_id=? AND b.context_generation=? AND b.caller_id=? ' +
        'AND b.is_current=1 AND b.revoked_at IS NULL AND c.closed_at IS NULL ' +
        'AND b.caller_id=c.caller_id AND b.session_ref=c.session_ref ' +
        'AND b.run_id=? AND b.binding_generation=r.expected_generation AND b.session_ref=r.target_session_ref',
        actor.context.contextId, actor.context.generation, actor.registration.caller.callerId, expectedRunId
      ) ?? null;
    }
    const run = tx.get(
      'SELECT r.run_id,r.link_id,r.run_seq,r.expected_generation,r.state,r.cancel_requested_at,l.state AS link_state ' +
      'FROM runs r JOIN links l ON l.link_id=r.link_id WHERE r.run_id=?', args.runId
    );
    if (!run) return null;
    return {
      ...run,
      isCurrent: tx.get('SELECT run_id FROM runs WHERE link_id=? ORDER BY run_seq DESC LIMIT 1', run.link_id)?.run_id === run.run_id,
      slotHeld: Boolean(tx.get('SELECT 1 FROM slots WHERE run_id=?', run.run_id)),
      isRunTerminal: !['starting', 'running', 'cancelling', 'uncertain'].includes(run.state),
      asOfSeq: Number(tx.get('SELECT coalesce(max(seq),0) AS seq FROM events').seq),
    };
  });
}
function canonicalReplyErrors(tool, value, durable, allowEarlierSeq = false) {
  const errors = [];
  const require = (condition, message) => { if (!condition) errors.push(message); };
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.ok !== true)
    return ['reply is not an explicit successful object'];
  if (!durable) return ['successful reply has no independent durable target'];
  if (tool === 'delegate_spawn' || tool === 'delegate_resume') {
    require(durable.outcome?.status === 'accepted', 'canonical outcome is not accepted');
    require(durable.outcome?.runId === durable.run_id && durable.outcome?.linkId === durable.link_id,
      'idempotency outcome and indexed identities disagree');
    // Only these explicitly optional presentation fields may differ on replay.
    const { advice: _advice, wake: _wake, ...required } = value;
    require(isDeepStrictEqual(required, { ok: true, ...durable.outcome }), 'reply differs from canonical idempotency outcome');
  } else if (tool === 'delegate_whoami') {
    require(typeof durable.binding_id === 'string' && typeof durable.caller_context_id === 'string' &&
      typeof durable.caller_id === 'string' && typeof durable.session_ref === 'string' &&
      Number.isSafeInteger(durable.context_generation), 'current child binding subject is incomplete');
    require(isDeepStrictEqual(value, {
      ok: true, state: 'bound', linkId: durable.link_id, runId: durable.run_id, reason: null,
    }), 'whoami reply differs from current bound run/link');
  } else if (tool === 'delegate_report') {
    require(isDeepStrictEqual(value, { ok: true, reportId: durable.report_id, runId: durable.run_id }),
      'report reply differs from stored report identity');
  } else if (tool === 'delegate_cancel') {
    require(value.accepted === true, 'cancel reply is not accepted');
    require(Number.isSafeInteger(durable.cancel_requested_at) && durable.cancel_requested_at >= 0 &&
      value.cancelRequestedAt === durable.cancel_requested_at, 'cancel timestamp differs from durable original');
    if (value.status !== null && value.status !== undefined)
      errors.push(...canonicalReplyErrors('delegate_status', value.status, durable, true).map((message) => 'cancel status: ' + message));
  } else if (tool === 'delegate_status') {
    require(value.link?.linkId === durable.link_id && value.link?.state === durable.link_state, 'status link identity/state differs');
    const run = value.currentRun;
    for (const [field, column] of [
      ['runId', 'run_id'], ['linkId', 'link_id'], ['state', 'state'],
      ['runSeq', 'run_seq'], ['expectedGeneration', 'expected_generation'], ['cancelRequestedAt', 'cancel_requested_at'],
    ]) require(run?.[field] === durable[column], 'status run fact differs: ' + field);
    for (const field of ['isCurrent', 'isRunTerminal', 'slotHeld'])
      require(value[field] === durable[field], 'status read fact differs: ' + field);
    require(allowEarlierSeq
      ? Number.isSafeInteger(value.asOfSeq) && value.asOfSeq >= 0 && value.asOfSeq <= durable.asOfSeq
      : value.asOfSeq === durable.asOfSeq, 'status event snapshot bound differs');
  } else errors.push('unknown canonical reply tool');
  return errors;
}
function actualOutcome(value) {
  if (!value) return 'uncompleted';
  if (value.ok === false) return value.code === 'busy' ? 'busy' : value.code === 'internal_error' ? 'internal_error' : 'refusal';
  return 'success';
}
const nonnegative = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
function timingErrors(tool, diagnostics) {
  const errors = [];
  const require = (condition, message) => { if (!condition) errors.push(message); };
  if (!diagnostics || typeof diagnostics !== 'object' || Array.isArray(diagnostics))
    return ['missing diagnostics object'];
  const d = diagnostics;
  const write = tool !== 'delegate_status';
  require(d.writeBudgetApplicable === write, 'wrong trusted timing applicability');
  require(nonnegative(d.elapsedMs), 'invalid elapsedMs');
  require(Array.isArray(d.phases) && d.phases.length > 0 && d.phases.every((entry, index, entries) =>
    entry && typeof entry.phase === 'string' && nonnegative(entry.at) && entry.at <= d.elapsedMs &&
    (index === 0 || entry.at >= entries[index - 1].at)), 'invalid checkpoint intervals');
  if (write) {
    for (const field of ['authorizationMs', 'deadlineMs', 'overrunMs', 'waitMs', 'queueMs'])
      require(nonnegative(d[field]), 'invalid ' + field);
    require(Number.isSafeInteger(d.attempts) && d.attempts >= 0, 'invalid lock attempt count');
    require(d.deadlineMs > 0 && d.deadlineMs <= 30, 'invalid original deadline');
    require(d.authorizationMs <= d.elapsedMs && d.queueMs <= d.waitMs, 'inconsistent timing intervals');
    require(d.enclosingDeadline === 'trusted' || d.enclosingDeadline === 'unavailable', 'invalid enclosing deadline kind');
    require(d.phaseMs && typeof d.phaseMs === 'object' && !Array.isArray(d.phaseMs) &&
      Object.values(d.phaseMs).every(nonnegative), 'invalid phase totals');
    require(d.phaseCounts && typeof d.phaseCounts === 'object' && !Array.isArray(d.phaseCounts) &&
      Object.values(d.phaseCounts).every((value) => Number.isSafeInteger(value) && value >= 0), 'invalid phase counts');
  } else {
    for (const field of ['authorizationMs', 'deadlineMs', 'overrunMs', 'waitMs', 'queueMs'])
      require(d[field] === null, 'read-only field must be explicitly N/A: ' + field);
    require(nonnegative(d.upfrontMs) && d.upfrontMs <= d.elapsedMs, 'invalid read upfrontMs');
    require(d.attempts === 0 && d.enclosingDeadline === 'not_applicable', 'read-only timing has writer metadata');
  }
  return errors;
}
function validColdTiming(sample) {
  return timingErrors('delegate_resume', sample.diagnostics).length === 0 &&
    nonnegative(sample.began) && nonnegative(sample.ended) && sample.ended >= sample.began;
}
function numerical(row) {
  const d = row.diagnostics;
  const invalid = timingErrors(row.tool, d);
  if (!nonnegative(row.responseMs)) invalid.push('invalid responseMs');
  const completeTiming = invalid.length === 0;
  return {
    completeTiming, invalidTiming: invalid,
    writeBudgetApplicable: row.tool !== 'delegate_status',
    writeBound: row.tool === 'delegate_status' ? null : completeTiming && d.authorizationMs <= 30,
    cumulativeWaitBound: row.tool === 'delegate_status' ? null : completeTiming && d.waitMs <= 20,
    busyTimeoutBound: row.busyTimeoutMs === 0,
    responseIndividualBelow50: nonnegative(row.responseMs) && row.responseMs < 50,
    overrunMs: nonnegative(d?.overrunMs) ? d.overrunMs : null,
  };
}
function overrunExempt(row) {
  // Semantic fault membership is not numerical-exemption eligibility. In
  // particular, zero-delay acknowledgement loss remains operational numerically.
  return row.bank === 'forced' && !row.recovery &&
    ['callback-overrun', 'commit-overrun'].includes(row.declaredInjection) &&
    row.injection?.requestedMs === 40 &&
    nonnegative(row.injection?.began) && nonnegative(row.injection?.ended) &&
    row.injection.ended - row.injection.began >= 40 &&
    nonnegative(row.diagnostics?.authorizationMs) && row.diagnostics.authorizationMs > 30;
}
function numericalGates(selected) {
  const percentileGate = (group) => {
    const valid = group.every((row) => nonnegative(row.responseMs));
    const outcomes = Object.fromEntries([...new Set(group.map((row) => row.actualOutcome))].map((outcome) => {
      const bucket = group.filter((row) => row.actualOutcome === outcome);
      const timing = stats(bucket.filter((row) => nonnegative(row.responseMs)).map((row) => row.responseMs));
      return [outcome, { n: bucket.length, timing, qualified: timing.n === bucket.length && timing.p95 < 50 }];
    }));
    const timing = stats(group.filter((row) => nonnegative(row.responseMs)).map((row) => row.responseMs));
    return { n: group.length, timing, outcomes,
      qualified: group.length === 0 || (valid && timing.n === group.length && timing.p95 < 50 &&
        Object.values(outcomes).every((bucket) => bucket.qualified)) };
  };
  const groups = {
    allAttempts: selected,
    primaryMeasured: selected.filter((row) => !row.recovery && row.phase === 'measured'),
    primaryWarmups: selected.filter((row) => !row.recovery && row.phase === 'warmup'),
    recoveryMeasured: selected.filter((row) => row.recovery && row.phase === 'measured'),
    recoveryWarmups: selected.filter((row) => row.recovery && row.phase === 'warmup'),
  };
  const response = Object.fromEntries(Object.entries(groups).map(([name, group]) => [name, percentileGate(group)]));
  const perCall = selected.every((row) => {
    const numeric = row.numeric ?? numerical(row);
    return numeric.completeTiming && numeric.writeBound !== false &&
      numeric.cumulativeWaitBound !== false && numeric.busyTimeoutBound;
  });
  return { perCall, response, qualified: perCall && Object.values(response).every((group) => group.qualified) };
}
function lossCoverage(cell, rows) {
  if (!cell.lossCoverageRequired) return { applicable: false, complete: true };
  const participants = Array.from({ length: cell.h }, (_unused, participant) => {
    const primary = rows.filter((row) => !row.recovery && row.phase === 'measured' && row.participant === participant);
    const successful = primary.filter((row) => row.deliveryOutcome === 'response_lost' && row.actualOutcome === 'success' &&
      row.canonicalReplyVerified === true && row.durableInspectionVerified === true && row.semantic);
    const recovered = successful.filter((row) => row.recoveryVerified === true);
    return {
      participant, successfulLost: successful.length, durableInspections: successful.length, checkedRecoveries: recovered.length,
      successfulCallIds: successful.map((row) => row.id), recoveryCallIds: recovered.map((row) => row.recoveryCall),
      complete: successful.length >= cell.lossCoverageRequired.successfulLostMeasuredPerParticipant &&
        successful.length >= cell.lossCoverageRequired.durableInspectionMeasuredPerParticipant &&
        recovered.length >= cell.lossCoverageRequired.checkedRecoveryMeasuredPerParticipant,
    };
  });
  return { applicable: true, required: cell.lossCoverageRequired, participants, complete: participants.every((entry) => entry.complete) };
}
function prepareCall(client, cell, phase, sequence, index, args, rows, recovery = false) {
  const row = {
    kind: 'call', id: randomUUID(), cell: cell.id, bank: recovery ? 'operational' : cell.bank,
    tool: cell.tool, scenario: recovery ? cell.scenario + '/recovery' : cell.scenario,
    phase, sequence, participant: index, fixture: fixtureOrdinal, h: cell.h, r: cell.r,
    recovery, dispatchState: 'pending', declaredInjection: !recovery && cell.bank === 'forced' ? cell.scenario : null,
    requestKey: args.request_key ?? null, transactions: [], sql: [], backoffs: [], injection: null,
    began: instant(), finished: false, semantic: true, semanticErrors: [], busyTimeoutMs: client.busyTimeoutMs,
  };
  // A registered dispatch intention is already a retained, invalid-timing attempt.
  // No response duration exists until a real response is observed.
  row.numeric = numerical(row);
  calls++;
  rows.push(row);
  raw({ ...row, record: 'started' });
  return row;
}
async function call(f, client, cell, phase, sequence, index, args, rows, recovery = false, prepared) {
  checkOuter();
  const row = prepared ?? prepareCall(client, cell, phase, sequence, index, args, rows, recovery);
  row.dispatchState = 'issued';
  client.setMeasurement(row);
  try {
    const value = await client.rpc('tools/call', { name: cell.tool, arguments: args }, !recovery && cell.scenario === 'response-loss');
    row.began = value.began;
    row.ended = value.flushedAt;
    row.responseMs = value.responseMs;
    row.diagnostics = value.diagnostics;
    row.discardedBytes = value.discardedBytes;
    row.value = value.frame?.result.structuredContent ?? null;
    row.serverValue = value.serverOutcome;
    row.actualOutcome = actualOutcome(value.serverOutcome);
    row.deliveryOutcome = value.discardedBytes > 0 ? 'response_lost' : 'delivered';
    row.finished = true;
  } catch (error) {
    row.error = errorText(error); row.ended = instant(); row.actualOutcome = 'uncompleted'; row.semantic = false;
  } finally {
    client.setMeasurement(null);
    row.numeric = numerical(row);
    row.backoffWallMs = row.backoffs.reduce((sum, item) => sum + item.ended - item.began, 0);
    row.backoffRequestedMs = row.backoffs.reduce((sum, item) => sum + item.requestedMs, 0);
    row.transactionWallMs = row.transactions.reduce((sum, item) => sum + (item.ended ?? row.ended) - item.began, 0);
    row.callbackMs = row.transactions.reduce((sum, item) => sum + (item.callbackMs ?? 0), 0);
    row.commitMs = row.sql.filter((item) => item.operation === 'COMMIT').reduce((sum, item) => sum + item.ended - item.began, 0);
    row.rollbackMs = row.sql.filter((item) => item.operation === 'ROLLBACK').reduce((sum, item) => sum + item.ended - item.began, 0);
    row.numericalExemptionEligible = overrunExempt(row);
    // No synchronous serialization/storage work while a sibling call is timed.
    // The wave journals these completed/incomplete measurements after all clocks end.
  }
  return row;
}
function verify(row, condition, message) {
  if (!condition) { row.semantic = false; (row.semanticErrors ??= []).push(message); }
}
function finalizeWaveFailure(row, reason) {
  row.numeric ??= numerical(row);
  row.interruptionReason = reason;
  row.completionDisposition = row.dispatchState === 'pending'
    ? 'not_issued_incomplete' : row.finished ? 'issued_completed_wave_failed' : 'issued_incomplete';
  row.error ??= reason;
  verify(row, false, 'wave incomplete: ' + reason);
  // Preserve finished, dispatchState and any real measurements unchanged.
  // In particular, never assign response/end/zero-duration data to an intention.
}
async function wave(cell, phase, sequence, rows) {
  checkOuter();
  fixtureOrdinal++;
  const setupBegan = instant();
  let f, observer;
  const clients = [], services = [], ledgers = [], restorers = [];
  const queueJobs = [];
  const waveRows = [];
  const registeredStart = rows.length;
  const issuedJobs = [];
  let before, after, traffic;
  try {
    f = await p065WorkloadFixture(cell.h, cell.r, cell.tool);
    current = { cell: cell.id, phase, sequence, fixture: fixtureOrdinal };
    assert.equal(f.h, cell.h); assert.equal(f.r, cell.r);
    assert.equal(f.initial.active.length, cell.r);
    assert.equal(f.initial.slots.length, cell.r);
    assert.equal(f.baselineIds.length, cell.r);
    assert.equal(new Set(f.actors.map((actor) => actor.registration.caller.callerId)).size, cell.h);
    assert.equal(new Set(f.actors.map((actor) => actor.context.contextId)).size, cell.h);
    observer = await openLedger(join(f.root, 'ledger.sqlite'));
    // A legitimate same-process reconnect creates a fresh handshake mapping for
    // COMMIT controls. It never edits an existing binding/claim or fabricates rows.
    if (cell.bank === 'forced' && cell.tool === 'delegate_whoami') {
      const actors = [...f.actors];
      for (let i = 0; i < cell.h; i++) {
        const old = actors[i];
        const replacement = await f.actor('p065-reconnect-' + i,
          old.registration.harnessPid, old.ref.sessionId, old.registration.caller.pid + 5);
        f.processes.get(replacement.registration.harnessPid).ppid = f.targets[i].supervisor.pid;
        actors[i] = replacement;
      }
      f = { ...f, actors };
    }
    const sourceId = f.parent.registration.source.sourceId;
    const readiness = await helper.request('configure', {
      root: f.root, baselineIds: f.baselineIds, sourceId, load: cell.scenario === 'storage-load',
    });
    assert.equal(readiness.ledgerId, f.ledger.ledgerId);
    assert.equal(readiness.busyTimeoutMs, 0);
    sqliteVersion ??= readiness.sqlite;
    for (let i = 0; i < cell.h; i++) {
      const ledger = await openLedger(join(f.root, 'ledger.sqlite'));
      ledgers.push(ledger);
      const options = {
        ...f.services[i].options, ledger, registration: f.actors[i].registration,
      };
      const service = new DelegationService(options);
      if (cell.tool === 'delegate_cancel') service.reads.probes.supervisorState = () => 'alive';
      services.push(service);
      restorers.push(instrument(ledger));
      const client = framedClient(f, i, observer, service, cell.scenario);
      clients.push(client);
      const initialized = await client.initialize();
      support({ kind: 'initialize', fixture: fixtureOrdinal, participant: i, began: initialized.began, responseMs: initialized.responseMs });
    }
    before = countState(observer, f.launches);
    assert.equal(before.active, cell.r);
    const setupMs = instant() - setupBegan;
    support({
      kind: 'fixture_ready', fixture: fixtureOrdinal, cell: cell.id, phase, sequence, setupMs, fixtureSetupMs: f.setupMs,
      baseline: f.baselineIds, initial: f.initial, limits: f.limits, before, readiness,
      callers: f.actors.map((actor) => ({ callerId: actor.registration.caller.callerId, contextId: actor.context.contextId, processKey: actor.authority.evidence.processKey })),
      sourcePremises: 'current scope/context; synthetic process facts; real writer enforcement',
    });
    if (['short-lock', 'long-lock', 'queued-expiry'].includes(cell.scenario)) {
      const held = await helper.request('hold', { ms: cell.scenario === 'short-lock' ? 5 : 100 });
      support({ kind: 'lock_ready', fixture: fixtureOrdinal, ...held });
    }
    if (cell.bank === 'operational') await helper.request('start');
    if (cell.scenario === 'queued-expiry') {
      // Actual bounded lock acquisitions queued on each service's own connection.
      // No fake queue clock or unresolved arbitrary promise.
      for (const ledger of ledgers)
        for (let n = 0; n < 3; n++) {
          const began = instant();
          queueJobs.push(ledger.transaction((tx) => tx.get('SELECT 1 AS queued_predecessor'), 20)
            .then((result) => ({ result }), (error) => ({ error: errorText(error) }))
            .then((result) => ({ kind: 'queue_predecessor', fixture: fixtureOrdinal, began, ended: instant(), ...result })));
        }
    }
    const argumentsByParticipant = f.actors.map((_actor, index) => {
      const args = f.args(index, 'p065-request-' + fixtureOrdinal + '-' + index);
      if (cell.tool === 'delegate_report') args.summary = 'Synthetic P065 report ' + fixtureOrdinal + '-' + index;
      return args;
    });
    // Journal both dispatch intentions before issuing either H=2 frame.
    const prepared = f.actors.map((_actor, index) =>
      prepareCall(clients[index], cell, phase, sequence + index, index, argumentsByParticipant[index], rows));
    const issue = (index) => {
      const job = call(f, clients[index], cell, phase, sequence + index, index, argumentsByParticipant[index], rows, false, prepared[index])
        .then((result) => { waveRows.push(result); return result; });
      issuedJobs.push(job);
      return job;
    };
    // H=2 operational frames are both issued before awaiting either result.
    if (cell.bank === 'operational') await Promise.all(f.actors.map((_actor, index) => issue(index)));
    else for (let index = 0; index < cell.h; index++) await issue(index);
    for (const row of waveRows) raw({ ...row, record: row.finished ? 'flushed' : 'incomplete' });
    for (const predecessor of await Promise.all(queueJobs)) support(predecessor);
    traffic = await helper.request('stop');
    support({ kind: 'traffic', fixture: fixtureOrdinal, ...traffic });
    assert.equal(traffic.missedMetrics, 0, 'helper_metric_overflow');
    const trafficErrors = traffic.metrics.filter((entry) => entry.kind.endsWith('_error'));
    const unexpectedTrafficErrors = trafficErrors.filter((entry) =>
      entry.kind !== 'heartbeat_error' || !/database (?:is )?(?:locked|busy)|SQLITE_BUSY|SQLITE_LOCKED|ledger_busy|Ledger busy/.test(entry.error));
    support({ kind: 'traffic_validation', fixture: fixtureOrdinal, trafficErrors, unexpectedTrafficErrors });
    after = countState(observer, f.launches);
    let accepted = 0, reported = 0, cancelled = 0, remapped = 0, expectedLaunches = 0;
    for (const row of waveRows) {
      const index = row.participant, args = argumentsByParticipant[index];
      const durable = durableFor(observer, cell.tool, args, f.actors[index], f.targets[index].runId);
      row.durable = durable;
      verify(row, unexpectedTrafficErrors.length === 0, 'unexpected heartbeat/observation traffic failure');
      const committed = cell.tool === 'delegate_cancel' ? durable?.cancel_requested_at !== null && durable?.cancel_requested_at !== undefined : Boolean(durable);
      row.canonicalReplyErrors = row.actualOutcome === 'success'
        ? canonicalReplyErrors(cell.tool, row.serverValue, durable) : [];
      row.canonicalReplyVerified = row.actualOutcome === 'success' && row.canonicalReplyErrors.length === 0;
      row.durableInspectionVerified = row.canonicalReplyVerified;
      verify(row, row.actualOutcome !== 'success' || row.canonicalReplyVerified,
        'successful server reply contradicts durable truth: ' + row.canonicalReplyErrors.join('; '));
      const targetSuccess = row.canonicalReplyVerified;
      if (['delegate_spawn', 'delegate_resume'].includes(cell.tool) && committed) accepted++;
      if (cell.tool === 'delegate_report' && committed) reported++;
      if (cell.tool === 'delegate_cancel' && committed) cancelled++;
      if (cell.tool === 'delegate_whoami' && cell.bank === 'forced' && committed) remapped++;
      if (['delegate_spawn', 'delegate_resume'].includes(cell.tool) && committed && cell.scenario !== 'commit-uncertain') expectedLaunches++;
      if (row.actualOutcome === 'busy' || row.actualOutcome === 'refusal') {
        if (cell.tool !== 'delegate_status' && !(cell.tool === 'delegate_whoami' && cell.bank !== 'forced'))
          verify(row, !committed, 'refusal/busy nevertheless committed requested work');
      }
      if (cell.scenario === 'refusal') verify(row, row.actualOutcome === 'refusal', 'physical source mismatch was not refused');
      else if (cell.bank === 'forced') {
        verify(row, Boolean(row.injection), 'required target injection was not reached');
        if (cell.scenario === 'callback-overrun') {
          verify(row, row.actualOutcome === 'busy', 'callback overrun did not refuse uncommitted target');
          verify(row, !committed, 'callback overrun persisted target');
          verify(row, row.sql.some((entry) => entry.operation === 'ROLLBACK' && !entry.error), 'callback rollback missing');
        } else if (cell.scenario === 'commit-overrun') {
          verify(row, targetSuccess && committed, 'late target COMMIT did not preserve durable success');
          verify(row, row.diagnostics?.authorizationMs > 30, 'forced COMMIT overrun not in original timing');
        } else {
          verify(row, row.actualOutcome === 'internal_error' && committed, 'uncertain real COMMIT mapping/truth incorrect');
          verify(row, row.value && !('notAccepted' in row.value) && !('accepted' in row.value), 'uncertainty falsely promises not accepted');
        }
      } else if (cell.scenario === 'response-loss') {
        verify(row, row.discardedBytes > 0 && row.value === null, 'response bytes were not actually discarded');
      } else if (row.actualOutcome === 'success') {
        verify(row, targetSuccess && committed, 'success lacks expected durable target/read');
      } else verify(row, row.actualOutcome === 'busy', 'unexpected operational outcome');
      if (cell.tool === 'delegate_status') verify(row, row.transactions.length === 0, 'read-only status wrote to the ledger');
      if (cell.scenario === 'storage-load') {
        const overlapping = traffic.metrics.filter((entry) =>
          entry.kind === 'observation' && entry.ended >= row.began && entry.began <= row.ended);
        row.observationOverlap = overlapping.length;
      }
      row.heartbeatOverlap = traffic.metrics.filter((entry) =>
        entry.kind === 'heartbeat' && entry.ended >= row.began && entry.began <= row.ended).length;
      row.fixtureSetupMs = setupMs;
      row.activeBefore = before.active; row.activeAfter = after.active;
      row.activePeak = Math.max(before.active, after.active);
      row.foregroundRunId = ['delegate_spawn', 'delegate_resume'].includes(cell.tool) ? durable?.run_id ?? null : null;
    }
    // Wave-level conservation avoids attributing another concurrent caller's changes
    // to this caller. Every service still has its own SQL trace and durable readback.
    const waveAssertions = {
      accepted: after.accepted - before.accepted === accepted,
      runs: after.runs - before.runs === accepted,
      slots: after.slots - before.slots === accepted,
      reports: after.reports - before.reports === reported,
      cancel: after.cancel - before.cancel === cancelled,
      bindings: after.bindings - before.bindings === remapped,
      launches: after.launches - before.launches === expectedLaunches,
      active: after.active === cell.r + accepted,
    };
    for (const row of waveRows) {
      row.waveAssertions = waveAssertions;
      verify(row, Object.values(waveAssertions).every(Boolean), 'wave durable/launch conservation failed');
    }
    // Canonical recovery follows an independent durable inspection, never an
    // automatic redispatch based on uncertainty. Reports have no retry key.
    if (['response-loss', 'commit-overrun', 'commit-uncertain'].includes(cell.scenario)) {
      for (const row of waveRows) {
        const index = row.participant, args = argumentsByParticipant[index];
        if (cell.scenario === 'response-loss' && !row.canonicalReplyVerified) {
          row.recoveryDisposition = 'no verified successful lost result; required coverage is incomplete';
          continue;
        }
        if (cell.tool === 'delegate_report') {
          row.recoveryDisposition = 'durable report inspected; no automatic resubmission';
          continue;
        }
        if (!row.durable || (cell.tool === 'delegate_cancel' && row.durable.cancel_requested_at === null)) {
          row.recoveryDisposition = 'no durable accepted fact; no replay qualification claimed';
          continue;
        }
        if (cell.scenario === 'commit-uncertain') {
          // The unknown-COMMIT connection is isolated by production Ledger.
          // A new connection can recover the already independently read fact.
          await clients[index].close();
          const recoveredLedger = await openLedger(join(f.root, 'ledger.sqlite'));
          ledgers.push(recoveredLedger);
          const recoveredService = new DelegationService({
            ...f.services[index].options, ledger: recoveredLedger, registration: f.actors[index].registration,
          });
          if (cell.tool === 'delegate_cancel') recoveredService.reads.probes.supervisorState = () => 'alive';
          services.push(recoveredService);
          restorers.push(instrument(recoveredLedger));
          clients[index] = framedClient(f, index, observer, recoveredService, 'recovery');
          await clients[index].initialize();
        }
        const old = countState(observer, f.launches);
        const recovered = await call(f, clients[index], cell, phase, sequence + index, index, args, rows, true);
        if (cell.tool === 'delegate_status') verify(recovered, recovered.transactions.length === 0, 'read-only status recovery wrote to the ledger');
        recovered.durable = durableFor(observer, cell.tool, args, f.actors[index], f.targets[index].runId);
        const latest = countState(observer, f.launches);
        recovered.canonicalReplyErrors = canonicalReplyErrors(cell.tool, recovered.value, row.durable);
        recovered.canonicalReplyVerified = recovered.canonicalReplyErrors.length === 0;
        recovered.durableInspectionVerified = recovered.canonicalReplyVerified;
        verify(recovered, recovered.canonicalReplyVerified,
          'canonical recovery reply mismatch: ' + recovered.canonicalReplyErrors.join('; '));
        verify(recovered, JSON.stringify(recovered.durable) === JSON.stringify(row.durable), 'recovery changed durable identity');
        for (const field of ['accepted', 'runs', 'slots', 'reports', 'cancel', 'bindings', 'launches'])
          verify(recovered, latest[field] === old[field], 'recovery duplicated ' + field);
        raw({ ...recovered, record: 'completed' });
        row.recoveryCall = recovered.id;
        row.recoveryVerified = recovered.finished && recovered.semantic && recovered.canonicalReplyVerified;
      }
    }
    support({ kind: 'wave_final', fixture: fixtureOrdinal, cell: cell.id, before, after, waveAssertions, activePeak: cell.r + accepted });
    for (const row of waveRows) raw({ ...row, record: 'completed' });
    return waveRows;
  } catch (error) {
    // A sibling may already be issued when another participant fails its outer
    // check. Its bounded response must settle before finalization/logging.
    await Promise.allSettled(issuedJobs);
    const reason = errorText(error);
    for (const row of rows.slice(registeredStart)) {
      finalizeWaveFailure(row, reason);
      raw({ ...row, record: 'wave_failed' });
    }
    throw error;
  } finally {
    if (helper) {
      try { await helper.request('close'); }
      catch (error) {
        failures.push({ kind: 'holder_close_failure', fixture: fixtureOrdinal, error: errorText(error) });
        await helper.close();
      }
    }
    await Promise.allSettled(queueJobs);
    for (const client of clients) { try { await client.close(); } catch (error) { failures.push(errorText(error)); } }
    for (const restore of restorers) restore();
    for (const service of services) await service.close();
    for (const ledger of ledgers) await ledger.close();
    await observer?.close();
    await f?.dispose();
    current = null;
  }
}

function summarize(cell, rows) {
  // Defensive read normalization also handles a retained raw intention from an
  // interruption before call() entered its finalizer. Do not mutate raw evidence.
  rows = rows.map((row) => ({ ...row, numeric: row.numeric ?? numerical(row),
    semantic: row.finished === true && row.semantic === true }));
  const primary = rows.filter((row) => !row.recovery);
  const measured = primary.filter((row) => row.phase === 'measured');
  const warmups = primary.filter((row) => row.phase === 'warmup');
  const populations = {};
  for (const bank of ['operational', 'forced']) {
    const included = rows.filter((row) => row.bank === bank);
    const measuredRows = included.filter((row) => row.phase === 'measured');
    const scopes = {};
    for (const [scope, selected] of [['all-attempts-including-warmups', included], ['primary-measured', measuredRows.filter((row) => !row.recovery)], ['recovery-measured', measuredRows.filter((row) => row.recovery)], ['primary-warmups', included.filter((row) => row.phase === 'warmup' && !row.recovery)], ['recovery-warmups', included.filter((row) => row.phase === 'warmup' && row.recovery)]]) {
      const outcomes = {};
      for (const row of selected) {
        const key = row.actualOutcome ?? 'uncompleted';
        (outcomes[key] ??= []).push(row);
      }
      const describe = (group) => ({
        n: group.length,
        timingCoverage: {
          expectedResponse: group.length,
          validResponse: group.filter((row) => nonnegative(row.responseMs)).length,
          expectedWrite: group.filter((row) => row.tool !== 'delegate_status').length,
          validWrite: group.filter((row) => row.tool !== 'delegate_status' && row.numeric.completeTiming).length,
          expectedRead: group.filter((row) => row.tool === 'delegate_status').length,
          validRead: group.filter((row) => row.tool === 'delegate_status' && row.numeric.completeTiming).length,
          invalid: group.filter((row) => !row.numeric.completeTiming).length,
        },
        responseMs: stats(group.filter((row) => Number.isFinite(row.responseMs)).map((row) => row.responseMs)),
        authorizationMs: stats(group.filter((row) => Number.isFinite(row.diagnostics?.authorizationMs)).map((row) => row.diagnostics.authorizationMs)),
        upfrontMs: stats(group.filter((row) => Number.isFinite(row.diagnostics?.upfrontMs)).map((row) => row.diagnostics.upfrontMs)),
        waitMs: stats(group.filter((row) => Number.isFinite(row.diagnostics?.waitMs)).map((row) => row.diagnostics.waitMs)),
        queueMs: stats(group.filter((row) => Number.isFinite(row.diagnostics?.queueMs)).map((row) => row.diagnostics.queueMs)),
        transactionMs: stats(group.map((row) => row.transactionWallMs).filter(nonnegative)),
        callbackMs: stats(group.map((row) => row.callbackMs).filter(nonnegative)),
        commitMs: stats(group.map((row) => row.commitMs).filter(nonnegative)),
        rollbackMs: stats(group.map((row) => row.rollbackMs).filter(nonnegative)),
        backoffMs: stats(group.map((row) => row.backoffWallMs).filter(nonnegative)),
        checkpointIntervalsMs: Object.fromEntries(
          ['prepare', 'source', 'queue', 'acquire', 'metadata', 'callback', 'commit', 'rollback', 'complete', 'flush']
            .map((phase) => [phase, stats(group.map((row) => row.diagnostics?.phaseMs?.[phase]).filter(Number.isFinite))])
        ),
        queueTotalMs: group.reduce((sum, row) => sum + (row.diagnostics?.queueMs ?? 0), 0),
        waitTotalMs: group.reduce((sum, row) => sum + (row.diagnostics?.waitMs ?? 0), 0),
        backoffTotalMs: group.reduce((sum, row) => sum + (row.backoffWallMs ?? 0), 0),
        lockAttempts: group.reduce((sum, row) => sum + (row.diagnostics?.attempts ?? 0), 0),
        uncompleted: group.filter((row) => !row.finished).length,
        numericalFailures: group.filter((row) => !row.numeric.completeTiming ||
          row.numeric.writeBound === false || row.numeric.cumulativeWaitBound === false || !row.numeric.busyTimeoutBound).length,
        semanticFailures: group.filter((row) => !row.semantic).length,
      });
      scopes[scope] = {
        all: describe(selected),
        outcomes: Object.fromEntries(Object.entries(outcomes).map(([name, group]) => [name, describe(group)])),
      };
    }
    populations[bank] = scopes;
  }
  const inclusiveGates = numericalGates(rows);
  const exempt = rows.filter(overrunExempt);
  const op = rows.filter((row) => !overrunExempt(row));
  const operationalGates = numericalGates(op);
  const coverage = lossCoverage(cell, rows);
  const force = rows.filter((row) => row.bank === 'forced');
  const participants = [...new Set(measured.map((row) => row.participant))].sort();
  const nonApplicable = cell.tool === 'delegate_status' ? {
    p065WriteBudget: 'not applicable: read-only',
    busyOutcome: 'not manufactured: read-only status does not acquire a writer lock',
    forcedCallbackAndCommit: 'not applicable: no write callback/COMMIT',
  } : null;
  const observedOutcomes = Object.fromEntries(['success', 'refusal', 'busy', 'response_lost', 'internal_error', 'uncompleted']
    .map((name) => [name, measured.filter((row) => (row.actualOutcome ?? 'uncompleted') === name).length]));
  const requiredOutcomeSeen = cell.scenario === 'refusal' ? observedOutcomes.refusal > 0 :
    cell.scenario === 'response-loss' ? measured.some((row) => row.deliveryOutcome === 'response_lost') :
    cell.scenario === 'callback-overrun' || (cell.scenario === 'long-lock' && cell.tool !== 'delegate_status') ? observedOutcomes.busy > 0 :
    cell.scenario === 'commit-uncertain' ? observedOutcomes.internal_error > 0 :
    cell.scenario === 'queued-expiry' && cell.tool !== 'delegate_status' ? observedOutcomes.busy > 0 : observedOutcomes.success > 0;
  const heartbeatSeen = cell.bank === 'forced' || measured.some((row) => row.heartbeatOverlap > 0);
  const observationSeen = cell.scenario !== 'storage-load' || measured.some((row) => row.observationOverlap > 0);
  const contentionSeen = !['short-lock', 'long-lock', 'queued-expiry'].includes(cell.scenario) ||
    cell.tool === 'delegate_status' || measured.some((row) =>
      row.sql.some((entry) => entry.operation === 'BEGIN IMMEDIATE' && entry.error) || row.diagnostics?.queueMs >= 20);
  const complete = warmups.length === WARMUPS && measured.length === MEASURED &&
    primary.every((row) => row.finished && row.numeric.completeTiming) && participants.length === cell.h &&
    requiredOutcomeSeen && heartbeatSeen && observationSeen && contentionSeen && coverage.complete;
  return {
    ...cell, warmups: warmups.length, measured: measured.length, totalAttempts: rows.length,
    complete, participants, observedOutcomes, requiredOutcomeSeen, heartbeatSeen, observationSeen, contentionSeen,
    dispatch: {
      registered: rows.length,
      issued: rows.filter((row) => row.dispatchState === 'issued').length,
      pendingNotIssued: rows.filter((row) => row.dispatchState === 'pending').length,
      uncompleted: rows.filter((row) => !row.finished).length,
      interrupted: rows.filter((row) => row.interruptionReason !== undefined).length,
    },
    nonApplicable, populations, lossCoverage: coverage,
    numericalScopes: {
      inclusive: inclusiveGates, operational: operationalGates,
      operationalAttempts: op.length, deliberateOverrunExemptions: exempt.length,
      exemptionCallIds: exempt.map((row) => row.id),
      semanticFaultBankDoesNotImplyExemption: true,
    },
    numerical: inclusiveGates.qualified,
    operationalNumerical: operationalGates.qualified,
    operationalSemantics: op.every((row) => row.semantic),
    semantics: rows.every((row) => row.semantic) && force.every((row) => row.injection),
    fixturePolicy: 'fresh real fixture per H-sized wave; no direct run/claim/slot/binding rewrite',
  };
}

function runEvidenceCheckerControls() {
  // Fixed adversarial inputs exercise only the evidence checker. They never enter
  // rows, raw samples, planned populations, timings, or performance qualification.
  const checks = [];
  const check = (name, body) => { body(); checks.push(name); };
  const writeDiagnostics = () => ({
    writeBudgetApplicable: true, elapsedMs: 2, authorizationMs: 1, deadlineMs: 30,
    overrunMs: 0, waitMs: 0, queueMs: 0, attempts: 1, enclosingDeadline: 'unavailable',
    phaseMs: { prepare: 1 }, phaseCounts: { prepare: 1, complete: 1 },
    phases: [{ phase: 'prepare', at: 0 }, { phase: 'complete', at: 1 }],
  });
  const record = (responseMs = 1, extra = {}) => {
    const row = {
      tool: 'delegate_spawn', phase: 'measured', recovery: false, bank: 'operational',
      responseMs, diagnostics: writeDiagnostics(), busyTimeoutMs: 0, actualOutcome: 'success', ...extra,
    };
    row.numeric = numerical(row);
    return row;
  };
  check('51-of-1000 slow primary calls cannot be diluted by 50 fast warmups', () => {
    const read = { writeBudgetApplicable: false, elapsedMs: 2, upfrontMs: 1, authorizationMs: null,
      deadlineMs: null, overrunMs: null, waitMs: null, queueMs: null, attempts: 0,
      enclosingDeadline: 'not_applicable', phases: [{ phase: 'complete', at: 1 }] };
    const primary = Array.from({ length: 1000 }, (_unused, index) =>
      record(index < 51 ? 60 : 1, { tool: 'delegate_status', diagnostics: read }));
    const warmups = Array.from({ length: 50 }, () => record(1, { phase: 'warmup', tool: 'delegate_status', diagnostics: read }));
    const gates = numericalGates([...primary, ...warmups]);
    assert.equal(gates.response.allAttempts.qualified, true);
    assert.equal(gates.response.primaryMeasured.timing.p95, 60);
    assert.equal(gates.response.primaryMeasured.qualified, false);
    assert.equal(gates.qualified, false);
  });
  check('fast recoveries cannot dilute slow primary calls', () => {
    const primary = Array.from({ length: 1000 }, (_unused, index) => record(index < 51 ? 60 : 1));
    const recovery = Array.from({ length: 1000 }, () => record(1, { recovery: true }));
    const gates = numericalGates([...primary, ...recovery]);
    assert.equal(gates.response.allAttempts.qualified, true);
    assert.equal(gates.response.recoveryMeasured.qualified, true);
    assert.equal(gates.response.primaryMeasured.qualified, false);
    assert.equal(gates.qualified, false);
  });
  check('outcome splits and recovery distributions are independently gated', () => {
    const rows = Array.from({ length: 1000 }, () => record());
    rows.push(record(60, { actualOutcome: 'busy' }));
    assert.equal(numericalGates(rows).qualified, false);
    assert.equal(numericalGates([...rows.slice(0, 1000), record(60, { recovery: true })]).qualified, false);
  });
  check('loss coverage requires each participant success, durable inspection and recovery', () => {
    const cell = { h: 2, lossCoverageRequired: {
      successfulLostMeasuredPerParticipant: 1, durableInspectionMeasuredPerParticipant: 1,
      checkedRecoveryMeasuredPerParticipant: 1,
    } };
    const success = (participant) => ({
      id: 'checker-' + participant, participant, recovery: false, phase: 'measured',
      deliveryOutcome: 'response_lost', actualOutcome: 'success', semantic: true,
      canonicalReplyVerified: true, durableInspectionVerified: true,
      recoveryVerified: true, recoveryCall: 'checker-recovery-' + participant,
    });
    const good = [success(0), success(1)];
    assert.equal(lossCoverage(cell, good).complete, true);
    assert.equal(lossCoverage(cell, good.map((row) => ({ ...row, actualOutcome: 'busy' }))).complete, false);
    assert.equal(lossCoverage(cell, [success(0)]).complete, false);
    assert.equal(lossCoverage(cell, good.map((row) => ({ ...row, durableInspectionVerified: false }))).complete, false);
    assert.equal(lossCoverage(cell, good.map((row) => ({ ...row, recoveryVerified: false }))).complete, false);
    const report = { ...cell, lossCoverageRequired: { ...cell.lossCoverageRequired, checkedRecoveryMeasuredPerParticipant: 0 } };
    assert.equal(lossCoverage(report, good.map((row) => ({ ...row, recoveryVerified: false }))).complete, true);
  });
  check('canonical intent reply rejects wrong run, link and saved outcome', () => {
    const durable = { run_id: 'r', link_id: 'l', outcome: { status: 'accepted', state: 'starting', runId: 'r', linkId: 'l' } };
    const reply = { ok: true, ...durable.outcome };
    for (const tool of ['delegate_spawn', 'delegate_resume']) {
      assert.deepEqual(canonicalReplyErrors(tool, { ...reply, advice: {} }, durable), []);
      for (const bad of [{ runId: 'wrong' }, { linkId: 'wrong' }, { state: 'running' }, { status: 'refused' }])
        assert.ok(canonicalReplyErrors(tool, { ...reply, ...bad }, durable).length > 0);
    }
  });
  check('canonical cancel, whoami, report and status replies reject contradictions', () => {
    const cancel = { cancel_requested_at: 123 };
    assert.deepEqual(canonicalReplyErrors('delegate_cancel', { ok: true, accepted: true, cancelRequestedAt: 123 }, cancel), []);
    for (const bad of [{ accepted: false }, { cancelRequestedAt: 124 }])
      assert.ok(canonicalReplyErrors('delegate_cancel', { ok: true, accepted: true, cancelRequestedAt: 123, ...bad }, cancel).length);
    const binding = { binding_id: 'b', caller_context_id: 'c', caller_id: 'a', session_ref: '{}', context_generation: 1, link_id: 'l', run_id: 'r' };
    const whoami = { ok: true, state: 'bound', linkId: 'l', runId: 'r', reason: null };
    assert.deepEqual(canonicalReplyErrors('delegate_whoami', whoami, binding), []);
    for (const bad of [{ state: 'pending' }, { runId: 'wrong' }, { linkId: 'wrong' }])
      assert.ok(canonicalReplyErrors('delegate_whoami', { ...whoami, ...bad }, binding).length);
    assert.ok(canonicalReplyErrors('delegate_whoami', whoami, null).length);
    assert.deepEqual(canonicalReplyErrors('delegate_report', { ok: true, reportId: 'p', runId: 'r' }, { report_id: 'p', run_id: 'r' }), []);
    assert.ok(canonicalReplyErrors('delegate_report', { ok: true, reportId: 'wrong', runId: 'r' }, { report_id: 'p', run_id: 'r' }).length);
    const durable = { run_id: 'r', link_id: 'l', link_state: 'bound', state: 'running', run_seq: 1,
      expected_generation: 1, cancel_requested_at: null, isCurrent: true, isRunTerminal: false, slotHeld: true, asOfSeq: 3 };
    const status = { ok: true, link: { linkId: 'l', state: 'bound' },
      currentRun: { runId: 'r', linkId: 'l', state: 'running', runSeq: 1, expectedGeneration: 1, cancelRequestedAt: null },
      isCurrent: true, isRunTerminal: false, slotHeld: true, asOfSeq: 3 };
    assert.deepEqual(canonicalReplyErrors('delegate_status', status, durable), []);
    assert.ok(canonicalReplyErrors('delegate_status', { ...status, slotHeld: false }, durable).length);
    assert.ok(canonicalReplyErrors('delegate_status', { ...status, currentRun: { ...status.currentRun, runId: 'wrong' } }, durable).length);
  });
  check('zero-delay acknowledgement loss is not a numerical exemption', () => {
    const row = record(35, { bank: 'forced', declaredInjection: 'commit-uncertain',
      injection: { requestedMs: 0, began: 0, ended: 0 },
      diagnostics: { ...writeDiagnostics(), elapsedMs: 35, authorizationMs: 31, overrunMs: 1 } });
    assert.equal(overrunExempt(row), false);
    assert.equal(numericalGates([row].filter((item) => !overrunExempt(item))).qualified, false);
  });
  check('malformed write and cold CLI timings cannot qualify', () => {
    for (const field of ['authorizationMs', 'elapsedMs', 'deadlineMs', 'overrunMs', 'waitMs', 'queueMs']) {
      for (const value of [null, '1', -1, Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
        const diagnostics = { ...writeDiagnostics(), [field]: value };
        assert.equal(numerical(record(1, { diagnostics })).completeTiming, false);
        assert.equal(validColdTiming({ began: 0, ended: 2, diagnostics }), false);
      }
    }
    const wrong = { ...writeDiagnostics(), writeBudgetApplicable: false };
    assert.equal(numerical(record(1, { diagnostics: wrong })).completeTiming, false);
    assert.equal(validColdTiming({ began: 0, ended: 2, diagnostics: wrong }), false);
    for (const value of [null, '1', -1, Number.NaN, Number.POSITIVE_INFINITY, undefined])
      assert.equal(numerical(record(1, { responseMs: value })).completeTiming, false);
    assert.equal(validColdTiming({ began: 0, ended: 2, diagnostics: writeDiagnostics() }), true);
  });
  check('read-only timing requires explicit N/A writer fields and valid read intervals', () => {
    const diagnostics = { writeBudgetApplicable: false, elapsedMs: 2, upfrontMs: 1, authorizationMs: null,
      deadlineMs: null, overrunMs: null, waitMs: null, queueMs: null, attempts: 0,
      enclosingDeadline: 'not_applicable', phases: [{ phase: 'complete', at: 1 }] };
    assert.equal(numerical(record(2, { tool: 'delegate_status', diagnostics })).completeTiming, true);
    for (const field of ['authorizationMs', 'deadlineMs', 'overrunMs', 'waitMs', 'queueMs'])
      assert.equal(numerical(record(2, { tool: 'delegate_status', diagnostics: { ...diagnostics, [field]: 0 } })).completeTiming, false);
    for (const value of [null, '1', -1, Number.NaN, Number.POSITIVE_INFINITY, undefined])
      assert.equal(numerical(record(2, { tool: 'delegate_status', diagnostics: { ...diagnostics, upfrontMs: value } })).completeTiming, false);
  });

  check('pending H=2 intentions remain summarized without invented latency', () => {
    const cell = { h: 2, r: 10, tool: 'delegate_spawn', scenario: 'callback-overrun', bank: 'forced',
      lossCoverageRequired: null };
    const completed = {
      ...record(), bank: 'forced', id: 'checker-finished', participant: 0, finished: true, semantic: true,
      dispatchState: 'issued', semanticErrors: [], sql: [], injection: { requestedMs: 40 },
      transactionWallMs: 1, callbackMs: 1, commitMs: 0, rollbackMs: 0, backoffWallMs: 0,
    };
    const pending = (participant) => ({
      id: 'checker-pending-' + participant, participant, tool: 'delegate_spawn', phase: 'measured',
      recovery: false, bank: 'forced', dispatchState: 'pending', finished: false,
      semantic: true, semanticErrors: [], sql: [], transactions: [], backoffs: [], busyTimeoutMs: 0,
    });
    const second = pending(1);
    const mixed = [completed, second];
    const beforeFinalization = summarize(cell, mixed);
    assert.equal(beforeFinalization.totalAttempts, 2);
    assert.equal(beforeFinalization.measured, 2);
    assert.equal(beforeFinalization.complete, false);
    assert.equal(beforeFinalization.numerical, false);
    assert.equal(beforeFinalization.operationalNumerical, false);
    assert.equal(beforeFinalization.semantics, false);
    assert.equal(numericalGates(mixed).qualified, false);
    const scope = beforeFinalization.populations.forced['primary-measured'].all;
    assert.equal(scope.timingCoverage.invalid, 1);
    assert.equal(scope.timingCoverage.expectedResponse, 2);
    assert.equal(scope.timingCoverage.expectedWrite, 2);
    assert.equal(scope.timingCoverage.validWrite, 1);
    assert.equal('numeric' in second, false);
    assert.equal(scope.responseMs.n, 1);
    assert.equal(scope.transactionMs.n, 1);
    assert.equal(beforeFinalization.dispatch.pendingNotIssued, 1);
    const reason = 'checker_outer_timeout_original_reason';
    for (const row of mixed) finalizeWaveFailure(row, reason);
    const afterFinalization = summarize(cell, mixed);
    assert.equal(afterFinalization.totalAttempts, 2);
    assert.equal(JSON.parse(JSON.stringify(afterFinalization)).dispatch.registered, 2);
    assert.equal(afterFinalization.dispatch.interrupted, 2);
    assert.equal(afterFinalization.complete, false);
    assert.equal(second.completionDisposition, 'not_issued_incomplete');
    assert.equal(second.interruptionReason, reason);
    assert.equal(second.finished, false);
    assert.equal(second.dispatchState, 'pending');
    assert.equal(second.numeric.completeTiming, false);
    assert.equal('responseMs' in second, false);
    assert.equal('ended' in second, false);
    const noneIssued = [pending(0), pending(1)];
    assert.equal(summarize(cell, noneIssued).numerical, false);
    for (const row of noneIssued) finalizeWaveFailure(row, reason);
    const allPending = summarize(cell, noneIssued);
    assert.equal(allPending.totalAttempts, 2);
    assert.equal(allPending.dispatch.pendingNotIssued, 2);
    assert.equal(allPending.dispatch.issued, 0);
    assert.equal(allPending.complete, false);
    assert.equal(allPending.operationalNumerical, false);
    assert.equal(allPending.semantics, false);
    const pendingScope = allPending.populations.forced['primary-measured'].all;
    assert.equal(pendingScope.timingCoverage.invalid, 2);
    assert.equal(pendingScope.responseMs.n, 0);
    assert.equal(pendingScope.transactionMs.n, 0);
    assert.ok(noneIssued.every((row) => row.interruptionReason === reason &&
      row.finished === false && !('responseMs' in row) && !('diagnostics' in row) && !('ended' in row)));
  });
  return { executed: true, passed: true, checks,
    scope: 'pure evidence-checker controls only; never benchmark samples or performance evidence' };
}

let artifactsReady = false;
let deadline;
try {
  mkdirSync(dirname(outputFile), { recursive: true });
  // Refuse to overwrite any earlier series, even a failed/partial one.
  for (const path of [outputFile, rawFile, supportFile]) assert.equal(existsSync(path), false, 'evidence_path_exists:' + basename(path));
  for (const path of [outputFile, rawFile, supportFile]) closeSync(openSync(path, 'wx', 0o600));
  artifactsReady = true;
  checkerControls = runEvidenceCheckerControls();
  support({ kind: 'evidence_checker_controls', ...checkerControls });
  const compiled = {
    ...hashTree(join(repository, 'dist')),
    ...hashTree(join(repository, 'dist-test')),
    ...hashTree(join(repository, 'packages/hud-mcp/dist')),
  };
  const filesystem = statfsSync(sandbox);
  const mountinfo = readOptional('/proc/self/mountinfo').split('\n')
    .filter((line) => {
      const mount = line.split(' ')[4];
      return mount && (sandbox === mount || sandbox.startsWith(mount.endsWith('/') ? mount : mount + '/'));
    }).sort((a, b) => b.split(' ')[4].length - a.split(' ')[4].length)[0];
  identity = {
    sourceSha: git('rev-parse', 'HEAD'), sourceTree: git('rev-parse', 'HEAD^{tree}'),
    trackedChanges: git('diff', '--name-only', 'HEAD'), untrackedFiles: git('ls-files', '--others', '--exclude-standard'),
    compiledSha256: compiled, sourceDriverSha256: digestFile(self),
    sourceHolderSha256: digestFile(join(repository, 'tests/int/p065-ledger-holder.mjs')),
    hostLabel: createHash('sha256').update(hostname() + '/' + release()).digest('hex').slice(0, 16),
    node: process.versions, execArgv: process.execArgv, platform: process.platform, arch: process.arch,
    os: type(), kernel: release(), cpus: cpus().map((cpu) => ({ model: cpu.model, mhz: cpu.speed })),
    availableParallelism: availableParallelism(), totalMemory: totalmem(), freeMemoryAtStart: freemem(),
    cpuQuota: readOptional('/sys/fs/cgroup/cpu.max'), memoryLimit: readOptional('/sys/fs/cgroup/memory.max'),
    cpuStatAtStart: readOptional('/sys/fs/cgroup/cpu.stat'),
    filesystem: { type: String(filesystem.type), blockSize: String(filesystem.bsize), device: String(statSync(sandbox).dev),
      mount: mountinfo ? { point: mountinfo.split(' ')[4], options: mountinfo.split(' ')[5], type: mountinfo.split(' - ')[1]?.split(' ')[0] } : 'unavailable' },
    command: ['node', 'tests/int/p065-budget-benchmark.mjs', basename(outputFile)],
    relevantEnvironment: { HOME: '<temporary>', HUD_HOME: '<temporary>', TMPDIR: '<temporary>', inheritedHarnessVariables: 'removed',
      NODE_OPTIONS: 'removed for children; initial process value recorded as present/absent only',
      parentNodeOptionsPresent: Boolean(originalEnv.NODE_OPTIONS) },
    interference: 'No unrelated workload is started. Host-wide interference is not controllable; all samples retained.',
  };
  assert.equal(identity.parentNodeOptionsPresent ?? Boolean(originalEnv.NODE_OPTIONS), false, 'unset_NODE_OPTIONS_before_benchmark');
  assert.equal(identity.trackedChanges, '', 'source_worktree_must_match_recorded_commit');
  const evidencePaths = new Set([outputFile, rawFile, supportFile].map((path) => relative(repository, path)));
  assert.ok(identity.untrackedFiles.split('\n').filter(Boolean).every((path) => evidencePaths.has(path)), 'source_worktree_has_unrecorded_files');
  snapshotReport(false);
  deadline = setTimeout(() => { stopped = true; raw({ kind: 'interrupted', reason: 'outer_timeout', current, at: instant() }); }, OUTER_MS - (performance.now() - bootAt));
  const interrupted = (signal) => {
    stopped = true;
    raw({ kind: 'interrupted', reason: signal, current, at: instant() });
    snapshotReport(false);
  };
  process.once('SIGTERM', () => interrupted('SIGTERM'));
  process.once('SIGINT', () => interrupted('SIGINT'));
  const importBegan = performance.now();
  ({ HudMcpServer, serveStdio } = await import('../../dist-test/packages/hud-mcp/src/server.js'));
  ({ DelegationService } = await import('../../dist-test/packages/hud-mcp/src/delegation.js'));
  ({ scopeSnapshot } = await import('../../dist-test/src/ledger/call-context.js'));
  ({ p065WorkloadFixture } = await import('../../dist-test/tests/unit/p065-budget-fixture.js'));
  ({ openLedger } = await import('../../dist-test/src/ledger/ledger.js'));
  ({ monotonicClock } = await import('../../dist-test/src/ledger/call-budget.js'));
  moduleStartupMs = performance.now() - importBegan;
  for (const profile of profiles) {
    let coldFixture, coldHelper;
    try {
      coldFixture = await p065WorkloadFixture(profile.h, profile.r, 'delegate_resume');
      writeFileSync(join(coldFixture.root, 'delegate.json'), JSON.stringify(coldFixture.services[0].options.config), { mode: 0o600 });
      const processBegan = instant();
      coldHelper = ownedHelper();
      const ready = await coldHelper.ready;
      const launchToReadyMs = instant() - processBegan;
      await coldHelper.request('configure', {
        root: coldFixture.root, baselineIds: coldFixture.baselineIds,
        sourceId: coldFixture.parent.registration.source.sourceId, load: false,
      });
      const before = countState(coldFixture.ledger, coldFixture.launches);
      const result = await coldHelper.request('cold-cli', {
        linkId: 'p065-link-100', runId: coldFixture.targets[0].runId,
      });
      const after = countState(coldFixture.ledger, coldFixture.launches);
      const semantic = result.result.every((sample) => sample.exitCode === null && sample.output.length === 0 &&
        /ledger_busy|capability_unverified/.test(sample.error ?? '')) &&
        ['accepted', 'runs', 'slots', 'reports', 'cancel', 'bindings', 'launches']
          .every((field) => before[field] === after[field]);
      const entry = {
        profile, launchToReadyMs, initializationMs: result.initializationMs, scope: result.scope,
        samples: result.result.map((sample) => ({ ...sample, invalidTiming: timingErrors('delegate_resume', sample.diagnostics) })), semantic, before, after, workerPid: ready.pid,
        limitation: 'H/R names fixture baseline, not concurrent CLI callers; these are additive cold boundary probes, not substitutes for the MCP populations.',
      };
      coldCli.push(entry);
      support({ kind: 'compiled_cli_cold', ...entry });
      for (const sample of entry.samples) raw({ kind: 'compiled_cli_call', bank: 'operational', ...profile, ...sample, semantic });
      snapshotReport(false);
    } finally {
      await coldHelper?.close();
      await coldFixture?.dispose();
    }
  }
  helper = ownedHelper();
  support({ kind: 'holder_ready', ...(await helper.ready) });
  for (const cell of planned) {
    checkOuter();
    const rows = [];
    support({ kind: 'population_predeclared', ...cell,
      injection: cell.bank === 'forced' ? { point: cell.scenario === 'callback-overrun' ? 'target callback return before COMMIT' : 'after actual target COMMIT', synchronousDelayMs: cell.scenario === 'commit-uncertain' ? 0 : 40 } : null });
    try {
      for (const phase of ['warmup', 'measured']) {
        const count = phase === 'warmup' ? WARMUPS : MEASURED;
        for (let sequence = 0; sequence < count; sequence += cell.h) await wave(cell, phase, sequence, rows);
      }
    } catch (error) {
      failures.push({ cell: cell.id, current, error: errorText(error) });
      distributions.push(summarize(cell, rows));
      snapshotReport(false);
      throw error;
    }
    const summary = summarize(cell, rows);
    distributions.push(summary);
    snapshotReport(false);
    process.stdout.write(JSON.stringify({
      cell: cell.id, complete: summary.complete, numerical: summary.numerical,
      semantics: summary.semantics, measured: summary.measured, outcomes: summary.observedOutcomes,
    }) + '\n');
  }
  const result = snapshotReport(true);
  process.stdout.write(JSON.stringify({ kind: 'p065-summary', ...result.results, populationComplete: result.populationComplete }) + '\n');
  if (!result.results.acceptanceChecks || !result.populationComplete) process.exitCode = 1;
} catch (error) {
  if (artifactsReady) {
    failures.push({ current, error: errorText(error) });
    snapshotReport(false);
  }
  process.stderr.write(errorText(error) + '\n');
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  await helper?.close();
  // Every helper connection/process is closed before deleting only this owned tree.
  if (readFileSync(join(sandbox, '.p065-owner'), 'utf8') === token) rmSync(sandbox, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
}
