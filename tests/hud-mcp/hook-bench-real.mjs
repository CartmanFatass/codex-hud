// Explicitly invoked real Claude probe. It never edits settings/config in the
// Claude home and reads only the exact run-owned sessions/<harnessPid>.json.
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  appendFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const repository = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const compiled = join(repository, 'packages/hud-mcp/dist');
const hookModule = pathToFileURL(join(compiled, 'packages/hud-mcp/src/hook/record.js'));
const { IMPLEMENTATION, CLAUDE_VERSION, hookProfileFingerprint, makeHookSettings, privateRead } = await import(
  hookModule
);
const { ReadOnlyScopeSnapshot } = await import(pathToFileURL(join(compiled, 'src/core/ledger-scope-read.js')));
const profile = (root) => ({
  name: 'synthetic-hook-probe',
  harness: 'claude',
  source: { root, label: 'Synthetic probe' },
  launch: { argv: ['claude', '{{prompt}}'] },
  headless: null,
  resume: null,
  resumeHeadless: null,
  host: { kind: 'none', layout: 'none' },
  env: {},
  mcpServerName: 'b1bprobe',
  claimTransport: 'config_env',
  clientToolTimeoutMs: 60000,
  responseMarginMs: 2000,
  orphan_policy: 'continue',
  managedShellVerified: false,
  callSource: { kind: 'claude_pre_tool_use_v1' },
});
const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
if (process.argv[2] === '--server') {
  const config = JSON.parse(privateRead(process.argv[3], 8192));
  const log = process.argv[4];
  const { LinuxProcessReader } = await import(pathToFileURL(join(compiled, 'packages/hud-mcp/src/process.js')));
  const { registerCaller, MemoryCallerRegistry } = await import(
    pathToFileURL(join(compiled, 'packages/hud-mcp/src/registry.js'))
  );
  const { SessionRefResolver } = await import(pathToFileURL(join(compiled, 'packages/hud-mcp/src/resolvers.js')));
  const { HudMcpServer, serveStdio } = await import(pathToFileURL(join(compiled, 'packages/hud-mcp/src/server.js')));
  const reader = new LinuxProcessReader();
  const p = profile(config.sourceRoot);
  const registration = await registerCaller({
    reader,
    registry: new MemoryCallerRegistry(),
    profile: p,
    pid: process.pid,
    cwd: () => process.cwd(),
    envPane: null,
    nowMs: Date.now(),
  });
  const scopes = new ReadOnlyScopeSnapshot(config.ledgerPath);
  let observed;
  const resolver = new SessionRefResolver(registration, reader, p, undefined, {
    config,
    scopes,
    observe: (sample) => {
      observed = sample;
    },
  });
  let latest;
  const source = {
    resolve: async (meta, toolName) => {
      observed = undefined;
      const entryMonoMs = Number(process.hrtime.bigint()) / 1e6;
      const outcome = await resolver.resolve(meta, toolName);
      latest = {
        toolName,
        sourceVerified: outcome.ok,
        refusal: outcome.ok ? null : outcome.code,
        agent: observed?.agent,
        sessionId: observed?.sessionId,
        callId: meta?.['claudecode/toolUseId'],
        hookStartMonoMs: observed?.hookStartMonoMs,
        hookStartUncertaintyMs: observed?.hookStartUncertaintyMs,
        publishedMonoMs: observed?.publishedMonoMs,
        entryMonoMs,
        resolutionMonoMs: Number(process.hrtime.bigint()) / 1e6,
        mcpPid: process.pid,
        mcpProcStart: registration.caller.procStart,
        harnessPid: registration.harnessPid,
      };
      return outcome;
    },
  };
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = function (chunk, encoding, callback) {
    const observation = latest;
    latest = undefined;
    const onFlush = () => {
      if (observation) {
        const flushMonoMs = Number(process.hrtime.bigint()) / 1e6;
        appendFileSync(
          log,
          JSON.stringify({
            ...observation,
            flushMonoMs,
            jointUpperMs: observation.hookStartMonoMs === undefined ? null : flushMonoMs - observation.hookStartMonoMs,
            jointLowerMs:
              observation.hookStartMonoMs === undefined
                ? null
                : Math.max(0, flushMonoMs - observation.hookStartMonoMs - observation.hookStartUncertaintyMs),
          }) + '\n',
          { mode: 0o600 }
        );
      }
      if (typeof encoding === 'function') encoding();
      else callback?.();
    };
    return typeof encoding === 'string' ? write(chunk, encoding, onFlush) : write(chunk, onFlush);
  };
  await serveStdio(new HudMcpServer(source), process.stdin, process.stdout);
} else {
  const output = process.argv[2];
  if (!output?.startsWith('/'))
    throw new Error('Usage: node hook-bench-real.mjs /absolute/run-owned-evidence-directory [runs<=40]');
  const runs = Number(process.argv[3] ?? 6);
  if (!Number.isSafeInteger(runs) || runs < 1 || runs > 40) throw new Error('At most 40 real Claude runs');
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const version = spawnSync('claude', ['--version'], { encoding: 'utf8' });
  if (version.status !== 0 || !version.stdout.startsWith(CLAUDE_VERSION + ' '))
    throw new Error('Unsupported Claude version');
  const executable = spawnSync('/bin/sh', ['-c', 'command -v claude'], { encoding: 'utf8' }).stdout.trim();
  const sourceRoot = realpathSync(process.env.CLAUDE_CONFIG_DIR || join(process.env.HOME, '.claude'));
  const { openLedger } = await import(pathToFileURL(join(compiled, 'src/ledger/ledger.js')));
  const { cleanupHookNamespace } = await import(pathToFileURL(join(compiled, 'packages/hud-mcp/src/hook/cleanup.js')));
  const children = new Set();
  const all = [],
    projectDirectories = [];
  try {
    for (let run = 0; run < runs; run++) {
      const work = realpathSync(mkdtempSync(join(tmpdir(), 'hud-b1b-real-')));
      const home = join(work, 'hud');
      mkdirSync(home, { mode: 0o700 });
      const hooks = join(home, 'hook');
      mkdirSync(hooks, { mode: 0o700 });
      const ledgerPath = join(home, 'ledger.sqlite');
      const ledger = await openLedger(ledgerPath);
      await ledger.close();
      const config = {
        version: 1,
        implementation: IMPLEMENTATION,
        claudeVersion: CLAUDE_VERSION,
        claudeExecutable: realpathSync(executable),
        sourceRoot,
        ledgerPath,
        directory: hooks,
        serverName: 'b1bprobe',
        profileFingerprint: hookProfileFingerprint(profile(sourceRoot)),
        clockTicksPerSecond: 100,
      };
      const configFile = join(home, 'hook.json');
      writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
      const log = join(output, `run-${run}.jsonl`);
      // Empty companion hook demonstrates coexistence without logging stdin.
      const old = {
        hooks: {
          PreToolUse: [{ matcher: '^mcp__b1bprobe__delegate_whoami$', hooks: [{ type: 'command', command: 'true' }] }],
        },
      };
      const settings = makeHookSettings(
        config,
        `${quote(process.execPath)} ${quote(process.env.HUD_B1B_HOOK_WRAPPER || join(repository, 'packages/hud-mcp/bin/hud-claude-hook.mjs'))} ${quote(configFile)}`,
        old
      );
      const mcp = {
        mcpServers: {
          b1bprobe: {
            command: process.execPath,
            args: [fileURLToPath(import.meta.url), '--server', configFile, log],
            env: { HUD_HOME: home },
          },
        },
      };
      const mcpFile = join(home, 'mcp.json');
      writeFileSync(mcpFile, JSON.stringify(mcp), { mode: 0o600 });
      const prompt =
        run % 2 === 0
          ? 'Synthetic HUD timing probe. Call mcp__b1bprobe__delegate_whoami with {} exactly five times sequentially. The tool returns not_implemented; this is expected. Do not call other tools. Finish with OK.'
          : 'Synthetic HUD source probe. First call mcp__b1bprobe__delegate_whoami with {} once yourself. Then use the Agent tool with subagent_type general-purpose and model haiku to ask a native child to call mcp__b1bprobe__delegate_whoami with {} exactly once (it returns an expected error), and return. After the child returns, call mcp__b1bprobe__delegate_whoami with {} once again yourself. Finish with OK. Do not delegate any other work.';
      const args = [
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
        'mcp__b1bprobe__delegate_whoami',
        'Agent',
        '--output-format',
        'json',
        '--',
        prompt,
      ];
      const env = { ...process.env, HUD_HOME: home };
      delete env.CLAUDECODE;
      if (process.env.HUD_B1B_USE_COMPILE_CACHE === '1') env.NODE_COMPILE_CACHE = join(home, 'compile-cache');
      else delete env.NODE_COMPILE_CACHE;
      let stdout = '',
        stderr = '';
      const child = spawn('claude', args, { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] });
      children.add(child);
      child.stdout.on('data', (b) => {
        if (stdout.length < 262144) stdout += b;
      });
      child.stderr.on('data', (b) => {
        if (stderr.length < 32768) stderr += b;
      });
      const timer = setTimeout(() => child.kill('SIGTERM'), 180000);
      const killer = setTimeout(() => child.kill('SIGKILL'), 185000);
      const [exit, signal] = await once(child, 'exit');
      clearTimeout(timer);
      clearTimeout(killer);
      children.delete(child);
      writeFileSync(join(output, `run-${run}-result.json`), JSON.stringify({ exit, signal, stdout, stderr }), {
        mode: 0o600,
      });
      const rows = (() => {
        try {
          return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
        } catch {
          return [];
        }
      })();
      all.push(...rows.map((row) => ({ run, ...row })));
      const slug = work.replace(/[^a-zA-Z0-9]/g, '-');
      projectDirectories.push(join(sourceRoot, 'projects', slug));
      // The owning harness has exited. Check only its observed, exact MCP PIDs.
      const remaining = [...new Set(rows.map((r) => r.mcpPid))].filter((pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      });
      if (remaining.length) throw new Error('Run-owned MCP still resident after harness exit: ' + remaining.join(','));
      let removed = 0;
      for (const name of readdirSync(hooks)) {
        const result = cleanupHookNamespace(join(hooks, name));
        if (!result.complete) throw new Error('Cleanup budget exceeded');
        removed += result.removed;
      }
      rmSync(work, { recursive: true, force: true });
      console.log(
        JSON.stringify({
          run,
          exit,
          calls: rows.length,
          sourceVerified: rows.filter((r) => r.sourceVerified).length,
          nativeRefused: rows.filter((r) => !r.sourceVerified && r.agent === 'native_child').length,
          cleanedFiles: removed,
        })
      );
    }
    const stats = (values) =>
      values.length
        ? {
            samples: values.length,
            p95Ms: [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1],
            maxMs: Math.max(...values),
          }
        : { samples: 0, p95Ms: null, maxMs: null };
    const result = {
      kind: 'real-Claude-source-only',
      claudeVersion: CLAUDE_VERSION,
      node: process.version,
      runs,
      success: stats(
        all
          .filter((r) => r.sourceVerified)
          .map((r) => r.jointUpperMs)
          .filter((v) => v !== null)
      ),
      refusal: stats(
        all
          .filter((r) => !r.sourceVerified)
          .map((r) => r.jointUpperMs)
          .filter((v) => v !== null)
      ),
      missingStart: all.filter((r) => r.jointUpperMs === null).length,
      calls: all,
      projectDirectories,
      clock:
        'BOOTTIME kernel start converted to MONOTONIC with bracketed /proc/uptime; jointUpperMs uses a conservative start, jointLowerMs subtracts the fingerprinted per-call uncertainty (20ms plus uptime-read duration)',
      limit:
        'source resolution success only; tools return not_implemented. No B5 claim/idempotency/authorization transaction or injected DB write wait; this is not the complete production F08 gate.',
    };
    writeFileSync(join(output, 'summary.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ ...result, calls: result.calls.length }, null, 2));
  } finally {
    for (const child of children) child.kill('SIGKILL');
  }
}
