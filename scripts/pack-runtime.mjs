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

import { OMITTED_OPTIONAL_DEPENDENCIES, PRODUCTION_LOCK_SHA256 } from './runtime-package/dependencies.mjs';
import { licenseSupplement } from './runtime-package/license-supplements.mjs';

// Transport only: never inherit npm config, auth, NODE_OPTIONS or client state.
// Do not serialize this environment: proxy URLs can contain credentials.
export function productionEnvironment(isolated, source = process.env) {
  const env = { ...isolated };
  for (const name of [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
    'no_proxy',
  ]) {
    if (typeof source[name] === 'string') env[name] = source[name];
  }
  return env;
}
// Library tarballs contain development dot-metadata. Never omit a declared entrypoint.
export function validateDependencyEntrypoints(pkg) {
  function visit(value) {
    if (
      typeof value === 'string' &&
      value.split('/').some((part) => part.startsWith('.') && part !== '.' && part !== '..')
    )
      throw new Error('dot_prefixed_dependency_entrypoint_refused');
    if (value && typeof value === 'object') for (const child of Object.values(value)) visit(child);
  }
  for (const key of ['main', 'module', 'exports', 'imports', 'bin']) visit(pkg[key]);
}
export function dependencyMetadataPath(name) {
  return name.startsWith('.');
}
export function validateLock(lock) {
  if (lock.lockfileVersion !== 3) throw new Error('lockfile_v3_required');
  const prod = Object.entries(lock.packages).filter(([name, value]) => name && !value.dev);
  const reviewed = { ...DEPENDENCIES, ...OMITTED_OPTIONAL_DEPENDENCIES };
  if (
    prod.length !== Object.keys(reviewed).length ||
    prod.some(([name]) => !Object.hasOwn(reviewed, name.replace(/^node_modules\//, '')))
  )
    throw new Error('unreviewed_production_dependency_closure');
  for (const [name, version] of Object.entries(reviewed)) {
    const value = lock.packages[`node_modules/${name}`];
    const packageName = name.split('/node_modules/').at(-1);
    const basename = packageName.split('/').at(-1);
    if (
      !value ||
      value.version !== version ||
      value.resolved !== `https://registry.npmjs.org/${packageName}/-/${basename}-${version}.tgz` ||
      !/^sha512-[A-Za-z0-9+/]+=*$/.test(value.integrity) ||
      value.link ||
      value.hasInstallScript
    )
      throw new Error('unreviewed_dependency_lock');
  }
  if (digest(JSON.stringify(prod)) !== PRODUCTION_LOCK_SHA256) throw new Error('unreviewed_dependency_lock_metadata');
  return DEPENDENCIES;
}

// Inspect only the exact reviewed installation layout; no arbitrary package walk.
export function validateInstalledClosure(nodeModules) {
  const expected = new Map();
  for (const name of Object.keys(DEPENDENCIES)) {
    const split = name.lastIndexOf('/node_modules/');
    const parent = split < 0 ? '' : name.slice(0, split + '/node_modules/'.length);
    const local = split < 0 ? name : name.slice(split + '/node_modules/'.length);
    if (!expected.has(parent)) expected.set(parent, []);
    expected.get(parent).push(local);
  }
  for (const [parent, names] of expected) {
    const root = path.join(nodeModules, parent);
    const tops = [...new Set(names.map((name) => name.split('/')[0]))].sort();
    const actual = listNames(root, 200)
      .filter((name) => name !== '.package-lock.json')
      .sort();
    if (JSON.stringify(actual) !== JSON.stringify(tops)) throw new Error('unexpected_dependency_tree');
    for (const top of tops) {
      if (!fs.lstatSync(path.join(root, top)).isDirectory()) throw new Error('unsafe_dependency_directory');
      if (top.startsWith('@')) {
        const leaves = names
          .filter((name) => name.startsWith(`${top}/`))
          .map((name) => name.slice(top.length + 1))
          .sort();
        if (JSON.stringify(listNames(path.join(root, top), 200).sort()) !== JSON.stringify(leaves))
          throw new Error('unexpected_scope_tree');
      }
    }
    for (const name of names) {
      const location = `${parent}${name}`;
      if (!fs.lstatSync(path.join(nodeModules, location)).isDirectory()) throw new Error('unsafe_dependency_directory');
      let pkg;
      try {
        pkg = JSON.parse(readBuildInput(nodeModules, `${location}/package.json`).data);
      } catch {
        throw new Error('invalid_dependency_manifest');
      }
      if (pkg.name !== name || pkg.version !== DEPENDENCIES[location]) throw new Error('dependency_identity_mismatch');
    }
  }
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
        'scripts/activate-runtime.mjs',
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
    const step = async (name, executable, args, cwd = ROOT, childEnv = env) =>
      report.results.push(await runOwned(name, executable, args, cwd, childEnv, out));
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
      ['ci', '--omit=dev', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund', '--bin-links=false'],
      deps,
      productionEnvironment(env)
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
      add(
        name,
        readBuildInput(ROOT, source).data,
        name === 'install-runtime.mjs' || name === 'activate-runtime.mjs',
        source
      );
    }
    // One canonical release version for every manifest in the bundle.
    const releaseVersion = JSON.parse(readBuildInput(ROOT, 'package.json').data).version;
    for (const source of ['package.json', 'packages/hud-mcp/package.json']) {
      const manifest = previewManifest(
        JSON.parse(readBuildInput(ROOT, source).data),
        source !== 'package.json',
        releaseVersion
      );
      delete manifest['x-cloud-preview'];
      manifest['x-runtime-bundle'] =
        'Application code and locked Node production dependencies only. No live capability qualification.';
      add(source, json(manifest), false, source);
    }
    validateInstalledClosure(path.join(deps, 'node_modules'));
    const dependencyOmissions = { count: 0, paths: [] };
    for (const name of Object.keys(DEPENDENCIES)) {
      const pkg = path.join(deps, 'node_modules', name);
      validateDependencyEntrypoints(JSON.parse(readBuildInput(pkg, 'package.json').data));
      let hasLicense = false;
      let count = 0;
      function walk(directory, prefix = '') {
        for (const file of listNames(directory, 4000)) {
          if (++count > 4000) throw new Error('dependency_entry_limit');
          const rel = prefix ? `${prefix}/${file}` : file;
          if (dependencyMetadataPath(file)) {
            dependencyOmissions.count++;
            const omitted = `node_modules/${name}/${rel}`;
            if (dependencyOmissions.paths.join(', ').length + omitted.length < 2500)
              dependencyOmissions.paths.push(omitted);
            continue;
          }
          const full = path.join(directory, file);
          const stat = fs.lstatSync(full);
          if (stat.isDirectory()) {
            // Nested packages are separately verified/copied by their lock paths.
            if (rel !== 'node_modules') walk(full, rel);
          } else if (stat.isFile() && stat.nlink === 1 && stat.size <= MAX_FILE) {
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
      if (!hasLicense) {
        const supplement = licenseSupplement(name, lock.packages[`node_modules/${name}`]);
        if (!supplement || !tracked.includes(supplement.source)) throw new Error(`missing_dependency_license: ${name}`);
        const data = readBuildInput(ROOT, supplement.source).data;
        if (digest(data) !== supplement.sha256) throw new Error('license_supplement_integrity_mismatch');
        add(
          `node_modules/${name}/LICENSE`,
          data,
          false,
          `${supplement.repository}@${supplement.commit}:libraries/LICENSE; tarball=${supplement.integrity}`
        );
      }
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
      releaseVersion,
      dependencies: DEPENDENCIES,
      provenance: `Tracked allowlisted sources, fresh TypeScript builds and isolated npm ci --omit=dev --omit=optional --ignore-scripts with lockfile integrity. Not a publisher signature. Omitted ${dependencyOmissions.count} dot-prefixed dependency metadata roots (bounded list, declared entrypoints refused): ${dependencyOmissions.paths.join(', ')}`,
      capabilityLimitation:
        'No live-provider, tmux, Jev, native-platform or release qualification. Historical capability manifests grant no capabilities and do not gate the native path. Node and harness executables are not bundled. Claude uses its installed user executable; SDK optional platform clients are omitted. Jev needs Python3 and its external Agent package. Legacy wrapper also needs bash, tmux and Unix tools.',
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
      releaseVersion,
      dependencyOmissions,
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
    error.runtimeBuildDirectory = out;
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
