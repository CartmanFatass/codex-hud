/** SIMULATED installed-startup composition. Not a compiler, package or provider qualification. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { isBuiltin, stripTypeScriptTypes } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  REQUIRED,
  INSTALLER_FILES,
  CELLS,
  DEPENDENCIES,
  verifyBundle,
} from '../../scripts/runtime-package/manifest.mjs';

export const SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const MODULES = Object.freeze([
  'packages/hud-mcp/src/managed-runtime.ts',
  'packages/hud-mcp/src/process.ts',
  'packages/hud-mcp/src/io.ts',
  'packages/hud-mcp/src/errors.ts',
  'packages/hud-mcp/src/config.ts',
  // Config reexports the native factory; preserve its real bounded import closure
  // even though this historical qualification fixture never dispatches a provider.
  'src/managed/host-config.ts',
  'src/managed/types.ts',
  'src/harness/codex/managed-adapter.ts',
  'src/harness/codex/app-server-transport.ts',
  'src/harness/codex/app-server.ts',
  'src/harness/claude/sdk-adapter.ts',
  'src/harness/pi/rpc-adapter.ts',
  'src/harness/pi/native-rpc-transport.ts',
  'packages/hud-mcp/src/registry.ts',
  'packages/hud-mcp/src/pi-host.ts',
  'src/cli/capability.ts',
  'src/core/capabilities.ts',
  'src/core/canonical.ts',
  'src/core/capability-manifest.ts',
  'src/core/identity.ts',
  'src/core/runtime-build.ts',
  'src/core/runtime-dependencies.ts',
  'src/core/launch/fingerprint.ts',
  'src/core/process-domain.ts',
  'src/core/link/limits.ts',
  'src/core/capacity.ts',
  'src/harness/pi/delegation-context.ts',
]);
const REGRESSION = ['tests/fixtures/managed-native-build.ts', 'tests/unit/runtime-build.test.ts'];
export const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const gitBlob = (data) => createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
export const json = (value) => JSON.stringify(value, null, 2) + '\n';
export function write(file, bytes, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, bytes, { mode });
  fs.chmodSync(file, mode);
}
export function stamp(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
    return { pid, start: fields[19], state: fields[0] };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
export function alive(identity) {
  const current = stamp(identity.pid);
  return current && current.start === identity.start && !['Z', 'X'].includes(current.state);
}

/** A finite direct-child runner. Never claims cleanup on exit without pipe closure. */
export async function run(context, name, executable, args, options = {}) {
  assert.equal(context.uncertain, false, 'stop after uncertain cleanup');
  const timeout = options.timeout ?? 15000;
  const receipt = {
    name,
    executable,
    args,
    timeout,
    cleanupTimeout: 3000,
    outputLimit: 2 * 1024 * 1024,
    startedAt: Date.now(),
    exit: false,
    close: false,
    cleanup: 'UNKNOWN',
  };
  context.processes.push(receipt);
  const fd = options.descriptor ? fs.openSync(options.descriptor, 'r') : undefined;
  let child;
  try {
    child = spawn(executable, args, {
      cwd: context.cwd,
      env: options.env ?? context.env,
      stdio: ['pipe', 'pipe', 'pipe', ...(fd === undefined ? [] : [fd])],
      detached: false,
    });
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  receipt.pid = child.pid;
  receipt.identity = child.pid ? stamp(child.pid) : null;
  let stdout = '',
    stderr = '',
    size = 0,
    failure,
    ended = false;
  const signal = (sig) => {
    if (receipt.identity && alive(receipt.identity)) child.kill(sig);
  };
  const abort = (reason) => {
    if (!failure) {
      failure = reason;
      signal('SIGTERM');
    }
  };
  child.stdout.on('data', (data) => {
    size += data.length;
    if (size > receipt.outputLimit) abort('output_limit');
    else stdout += data;
  });
  child.stderr.on('data', (data) => {
    size += data.length;
    if (size > receipt.outputLimit) abort('output_limit');
    else stderr += data;
  });
  child.stdin.on('error', (error) => {
    if (error.code !== 'EPIPE') abort(error.message);
  });
  child.stdin.end(options.input ?? '');
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      abort('deadline');
      cleanupTimer = setTimeout(() => {
        // Do not kill the native parent first and orphan its child. Preserve evidence.
        context.uncertain = true;
        child.stdout.destroy();
        child.stderr.destroy();
        child.stdin.destroy();
        child.unref();
        ended = true;
        resolve();
      }, receipt.cleanupTimeout);
    }, timeout);
    let cleanupTimer;
    child.on('error', (error) => {
      failure = error.message;
    });
    child.on('exit', (code, sig) => {
      receipt.exit = true;
      receipt.code = code;
      receipt.signal = sig;
    });
    child.on('close', (code, sig) => {
      receipt.close = true;
      receipt.code = code;
      receipt.signal = sig;
      clearTimeout(timer);
      clearTimeout(cleanupTimer);
      if (!ended) resolve();
    });
  });
  receipt.endedAt = Date.now();
  receipt.stdoutSha256 = sha256(stdout);
  receipt.stderrSha256 = sha256(stderr);
  receipt.cleanup = receipt.close && (receipt.exit || !receipt.pid) ? 'REAPED_AND_CLOSED' : 'UNKNOWN';
  receipt.failure = failure ?? null;
  if (receipt.cleanup === 'UNKNOWN') context.uncertain = true;
  context.outputs.push({ name, stdout, stderr });
  if (failure || context.uncertain) throw new Error(`${name}: ${failure ?? 'cleanup_unknown'}`);
  return { status: receipt.code, stdout, stderr, receipt };
}

