// Explicit paid B13 skill probe. Never imported by npm test. Like B45, this
// composes the real services with a TEST-ONLY capability verifier and no native
// wake endpoint. Interactive Codex queue pickup belongs to B14.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

// Retired: the fixed-role roster skill replaced the native skill this probe fed to a paid Codex child.
process.stdout.write('SKIP B13 real model probe (retired: parent skill is the fixed-role roster skill)\n');
process.exit(0);

if (process.env.B13_REAL !== '1') {
  process.stdout.write('SKIP B13 real model probe (set B13_REAL=1 to opt in)\n');
  process.exit(0);
}
const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const script = fileURLToPath(import.meta.url);
const load = (path) => import(pathToFileURL(join(repo, 'packages/hud-mcp/dist', path)));
const { openLedger } = await load('src/ledger/ledger.js');
const { readProcess, processState, sameStamp } = await import(pathToFileURL(join(repo, 'dist/core/run/process.js')));

// A persistent file shared by all invocations, reserved BEFORE a real launch.
// A concurrent invoker refuses rather than racing or resetting the allowance.
function reserveRun(file, kind, runId = null) {
  const lock = `${file}.lock`;
  mkdirSync(lock, { mode: 0o700 });
  try {
    const rows = existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
    if (rows.filter((row) => row.kind === kind).length >= 3) throw new Error(`B13 ${kind} budget exhausted (3)`);
    appendFileSync(file, JSON.stringify({ kind, runId, at: Date.now() }) + '\n', { mode: 0o600 });
  } finally {
    rmSync(lock, { recursive: true });
  }
}
const json = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const lines = (file) =>
  existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];

