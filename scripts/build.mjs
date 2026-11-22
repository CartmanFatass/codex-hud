import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireBuildLock, withDistLock } from './dist-lock.mjs';

const root = fs.realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const legacy = 'packages/hud-mcp/dist';
const cacheRoot = '.tsbuild';
const stagePattern = /^\.dist(?:-test)?-stage-([1-9]\d*)$/;

function pidIsAlive(pid) {
  if (pid > 0x7fffffff) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

function cleanStages(all) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const match = stagePattern.exec(entry.name);
    if (entry.isDirectory() && match && (all || !pidIsAlive(Number(match[1])))) {
      fs.rmSync(join(root, entry.name), { recursive: true, force: true });
    }
  }
}

// Postorder so pruning removes orphan files before their empty directories.
function* inventory(dir, prefix = '') {
  for (const entry of fs.readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const name = join(prefix, entry.name);
    if (entry.isDirectory()) yield* inventory(dir, name);
    yield [name, entry];
  }
}

function expectedOutputs(infoPath) {
  try {
    const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
    const infoDir = dirname(infoPath);
    const rootDir = typeof info.options?.rootDir === 'string' ? resolve(infoDir, info.options.rootDir) : null;
    if (!rootDir || !Array.isArray(info.fileNames)) return null;
    const expected = new Set();
    for (const file of info.fileNames) {
      if (typeof file !== 'string') continue;
      const rel = relative(rootDir, resolve(infoDir, file));
      if (!rel || rel.startsWith('..') || isAbsolute(rel) || /\.d\.[cm]?ts$/.test(rel)) continue;
      if (rel.endsWith('.json')) { expected.add(rel); continue; }
      const match = /^(.*)\.(c|m)?tsx?$/.exec(rel);
      if (!match) continue;
      const [, stem, mod = ''] = match;
      expected.add(`${stem}.${mod}js`);
      if (info.options.sourceMap) expected.add(`${stem}.${mod}js.map`);
      if (info.options.declaration) {
        expected.add(`${stem}.d.${mod}ts`);
        if (info.options.declarationMap) expected.add(`${stem}.d.${mod}ts.map`);
      }
    }
    return expected;
  } catch { return null; }
}

function syncCache(cacheOut, expected) {
  const present = new Set();
  for (const [name, entry] of inventory(cacheOut)) {
    const path = join(cacheOut, name);
    if (entry.isDirectory()) {
      try { fs.rmdirSync(path); } catch (e) { if (e.code !== 'ENOTEMPTY') throw e; }
    } else if (!expected.has(name)) {
      fs.unlinkSync(path);
    } else {
      present.add(name);
    }
  }
  for (const name of expected) if (!present.has(name)) return false;
  return true;
}

function publish(source, stage, dist, main) {
  const staged = new Map(inventory(source));
  const sentinels = main ? ['index.js', 'tree-page.js'] : [];
  for (const name of sentinels) {
    if (!staged.get(name)?.isFile()) throw new Error(`Compiler did not emit ${name}; keeping the current build`);
  }
  const existing = fs.lstatSync(dist, { throwIfNoEntry: false });
  if (existing && !existing.isDirectory()) throw new Error(`${dist} is not a real directory`);
  const live = existing ? new Map(inventory(dist)) : new Map();
  for (const [name, entry] of staged) {
    // Don't traverse symlinked directories or delete a live directory to make way for a file.
    if (live.has(name) && entry.isDirectory() !== live.get(name).isDirectory()) {
      throw new Error(`Build output path changed file/directory type: ${name}; run npm run clean while HUD is stopped`);
    }
  }
  const replace = (name) => {
    const tmp = join(stage, name), dest = join(dist, name);
    fs.mkdirSync(dirname(tmp), { recursive: true });
    fs.copyFileSync(join(source, name), tmp);
    fs.mkdirSync(dirname(dest), { recursive: true });
    fs.renameSync(tmp, dest);
  };
  const changed = [];
  for (const [name, entry] of staged) {
    if (entry.isDirectory()) continue;
    const before = join(dist, name), after = join(source, name);
    if (live.get(name)?.isFile() && fs.statSync(before).size === fs.statSync(after).size &&
      fs.readFileSync(before).equals(fs.readFileSync(after))) continue;
    changed.push(name);
    if (!sentinels.includes(name)) replace(name);
  }
  for (const [name, entry] of live) {
    if (staged.has(name)) continue;
    const path = join(dist, name);
    if (entry.isDirectory()) fs.rmdirSync(path);
    else {
      fs.unlinkSync(path);
      changed.push(name);
    }
  }
  if (!main) return;
  if (changed.length) replace('index.js');
  else {
    // codex-hud compares source mtimes with index.js even when emitted bytes are unchanged.
    const now = new Date();
    fs.utimesSync(join(dist, 'index.js'), now, now);
  }
  // Signal PanelReload only after all other outputs and prunes have landed.
  if (changed.some((name) => !name.startsWith('mcp/'))) replace('tree-page.js');
}