function imports(code) {
  // The finite emitter accepts static ESM only. No computed imports, require or hooks.
  // Only the public SDK's literal lazy imports are admitted; provider invocation
  // is outside this legacy fixture and the SDK is not materialized here.
  code = code.replace(/\bimport\s*\(\s*['"]@anthropic-ai\/claude-agent-sdk['"]\s*\)/g, 'undefined');
  if (/\bimport\s*\(|\brequire\s*\(|\bregisterHooks\s*\(/.test(code))
    throw new Error('unexpected_dynamic_import_or_loader');
  const values = [];
  for (const match of code.matchAll(/\b(?:import|export)\s+(?:[^;'"`]*?\s+from\s*)?['"]([^'"]+)['"]/g))
    values.push(match[1]);
  return values;
}
export async function emit(context, root, regression = false) {
  assert.equal(process.versions.node, '24.22.1', 'pinned builtin transform runtime');
  write(path.join(root, 'package.json'), json({ type: 'module' }));
  const allowed = [...MODULES, ...(regression ? REGRESSION : [])];
  const emitted = new Map();
  for (const source of allowed) {
    const bytes = fs.readFileSync(path.join(SOURCE, source));
    const code = stripTypeScriptTypes(bytes.toString('utf8'), { mode: 'transform' });
    const output = source.replace(/\.ts$/, '.js');
    emitted.set(output, code);
    context.emissions.push({
      source,
      inputGitBlob: gitBlob(bytes),
      inputSha256: sha256(bytes),
      output,
      outputSha256: sha256(code),
      node: process.versions.node,
      mode: 'transform',
      typeChecked: false,
    });
  }
  const syntheticMain = fs.readFileSync(path.join(SOURCE, 'tests/fixtures/runtime-compose-main.mjs'), 'utf8');
  const mainPath = 'packages/hud-mcp/src/main.js';
  for (const specifier of imports(syntheticMain)) {
    if (specifier.startsWith('node:') && isBuiltin(specifier)) continue;
    assert.ok(specifier.startsWith('.'));
    assert.ok(
      emitted.has(path.posix.normalize(path.posix.join(path.posix.dirname(mainPath), specifier))),
      `synthetic main import: ${specifier}`
    );
  }
  context.importClosure.push({ output: mainPath, imports: imports(syntheticMain), syntheticDriver: true });
  for (const [output, code] of emitted) {
    const dependencies = imports(code);
    for (const specifier of dependencies) {
      if (specifier.startsWith('node:') && isBuiltin(specifier)) continue;
      assert.ok(specifier.startsWith('.'), `unexpected external import: ${specifier}`);
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(output), specifier));
      assert.ok(emitted.has(resolved), `import outside bounded graph: ${output} -> ${specifier}`);
    }
    context.importClosure.push({ output, imports: dependencies });
    write(path.join(root, output), code);
    const check = await run(context, `syntax:${output}`, process.execPath, ['--check', path.join(root, output)]);
    assert.equal(check.status, 0, check.stderr);
  }
  write(path.join(root, 'package.json'), json({ type: 'module' }));
  return import(pathToFileURL(path.join(root, 'src/core/runtime-build.js')).href);
}

export async function createContext(label) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'runtime-compose-'));
  fs.chmodSync(root, 0o700);
  const context = {
    root,
    label,
    uncertain: false,
    processes: [],
    outputs: [],
    emissions: [],
    importClosure: [],
    checks: [],
  };
  for (const name of ['home', 'hud', 'source', 'target-source', 'claude', 'tmp', 'unrelated'])
    fs.mkdirSync(path.join(root, name), { mode: 0o700 });
  context.cwd = path.join(root, 'unrelated');
  context.env = {
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: path.join(root, 'home'),
    HUD_HOME: path.join(root, 'hud'),
    CODEX_HOME: path.join(root, 'source'),
    CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
    TMPDIR: path.join(root, 'tmp'),
  };
  write(path.join(root, 'package.json'), json({ type: 'commonjs' }));
  context.emitted = path.join(root, 'emitted');
  try {
    context.runtime = await emit(context, context.emitted);
  } catch (error) {
    finish(context);
    throw error;
  }
  return context;
}
export function finish(context) {
  const live = context.processes.filter((r) => r.identity && alive(r.identity));
  if (live.length || context.processes.some((r) => r.cleanup !== 'REAPED_AND_CLOSED')) context.uncertain = true;
  context.completedAt = Date.now();
  context.cleanup = context.uncertain ? 'UNKNOWN_ROOT_PRESERVED' : 'ALL_OWNED_REAPED_AND_CLOSED';
  const record = { ...context, runtime: undefined };
  if (process.env.RUNTIME_COMPOSE_EVIDENCE) {
    const directory = path.resolve(process.env.RUNTIME_COMPOSE_EVIDENCE);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    write(path.join(directory, `${context.label}.json`), json(record));
  }
  if (context.uncertain) throw new Error(`UNKNOWN cleanup; preserve ${context.root}`);
  assert.ok(path.basename(context.root).startsWith('runtime-compose-'));
  fs.rmSync(context.root, { recursive: true });
}
export async function compile(context, version = '0.166.0') {
  const executable = path.join(context.root, version, 'codex');
  fs.mkdirSync(path.dirname(executable), { mode: 0o700 });
  const source = path.join(SOURCE, 'tests/fixtures/managed-native-codex.c');
  const result = await run(
    context,
    `compile:${version}`,
    '/usr/bin/cc',
    ['-std=c11', '-O2', `-DSIMULATED_VERSION="${version}"`, source, '-o', executable],
    { timeout: 10000 }
  );
  assert.equal(result.status, 0, result.stderr);
  context.checks.push({
    name: `native-fixture:${version}`,
    sourceGitBlob: gitBlob(fs.readFileSync(source)),
    executableSha256: sha256(fs.readFileSync(executable)),
    compilerPath: fs.realpathSync('/usr/bin/cc'),
  });
  return executable;
}
export function seal(bundle, change = () => {}) {
  const entries = [];
  function walk(relative = '') {
    for (const item of fs.readdirSync(path.join(bundle, relative)).sort()) {
      const name = relative ? `${relative}/${item}` : item;
      if (name === 'RUNTIME-MANIFEST.json') continue;
      const target = path.join(bundle, name),
        stat = fs.lstatSync(target);
      if (stat.isDirectory()) {
        assert.equal(stat.mode & 0o7777, 0o700);
        walk(name);
      } else {
        assert.ok(stat.isFile());
        entries.push({
          path: name,
          mode: (stat.mode & 0o7777).toString(8).padStart(4, '0'),
          bytes: stat.size,
          sha256: sha256(fs.readFileSync(target)),
          origin: 'SIMULATED source/canary inventory; not distributable',
        });
      }
    }
  }
  walk();
  const manifest = {
    schemaVersion: 1,
    repositorySha: 'a'.repeat(40),
    repositoryTree: 'b'.repeat(40),
    dirty: false,
    lockfileSha256: 'c'.repeat(64),
    dependencies: DEPENDENCIES,
    entries,
    provenance: 'SIMULATED clean-bundle input, not working-tree provenance or a publisher signature',
    capabilityLimitation: 'SIMULATED installed-startup only; no production qualification or dependency materialization',
  };
  change(manifest);
  write(path.join(bundle, 'RUNTIME-MANIFEST.json'), json(manifest));
  return sha256(json(manifest));
}
export function bundle(context, label) {
  const root = path.join(context.root, `bundle-${label}`);
  fs.mkdirSync(root, { mode: 0o700 });
  const canary = 'throw new Error("SIMULATED_CANARY_EXECUTED_NOT_DISTRIBUTABLE");\n';
  for (const name of new Set([...REQUIRED, ...context.runtime.MINIMUM_RUNTIME_FILES]))
    write(path.join(root, name), canary, name.startsWith('bin/') || name === 'install-runtime.mjs' ? 0o700 : 0o600);
  for (const name of INSTALLER_FILES)
    write(
      path.join(root, name),
      fs.readFileSync(path.join(SOURCE, 'scripts', name)),
      name === 'install-runtime.mjs' ? 0o700 : 0o600
    );
  for (const name of ['packages/hud-mcp/bin/hud-mcp.mjs', 'packages/hud-mcp/bin/surface.mjs'])
    write(path.join(root, name), fs.readFileSync(path.join(SOURCE, name)), 0o700);
  for (const name of MODULES) {
    const output = name.replace(/\.ts$/, '.js');
    write(path.join(root, 'packages/hud-mcp/dist', output), fs.readFileSync(path.join(context.emitted, output)));
  }
  write(
    path.join(root, 'packages/hud-mcp/dist/packages/hud-mcp/src/main.js'),
    fs.readFileSync(path.join(SOURCE, 'tests/fixtures/runtime-compose-main.mjs'))
  );
  write(path.join(root, 'package.json'), json({ name: 'codex-hud', type: 'module' }));
  write(path.join(root, 'packages/hud-mcp/package.json'), json({ name: '@myhud/hud-mcp', type: 'module' }));
  for (const [name, version] of Object.entries(DEPENDENCIES))
    write(
      path.join(root, 'node_modules', name, 'package.json'),
      json({ name: name.split('/node_modules/').at(-1), version })
    );
  for (const [name, value] of Object.entries({
    '@iarna/toml': { name: '@iarna/toml', version: '2.2.5', main: 'toml.js' },
    chokidar: {
      name: 'chokidar',
      version: '5.0.0',
      type: 'module',
      main: './index.js',
      exports: { '.': { default: './index.js' }, './handler.js': { default: './handler.js' } },
    },
    readdirp: {
      name: 'readdirp',
      version: '5.0.0',
      type: 'module',
      main: './index.js',
      exports: { '.': './index.js' },
    },
  }))
    write(path.join(root, 'node_modules', name, 'package.json'), json(value));
  for (const name of CELLS) write(path.join(root, name), json({ version: 1, hudRevision: null, cells: [] }));
  seal(root);
  return root;
}
export function cloneBundle(context, source, label) {
  const target = path.join(context.root, `bundle-${label}`);
  fs.cpSync(source, target, { recursive: true });
  return target;
}
export function installerIntegrity(root) {
  try {
    const result = verifyBundle(root);
    result.directory.close();
    return { ok: true, digest: result.digest };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}
export async function install(context, root, prefix, receipt) {
  const cli = path.join(root, 'install-runtime.mjs');
  const preview = await run(context, 'installer-preview', process.execPath, [
    cli,
    'preview',
    '--prefix',
    prefix,
    ...(receipt ? ['--restore-receipt', receipt] : []),
  ]);
  assert.equal(preview.status, 0, preview.stderr);
  const plan = JSON.parse(preview.stdout);
  const applied = await run(context, receipt ? 'installer-restore' : 'installer-apply', process.execPath, [
    cli,
    receipt ? 'restore' : 'apply',
    '--prefix',
    prefix,
    '--expect',
    plan.planDigest,
    ...(receipt ? ['--receipt', receipt] : []),
  ]);
  assert.equal(applied.status, 0, applied.stderr);
  return { plan, result: JSON.parse(applied.stdout) };
}
export const cell = (expected) => ({
  ...structuredClone(expected),
  support: 'verified',
  evidence: {
    script: 'SIMULATED',
    report: 'SIMULATED',
    reportSha256: 'a'.repeat(64),
    artifactDigest: 'b'.repeat(64),
    observedAt: 1,
    reviewStatus: 'accepted',
    scope: 'product',
  },
  results: { identity: 'passed', input: 'passed', scope: 'passed', receipt: 'passed', singleSubmission: 'passed' },
  incomplete: [],
});
export function cells(root, expectations, selected = CELLS) {
  for (const name of selected)
    write(
      path.join(root, name),
      json({ version: 1, hudRevision: expectations[0].versions.hudRevision, cells: expectations.map(cell) })
    );
  return seal(root);
}
export async function launch(context, native, prefix, extra = {}) {
  const index = context.processes.length;
  const input = {
    root: context.root,
    prefix,
    native,
    target: native,
    marker: path.join(context.root, `started-${index}`),
    ...extra,
  };
  const config = path.join(context.root, `input-${index}.json`);
  write(config, json(input));
  const descriptor = path.join(context.root, 'descriptor');
  write(descriptor, 'literal descriptor\n');
  const env = {
    ...context.env,
    SYNTHETIC_COMPOSE_INPUT: config,
    SYNTHETIC_NATIVE_NODE: process.execPath,
    SYNTHETIC_NATIVE_DRIVER: input.driver ?? path.join(prefix, 'bin/hud-mcp'),
    SYNTHETIC_NATIVE_PROBE_LOG: path.join(context.root, `probes-${index}.jsonl`),
    HUD_CLAIM: 'SIMULATED',
    HUD_RUN: 'SIMULATED',
    HUD_LINK: 'SIMULATED',
    PI_SESSION_ID: 'SIMULATED-stale',
    PI_CODING_AGENT_SESSION_DIR: 'SIMULATED-stale',
    ...(input.fakeRoot
      ? {
          HUD_RUNTIME_ROOT: input.fakeRoot,
          HUD_RUNTIME_MANIFEST: input.fakeManifest,
          RUNTIME_MANIFEST_PATH: input.fakeManifest,
          HUD_MANAGED_CELLS: path.join(input.fakeRoot, CELLS[3]),
        }
      : {}),
  };
  let result;
  try {
    result = await run(context, 'native-installed-startup', native, ['literal space', "';$()", ''], {
      env,
      input: 'literal stdin\n',
      descriptor,
      timeout: 12000,
    });
  } finally {
    if (fs.existsSync(input.marker)) {
      try {
        const identity = JSON.parse(fs.readFileSync(input.marker, 'utf8'));
        assert.ok(Number.isSafeInteger(identity.pid) && /^\d+$/.test(identity.start));
        const ended = !alive(identity);
        context.checks.push({ name: 'owned-synthetic-main-at-entry', identity, ended });
        if (!ended) context.uncertain = true;
      } catch (error) {
        context.uncertain = true;
        throw error;
      }
    }
  }
  assert.equal(context.uncertain, false, 'synthetic main cleanup unknown');
  const probes = fs.existsSync(env.SYNTHETIC_NATIVE_PROBE_LOG)
    ? fs.readFileSync(env.SYNTHETIC_NATIVE_PROBE_LOG, 'utf8').trim().split('\n').map(JSON.parse)
    : [];
  for (const probe of probes) {
    if (alive({ pid: probe.pid, start: probe.procStart })) context.uncertain = true;
    assert.equal(context.uncertain, false, 'version probe cleanup unknown');
  }
  context.checks.push({
    name: 'probe-receipts',
    probes: probes.map((p) => ({ ...p, observedEndedAt: Date.now(), alive: false })),
  });
  const value = result.status === 0 ? JSON.parse(result.stdout) : null;
  if (value?.physical) {
    const identity = { pid: value.physical.pid, start: value.physical.start };
    const ended = !alive(identity);
    context.checks.push({ name: 'owned-synthetic-main', identity, ended });
    if (!ended) {
      context.uncertain = true;
      throw new Error('synthetic_main_cleanup_unknown');
    }
  }
  return { ...result, value, probes, marker: input.marker };
}

async function main() {
  assert.deepEqual(process.argv.slice(2), ['--check-runtime-build'], 'only --check-runtime-build is supported');
  const context = await createContext('runtime-build-regression');
  try {
    const root = path.join(context.root, 'regression');
    await emit(context, root, true);
    const result = await run(
      context,
      'unchanged-runtime-build-tests',
      process.execPath,
      ['--test', '--test-concurrency=1', path.join(root, 'tests/unit/runtime-build.test.js')],
      { timeout: 30000 }
    );
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    assert.equal(result.status, 0);
  } finally {
    finish(context);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
