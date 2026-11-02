// Offline ONLY: the synthetic harness uses argv0=claude with the Node executable.
// This exercises actual ancestry, scope SQL, private publication and full cold exit,
// and is deliberately never counted as real Claude evidence.
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
const base = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const output = process.argv[2];
const samples = 200;
const [major, minor] = process.versions.node.split('.').map(Number);
if (!((major === 22 && minor >= 13) || major >= 24)) {
  console.log('SKIP hook benchmark: Node 22.x >=22.13 or >=24 required');
  process.exit(0);
}
const stat = (values) => ({
  samples: values.length,
  p95Ms: [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1],
  maxMs: Math.max(...values),
  minMs: Math.min(...values),
});
if (process.env.HUD_SYNTHETIC_HARNESS !== '1') {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...(output ? [output] : [])], {
    argv0: 'claude',
    env: { ...process.env, HUD_SYNTHETIC_HARNESS: '1' },
    stdio: 'inherit',
  });
  const [code] = await once(child, 'exit');
  process.exitCode = code;
} else {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hud-hook-bench-')));
  const build = join(base, 'packages/hud-mcp/dist');
  const { openLedger } = await import(pathToFileURL(join(build, 'src/ledger/ledger.js')));
  const { ReadOnlyScopeSnapshot } = await import(pathToFileURL(join(build, 'src/core/ledger-scope-read.js')));
  const { consumeHookRecord } = await import(pathToFileURL(join(build, 'packages/hud-mcp/src/hook/resolve.js')));
  const { IMPLEMENTATION, CLAUDE_VERSION, hash, recordPaths } = await import(
    pathToFileURL(join(build, 'packages/hud-mcp/src/hook/record.js'))
  );
  const { cleanupHookNamespace } = await import(pathToFileURL(join(build, 'packages/hud-mcp/src/hook/cleanup.js')));
  // The child inherits this explicit source root at birth (/proc/environ is the
  // original environment). Re-exec once to establish it without mutating HOME.
  if (process.env.CLAUDE_CONFIG_DIR !== root && !process.env.HUD_BENCH_ROOT) {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...(output ? [output] : [])], {
      argv0: 'claude',
      env: { ...process.env, CLAUDE_CONFIG_DIR: root, HUD_BENCH_ROOT: root },
      stdio: 'inherit',
    });
    try {
      const [code] = await once(child, 'exit');
      process.exitCode = code;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  } else {
    const sourceRoot = process.env.HUD_BENCH_ROOT;
    let ledger;
    try {
      const hooks = join(root, 'hooks');
      mkdirSync(hooks, { mode: 0o700 });
      const config = {
        version: 1,
        implementation: IMPLEMENTATION,
        claudeVersion: CLAUDE_VERSION,
        claudeExecutable: realpathSync(process.execPath),
        sourceRoot,
        ledgerPath: join(root, 'ledger.sqlite'),
        directory: hooks,
        serverName: 'hud',
        profileFingerprint: 'a'.repeat(64),
        clockTicksPerSecond: 100,
      };
      const configFile = join(root, 'config.json');
      writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
      const { proc } = await import(pathToFileURL(join(build, 'packages/hud-mcp/src/hook/process.js')));
      const processInfo = proc(process.pid);
      const machine = readFileSync('/etc/machine-id', 'utf8').trim(),
        bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      const sourceId = hash(['claude', sourceRoot]);
      const processKey = JSON.stringify([
        'claude',
        sourceId,
        JSON.stringify(['linux', machine, bootId, processInfo.namespace]),
        process.pid,
        processInfo.start,
      ]);
      const sessions = join(sourceRoot, 'sessions');
      mkdirSync(sessions, { recursive: true });
      const sessionId = '01900000-0000-7000-8000-000000000001';
      writeFileSync(
        join(sessions, `${process.pid}.json`),
        JSON.stringify({
          pid: process.pid,
          procStart: processInfo.start,
          pidDomain: `linux:${machine}:${processInfo.namespace}`,
          sessionId,
        }),
        { mode: 0o600 }
      );
      ledger = await openLedger(config.ledgerPath);
      const scopes = new ReadOnlyScopeSnapshot(config.ledgerPath);
      const plainEnv = { ...process.env };
      delete plainEnv.NODE_COMPILE_CACHE;
      const cacheEnv = { ...plainEnv, NODE_COMPILE_CACHE: join(root, 'compile-cache') };
      const results = {};
      for (const [name, env] of [
        ['node-minimal', plainEnv],
        ['node-compile-cache', cacheEnv],
      ]) {
        const values = [];
        for (let i = -1; i < samples; i++) {
          const callId = `${name}-${i}`;
          const input = JSON.stringify({
            hook_event_name: 'PreToolUse',
            session_id: sessionId,
            tool_use_id: callId,
            tool_name: 'mcp__hud__delegate_whoami',
            tool_input: { claim: 'SYNTHETIC-PRIVATE-SENTINEL' },
          });
          const start = performance.now();
          const child = spawnSync(
            process.execPath,
            [join(base, 'packages/hud-mcp/bin/hud-claude-hook.mjs'), configFile],
            { input, env, timeout: 5000 }
          );
          const elapsed = performance.now() - start;
          if (child.status !== 0) throw new Error(`${name}: ${child.stderr} ${child.error ?? ''}`);
          if (i >= 0) values.push(elapsed);
          consumeHookRecord(
            { config, scopes },
            { processKey, sourceId, bootId, callId, toolName: 'mcp__hud__delegate_whoami', sessionId }
          );
        }
        results[name] = stat(values);
      }
      // sh + coreutils cannot parse arbitrary JSON or query SQLite/WAL. Measure
      // its private non-overwriting publication lower bound, NOT a correct helper.
      const lower = [];
      for (let i = 0; i < samples; i++) {
        const start = performance.now();
        const child = spawnSync(
          '/bin/sh',
          [
            '-c',
            'umask 077; p="$1/shell-$2"; printf "%s\\n" "{}" > "$p.tmp" && ln "$p.tmp" "$p.json" && rm "$p.tmp" "$p.json"',
            'hook-bench',
            root,
            String(i),
          ],
          { timeout: 5000 }
        );
        if (child.status !== 0) throw new Error(String(child.stderr));
        lower.push(performance.now() - start);
      }
      results['sh-coreutils-publication-only-NOT-qualified'] = stat(lower);
      const builder = join(root, 'snapshot.cjs'),
        blob = join(root, 'snapshot.blob');
      writeFileSync(
        builder,
        `require('node:fs');require('node:crypto');require('node:v8').startupSnapshot.setDeserializeMainFunction(()=>import(process.env.HUD_SNAPSHOT_ENTRY).then(m=>m.runHook(process.argv[1])).catch(e=>{process.stderr.write(e.message);process.exitCode=1;}));`
      );
      const built = spawnSync(process.execPath, ['--snapshot-blob=' + blob, '--build-snapshot', builder], {
        timeout: 10000,
      });
      const snapshot =
        built.status === 0
          ? spawnSync(process.execPath, ['--snapshot-blob=' + blob, configFile], {
              input: '{}',
              env: {
                ...plainEnv,
                HUD_SNAPSHOT_ENTRY: pathToFileURL(join(build, 'packages/hud-mcp/src/hook/command.js')).href,
              },
              timeout: 5000,
            })
          : built;
      results.snapshot = {
        buildExit: built.status,
        runExit: snapshot.status,
        supportedForThisModuleGraph: false,
        reason: String(snapshot.stderr).slice(0, 1500),
      };
      let files = 0;
      for (const namespace of readdirSync(hooks)) {
        const dir = join(hooks, namespace);
        for (const file of readdirSync(dir)) {
          files++;
          if (readFileSync(join(dir, file), 'utf8').includes('SYNTHETIC-PRIVATE-SENTINEL'))
            throw new Error('Privacy leak');
        }
        const cleaned = cleanupHookNamespace(dir);
        if (!cleaned.complete) throw new Error('Cleanup incomplete');
        if (readdirSync(dir).length) throw new Error('Files remain');
      }
      const result = {
        kind: 'offline-synthetic',
        node: process.version,
        samplesPerCandidate: samples,
        helper: results,
        cleanedPublicationFiles: files,
        residentProcesses: 0,
        note: 'full helper cold launch/read scope/publish/exit, no real Claude or MCP body/DB contention; shell number excludes required parsing/scope/currentness and is unqualified',
      };
      if (output) writeFileSync(output, JSON.stringify(result, null, 2));
      console.log(JSON.stringify(result, null, 2));
    } finally {
      await ledger?.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
}
