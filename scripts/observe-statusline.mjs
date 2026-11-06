#!/usr/bin/env node
/** Finite synthetic product-entry observation. Never installs or discovers user settings. */
import { spawn, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const LIMITS = Object.freeze({
  samples: 20,
  maximumSamples: 100,
  sampleMs: 2000,
  totalMs: 30000,
  termMs: 100,
  cleanupMs: 1000,
  outputBytes: 16384,
});
export const HELP =
  'Usage: node scripts/observe-statusline.mjs --synthetic [--samples N]\nN is an integer 1..100 (default 20). Synthetic inputs only; no settings are read or installed.\n';
export function parseArgs(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  if (args[0] !== '--synthetic' || ![1, 3].includes(args.length)) throw Error('usage');
  if (args.length === 3 && (args[1] !== '--samples' || !/^[1-9]\d*$/.test(args[2]) || Number(args[2]) > 100))
    throw Error('usage');
  return { samples: args.length === 3 ? Number(args[2]) : LIMITS.samples };
}
export function isolatedEnvironment(directory, source = false, width = 80) {
  return {
    HOME: path.join(directory, 'home'),
    HUD_HOME: path.join(directory, 'hud'),
    ...(source ? { CLAUDE_CONFIG_DIR: path.join(directory, 'source') } : {}),
    COLUMNS: String(width),
    LANG: 'C.UTF-8',
  };
}

/** Own only the direct ChildProcess. Exit, successful kill and pipe destruction are not close. */
export async function runChild({ args, input, env, cwd, signal, timeoutMs = LIMITS.sampleMs }, spawnImpl = spawn) {
  const start = performance.now();
  let child,
    spawned = false,
    exited = false,
    closed = false,
    reason = null,
    code = null,
    exitSignal = null;
  let stdout = Buffer.alloc(0),
    stderr = Buffer.alloc(0),
    stdoutBytes = 0,
    stderrBytes = 0;
  let timer, killTimer, cleanupTimer, resolveResult;
  let settled = false;
  const promise = new Promise((resolve) => {
    resolveResult = resolve;
  });
  const finish = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    clearTimeout(killTimer);
    clearTimeout(cleanupTimer);
    signal?.removeEventListener('abort', interrupt);
    resolveResult({
      spawned,
      directChildExited: exited,
      closeObserved: closed,
      exitCode: code,
      signal: exitSignal,
      reason,
      cleanupUncertain: spawned && !closed,
      elapsedMs: performance.now() - start,
      stdoutBytes,
      stderrBytes,
      stdout: stdout.toString('utf8'),
      stderr: stderr.toString('utf8'),
    });
  };
  const signalDirect = () => {
    if (!spawned || exited || closed || settled || killTimer) return;
    killTimer = setTimeout(() => {
      if (!exited && !closed)
        try {
          child.kill('SIGKILL');
        } catch {
          /* Never infer cleanup. */
        }
    }, LIMITS.termMs);
    try {
      child.kill('SIGTERM');
    } catch {
      /* Deadline still owns the outcome. */
    }
  };
  const stop = (why) => {
    if (reason || settled) return;
    reason = why;
    cleanupTimer = setTimeout(() => {
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      finish();
    }, LIMITS.cleanupMs);
    signalDirect();
  };
  const interrupt = () => stop('interrupted');
  if (signal?.aborted) {
    reason = 'interrupted';
    finish();
    return promise;
  }
  try {
    child = spawnImpl(process.execPath, args, {
      cwd,
      env,
      shell: false,
      detached: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    reason = 'spawn_error';
    finish();
    return promise;
  }
  child.once('spawn', () => {
    spawned = true;
    if (reason) signalDirect();
    else if (signal?.aborted) interrupt();
  });
  child.once('exit', (value, sig) => {
    exited = true;
    code = value;
    exitSignal = sig;
  });
  child.once('close', (value, sig) => {
    closed = true;
    code = value;
    exitSignal = sig;
    finish();
  });
  child.once('error', () => {
    stop('spawn_error');
  });
  const receive = (kind, chunk) => {
    const bytes = Buffer.from(chunk);
    if (kind === 'stdout') {
      stdoutBytes += bytes.length;
      stdout = Buffer.concat([stdout, bytes.subarray(0, Math.max(0, LIMITS.outputBytes - stdout.length))]);
    } else {
      stderrBytes += bytes.length;
      stderr = Buffer.concat([stderr, bytes.subarray(0, Math.max(0, LIMITS.outputBytes - stderr.length))]);
    }
    if (stdoutBytes > LIMITS.outputBytes || stderrBytes > LIMITS.outputBytes) stop('output_limit');
  };
  child.stdout.on('data', (chunk) => receive('stdout', chunk));
  child.stderr.on('data', (chunk) => receive('stderr', chunk));
  child.stdout.on('error', () => stop('output_error'));
  child.stderr.on('error', () => stop('output_error'));
  child.stdin.on('error', () => {
    if (!exited) stop('input_error');
  });
  signal?.addEventListener('abort', interrupt, { once: true });
  timer = setTimeout(() => stop('timeout'), Math.max(1, timeoutMs));
  if (signal?.aborted) interrupt();
  try {
    child.stdin.end(input);
  } catch {
    stop('input_error');
  }
  return promise;
}

export function statistics(rows) {
  // Only validated, successfully closed observations are latency samples. All other attempts stay in the receipt.
  const times = rows
    .filter(
      (row) =>
        row.status === 'PASS' &&
        row.spawned &&
        row.directChildExited &&
        row.closeObserved &&
        !row.reason &&
        !row.signal &&
        !row.cleanupUncertain
    )
    .map((row) => row.elapsedMs)
    .sort((a, b) => a - b);
  const quantile = (p) => (times.length ? times[Math.ceil(p * times.length) - 1] : null);
  return {
    n: times.length,
    p50Ms: quantile(0.5),
    p95Ms: quantile(0.95),
    p99Ms: quantile(0.99),
    maxMs: times.at(-1) ?? null,
  };
}
export function metadata(directory) {
  let sourceSha = null,
    dirty = 'unknown';
  try {
    const git = (...args) =>
      execFileSync('/usr/bin/git', ['-C', ROOT, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 2000,
        maxBuffer: 65536,
        env: {
          HOME: directory,
          PATH: '/usr/bin:/bin',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_OPTIONAL_LOCKS: '0',
        },
      }).trim();
    sourceSha = git('rev-parse', 'HEAD');
    dirty = git('status', '--porcelain', '--untracked-files=normal') !== '';
  } catch {
    /* Git absence does not invent source or build identity. */
  }
  return {
    sourceSha,
    dirty,
    buildStatus: 'NOT_VERIFIED_BY_OBSERVER',
    node: process.versions.node,
    host: { platform: process.platform, release: os.release(), architecture: process.arch },
  };
}

export async function createFixture() {
  const temporaryRoot = path.join(ROOT, 'tmp', 'cloud-development');
  for (const dir of [path.join(ROOT, 'tmp'), temporaryRoot]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { mode: 0o700 });
    if (fs.lstatSync(dir).isSymbolicLink() || !fs.statSync(dir).isDirectory() || fs.realpathSync(dir) !== dir)
      throw Error('unsafe_temporary_root');
  }
  const directory = fs.mkdtempSync(path.join(temporaryRoot, 'statusline-observation-'));
  try {
    for (const name of ['home', 'hud', 'source']) fs.mkdirSync(path.join(directory, name), { mode: 0o700 });
    const { openLedger } = await import('../dist/ledger/ledger.js');
    const { makeSourceId, sessionRefKey } = await import('../dist/core/identity.js');
    const { summaryFileIdentity, delegationSummaryPath } = await import('../dist/core/delegation-summary-store.js');
    const { validateDelegationSummary } = await import('../dist/core/delegation-summary-schema.js');
    const hud = path.join(directory, 'hud');
    const source = path.join(directory, 'source');
    const ledger = await openLedger(path.join(hud, 'ledger.sqlite'));
    const parent = {
      harness: 'claude',
      sourceId: makeSourceId('claude', source),
      sessionId: 'synthetic-parent',
      threadId: null,
    };
    let ledgerId;
    try {
      ledgerId = ledger.ledgerId;
      await ledger.transaction((tx) => {
        tx.run(
          'INSERT INTO sources(source_id,harness,root_path,label) VALUES(?,?,?,?)',
          parent.sourceId,
          'claude',
          source,
          'Synthetic observation'
        );
        tx.run(
          'INSERT INTO sessions(session_ref,harness,source_id,session_id,thread_id) VALUES(?,?,?,?,?)',
          sessionRefKey(parent),
          'claude',
          parent.sourceId,
          parent.sessionId,
          ''
        );
      });
    } finally {
      await ledger.close();
    }
    const cache = path.join(hud, 'delegation-summaries-v1');
    fs.mkdirSync(cache, { mode: 0o700 });
    const file = delegationSummaryPath(hud, parent);
    const refresh = (ageMs) => {
      const now = Date.now() - ageMs;
      const child = { harness: 'codex', sourceId: 'a'.repeat(64), sessionId: 'synthetic-child', threadId: null };
      const stamp = {
        ref: child,
        runId: 'synthetic-run',
        bindingGeneration: 1,
        sourceGeneration: 1,
        seqDomain: 'synthetic',
        commitSeq: 1,
        inputLedgerSeq: 0,
      };
      const value = {
        schemaVersion: 1,
        parent,
        ledgerId,
        ledgerFileIdentity: summaryFileIdentity(path.join(hud, 'ledger.sqlite')),
        asOfSeq: 0,
        observedAt: now,
        expiresAt: now + 5000,
        coverage: 'partial',
        reason: 'direct_children_only',
        treeCounts: null,
        limitReached: false,
        children: [
          {
            key: 'synthetic-link',
            ref: child,
            label: 'Synthetic observation',
            backend: 'codex',
            linkState: 'bound',
            run: {
              id: 'synthetic-run',
              state: 'running',
              mode: 'headless',
              generation: 1,
              createdAt: now,
              endedAt: null,
              cancelRequestedAt: null,
            },
            stamp,
            coverage: { state: 'complete', loaded: true, gaps: [], skipped: {} },
            unavailableReason: null,
            status: {
              activity: 'waiting_input',
              pendingReason: 'needs_human',
              lastTurnOutcome: 'none',
              liveness: 'alive',
              freshness: {
                state: 'fresh',
                sources: [
                  {
                    id: 'synthetic',
                    validity: 'current',
                    lastEvidenceAt: now,
                    observedAt: now,
                    lastSuccessfulReadAt: now,
                    deadlineAt: now + 5000,
                  },
                ],
                requiredSourceIds: ['synthetic'],
                staleSince: null,
                reason: null,
                clockAnomaly: false,
              },
              stateKey: 'needs_human',
              stateSince: null,
              stateSinceBasis: 'unknown',
              isRunTerminal: false,
              asOfSeq: 0,
              observationStamp: stamp,
              asOf: now,
              observedAt: now,
              lastEvidenceAt: now,
            },
          },
        ],
      };
      if (!validateDelegationSummary(value, parent, now)) throw Error('fixture_invalid');
      fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
    };
    return {
      directory,
      refresh,
      removeSummary: () => fs.rmSync(file, { force: true }),
      cleanup: () => fs.rmSync(directory, { recursive: true }),
    };
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
const FACTS = {
  model: { display_name: 'Synthetic Claude' },
  context_window: { used_percentage: 42 },
  cost: { total_cost_usd: 0.12 },
};
const FIRST = 'Synthetic Claude · ctx 42% · $0.12\n';
export const SCENARIOS = Object.freeze([
  'stdin-normal',
  'narrow',
  'missing-summary',
  'fresh-summary',
  'expired-summary',
]);
function scenarioInput(name) {
  return JSON.stringify({
    ...FACTS,
    ...(['missing-summary', 'fresh-summary', 'expired-summary'].includes(name)
      ? { session_id: 'synthetic-parent' }
      : {}),
  });
}
export function validateResult(name, result) {
  if (result.reason || !result.closeObserved || !result.directChildExited || result.cleanupUncertain || result.signal)
    return false;
  if (name === 'malformed-json')
    return result.exitCode === 3 && result.stdout === '' && result.stderr === 'invalid_statusline_input\n';
  if (result.exitCode !== 0) return false;
  // SQLite's standard experimental warning is not captured in the report or mistaken for a product error.
  if (
    result.stderr &&
    !/^\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\n$/.test(
      result.stderr
    )
  )
    return false;
  if (name === 'narrow') return result.stdout === 'Synthetic…\n';
  if (name === 'sparse-object') return result.stdout === 'Claude\n';
  if (name === 'zero-unknown-fields') return result.stdout === 'Claude · ctx 0% · $0.00\n';
  if (name === 'fresh-summary') {
    const lines = result.stdout.split('\n');
    return (
      lines.length === 3 &&
      lines[0] + '\n' === FIRST &&
      lines[1].includes('partial') &&
      lines[1].includes('Synthetic observation') &&
      lines[1].includes('needs human')
    );
  }
  return result.stdout === FIRST;
}
export function aggregate(name, requested, rows, control = false, incompleteReason = null) {
  const latency = statistics(rows);
  return {
    name,
    category: control ? 'correctness-control' : 'positive-observation',
    requested,
    attempted: rows.length,
    completed: latency.n,
    failed: rows.filter((r) => r.status === 'FAIL').length,
    censored: rows.filter((r) => r.spawned && !r.closeObserved).length,
    notAttempted: requested - rows.length,
    incompleteReason: latency.n === requested ? null : incompleteReason,
    uncompleted: requested - latency.n,
    status: latency.n === requested ? 'PASS' : rows.length ? 'FAIL' : 'NOT_RUN',
    latency: control ? null : latency,
    advisoryP95AtMost150Ms:
      control || latency.n !== requested || rows.some((r) => r.status !== 'PASS')
        ? 'NOT_RUN'
        : latency.p95Ms <= 150
          ? 'PASS'
          : 'FAIL',
    attempts: rows,
  };
}
export async function observe({ samples, signal }, spawnImpl = spawn) {
  if (!Number.isInteger(samples) || samples < 1 || samples > 100) throw Error('invalid_samples');
  const fixture = await createFixture();
  const report = {
    schemaVersion: 1,
    mode: 'synthetic',
    ...metadata(fixture.directory),
    fixtureRevision: 'statusline-observation-v1',
    specification: {
      url: 'https://code.claude.com/docs/en/statusline',
      accessedAt: '2026-11-06',
      version: 'moving-documentation-no-client-version-claim',
    },
    limits: LIMITS,
    timing: {
      boundary: 'immediately before spawn through direct-child close',
      clock: 'monotonic performance.now',
      quantiles: 'nearest-rank',
      warmupExcluded: 0,
      population: 'validated successful closed observations only',
      failedAndCensored: 'not in quantiles; all durations and outcomes retained in attempts',
      cacheState: 'new process per sample; OS caches uncontrolled',
    },
    status: 'PASS',
    cleanup: 'pending',
    scenarios: [...SCENARIOS, 'malformed-json', 'sparse-object', 'zero-unknown-fields'].map((name) =>
      aggregate(name, SCENARIOS.includes(name) ? samples : 1, [], !SCENARIOS.includes(name))
    ),
    qualifications: Object.fromEntries(
      [
        'historical1000SampleGate',
        'internalReader20ms',
        'liveClaude',
        'wslWindowsTerminal',
        'twoWeekObservation',
        'defaultReadiness',
      ].map((name) => [name, 'NOT_RUN'])
    ),
  };
  let uncertain = false,
    stopReason = null;
  const deadline = performance.now() + LIMITS.totalMs;
  try {
    for (const scenario of report.scenarios) {
      const { name, requested, attempts: rows } = scenario;
      for (let i = 0; i < requested; i++) {
        if (stopReason || signal?.aborted || performance.now() >= deadline) {
          stopReason ??= signal?.aborted ? 'interrupted' : 'global_deadline';
          break;
        }
        try {
          if (name === 'fresh-summary') fixture.refresh(0);
          else if (name === 'expired-summary') fixture.refresh(10000);
          else fixture.removeSummary();
        } catch {
          stopReason = 'fixture_error';
          break;
        }
        if (signal?.aborted || performance.now() >= deadline) {
          stopReason = signal?.aborted ? 'interrupted' : 'global_deadline';
          break;
        }
        const source = ['missing-summary', 'fresh-summary', 'expired-summary'].includes(name);
        const result = await runChild(
          {
            args: [path.join(ROOT, 'bin/hud-statusline')],
            input:
              name === 'sparse-object'
                ? '{}'
                : name === 'malformed-json'
                  ? '{synthetic-invalid'
                  : name === 'zero-unknown-fields'
                    ? JSON.stringify({
                        context_window: { used_percentage: 0 },
                        cost: { total_cost_usd: 0 },
                        future_field: 'synthetic',
                      })
                    : scenarioInput(name),
            env: isolatedEnvironment(fixture.directory, source, name === 'narrow' ? 10 : 80),
            cwd: fixture.directory,
            signal,
            timeoutMs: Math.min(LIMITS.sampleMs, deadline - performance.now()),
          },
          spawnImpl
        );
        const { stdout, stderr, ...receipt } = result;
        rows.push({ ...receipt, status: validateResult(name, result) ? 'PASS' : 'FAIL' });
        if (result.cleanupUncertain) {
          uncertain = true;
          stopReason = 'cleanup_uncertain';
        } else if (result.reason === 'interrupted') stopReason = 'interrupted';
      }
    }
  } catch {
    stopReason = 'runtime_error';
  } finally {
    if (uncertain) report.cleanup = 'retained_uncertain';
    else
      try {
        fixture.cleanup();
        report.cleanup = 'removed_after_confirmed_close';
      } catch {
        report.cleanup = 'failed';
      }
  }
  report.scenarios = report.scenarios.map((scenario) =>
    aggregate(
      scenario.name,
      scenario.requested,
      scenario.attempts,
      scenario.category === 'correctness-control',
      stopReason ?? 'attempt_failed'
    )
  );
  report.stopReason = stopReason;
  report.status =
    !stopReason &&
    report.cleanup === 'removed_after_confirmed_close' &&
    report.scenarios.length === 8 &&
    report.scenarios.every((s) => s.status === 'PASS')
      ? 'PASS'
      : 'FAIL';
  return report;
}
export function writeReport(text, stream = process.stdout) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.removeListener('error', onError);
      if (error) {
        stream.on('error', () => {});
        stream.destroy?.();
        reject(Error('report_failed'));
      } else resolve();
    };
    const onError = () => finish(true);
    const timer = setTimeout(() => finish(true), 1000);
    stream.once('error', onError);
    try {
      stream.write(text, (error) => finish(error));
    } catch {
      finish(true);
    }
  });
}
export async function main(args = process.argv.slice(2), writer = writeReport) {
  let options;
  try {
    options = parseArgs(args);
  } catch {
    process.stderr.write(HELP);
    return 2;
  }
  if (options.help) {
    try {
      await writer(HELP);
      return 0;
    } catch {
      process.stderr.write('statusline_observation_report_failed\n');
      return 1;
    }
  }
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (
    process.platform !== 'linux' ||
    !((major === 22 && minor >= 13) || major >= 24) ||
    !fs.existsSync(path.join(ROOT, 'dist/cli/statusline.js'))
  ) {
    process.stderr.write(
      'statusline_observation_prerequisite_failed: Linux, Node 22.13+/24 and npm run build required\n'
    );
    return 2;
  }
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    const report = await observe({ ...options, signal: controller.signal });
    try {
      await writer(JSON.stringify(report, null, 2) + '\n');
    } catch {
      process.stderr.write('statusline_observation_report_failed\n');
      return 1;
    }
    return report.status === 'PASS' ? 0 : 1;
  } catch {
    process.stderr.write('statusline_observation_runtime_failed\n');
    return 1;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await main();