function compile(main, cacheOut, buildInfo) {
  const result = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'),
    '-p', main ? 'tsconfig.json' : 'tsconfig.test.json', '--incremental', '--tsBuildInfoFile', buildInfo,
    '--outDir', cacheOut, '--noEmitOnError', 'true'],
  { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`TypeScript compiler terminated by ${result.signal}`);
  return result.status ?? 1;
}

async function run(args) {
  const target = args[0] === '--target' && args.length === 2 ? args[1] : !args.length ? 'main' : undefined;
  const clean = args.length === 1 && args[0] === '--clean';
  const publishFrom = args[0] === '--publish-from' && args.length === 2 ? args[1] : undefined;
  if (!clean && !publishFrom && target !== 'main' && target !== 'test') {
    throw new Error('Usage: node scripts/build.mjs [--target main|test | --publish-from <dir> | --clean]');
  }

  // Keep compilation serialized, but only exclude dist readers while changing live files.
  const lock = await acquireBuildLock('build');
  try {
    cleanStages(clean);
    if (clean) {
      return await withDistLock(() => {
        for (const name of ['dist', 'dist-test', cacheRoot, legacy]) {
          const path = join(root, name);
          if (!fs.lstatSync(path, { throwIfNoEntry: false })) continue;
          if (fs.realpathSync(dirname(path)) !== dirname(path)) throw new Error(`Refusing to clean ${name} through a symlink`);
          console.log(`Removing ${name}`);
          fs.rmSync(path, { recursive: true, force: true });
        }
      });
    }
    const main = Boolean(publishFrom) || target === 'main';
    const dist = join(root, main ? 'dist' : 'dist-test');
    const stage = join(root, `.${main ? 'dist' : 'dist-test'}-stage-${process.pid}`);
    if (main && fs.existsSync(join(root, legacy))) {
      console.warn(`${legacy} is obsolete; run npm run clean after running workers have stopped.`);
    }
    fs.mkdirSync(stage);
    try {
      if (publishFrom) {
        const source = resolve(root, publishFrom);
        if (!fs.lstatSync(source, { throwIfNoEntry: false })?.isDirectory()) {
          throw new Error(`Publish source is not a real directory: ${publishFrom}`);
        }
        await withDistLock(() => publish(source, stage, dist, true));
        return;
      }
      const cacheOut = join(root, cacheRoot, main ? 'dist' : 'dist-test');
      const buildInfo = join(root, cacheRoot, main ? 'main.tsbuildinfo' : 'test.tsbuildinfo');
      const hadInfo = fs.existsSync(buildInfo);
      fs.mkdirSync(cacheOut, { recursive: true });
      let status = compile(main, cacheOut, buildInfo);
      if (status === 0) {
        const expected = expectedOutputs(buildInfo);
        if ((expected && !syncCache(cacheOut, expected)) || (!expected && hadInfo)) {
          fs.rmSync(cacheOut, { recursive: true, force: true });
          fs.rmSync(buildInfo, { force: true });
          fs.mkdirSync(cacheOut, { recursive: true });
          status = compile(main, cacheOut, buildInfo);
          if (status === 0) {
            const rebuilt = expectedOutputs(buildInfo);
            if (rebuilt) syncCache(cacheOut, rebuilt);
          }
        }
      }
      if (status !== 0) process.exitCode = status;
      else if (main) await withDistLock(() => publish(cacheOut, stage, dist, main));
      else publish(cacheOut, stage, dist, main);
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
  } finally {
    lock.close();
  }
}

try {
  await run(process.argv.slice(2));
} catch (error) {
  console.error(`HUD build: ${error.message}`);
  process.exitCode = 1;
}
