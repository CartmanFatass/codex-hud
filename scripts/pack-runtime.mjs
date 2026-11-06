#!/usr/bin/env node
/** Build a local, unpacked runtime plus archive. Never install, publish or activate. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROOT, git, isolatedEnvironment, outputDirectory } from './check-cloud.mjs';
import { ROOT_BINS, REQUIRED_OUTPUTS, EXTRA_FILES, previewManifest, selectedOutputs } from './pack-cloud-preview.mjs';
import {
  Directory,
  digest,
  json,
  runtime,
  MAX_FILE,
  MAX_TOTAL,
  MAX_ENTRIES,
  listNames,
} from './runtime-package/safety.mjs';
import { HELPERS, DEPENDENCIES, INSTALLER_FILES, verifyBundle } from './runtime-package/manifest.mjs';

export function validateLock(lock) {
  if (lock.lockfileVersion !== 3) throw new Error('lockfile_v3_required');
  const prod = Object.entries(lock.packages).filter(([name, value]) => name && !value.dev);
  if (prod.length !== 3) throw new Error('unreviewed_production_dependency_closure');
  for (const [name, version] of Object.entries(DEPENDENCIES)) {
    const value = lock.packages[`node_modules/${name}`];
    const basename = name.split('/').at(-1);
    if (
      !value ||
      value.version !== version ||
      value.resolved !== `https://registry.npmjs.org/${name}/-/${basename}-${version}.tgz` ||
      !/^sha512-[A-Za-z0-9+/]+=*$/.test(value.integrity) ||
      value.link ||
      value.hasInstallScript
    )
      throw new Error('unreviewed_dependency_lock');
  }
  return DEPENDENCIES;
}
export async function runOwned(name, executable, args, cwd, env, out, timeoutMs = 180000) {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const child = spawn(executable, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let count = 0,
    reason = null,
    closed = false,
    exited = false,
    birth = null,
    cleanupUncertain = false;
  let completionGuard,
    cleanupDeadline = null;
  const chunks = [];
  const signals = [];
  const processIdentity = () => {
    const fd = fs.openSync(`/proc/${child.pid}/stat`, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const bytes = Buffer.alloc(8192);
    let length;
    try {
      length = fs.readSync(fd, bytes, 0, bytes.length, 0);
    } finally {
      fs.closeSync(fd);
    }
    if (!length || length === bytes.length) throw new Error('invalid_process_identity');
    const stat = bytes.subarray(0, length).toString();
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { start: fields[19], state: fields[0], group: Number(fields[2]) };
  };
  const signalOwned = (signal) => {
    if (exited) return;
    if (!child.pid || !birth) return;
    try {
      const current = processIdentity();
      if (current.start !== birth.start || current.group !== child.pid) {
        cleanupUncertain = true;
        return;
      }
      if (current.state === 'Z') return;
      process.kill(-child.pid, signal);
      signals.push({ signal, at: new Date().toISOString(), start: birth.start });
    } catch (error) {
      if (error.code !== 'ESRCH') cleanupUncertain = true;
    }
  };
  let finish;
  const stop = (why) => {
    if (reason) return;
    reason = why;
    cleanupDeadline = new Date(Date.now() + 1500).toISOString();
    signalOwned('SIGKILL');
    // An interruption has its own absolute cleanup deadline, not the build's long deadline.
    clearTimeout(completionGuard);
    completionGuard = setTimeout(() => {
      cleanupUncertain = true;
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      finish({ code: null, signal: null });
    }, 1500);
  };
  const interrupt = (signal) => stop(`interrupted_${signal}`);
  const onInt = () => interrupt('SIGINT');
  const onTerm = () => interrupt('SIGTERM');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  child.once('spawn', () => {
    try {
      birth = processIdentity();
      if (reason) signalOwned('SIGKILL');
    } catch {
      cleanupUncertain = true;
      stop('identity_unavailable');
    }
  });
  child.once('exit', () => {
    exited = true;
  });
  const receive = (chunk) => {
    if (count < 4 * 1024 * 1024) chunks.push(chunk.subarray(0, 4 * 1024 * 1024 - count));
    count += chunk.length;
    if (count > 4 * 1024 * 1024) stop('output_limit');
  };
  child.stdout.on('data', receive);
  child.stderr.on('data', receive);
  child.stdout.on('error', () => stop('output_error'));
  child.stderr.on('error', () => stop('output_error'));
  const timer = setTimeout(() => stop('deadline'), Math.max(0, started + timeoutMs - Date.now()));
  let result;
  try {
    result = await new Promise((resolve) => {
      let settled = false;
      finish = (value) => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };
      child.once('error', (error) => finish({ code: null, error: error.code, signal: null }));
      child.once('close', (code, signal) => {
        closed = true;
        finish({ code, signal });
      });
      completionGuard = setTimeout(() => stop('unreaped'), timeoutMs + 1500);
    });
  } finally {
    clearTimeout(timer);
    clearTimeout(completionGuard);
    process.removeListener('SIGINT', onInt);
    process.removeListener('SIGTERM', onTerm);
  }
  if (reason && (!closed || !exited)) cleanupUncertain = true;
  fs.writeFileSync(path.join(out, `${name}.log`), Buffer.concat(chunks), { mode: 0o600, flag: 'wx' });
  const receipt = {
    name,
    command: [executable, ...args],
    cwd,
    startedAt,
    finishedAt: new Date().toISOString(),
    ownedPid: child.pid ?? null,
    ownedStart: birth?.start ?? null,
    deadline: new Date(started + timeoutMs).toISOString(),
    ...result,
    cleanupDeadline,
    directChildExited: exited,
    closeObserved: closed,
    reason,
    signals,
    cleanupUncertain,
    status: result.code === 0 && closed && !reason && !cleanupUncertain ? 'PASS' : 'FAIL',
    cleanup: cleanupUncertain
      ? 'uncertain; stop and inspect, do not replay'
      : reason
        ? 'owned direct child reaped after interruption/failure'
        : 'direct child closed normally',
  };
  fs.writeFileSync(path.join(out, `${name}.receipt.json`), json(receipt), { mode: 0o600, flag: 'wx' });
  if (receipt.status !== 'PASS')
    throw new Error(`step_failed: ${name}; see receipt; do_not_replay_uncertain_execution`);
  return receipt;
}
export function readBuildInput(root, name, limit = MAX_FILE) {
  const directory = new Directory(root);
  try {
    return directory.read(name, limit);
  } finally {
    directory.close();
  }
}
function sourceSnapshot(tracked) {
  const result = [];
  for (const name of tracked)
    if (
      /^(src\/|packages\/hud-mcp\/src\/)/.test(name) ||
      name.startsWith('scripts/runtime-package/') ||
      [
        'scripts/install-runtime.mjs',
        'scripts/pack-runtime.mjs',
        'scripts/pack-cloud-preview.mjs',
        'scripts/check-cloud.mjs',
        'tsconfig.json',
        'packages/hud-mcp/tsconfig.json',
        'package.json',
        'package-lock.json',
        'packages/hud-mcp/package.json',
        ...Object.values(ROOT_BINS),
        ...EXTRA_FILES,
        ...HELPERS,
      ].includes(name)
    ) {
      const bytes = readBuildInput(ROOT, name).data;
      if (bytes.length > MAX_FILE) throw new Error('source_limit');
      result.push([name, digest(bytes)]);
    }
  return digest(json(result));
}
export async function buildRuntime() {
  runtime();
  const out = outputDirectory('runtime');
  fs.chmodSync(out, 0o700);
  const env = isolatedEnvironment(out);
  const report = { schemaVersion: 1, startedAt: new Date().toISOString(), status: 'RUNNING', results: [] };
  try {
    const tracked = git('ls-files', '-z').split('\0').filter(Boolean);
    const inputs = tracked.filter((name) => name.startsWith('src/') || name.startsWith('packages/hud-mcp/src/'));
    const snapshot = sourceSnapshot(tracked);
    const repositorySha = git('rev-parse', 'HEAD');
    const repositoryTree = git('rev-parse', 'HEAD^{tree}');
    const dirty = git('status', '--porcelain', '--untracked-files=normal') !== '';
    const lockBytes = readBuildInput(ROOT, 'package-lock.json').data;
    const lock = JSON.parse(lockBytes);
    validateLock(lock);
    const step = async (name, executable, args, cwd = ROOT) =>
      report.results.push(await runOwned(name, executable, args, cwd, env, out));
    await step('runtime-build', process.execPath, [
      'node_modules/typescript/bin/tsc',
      '--outDir',
      path.join(out, 'main'),
    ]);
    await step('runtime-build-mcp', process.execPath, [
      'node_modules/typescript/bin/tsc',
      '-p',
      'packages/hud-mcp/tsconfig.json',
      '--outDir',
      path.join(out, 'mcp'),
    ]);
    const deps = path.join(out, 'dependencies');
    fs.mkdirSync(deps, { mode: 0o700 });
    fs.writeFileSync(path.join(deps, 'package.json'), readBuildInput(ROOT, 'package.json').data, { mode: 0o600 });
    fs.writeFileSync(path.join(deps, 'package-lock.json'), lockBytes, { mode: 0o600 });
    const npmrc = path.join(out, 'empty-user-npmrc');
    const globalNpmrc = path.join(out, 'empty-global-npmrc');
    fs.writeFileSync(npmrc, '', { mode: 0o600 });
    fs.writeFileSync(globalNpmrc, '', { mode: 0o600 });
    Object.assign(env, {
      npm_config_userconfig: npmrc,
      npm_config_globalconfig: globalNpmrc,
      npm_config_cache: path.join(out, 'npm-cache'),
      npm_config_registry: 'https://registry.npmjs.org/',
      npm_config_audit: 'false',
      npm_config_fund: 'false',
      npm_config_update_notifier: 'false',
    });
    // Clean environment, empty configs and new private cache. Never inherit auth or a working node_modules.
    await step(
      'runtime-production-ci',
      'npm',
      ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
      deps
    );
    const stage = path.join(out, 'runtime');
    fs.mkdirSync(stage, { mode: 0o700 });
    const entries = [];
    let total = 0;
    const add = (name, data, executable = false, origin = 'generated') => {
      if (entries.some((entry) => entry.path === name)) throw new Error('duplicate_runtime_entry');
      if (data.length > MAX_FILE || entries.length >= MAX_ENTRIES || (total += data.length) > MAX_TOTAL)
        throw new Error('runtime_size_limit');
      const target = path.join(stage, name);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      const mode = executable ? 0o700 : 0o600;
      fs.writeFileSync(target, data, { flag: 'wx', mode });
      entries.push({
        path: name,
        bytes: data.length,
        sha256: digest(data),
        mode: mode.toString(8).padStart(4, '0'),
        origin,
      });
    };
    const generated = new Directory(out);
    try {
      for (const { source, output, generatedPath } of selectedOutputs(inputs, (name) =>
        fs.existsSync(path.join(out, name))
      ))
        add(output, generated.read(generatedPath).data, false, source);
    } finally {
      generated.close();
    }
    for (const output of Object.values(REQUIRED_OUTPUTS))
      if (!entries.some((entry) => entry.path === output)) throw new Error('missing_required_runtime_output');
    for (const name of ['codex-cells.json', 'managed-cells.json']) {
      const source = `src/core/launch/${name}`;
      if (!tracked.includes(source)) throw new Error('untracked_capability_manifest');
      const data = readBuildInput(ROOT, source).data;
      add(`dist/core/launch/${name}`, data, false, source);
      add(`packages/hud-mcp/dist/src/core/launch/${name}`, data, false, source);
    }
    for (const source of new Set([...Object.values(ROOT_BINS), ...EXTRA_FILES, ...HELPERS])) {
      if (!tracked.includes(source)) throw new Error(`untracked_runtime_input: ${source}`);
      add(source, readBuildInput(ROOT, source).data, source.startsWith('bin/') || source.includes('/bin/'), source);
    }
    for (const name of INSTALLER_FILES) {
      const source = `scripts/${name}`;
      if (!tracked.includes(source)) throw new Error(`untracked_installer_input: ${source}`);
      add(name, readBuildInput(ROOT, source).data, name === 'install-runtime.mjs', source);
    }
    for (const source of ['package.json', 'packages/hud-mcp/package.json']) {
      const manifest = previewManifest(JSON.parse(readBuildInput(ROOT, source).data), source !== 'package.json');
      delete manifest['x-cloud-preview'];
      manifest['x-runtime-bundle'] =
        'Application code and locked Node production dependencies only. No live capability qualification.';
      add(source, json(manifest), false, source);
    }
    const installedNames = fs
      .readdirSync(path.join(deps, 'node_modules'))
      .filter((name) => name !== '.package-lock.json')
      .sort();
    if (JSON.stringify(installedNames) !== JSON.stringify(['@iarna', 'chokidar', 'readdirp']))
      throw new Error('unexpected_dependency_tree');
    if (JSON.stringify(listNames(path.join(deps, 'node_modules/@iarna'), 1)) !== JSON.stringify(['toml']))
      throw new Error('unexpected_scope_tree');
    for (const name of Object.keys(DEPENDENCIES)) {
      const pkg = path.join(deps, 'node_modules', name);
      let hasLicense = false;
      let count = 0;
      function walk(directory, prefix = '') {
        for (const file of listNames(directory, 1000)) {
          if (++count > 1000) throw new Error('dependency_entry_limit');
          const rel = prefix ? `${prefix}/${file}` : file;
          const full = path.join(directory, file);
          const stat = fs.lstatSync(full);
          if (stat.isDirectory()) walk(full, rel);
          else if (stat.isFile() && stat.nlink === 1 && stat.size <= MAX_FILE) {
            if (/^licen[sc]e(?:\..*)?$/i.test(rel)) hasLicense = true;
            add(
              `node_modules/${name}/${rel}`,
              readBuildInput(pkg, rel).data,
              false,
              `lockfile:${name}@${DEPENDENCIES[name]}:${lock.packages[`node_modules/${name}`].integrity}`
            );
          } else throw new Error('unsafe_dependency_file');
        }
      }
      walk(pkg);
      if (!hasLicense) throw new Error(`missing_dependency_license: ${name}`);
    }
    if (
      sourceSnapshot(tracked) !== snapshot ||
      git('rev-parse', 'HEAD') !== repositorySha ||
      (git('status', '--porcelain', '--untracked-files=normal') !== '') !== dirty
    )
      throw new Error('source_changed_during_build');
    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const manifest = {
      schemaVersion: 1,
      repositorySha,
      repositoryTree,
      dirty,
      sourceContentSha256: snapshot,
      lockfileSha256: digest(lockBytes),
      platform: 'linux',
      nodeRequirement: '^22.13.0 || ^24.0.0',
      builtWithNode: process.versions.node,
      dependencies: DEPENDENCIES,
      provenance:
        'Tracked allowlisted sources, fresh TypeScript builds and isolated npm ci --omit=dev --ignore-scripts with lockfile integrity. Not a publisher signature.',
      capabilityLimitation:
        'No live-provider, tmux, Jev, native-platform or release qualification. Capability manifests are preserved; packaging grants no capabilities. Node is not bundled. Legacy wrapper also needs bash, tmux, Codex, Python3 and Unix tools.',
      entries,
    };
    fs.writeFileSync(path.join(stage, 'RUNTIME-MANIFEST.json'), json(manifest), { mode: 0o600, flag: 'wx' });
    const verified = verifyBundle(stage);
    const manifestDigest = verified.digest;
    verified.directory.close();
    const archive = path.join(out, `codex-hud-runtime-${manifestDigest}.tgz`);
    await step('runtime-archive', '/usr/bin/tar', [
      '--sort=name',
      '--mtime=@0',
      '--owner=0',
      '--group=0',
      '--numeric-owner',
      '-czf',
      archive,
      '-C',
      out,
      'runtime',
    ]);
    fs.chmodSync(archive, 0o600);
    await step('runtime-archive-list', '/usr/bin/tar', ['-tzf', archive]);
    const archived = readBuildInput(out, 'runtime-archive-list.log', 4 * 1024 * 1024)
      .data.toString('utf8')
      .trim()
      .split('\n')
      .filter((name) => !name.endsWith('/'))
      .sort();
    const expectedArchive = [
      ...entries.map((entry) => `runtime/${entry.path}`),
      'runtime/RUNTIME-MANIFEST.json',
    ].sort();
    if (JSON.stringify(archived) !== JSON.stringify(expectedArchive)) throw new Error('archive_entry_mismatch');
    if (fs.statSync(archive).size > MAX_TOTAL + 8 * 1024 * 1024) throw new Error('archive_size_limit');
    const archiveSha256 = digest(readBuildInput(out, path.basename(archive), MAX_TOTAL + 8 * 1024 * 1024).data);
    Object.assign(report, {
      status: 'PASS',
      bundle: stage,
      archive,
      archiveSha256,
      manifestDigest,
      repositorySha,
      repositoryTree,
      dirty,
      lockfileSha256: manifest.lockfileSha256,
      entries: entries.length,
      bytes: total,
    });
  } catch (error) {
    report.status = 'FAIL';
    report.reason = error.message;
    throw error;
  } finally {
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(out, 'runtime-build.json'), json(report), { mode: 0o600 });
    console.log(`Runtime build receipt: ${path.join(out, 'runtime-build.json')}`);
  }
  return report;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) {
    console.log('Usage: node scripts/pack-runtime.mjs\nBuild only; no installation or activation.');
    if (process.argv.length !== 3 || !['--help', '-h'].includes(process.argv[2])) process.exitCode = 1;
  } else
    buildRuntime()
      .then((result) => console.log(JSON.stringify(result, null, 2)))
      .catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
      });
}
