// Explicit paid B45 integration probe. Synthetic prompts only; production cells
// remain unverified. This executable injects a TEST-ONLY capability verifier.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const script = fileURLToPath(import.meta.url);
const compiled = join(repo, 'packages/hud-mcp/dist');
const load = (path) => import(pathToFileURL(join(compiled, path)));
const { openLedger } = await load('src/ledger/ledger.js');
function reserveRun(file, harness, kind, runId = null) {
  let rows = [];
  try {
    rows = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (rows.filter((r) => r.harness === harness).length >= 30) throw new Error('B45 real-run budget exhausted');
  appendFileSync(file, JSON.stringify({ harness, kind, runId, at: Date.now() }) + '\n', { mode: 0o600 });
}
if (process.argv[2] === '--server') {
  const cfg = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  const log = process.argv[4];
  const { LinuxProcessReader } = await load('packages/hud-mcp/src/process.js');
  const { registerCaller } = await load('packages/hud-mcp/src/registry.js');
  const { createLedgerCallerRegistry } = await load('packages/hud-mcp/src/ledger-registry.js');
  const { SessionRefResolver } = await load('packages/hud-mcp/src/resolvers.js');
  const { scopeSnapshot } = await load('src/ledger/call-context.js');
  const { HudMcpServer, serveStdio } = await load('packages/hud-mcp/src/server.js');
  const { DelegationService } = await load('packages/hud-mcp/src/delegation.js');
  const { readHookConfig } = await load('packages/hud-mcp/src/hook/record.js');
  const registry = await createLedgerCallerRegistry(cfg.home),
    reader = new LinuxProcessReader();
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
  const scopes = { read: (key) => registry.ledger.snapshot((tx) => scopeSnapshot(tx, registry.ledger.ledgerId, key)) };
  let observation;
  const hook =
    profile.harness === 'claude'
      ? {
          config: readHookConfig(cfg.hookFile),
          scopes,
          observe: (sample) => {
            observation = sample;
          },
        }
      : undefined;
  const source = new SessionRefResolver(registration, reader, profile, undefined, hook, scopes);
  const { launchPreparedRun } = await load('src/core/launch/index.js');
  const bodies = new DelegationService({
    launch: async (prepared, ticket, options) => {
      reserveRun(cfg.budgetFile, 'codex', 'child', prepared.input.runId);
      return launchPreparedRun(prepared, ticket, options);
    },
    ledger: registry.ledger,
    home: cfg.home,
    config: cfg.config,
    registration,
    reader,
    codexConfig: cfg.codexConfig,
    capability: { verify: () => ({ ok: true, reason: null }) },
    hudRunPath: join(repo, 'bin/hud-run'),
  });
  const server = new HudMcpServer(source, bodies);
  const original = server.handle.bind(server);
  let sample;
  server.handle = async (value) => {
    observation = undefined;
    const started = Number(process.hrtime.bigint()) / 1e6;
    const result = await original(value);
    if (value?.method === 'tools/call')
      sample = {
        tool: value.params.name,
        mcpMs: Number(process.hrtime.bigint()) / 1e6 - started,
        outcome: result?.result?.structuredContent,
        ...(observation
          ? { hookStartMonoMs: observation.hookStartMonoMs, hookStartUncertaintyMs: observation.hookStartUncertaintyMs }
          : {}),
        mcpPid: process.pid,
      };
    return result;
  };
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = function (chunk, encoding, callback) {
    const current = sample;
    sample = undefined;
    const flushed = () => {
      if (current)
        appendFileSync(
          log,
          JSON.stringify({
            ...current,
            jointUpperMs:
              current.hookStartMonoMs === undefined
                ? null
                : Number(process.hrtime.bigint()) / 1e6 - current.hookStartMonoMs,
          }) + '\n',
          { mode: 0o600 }
        );
      if (typeof encoding === 'function') encoding();
      else callback?.();
    };
    return typeof encoding === 'string' ? originalWrite(chunk, encoding, flushed) : originalWrite(chunk, flushed);
  };
  await serveStdio(server, process.stdin, process.stdout);
  await registry.ledger.close();
} else if (process.argv[2] === '--await-run') {
  const ledger = await openLedger(join(process.argv[3], 'ledger.sqlite'));
  try {
    const until = Date.now() + 120000;
    while (Date.now() < until) {
      const value = ledger.snapshot((tx) => tx.get('SELECT state FROM runs WHERE run_id=?', process.argv[4]));
      if (['ended', 'failed', 'cancelled'].includes(value?.state)) {
        process.stdout.write(JSON.stringify(value));
        process.exitCode = 0;
        break;
      }
      await delay(250);
    }
  } finally {
    await ledger.close();
  }
} else {
  const output = process.argv[2],
    kind = process.argv[3] ?? 'codex';
  if (!output?.startsWith('/') || !['codex', 'claude'].includes(kind))
    throw new Error('usage: b45-real.mjs /absolute/evidence <codex|claude>');
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'hud-b45-real-'))),
    home = join(project, 'hud');
  mkdirSync(home, { mode: 0o700 });
  const ledger = await openLedger(join(home, 'ledger.sqlite'));
  await ledger.close();
  const codexRoot = realpathSync(process.env.CODEX_HOME || join(homedir(), '.codex'));
  const claudeRoot = realpathSync(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'));
  const codex = realpathSync(spawnSync('/bin/sh', ['-c', 'command -v codex'], { encoding: 'utf8' }).stdout.trim());
  const claude = realpathSync(spawnSync('/bin/sh', ['-c', 'command -v claude'], { encoding: 'utf8' }).stdout.trim());
  const cfgFile = join(home, 'probe.json'),
    log = join(output, `${kind}-calls.jsonl`);
  const serverArgs = [script, '--server', cfgFile, log];
  const server = {
    command: process.execPath,
    args: serverArgs,
    env: { HUD_HOME: home, HUD_MCP_PROFILE: 'child-codex' },
  };
  const overrides = Object.entries({
    command: server.command,
    args: server.args,
    default_tools_approval_mode: 'approve',
  }).flatMap(([key, value]) => ['-c', `mcp_servers.b45.${key}=${JSON.stringify(value)}`]);
  const envArgs = Object.entries(server.env).flatMap(([key, value]) => [
    '-c',
    `mcp_servers.b45.env.${key}=${JSON.stringify(value)}`,
  ]);
  const routingEnv = Object.fromEntries(
    ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'NODE_USE_ENV_PROXY']
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]])
  );
  const profile = (name, harness, root) => ({
    name,
    harness,
    source: { root, label: 'Synthetic B45 probe' },
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
        ...overrides,
        ...envArgs,
        '-',
      ],
    },
    resume: { argv: [codex, 'resume', '{{sessionId}}'] },
    resumeHeadless: {
      argv: [
        codex,
        '-c',
        'features.apps=false',
        'exec',
        'resume',
        '--ignore-user-config',
        '--skip-git-repo-check',
        '--json',
        ...overrides,
        ...envArgs,
        '{{sessionId}}',
        '-',
      ],
    },
    host: { kind: 'none', layout: 'none' },
    env: harness === 'codex' ? { ...routingEnv, CODEX_HOME: root } : {},
    mcpServerName: 'b45',
    claimTransport: 'config_env',
    clientToolTimeoutMs: 60000,
    responseMarginMs: 2000,
    orphan_policy: 'continue',
    managedShellVerified: false,
    roles: { implementer: { model: 'gpt-6.1-sol', effort: 'low' } },
    ...(harness === 'claude' ? { callSource: { kind: 'claude_pre_tool_use_v1' } } : {}),
  });
  const config = {
    version: 1,
    profiles: [
      profile('parent-codex', 'codex', codexRoot),
      profile('parent-claude', 'claude', claudeRoot),
      profile('child-codex', 'codex', codexRoot),
    ],
  };
  const cfg = {
    home,
    project,
    config,
    budgetFile: join(dirname(output), 'real-runs.jsonl'),
    codexConfig: { mcp_servers: { b45: server } },
  };
  const recovery = process.argv[4] === 'recovery';
  // Resolve the supervisor's root build before starting any paid harness. The
  // MCP package intentionally does not compile its unrelated CLI/run adapter.
  const rootLoad = (path) => import(pathToFileURL(join(repo, 'dist', path)));
  const runProcess = await rootLoad('core/run/process.js');
  const recoveryRuntime = recovery
    ? Object.assign(
        {},
        ...(await Promise.all([
          rootLoad('core/run/ledger-port.js'),
          rootLoad('core/run/control.js'),
          rootLoad('ledger/local-manager.js'),
          rootLoad('core/supervision.js'),
        ]))
      )
    : null;
  const brief = join(project, 'brief.md');
  writeFileSync(
    brief,
    'Synthetic integration task: call delegate_whoami with {} to bind this run. If pending or busy, retry the same call at most twice. Use runId returned by whoami to call delegate_report with status completed and summary "Synthetic B45 child complete". ' +
      (recovery
        ? 'After the report, execute the single shell command sleep 3, then finish OK.'
        : 'Use only HUD MCP tools, then finish OK.') +
      ' Do not spawn another agent.\n',
    { mode: 0o600 }
  );
  const prompt = recovery
    ? `Synthetic recovery probe. Call mcp__b45__delegate_spawn with ${JSON.stringify({ backend: 'child-codex', role: 'implementer', brief, cwd: project, mode: 'headless', request_key: 'synthetic-recovery' })}. Retry only busy with identical arguments at most twice. After accepted finish OK immediately; do not wait, resume, cancel or launch another request.`
    : `Synthetic B45 delegation integration. Call mcp__b45__delegate_spawn exactly once with ${JSON.stringify({ backend: 'child-codex', role: 'implementer', brief, cwd: project, mode: 'headless', request_key: 'synthetic-spawn' })}. After accepted, run this exact command with the returned runId as last argument: ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} --await-run ${JSON.stringify(home)} RUN_ID. Then call mcp__b45__delegate_resume with linkId returned by spawn, mode headless, request_key synthetic-resume, and prompt "Synthetic second turn: bind using current env claim and report completed for current run, then finish OK." After accepted run the same await command using new runId. If a call returns busy, retry the exact same tool arguments and request_key at most twice. Never retry an accepted request or any other refusal; stop and report other codes. Do not invoke other delegation requests. Finish with OK.`;
  let args,
    executable,
    environment = { ...process.env, HUD_HOME: home, CODEX_HOME: codexRoot };
  if (kind === 'codex') {
    executable = codex;
    args = [
      '-c',
      'features.apps=false',
      '-c',
      'mcp_servers.b45.default_tools_approval_mode="approve"',
      '--model',
      'gpt-6.1-sol',
      '-c',
      'model_reasoning_effort="low"',
      'exec',
      '--ignore-user-config',
      '--skip-git-repo-check',
      '--json',
      '-c',
      `mcp_servers.b45.command=${JSON.stringify(process.execPath)}`,
      '-c',
      `mcp_servers.b45.args=${JSON.stringify(serverArgs)}`,
      '-c',
      `mcp_servers.b45.env.HUD_HOME=${JSON.stringify(home)}`,
      '-c',
      'mcp_servers.b45.env.HUD_MCP_PROFILE="parent-codex"',
      '-',
    ];
  } else {
    const { IMPLEMENTATION, CLAUDE_VERSION, hookProfileFingerprint, makeHookSettings } = await load(
      'packages/hud-mcp/src/hook/record.js'
    );
    const directory = join(home, 'hooks');
    mkdirSync(directory, { mode: 0o700 });
    const hook = {
      version: 1,
      implementation: IMPLEMENTATION,
      claudeVersion: CLAUDE_VERSION,
      claudeExecutable: claude,
      sourceRoot: claudeRoot,
      ledgerPath: join(home, 'ledger.sqlite'),
      directory,
      serverName: 'b45',
      profileFingerprint: hookProfileFingerprint(config.profiles[1]),
      clockTicksPerSecond: 100,
    };
    cfg.hookFile = join(home, 'hook.json');
    writeFileSync(cfg.hookFile, JSON.stringify(hook), { mode: 0o600 });
    const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
    const settings = makeHookSettings(
      hook,
      `${quote(process.execPath)} ${quote(join(repo, 'packages/hud-mcp/bin/hud-claude-hook.mjs'))} ${quote(cfg.hookFile)}`,
      {
        hooks: {
          PreToolUse: [{ matcher: '^mcp__b45__delegate_spawn$', hooks: [{ type: 'command', command: 'true' }] }],
        },
      }
    );
    const mcpFile = join(home, 'mcp.json');
    writeFileSync(
      mcpFile,
      JSON.stringify({
        mcpServers: {
          b45: {
            command: process.execPath,
            args: serverArgs,
            env: { HUD_HOME: home, HUD_MCP_PROFILE: 'parent-claude' },
          },
        },
      }),
      { mode: 0o600 }
    );
    executable = claude;
    args = [
      '-p',
      '--model',
      'haiku',
      '--effort',
      'low',
      '--settings',
      JSON.stringify(settings),
      '--mcp-config',
      mcpFile,
      '--strict-mcp-config',
      '--allowedTools',
      'mcp__b45__delegate_spawn',
      'mcp__b45__delegate_resume',
      'Bash',
      '--output-format',
      'json',
      '--',
      prompt,
    ];
    delete environment.CLAUDECODE;
  }
  writeFileSync(cfgFile, JSON.stringify(cfg), { mode: 0o600 });
  let stdout = '',
    stderr = '';
  reserveRun(cfg.budgetFile, kind, 'parent');
  const child = spawn(executable, args, {
    cwd: project,
    env: environment,
    argv0: kind === 'claude' ? 'claude' : undefined,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  writeFileSync(
    join(output, `${kind}-launcher.json`),
    JSON.stringify({
      project,
      home,
      parent: runProcess.readProcess(child.pid)?.stamp ?? null,
      scenario: recovery ? 'recovery' : 'loop',
    }),
    { mode: 0o600 }
  );
  child.stdout.on('data', (b) => {
    if (stdout.length < 2_000_000) stdout += b;
    appendFileSync(join(output, `${kind}-parent.stdout.jsonl`), b, { mode: 0o600 });
  });
  child.stderr.on('data', (b) => {
    if (stderr.length < 131072) stderr += b;
  });
  const timer = setTimeout(() => child.kill('SIGTERM'), 240000),
    killer = setTimeout(() => child.kill('SIGKILL'), 245000);
  if (kind === 'codex') child.stdin.end(prompt);
  else child.stdin.end();
  const recoveryObservation = recovery
    ? (async () => {
        const db = await openLedger(join(home, 'ledger.sqlite'));
        const { createRunFactPort, HeadlessRunControl, PrivateLedgerGate, sameProcessStamp } = recoveryRuntime;
        const { readProcess, processState } = runProcess;
        const port = await createRunFactPort(home),
          control = new HeadlessRunControl(port, home, new PrivateLedgerGate(home).actor());
        const deadline = Date.now() + 180000;
        const trace = [];
        let snapshot;
        try {
          while (Date.now() < deadline) {
            if (
              (child.exitCode !== null || child.signalCode !== null) &&
              !db.snapshot((tx) => tx.get('SELECT 1 FROM runs LIMIT 1'))
            )
              throw new Error('parent_ended_before_acceptance');
            const run = db.snapshot((tx) =>
              tx.get(
                'SELECT r.run_id FROM runs r JOIN child_bindings b ON b.run_id=r.run_id WHERE b.is_current=1 LIMIT 1'
              )
            );
            if (run) {
              snapshot = await port.read(run.run_id);
              break;
            }
            await delay(50);
          }
          if (!snapshot?.meta?.harness) throw new Error('recovery child never bound');
          const { run, meta } = snapshot;
          if (!sameProcessStamp(readProcess(run.supervisor.pid)?.stamp ?? null, run.supervisor))
            throw new Error('supervisor instance changed');
          process.kill(run.supervisor.pid, 'SIGKILL');
          trace.push({ step: 'supervisor_sigkill', runId: run.runId, at: Date.now() });
          const uncertain = await control.reconcile(run.runId);
          const held = await port.read(run.runId);
          if (uncertain.currentRun.state !== 'uncertain' || !held.slotHeld)
            throw new Error('supervisor death did not retain uncertain slot');
          trace.push({ step: 'uncertain_slot_held', at: Date.now() });
          while (Date.now() < deadline && processState(meta.harness) !== 'dead') await delay(100);
          let final;
          while (Date.now() < deadline) {
            final = await control.reconcile(run.runId);
            if (['ended', 'cancelled'].includes(final.currentRun.state)) break;
            await delay(100);
          }
          const finished = await port.read(run.runId);
          if (!['ended', 'cancelled'].includes(finished.run.state) || finished.slotHeld || finished.receipt !== null)
            throw new Error('receiptless Q recovery missing');
          if (finished.events.filter((e) => e.kind === 'launch.submitting').length !== 1)
            throw new Error('duplicate submission');
          trace.push({
            step: 'receiptless_recovered',
            state: finished.run.state,
            nativeExit: finished.run.exitCode,
            at: Date.now(),
          });
          return { ok: true, trace };
        } catch (error) {
          // Cleanup only the exact owned scope/stamps, never a process name or a
          // numeric group whose original leader can no longer be corroborated.
          const meta = snapshot?.meta;
          if (
            meta?.scope &&
            sameProcessStamp(readProcess(meta.scope.group_leader.pid)?.stamp ?? null, meta.scope.group_leader)
          ) {
            try {
              process.kill(-meta.scope.pgid, 'SIGKILL');
              trace.push({ step: 'owned_scope_cleanup', at: Date.now() });
            } catch {}
          }
          if (meta?.supervisor && sameProcessStamp(readProcess(meta.supervisor.pid)?.stamp ?? null, meta.supervisor)) {
            try {
              process.kill(meta.supervisor.pid, 'SIGKILL');
            } catch {}
          }
          return { ok: false, error: error.message, trace };
        } finally {
          await port.close();
          await db.close();
        }
      })()
    : Promise.resolve(null);
  const result = await new Promise((done) => {
    child.once('exit', (code, signal) => done({ code, signal }));
    child.once('error', (error) => done({ error: error.message }));
  });
  clearTimeout(timer);
  clearTimeout(killer);
  const recoveryResult = await recoveryObservation;
  if (recoveryResult)
    writeFileSync(join(output, `${kind}-recovery.json`), JSON.stringify(recoveryResult, null, 2), { mode: 0o600 });
  writeFileSync(
    join(output, `${kind}-parent.json`),
    JSON.stringify(
      {
        ...result,
        stdout,
        stderr,
        project,
        home,
        ...(kind === 'claude'
          ? { claudeProjectDirectory: join(claudeRoot, 'projects', project.replace(/[^a-zA-Z0-9]/g, '-')) }
          : {}),
      },
      null,
      2
    ),
    { mode: 0o600 }
  );
  const db = await openLedger(join(home, 'ledger.sqlite'));
  const snapshot = db.snapshot((tx) => ({
    runs: tx.all('SELECT run_id,run_seq,state,launch_phase,created_at,started_at FROM runs ORDER BY created_at'),
    reports: tx.all('SELECT run_id,status,summary FROM reports'),
    events: tx.all('SELECT run_id,kind,at FROM events WHERE run_id IS NOT NULL ORDER BY seq'),
    slots: tx.all('SELECT run_id FROM slots'),
  }));
  await db.close();
  writeFileSync(join(output, `${kind}-ledger.json`), JSON.stringify(snapshot, null, 2), { mode: 0o600 });
  process.stdout.write(
    JSON.stringify({
      kind,
      ...result,
      project,
      home,
      runs: snapshot.runs,
      reports: snapshot.reports,
      submissions: snapshot.events.filter((e) => e.kind === 'launch.submitting').length,
    }) + '\n'
  );
}
