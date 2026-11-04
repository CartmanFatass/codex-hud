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
])).map((cell) => ({ ...cell, id: [cell.h, cell.r, cell.tool, cell.scenario].join('/'), warmups: WARMUPS, measured: MEASURED }));
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
function snapshotReport(complete = false) {
  const coldCliComplete = coldCli.length === profiles.length && coldCli.every((entry) => entry.samples.length === 2 && entry.semantic);
  const coldCliNumerical = coldCliComplete && coldCli.every((entry) => entry.samples.every((sample) => sample.diagnostics.authorizationMs <= 30 && sample.diagnostics.waitMs <= 20));
  const populationComplete = complete && coldCliComplete && distributions.length === planned.length &&
    distributions.every((row) => row.warmups === WARMUPS && row.measured === MEASURED && row.complete);
  const operationalNumericalQualification = populationComplete && coldCliNumerical &&
    distributions.every((row) => row.operationalNumerical && row.operationalSemantics);
  const forcedControlSemanticCompletion = populationComplete &&
    distributions.filter((row) => row.bank === 'forced').every((row) => row.semantics);
  const inclusiveAllSamplesNumericalStatus = populationComplete && coldCliNumerical && distributions.every((row) => row.numerical);
  const report = {
    schemaVersion: 1, kind: 'p065-real-sqlite-synthetic-cloud-surrogate',
    startedAt, endedAt: new Date().toISOString(), complete, populationComplete, calls, planned,
    identity, sqliteVersion, moduleStartupMs, distributions, failures, coldCli, coldCliComplete, coldCliNumerical,
    resourceUsage: process.resourceUsage(), freeMemoryAtSnapshot: freemem(), cpuStatAtSnapshot: readOptional('/sys/fs/cgroup/cpu.stat'),
    results: {
      operationalNumericalQualification, forcedControlSemanticCompletion, inclusiveAllSamplesNumericalStatus,
      overallQualified: inclusiveAllSamplesNumericalStatus && forcedControlSemanticCompletion && failures.length === 0,
      acceptanceChecks: operationalNumericalQualification && forcedControlSemanticCompletion && failures.length === 0,
    },
    settings: {
      warmups: WARMUPS, measured: MEASURED, responseDeadlineMs: RESPONSE_MS, holderDeadlineMs: HELPER_MS,
      outerDeadlineMs: OUTER_MS, ledgerBusyTimeoutMs: 0, writeWallBoundMs: 30, cumulativeWaitBoundMs: 20,
      responseP95StrictlyBelowMs: 50, shortLockMs: 5, longLockMs: 100, forcedSynchronousDelayMs: 40,
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
function durableFor(ledger, tool, args, actor) {
  return ledger.snapshot((tx) => {
    if (tool === 'delegate_spawn' || tool === 'delegate_resume') {
      const row = tx.get('SELECT run_id,link_id,outcome FROM idempotency WHERE request_key=?', args.request_key);
      return row ? { ...row, outcome: JSON.parse(row.outcome) } : null;
    }
    if (tool === 'delegate_report') return tx.get('SELECT report_id,run_id FROM reports WHERE summary=?', args.summary) ?? null;
    if (tool === 'delegate_whoami')
      return tx.get('SELECT binding_id,run_id,caller_context_id FROM child_bindings WHERE caller_context_id=? AND is_current=1', actor.context.contextId) ?? null;
    if (tool === 'delegate_cancel')
      return tx.get('SELECT run_id,cancel_requested_at FROM runs WHERE run_id=?', args.runId) ?? null;
    return tx.get('SELECT run_id,state FROM runs WHERE run_id=?', args.runId) ?? null;
  });
}
function actualOutcome(value, lost = false) {
  if (lost) return 'response_lost';
  if (!value) return 'uncompleted';
  if (value.ok === false) return value.code === 'busy' ? 'busy' : value.code === 'internal_error' ? 'internal_error' : 'refusal';
  return 'success';
}
function numerical(row) {
  const d = row.diagnostics;
  return {
    completeTiming: Boolean(d) && Number.isFinite(row.responseMs),
    writeBudgetApplicable: row.tool !== 'delegate_status',
    writeBound: row.tool === 'delegate_status' ? null : Boolean(d) && d.authorizationMs <= 30,
    cumulativeWaitBound: row.tool === 'delegate_status' ? null : Boolean(d) && d.waitMs <= 20,
    busyTimeoutBound: row.busyTimeoutMs === 0,
    responseIndividualBelow50: Number.isFinite(row.responseMs) && row.responseMs < 50,
    overrunMs: d?.overrunMs ?? null,
  };
}
async function call(f, client, cell, phase, sequence, index, args, rows, recovery = false) {
  checkOuter();
  const row = {
    kind: 'call', id: randomUUID(), cell: cell.id, bank: recovery ? 'operational' : cell.bank,
    tool: cell.tool, scenario: recovery ? cell.scenario + '/recovery' : cell.scenario,
    phase, sequence, participant: index, fixture: fixtureOrdinal, h: cell.h, r: cell.r,
    recovery, declaredInjection: !recovery && cell.bank === 'forced' ? cell.scenario : null,
    requestKey: args.request_key ?? null, transactions: [], sql: [], backoffs: [], injection: null,
    began: instant(), finished: false, semantic: true, semanticErrors: [], busyTimeoutMs: client.busyTimeoutMs,
  };
  calls++;
  rows.push(row);
  raw({ ...row, record: 'started' });
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
    // Completion is appended again with semantic assertions after durable readback.
    raw({ ...row, record: row.finished ? 'flushed' : 'incomplete' });
  }
  return row;
}
function verify(row, condition, message) {
  if (!condition) { row.semantic = false; row.semanticErrors.push(message); }
}
async function wave(cell, phase, sequence, rows) {
  checkOuter();
  fixtureOrdinal++;
  const setupBegan = instant();
  let f, observer;
  const clients = [], services = [], ledgers = [], restorers = [];
  const queueJobs = [];
  const waveRows = [];
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
            .then((result) => support({ kind: 'queue_predecessor', fixture: fixtureOrdinal, began, ended: instant(), ...result })));
        }
    }
    const argumentsByParticipant = f.actors.map((_actor, index) => {
      const args = f.args(index, 'p065-request-' + fixtureOrdinal + '-' + index);
      if (cell.tool === 'delegate_report') args.summary = 'Synthetic P065 report ' + fixtureOrdinal + '-' + index;
      return args;
    });
    const issue = async (index) => {
      const result = await call(f, clients[index], cell, phase, sequence + index, index, argumentsByParticipant[index], rows);
      waveRows.push(result);
      return result;
    };
    // H=2 operational frames are both issued before awaiting either result.
    if (cell.bank === 'operational') await Promise.all(f.actors.map((_actor, index) => issue(index)));
    else for (let index = 0; index < cell.h; index++) await issue(index);
    await Promise.all(queueJobs);
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
      const durable = durableFor(observer, cell.tool, args, f.actors[index]);
      row.durable = durable;
      verify(row, unexpectedTrafficErrors.length === 0, 'unexpected heartbeat/observation traffic failure');
      const committed = cell.tool === 'delegate_cancel' ? durable?.cancel_requested_at !== null && durable?.cancel_requested_at !== undefined : Boolean(durable);
      const targetSuccess = cell.tool === 'delegate_status' ? row.value?.ok === true :
        cell.tool === 'delegate_cancel' ? row.value?.accepted === true :
        cell.tool === 'delegate_whoami' ? row.value?.state === 'bound' :
        row.value?.ok === true;
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
        recovered.durable = durableFor(observer, cell.tool, args, f.actors[index]);
        const latest = countState(observer, f.launches);
        verify(recovered, recovered.value?.ok === true, 'canonical recovery did not succeed');
        verify(recovered, JSON.stringify(recovered.durable) === JSON.stringify(row.durable), 'recovery changed durable identity');
        for (const field of ['accepted', 'runs', 'slots', 'reports', 'cancel', 'bindings', 'launches'])
          verify(recovered, latest[field] === old[field], 'recovery duplicated ' + field);
        raw({ ...recovered, record: 'completed' });
        row.recoveryCall = recovered.id;
      }
    }
    support({ kind: 'wave_final', fixture: fixtureOrdinal, cell: cell.id, before, after, waveAssertions, activePeak: cell.r + accepted });
    for (const row of waveRows) raw({ ...row, record: 'completed' });
    return waveRows;
  } catch (error) {
    for (const row of waveRows) {
      verify(row, false, 'wave incomplete: ' + errorText(error));
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
  const primary = rows.filter((row) => !row.recovery);
  const measured = primary.filter((row) => row.phase === 'measured');
  const warmups = primary.filter((row) => row.phase === 'warmup');
  const populations = {};
  for (const bank of ['operational', 'forced']) {
    const included = rows.filter((row) => row.bank === bank);
    const measuredRows = included.filter((row) => row.phase === 'measured');
    const scopes = {};
    for (const [scope, selected] of [['all-attempts-including-warmups', included], ['measured', measuredRows]]) {
      const outcomes = {};
      for (const row of selected) {
        const key = row.actualOutcome ?? 'uncompleted';
        (outcomes[key] ??= []).push(row);
      }
      const describe = (group) => ({
        n: group.length,
        responseMs: stats(group.filter((row) => Number.isFinite(row.responseMs)).map((row) => row.responseMs)),
        authorizationMs: stats(group.filter((row) => Number.isFinite(row.diagnostics?.authorizationMs)).map((row) => row.diagnostics.authorizationMs)),
        upfrontMs: stats(group.filter((row) => Number.isFinite(row.diagnostics?.upfrontMs)).map((row) => row.diagnostics.upfrontMs)),
        waitMs: stats(group.filter((row) => Number.isFinite(row.diagnostics?.waitMs)).map((row) => row.diagnostics.waitMs)),
        queueMs: stats(group.filter((row) => Number.isFinite(row.diagnostics?.queueMs)).map((row) => row.diagnostics.queueMs)),
        transactionMs: stats(group.map((row) => row.transactionWallMs ?? 0)),
        callbackMs: stats(group.map((row) => row.callbackMs ?? 0)),
        commitMs: stats(group.map((row) => row.commitMs ?? 0)),
        rollbackMs: stats(group.map((row) => row.rollbackMs ?? 0)),
        backoffMs: stats(group.map((row) => row.backoffWallMs ?? 0)),
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
  const numeric = (selected) => selected.every((row) => row.numeric.completeTiming &&
    row.numeric.writeBound !== false && row.numeric.cumulativeWaitBound !== false && row.numeric.busyTimeoutBound) &&
    (!selected.length || stats(selected.map((row) => row.responseMs)).p95 < 50) &&
    [...new Set(selected.map((row) => row.actualOutcome))].every((outcome) =>
      stats(selected.filter((row) => row.actualOutcome === outcome).map((row) => row.responseMs)).p95 < 50);
  const op = rows.filter((row) => row.bank === 'operational');
  const force = rows.filter((row) => row.bank === 'forced');
  const participants = [...new Set(measured.map((row) => row.participant))].sort();
  const nonApplicable = cell.tool === 'delegate_status' ? {
    p065WriteBudget: 'not applicable: read-only',
    busyOutcome: 'not manufactured: read-only status does not acquire a writer lock',
    forcedCallbackAndCommit: 'not applicable: no write callback/COMMIT',
  } : null;
  const observedOutcomes = Object.fromEntries(['success', 'refusal', 'busy', 'response_lost', 'internal_error', 'uncompleted']
    .map((name) => [name, measured.filter((row) => row.actualOutcome === name).length]));
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
    requiredOutcomeSeen && heartbeatSeen && observationSeen && contentionSeen;
  return {
    ...cell, warmups: warmups.length, measured: measured.length, totalAttempts: rows.length,
    complete, participants, observedOutcomes, requiredOutcomeSeen, heartbeatSeen, observationSeen, contentionSeen,
    nonApplicable, populations,
    numerical: numeric(rows),
    operationalNumerical: numeric(op),
    operationalSemantics: op.every((row) => row.semantic),
    semantics: rows.every((row) => row.semantic) && force.every((row) => row.injection),
    fixturePolicy: 'fresh real fixture per H-sized wave; no direct run/claim/slot/binding rewrite',
  };
}
let artifactsReady = false;
let deadline;
try {
  mkdirSync(dirname(outputFile), { recursive: true });
  // Refuse to overwrite any earlier series, even a failed/partial one.
  for (const path of [outputFile, rawFile, supportFile]) assert.equal(existsSync(path), false, 'evidence_path_exists:' + basename(path));
  for (const path of [outputFile, rawFile, supportFile]) closeSync(openSync(path, 'wx', 0o600));
  artifactsReady = true;
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
        samples: result.result, semantic, before, after, workerPid: ready.pid,
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