if (process.argv[2] === '--server') {
  const cfg = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  const { LinuxProcessReader } = await load('packages/hud-mcp/src/process.js');
  const { registerCaller } = await load('packages/hud-mcp/src/registry.js');
  const { createLedgerCallerRegistry } = await load('packages/hud-mcp/src/ledger-registry.js');
  const { SessionRefResolver } = await load('packages/hud-mcp/src/resolvers.js');
  const { scopeSnapshot } = await load('src/ledger/call-context.js');
  const { HudMcpServer, serveStdio } = await load('packages/hud-mcp/src/server.js');
  const { DelegationService } = await load('packages/hud-mcp/src/delegation.js');
  const { launchPreparedRun } = await load('src/core/launch/index.js');
  const registry = await createLedgerCallerRegistry(cfg.home);
  const reader = new LinuxProcessReader();
  const profile = cfg.config.profiles.find((p) => p.name === process.env.HUD_MCP_PROFILE);
  const registration = await registerCaller({
    reader,
    registry,
    profile,
    pid: process.pid,
    cwd: () => process.cwd(),
    envPane: null,
    nowMs: Date.now(),
  });
  const recordProcess = (kind, pid, extra = {}) =>
    appendFileSync(cfg.processFile, JSON.stringify({ kind, stamp: readProcess(pid)?.stamp, ...extra }) + '\n', {
      mode: 0o600,
    });
  recordProcess('mcp', process.pid);
  const completions = [];
  const scopes = { read: (key) => registry.ledger.snapshot((tx) => scopeSnapshot(tx, registry.ledger.ledgerId, key)) };
  const source = new SessionRefResolver(registration, reader, profile, undefined, undefined, scopes);
  const bodies = new DelegationService({
    ledger: registry.ledger,
    home: cfg.home,
    config: cfg.config,
    registration,
    reader,
    codexConfig: cfg.codexConfig,
    capability: { verify: () => ({ ok: true, reason: null }) },
    hudRunPath: join(repo, 'bin/hud-run'),
    // Deliberately the same endpoint availability as B45: no wakeExecutable.
    launch: async (prepared, ticket, options) => {
      reserveRun(cfg.budgetFile, 'child', prepared.input.runId);
      const launched = await launchPreparedRun(prepared, ticket, options);
      recordProcess('supervisor', launched.pid, { runId: prepared.input.runId });
      completions.push(
        launched.completion.then((result) => recordProcess('supervisor-reaped', launched.pid, { result }))
      );
      return launched;
    },
  });
  const server = new HudMcpServer(source, bodies);
  const handle = server.handle.bind(server);
  server.handle = async (request) => {
    const result = await handle(request);
    if (request?.method === 'tools/call') {
      // No launch claims/config/auth/env are exported. The exercised calls use
      // environment whoami; redact an explicit claim defensively.
      const args = { ...request.params.arguments };
      if ('claim' in args) args.claim = '<redacted>';
      appendFileSync(
        cfg.callFile,
        JSON.stringify({
          profile: profile.name,
          tool: request.params.name,
          args,
          outcome: result?.result?.structuredContent,
          at: Date.now(),
        }) + '\n',
        { mode: 0o600 }
      );
    }
    return result;
  };
  try {
    await serveStdio(server, process.stdin, process.stdout);
  } finally {
    await bodies.close();
    // waitpid the exact supervisor this MCP launched, including on parent EOF.
    await Promise.all(completions);
    await registry.ledger.close();
  }
} else {
  // Resolve prerequisites before creating any scratch directory.
  const codexRoot = realpathSync(process.env.CODEX_HOME || join(homedir(), '.codex'));
  const found = spawnSync('/bin/sh', ['-c', 'command -v codex'], { encoding: 'utf8' });
  assert.equal(found.status, 0, 'Codex CLI required');
  const codex = realpathSync(found.stdout.trim());
  const skill = readFileSync(join(repo, 'integrations/skills/hud-delegate/SKILL.md'), 'utf8');
  const role = readFileSync(join(repo, 'integrations/skills/hud-delegate/roles/implementer.md'), 'utf8');
  const evidence = resolve(process.env.B13_EVIDENCE_DIR ?? join(repo, 'tmp/b13-real-evidence'));
  mkdirSync(evidence, { recursive: true, mode: 0o700 });
  const output = mkdtempSync(join(evidence, 'attempt-'));
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'hud-b13-real-')));
  const home = join(project, 'hud');
  mkdirSync(home, { mode: 0o700 });
  const cfgFile = join(home, 'probe.json');
  const cfg = {
    home,
    budgetFile: join(evidence, 'real-runs.jsonl'),
    processFile: join(output, 'processes.jsonl'),
    callFile: join(output, 'calls.jsonl'),
  };
  const server = {
    command: process.execPath,
    args: [script, '--server', cfgFile],
    env: { HUD_HOME: home, HUD_MCP_PROFILE: 'child-codex', B13_REAL: '1' },
  };
  const overrides = (env) =>
    Object.entries({ command: server.command, args: server.args, default_tools_approval_mode: 'approve' })
      .concat(Object.entries(env).map(([key, value]) => [`env.${key}`, value]))
      .flatMap(([key, value]) => ['-c', `mcp_servers.b13.${key}=${JSON.stringify(value)}`]);
  const routingEnv = Object.fromEntries(
    ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'NODE_USE_ENV_PROXY']
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]])
  );
  const profile = (name) => ({
    name,
    harness: 'codex',
    source: { root: codexRoot, label: 'Synthetic B13 probe' },
    launch: { argv: [codex] },
    headless: {
      argv: [
        codex,
        '-c',
        'features.apps=false',
        'exec',
        '--ignore-user-config',
        '--skip-git-repo-check',
        '--json',
        '-s',
        'danger-full-access',
        ...overrides(server.env),
        '-',
      ],
    },
    resume: { argv: [codex, 'resume', '{{sessionId}}'] },
    host: { kind: 'none', layout: 'none' },
    env: { ...routingEnv, CODEX_HOME: codexRoot },
    mcpServerName: 'b13',
    claimTransport: 'config_env',
    clientToolTimeoutMs: 60000,
    responseMarginMs: 2000,
    orphan_policy: 'continue',
    managedShellVerified: false,
    roles: name === 'child-codex' ? { implementer: { model: 'gpt-6.1-sol', effort: 'low' } } : {},
  });
  cfg.config = { version: 1, profiles: [profile('parent-codex'), profile('child-codex')] };
  cfg.codexConfig = { mcp_servers: { b13: server } };
  const reportPath = join(project, 'child-report.md');
  const content = 'Synthetic B13 delegation complete.\n';
  // Only the parent skill plus one synthetic task paragraph: no prescribed
  // tools, brief, cursor script, response schema, or waiting algorithm.
  const prompt = `${skill}\n\nSynthetic task: Use the skill above (its repository is ${repo}) to delegate one implementation in the scratch Git repository ${project}. The child must create greeting.txt containing exactly ${JSON.stringify(content)}, verify its bytes with a command, and write its report to ${reportPath}. Choose the existing implementer profile from HUD_HOME; the fallback question channel is herdr agent prompt w3Q:p3 with name B13-synthetic. Verify the child's file and report, then give a final account of the delegation and the cursor you retained. This is one child task, with no other agents or changes to files outside this scratch repository.\n`;
  const redacted = (text) => {
    for (const value of Object.values(routingEnv)) {
      if (value.length > 8) text = text.replaceAll(value, '<routing-value>');
    }
    return text
      .replaceAll(project, '<scratch>')
      .replaceAll(repo, '<repo>')
      .replaceAll(codexRoot, '<codex-home>')
      .replaceAll(homedir(), '<home>');
  };
  json(join(output, 'setup.json'), {
    node: process.version,
    codex: spawnSync(codex, ['--version'], { encoding: 'utf8' }).stdout.trim(),
    capability: 'TEST-ONLY verifier; no production cells promoted',
    wake: 'B45 composition: no wakeExecutable; native interactive queue untested',
  });
  writeFileSync(join(output, 'parent-prompt.md'), redacted(prompt), { mode: 0o600 });
  let parent, done, db, failure;
  let parentResult;
  const owned = new Map();
  const remember = (stamp) => {
    if (stamp) owned.set(`${stamp.pid}:${stamp.proc_start}`, stamp);
  };
  // Ownership is established by ancestry from our children or the launch log,
  // never by a process name, a reused PID, or another session's environment.
  function observeOwned() {
    for (const row of lines(cfg.processFile)) remember(row.stamp);
    const records = readdirSync('/proc')
      .filter((name) => /^\d+$/.test(name))
      .map((name) => readProcess(Number(name)))
      .filter(Boolean);
    let added;
    do {
      added = false;
      for (const record of records) {
        const key = `${record.stamp.pid}:${record.stamp.proc_start}`;
        const owner = [...owned.values()].find((stamp) => stamp.pid === record.ppid);
        if (!owned.has(key) && owner && sameStamp(readProcess(owner.pid)?.stamp ?? {}, owner)) {
          remember(record.stamp);
          added = true;
        }
      }
    } while (added);
  }
  let hardStop;
  const onInterrupt = () => {
    failure ??= new Error('probe interrupted');
    parent?.kill('SIGTERM');
    hardStop ??= setTimeout(() => {
      observeOwned();
      for (const stamp of owned.values())
        if (processState(stamp) === 'alive') {
          try {
            process.kill(stamp.pid, 'SIGKILL');
          } catch {}
        }
      // Do not let an inherited pipe postpone the direct child's waitpid.
      parent?.stdout.destroy();
      parent?.stderr.destroy();
    }, 2000);
  };
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onInterrupt);
  let observer, timer;
  try {
    const initialized = spawnSync('git', ['init', '--quiet', project], { encoding: 'utf8' });
    assert.equal(initialized.status, 0, initialized.stderr);
    db = await openLedger(join(home, 'ledger.sqlite'));
    writeFileSync(join(home, 'delegate.json'), JSON.stringify(cfg.config), { mode: 0o600 });
    json(cfgFile, cfg);
    reserveRun(cfg.budgetFile, 'parent');
    const env = { ...process.env, HUD_HOME: home, CODEX_HOME: codexRoot };
    for (const key of Object.keys(env))
      if (key.startsWith('HERDR_') || key === 'TMUX' || key === 'TMUX_PANE') delete env[key];
    parent = spawn(
      codex,
      [
        '-c',
        'features.apps=false',
        '--model',
        'gpt-6.1-sol',
        '-c',
        'model_reasoning_effort="low"',
        'exec',
        '--ignore-user-config',
        '--skip-git-repo-check',
        '--json',
        '-s',
        'danger-full-access',
        ...overrides({ ...server.env, HUD_MCP_PROFILE: 'parent-codex' }),
        '-',
      ],
      { cwd: project, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    remember(readProcess(parent.pid)?.stamp);
    done = new Promise((resolve) => {
      parent.once('close', (code, signal) => resolve({ code, signal }));
      parent.once('error', (error) => resolve({ error: error.message }));
    });
    parent.stdout.on('data', (data) => appendFileSync(join(output, 'parent.stdout.jsonl'), data, { mode: 0o600 }));
    parent.stderr.on('data', (data) => appendFileSync(join(output, 'parent.stderr.log'), data, { mode: 0o600 }));
    parent.stdin.on('error', () => {});
    parent.stdin.end(prompt);
    observer = setInterval(observeOwned, 250);
    timer = setTimeout(onInterrupt, 240000);
    parentResult = await done;
    assert.equal(parentResult.code, 0, `parent failed: ${JSON.stringify(parentResult)}`);
    if (failure) throw failure;
    // Outer test observation only, never available to the parent: let the
    // supervisor finish the real exit/receipt/slot-release transaction.
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      observeOwned();
      const runs = db.snapshot((tx) => tx.all('SELECT state FROM runs'));
      if (runs.length && runs.every((run) => ['ended', 'failed', 'cancelled'].includes(run.state))) break;
      await delay(100);
    }
    const snapshot = db.snapshot((tx) => ({
      runs: tx.all('SELECT run_id,link_id,state,launch_phase,ended_at,terminal_evidence_id FROM runs'),
      reports: tx.all('SELECT run_id,status,summary,path FROM reports'),
      events: tx
        .all('SELECT seq,link_id,run_id,kind,payload,at FROM events ORDER BY seq')
        .map((row) => ({ ...row, payload: JSON.parse(row.payload) })),
      slots: tx.all('SELECT run_id FROM slots'),
    }));
    json(join(output, 'ledger.json'), snapshot);
    for (const run of snapshot.runs) {
      const directory = join(home, 'runs', run.run_id);
      for (const file of ['stdout.log', 'stderr.log']) {
        const path = join(directory, file);
        if (existsSync(path)) writeFileSync(join(output, `child-${file}`), readFileSync(path), { mode: 0o600 });
      }
      const metaFile = join(directory, 'meta.json');
      if (existsSync(metaFile)) {
        const meta = JSON.parse(readFileSync(metaFile, 'utf8'));
        for (const stamp of [meta.harness, meta.supervisor, meta.scope?.group_leader]) remember(stamp);
      }
    }
    const calls = lines(cfg.callFile);
    const parentCalls = calls.filter((call) => call.profile === 'parent-codex');
    const childCalls = calls.filter((call) => call.profile === 'child-codex');
    const spawns = parentCalls.filter((call) => call.tool === 'delegate_spawn');
    assert.ok(spawns.length, 'parent used delegate_spawn');
    assert.equal(new Set(spawns.map((call) => call.args.request_key)).size, 1, 'stable request_key');
    assert.ok(spawns[0].args.request_key?.length, 'nonempty request_key');
    const accepted = spawns.find((call) => call.outcome?.ok);
    assert.ok(accepted, 'accepted spawn');
    assert.equal(snapshot.runs.length, 1, 'exactly one real child');
    const childBrief = readFileSync(spawns[0].args.brief, 'utf8');
    assert.ok(
      childBrief.startsWith(role) ||
        childBrief.includes(join(repo, 'integrations/skills/hud-delegate/roles/implementer.md')),
      'brief carries the role verbatim or by path'
    );
    assert.ok(childBrief.includes(reportPath), 'brief names report path');
    assert.ok(childBrief.includes('w3Q:p3'), 'brief names fallback channel');
    writeFileSync(join(output, 'child-brief.md'), childBrief, { mode: 0o600 });
    assert.equal(childCalls[0]?.tool, 'delegate_whoami', 'first child MCP call is whoami');
    assert.ok(
      childCalls.some((call) => call.tool === 'delegate_whoami' && call.outcome?.state === 'bound'),
      'child bound'
    );
    assert.ok(
      childCalls.some(
        (call) =>
          call.tool === 'delegate_report' &&
          call.args.status === 'completed' &&
          call.args.reportPath === reportPath &&
          call.outcome?.ok
      ),
      'child completed report'
    );
    const runId = snapshot.runs[0].run_id;
    const waits = parentCalls.filter((call) => call.tool === 'delegate_wait' && call.outcome?.ok);
    assert.deepEqual(accepted.outcome.advice.wake, { adapter: 'none', state: 'none' });
    assert.ok(waits.length, 'unavailable native delivery uses bounded delegate_wait');
    let cursor = 0;
    const cursorTrace = [];
    for (const call of parentCalls) {
      if (!call.outcome?.ok) continue;
      if (call.tool === 'delegate_wait') {
        assert.equal(call.args.runId, runId, 'fixed run');
        assert.equal(call.args.afterSeq, cursor, 'wait uses retained cursor');
        assert.ok(call.args.timeoutMs > 0 && call.args.timeoutMs <= 120000, 'bounded wait');
        cursor = call.outcome.nextSeq;
        assert.ok(Number.isSafeInteger(cursor), 'nextSeq cursor');
        cursorTrace.push({
          tool: call.tool,
          afterSeq: call.args.afterSeq,
          nextSeq: cursor,
          hasMore: call.outcome.hasMore,
        });
      } else if (call.tool === 'delegate_status') {
        cursor = call.outcome.asOfSeq;
        cursorTrace.push({ tool: call.tool, asOfSeq: cursor });
      }
    }
    const finalStatus = parentCalls.filter((call) => call.tool === 'delegate_status' && call.outcome?.ok).at(-1);
    assert.ok(
      finalStatus?.outcome.latestReportForRun?.status === 'completed',
      'parent reads completed report through final status'
    );
    assert.equal(finalStatus.outcome.currentRun.runId, runId);
    assert.equal(waits.at(-1).outcome.hasMore, false, 'last wait page drained');
    assert.equal(snapshot.runs[0].state, 'ended', 'natural exit recorded');
    assert.ok(snapshot.runs[0].terminal_evidence_id, 'terminal evidence committed');
    assert.equal(snapshot.slots.length, 0, 'capacity returns to zero');
    assert.equal(readFileSync(join(project, 'greeting.txt'), 'utf8'), content);
    assert.equal(snapshot.reports[0]?.path, reportPath);
    writeFileSync(join(output, 'child-report.md'), readFileSync(reportPath), { mode: 0o600 });
    writeFileSync(join(output, 'greeting.txt'), readFileSync(join(project, 'greeting.txt')), { mode: 0o600 });
    json(join(output, 'assertions.json'), {
      ok: true,
      requestKey: spawns[0].args.request_key,
      runId,
      wake: accepted.outcome.advice.wake,
      cursorTrace,
      lastSeenSeq: cursor,
      capacityActive: snapshot.slots.length,
      parentResult,
    });
  } catch (error) {
    failure = error;
    json(join(output, 'failure.json'), { error: error.stack, parentResult });
  } finally {
    clearInterval(observer);
    clearTimeout(timer);
    clearTimeout(hardStop);
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onInterrupt);
    observeOwned();
    // Let successful children finish their normal waitpid/EOF teardown before
    // considering signals. The real cycle must not depend on test cleanup.
    const drainDeadline = Date.now() + 3000;
    while (
      !failure &&
      Date.now() < drainDeadline &&
      [...owned.values()].some((stamp) => processState(stamp) === 'alive')
    ) {
      await delay(100);
      observeOwned();
    }
    // Reap/kill only corroborated instances. Normally every process is already
    // gone; this covers a failed/interrupted paid probe without touching peers.
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      for (const stamp of owned.values())
        if (processState(stamp) === 'alive') {
          try {
            process.kill(stamp.pid, signal);
          } catch (error) {
            if (error.code !== 'ESRCH') throw error;
          }
        }
      await delay(300);
      observeOwned();
    }
    if (done) await done;
    // Preserve failure evidence too, before removing the isolated runtime.
    if (db && !existsSync(join(output, 'ledger.json'))) {
      json(
        join(output, 'ledger.json'),
        db.snapshot((tx) => ({
          runs: tx.all('SELECT run_id,state FROM runs'),
          reports: tx.all('SELECT run_id,status,summary,path FROM reports'),
          events: tx
            .all('SELECT seq,kind,payload FROM events ORDER BY seq')
            .map((row) => ({ ...row, payload: JSON.parse(row.payload) })),
          slots: tx.all('SELECT run_id FROM slots'),
        }))
      );
    }
    await db?.close();
    const processes = [...owned.values()].map((stamp) => ({ stamp, state: processState(stamp) }));
    rmSync(project, { recursive: true, force: true });
    json(join(output, 'cleanup.json'), {
      processes,
      alive: processes.filter((row) => row.state !== 'dead'),
      scratchRemoved: !existsSync(project),
      tmux: 'not used',
      parentResult,
    });
    // Evidence uses synthetic transcripts only, with local source/repo paths
    // replaced. No auth file, user config, launch credential or native user rollout
    // is copied from CODEX_HOME.
    for (const file of readdirSync(output)) {
      const path = join(output, file);
      const text = readFileSync(path, 'utf8');
      // CLI diagnostics can include an external HTML challenge. It is not
      // synthetic task evidence and must not be retained with the transcript.
      const cleaned =
        file.includes('stderr') && /<!doctype|<html/i.test(text)
          ? 'External HTTP HTML diagnostics omitted; not synthetic task evidence.\n'
          : redacted(text);
      writeFileSync(path, cleaned, { mode: 0o600 });
    }
    if (processes.some((row) => row.state !== 'dead')) failure ??= new Error('owned process remains alive/unknown');
  }
  process.stdout.write(JSON.stringify({ ok: !failure, evidence: output, error: failure?.message }) + '\n');
  if (failure) process.exitCode = 1;
}
