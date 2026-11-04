import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

/** Closed test profiles, not a product runtime-support predicate.
 * Sources: nodejs/node v22.23.4 and v24.22.1, lib/internal/process/
 * {pre_execution,warning}.js and deps/undici/src/lib/dispatcher/env-http-proxy-agent.js.
 */
export interface DiagnosticProfile {
  version: '22.23.4' | '24.22.1';
  release: 'node';
  proxyStartup: boolean;
}

export function diagnosticProfile(
  env: NodeJS.ProcessEnv = process.env,
  childExecArgv: readonly string[] = []
): DiagnosticProfile {
  assert.ok(
    process.versions.node === '22.23.4' || process.versions.node === '24.22.1',
    `Unexamined diagnostic profile ${process.versions.node}; record a source-backed expectation before crediting it`
  );
  assert.equal(process.release.name, 'node');
  for (const name of ['NODE_OPTIONS', 'NODE_NO_WARNINGS', 'NODE_REDIRECT_WARNINGS']) {
    assert.equal(env[name], undefined, `Unexpected ${name}; do not erase inherited diagnostic settings`);
  }
  // Validate the actual child flags, not the Node 24 test runner's normalized
  // parent execArgv (which materializes inherited NODE_USE_ENV_PROXY as a flag).
  assert.ok(
    childExecArgv.every(
      (arg) =>
        !/^--(?:no-warnings|trace-warnings|trace-deprecation|no-deprecation|disable-warning|redirect-warnings|diagnostic-dir|require|import|loader|experimental-loader|use-env-proxy)(?:=|$)/.test(
          arg
        ) && arg !== '-r'
    ),
    'Unexpected child diagnostic/preload/activation argv settings'
  );
  assert.ok(env.NODE_USE_ENV_PROXY === undefined || env.NODE_USE_ENV_PROXY === '1', 'Undeclared envproxy opt-in');
  return {
    version: process.versions.node as DiagnosticProfile['version'],
    release: 'node',
    proxyStartup:
      env.NODE_USE_ENV_PROXY === '1' &&
      ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'].some((name) => !!env[name]),
  };
}

export function traceHint(argv0 = process.execPath): string {
  return `(Use \`${basename(argv0, '.exe')} --trace-warnings ...\` to show where the warning was created)\n`;
}

export function startupStderr(profile: DiagnosticProfile, pid: number, argv0 = process.execPath): Buffer {
  assert.ok(Number.isSafeInteger(pid) && pid > 0, 'Known child PID required');
  return Buffer.from(
    profile.version === '22.23.4' && profile.proxyStartup
      ? `(${profile.release}:${pid}) [UNDICI-EHPA] Warning: EnvHttpProxyAgent is experimental, expect them to change at any time.\n${traceHint(argv0)}`
      : ''
  );
}

export interface RawCapture {
  stdout: Buffer | null;
  stderr: Buffer | null;
  status: number | null;
  signal: string | null;
  pid: number;
}

/** Optional lossless synthetic evidence. Never dumps an environment or alters a capture. */
export function retainCapture(label: string, capture: RawCapture): void {
  const dir = process.env.NODE_PROXY_EVIDENCE_DIR;
  if (!dir) return;
  assert.match(label, /^[a-zA-Z0-9_-]+$/);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const prefix = join(dir, `${label}-${process.pid}-${capture.pid}`);
  for (const stream of ['stdout', 'stderr'] as const) {
    if (capture[stream] !== null) writeFileSync(`${prefix}.${stream}`, capture[stream]!, { mode: 0o600 });
  }
  writeFileSync(
    `${prefix}.json`,
    JSON.stringify({
      label,
      pid: capture.pid,
      status: capture.status,
      signal: capture.signal,
      version: process.versions.node,
    }) + '\n',
    { mode: 0o600 }
  );
}

export function assertRawResult(actual: RawCapture, expected: Omit<RawCapture, 'pid'>): void {
  assert.equal(actual.signal, expected.signal, 'exact signal');
  assert.equal(actual.status, expected.status, 'exact exit status');
  assert.deepEqual(actual.stdout, expected.stdout, 'exact stdout bytes');
  assert.deepEqual(actual.stderr, expected.stderr, 'exact stderr bytes');
}

/** Imports no HUD/SQLite, does not fetch, and validates source-derived bytes BEFORE any HUD child. */
export function validateStartup(env: NodeJS.ProcessEnv = process.env): DiagnosticProfile {
  const profile = diagnosticProfile(env);
  const result = spawnSync(process.execPath, ['-e', ''], { env, timeout: 8000, maxBuffer: 64 * 1024 });
  retainCapture('startup', result);
  assert.ifError(result.error);
  assertRawResult(result, {
    status: 0,
    signal: null,
    stdout: Buffer.alloc(0),
    stderr: startupStderr(profile, result.pid),
  });
  return profile;
}
