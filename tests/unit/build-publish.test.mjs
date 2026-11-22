import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { describe } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { PanelReload } from '../../dist/utils/panel-reload.js';

const exec = promisify(execFile);
const script = new URL('../../scripts/build.mjs', import.meta.url);
const compiler = fileURLToPath(new URL('../../node_modules/typescript', import.meta.url));
const signature = (file) => {
  const { ino, size, mtimeMs, ctimeMs } = fs.statSync(file);
  return { ino, size, mtimeMs, ctimeMs };
};

function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'hud-build-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = (name) => join(root, name);
  const put = (name, body) => {
    fs.mkdirSync(dirname(file(name)), { recursive: true });
    fs.writeFileSync(file(name), body);
  };
  const run = (args = [], preload) =>
    exec(process.execPath, [...(preload ? ['--import', file(preload)] : []), file('scripts/build.mjs'), ...args], { cwd: root });
  const stages = () => fs.readdirSync(root).filter((name) => /^\.dist(?:-test)?-stage-/.test(name));
  fs.mkdirSync(file('scripts'));
  fs.copyFileSync(script, file('scripts/build.mjs'));
  fs.copyFileSync(new URL('dist-lock.mjs', script), file('scripts/dist-lock.mjs'));
  fs.mkdirSync(file('node_modules'));
  fs.symlinkSync(compiler, file('node_modules/typescript'), 'dir');
  put('package.json', '{"type":"module"}');
  put('tsconfig.json', JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'NodeNext', rootDir: 'src', types: [], declaration: true, sourceMap: true, removeComments: true },
    include: ['src/**/*.ts'],
  }));
  put('tsconfig.test.json', '{"extends":"./tsconfig.json","compilerOptions":{"rootDir":"tests"},"include":["tests/**/*.ts"]}');
  put('tests/unit/sub.test.ts', 'export const fixture = true;\n');
  put('src/index.ts', 'export const index = true;\n');
  put('src/tree-page.ts', 'export { generation } from "./render/sub.js";\n');
  put('src/render/sub.ts', 'export const generation = 1;\n');
  put('src/mcp/thin-main.ts', 'export const mcp = true;\n');
  return { file, put, run, stages };
}

describe('build publish', { concurrency: 3 }, () => {
test('both targets prune orphan JS, maps, declarations and empty directories', async (t) => {
  const f = fixture(t);
  for (const [dist, dir, stem, args] of [['dist', 'render', 'sub', []], ['dist-test', 'unit', 'sub.test', ['--target', 'test']]]) {
    for (const suffix of ['js', 'js.map', 'd.ts']) f.put(`${dist}/${dir}/orphan.${suffix}`, 'obsolete');
    f.put(`${dist}/obsolete/dead.js`, 'obsolete');
    await f.run(args);
    assert.deepEqual(fs.readdirSync(f.file(`${dist}/${dir}`)).sort(), [`${stem}.d.ts`, `${stem}.js`, `${stem}.js.map`]);
    assert.equal(fs.existsSync(f.file(`${dist}/obsolete`)), false);
  }
});

test('TypeScript errors leave the live files and timestamps intact', async (t) => {
  const f = fixture(t);
  await f.run();
  f.put('dist/orphan.js', 'not pruned on failure');
  const files = ['dist/tree-page.js', 'dist/index.js', 'dist/orphan.js'].map(f.file);
  const snapshot = () => files.map((file) => [signature(file), fs.readFileSync(file, 'utf8')]);
  const before = snapshot();
  f.put('src/render/sub.ts', 'export const generation: number = "wrong";\n');
  await assert.rejects(f.run(), (error) => error.code === 1 && /error TS2322/.test(error.stdout));
  assert.deepEqual(snapshot(), before);
  assert.deepEqual(f.stages(), []);
});

test('concurrent readers see only complete old or new panel entry bytes', async (t) => {
  const f = fixture(t);
  await f.run();
  const entry = f.file('dist/tree-page.js'), read = () => fs.readFileSync(entry, 'utf8');
  const before = read(), seen = new Set([before]);
  f.put('src/tree-page.ts', 'export const replacement = true;\n');
  let samples = 0;
  const timer = setInterval(() => {
    samples++;
    try { seen.add(read()); } catch (error) { seen.add(error.code); }
  }, 5);
  try { await f.run(); } finally { clearInterval(timer); }
  const after = read();
  assert.ok(samples > 0 && after.includes('replacement') && before !== after);
  seen.add(after);
  assert.deepEqual(seen, new Set([before, after]));
});

test('hud-sonic starts without a retry when idle and waits for a consistent generation during publish', async (t) => {
  const f = fixture(t);
  fs.cpSync(new URL('../../packages/hud-mcp/bin', import.meta.url), f.file('packages/hud-mcp/bin'), { recursive: true });
  const job = 'j0000000000000001', jobDir = f.file(`hud/jobs/${job}`);
  f.put(`hud/jobs/${job}/job.json`, JSON.stringify({ job, role: 'oracle' }));
  const main = (binding) => `import { ${binding} } from '../render/sub.js';
export function dispatchJob() { return { job: ${binding} }; }`;
  // The wrapper now locks while loading its compiled entry and that entry's dependency graph.
  f.put('src/worker/cli-sonic.ts', `import { dispatchJob } from '../mcp/thin-main.js';
export function main() { console.log(dispatchJob().job); }`);
  f.put('src/mcp/thin-main.ts', main('oldJob'));
  f.put('src/render/sub.ts', 'export const oldJob = "old", generation = 1;');
  await f.run();

  f.put('observe.mjs', `import {appendFileSync, writeFileSync} from 'node:fs';
import {Server} from 'node:net';
const {listen, emit} = Server.prototype;
Server.prototype.listen = function (...args) {
  appendFileSync('sonic-attempts', '1');
  return listen.apply(this, args);
};
Server.prototype.emit = function (event, ...args) {
  if (event === 'error' && args[0]?.code === 'EADDRINUSE') writeFileSync('sonic-blocked', '');
  return emit.call(this, event, ...args);
};`);
  const sonic = () => exec(process.execPath, ['--import', f.file('observe.mjs'),
    f.file('packages/hud-mcp/bin/hud-sonic.mjs'), 'start', '--dir', jobDir, '--task', 'synthetic'],
  { cwd: f.file('.'), env: { ...process.env, HUD_HOME: f.file('hud'), HUD_JOB_DIR: jobDir }, timeout: 5000 });
  const idle = await sonic();
  assert.equal(idle.stdout, 'old\n');
  assert.equal(idle.stderr, '');
  assert.equal(fs.readFileSync(f.file('sonic-attempts'), 'utf8'), '1');

  f.put('src/mcp/thin-main.ts', main('newJob'));
  f.put('src/render/sub.ts', 'export const newJob = "new", generation = 2;');
  f.put('pause.mjs', `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
const rename = fs.renameSync, timer = new Int32Array(new SharedArrayBuffer(4));
fs.renameSync = (src, dst) => {
  rename(src, dst);
  if (!dst.endsWith('/dist/mcp/thin-main.js')) return;
  fs.writeFileSync('publish-open', '');
  const deadline = Date.now() + 12000;
  while (!fs.existsSync('publish-release')) {
    if (Date.now() >= deadline) throw new Error('test never released publish');
    Atomics.wait(timer, 0, 0, 10);
  }
}; syncBuiltinESMExports();`);
  const until = async (name) => {
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(f.file(name))) {
      assert.ok(Date.now() < deadline, `timed out waiting for ${name}`);
      await delay(10);
    }
  };
  const build = f.run([], 'pause.mjs');
  build.catch(() => {});
  let started;
  try {
    await until('publish-open');
    // Prove the fixture really exposes the live bug if the lock is bypassed.
    await assert.rejects(exec(process.execPath, ['--input-type=module', '-e', 'await import("./dist/mcp/thin-main.js")'],
      { cwd: f.file('.'), timeout: 5000 }), /does not provide an export named 'newJob'/);
    started = sonic();
    started.catch(() => {});
    await until('sonic-blocked');
  } finally {
    f.put('publish-release', '');
    await build;
  }
  const result = await started;
  assert.equal(result.stdout, 'new\n');
  assert.equal(result.stderr, '');
});

test('panel sentinel is last; no-op and MCP-only builds leave it alone', async (t) => {
  const f = fixture(t);
  await f.run();
  const entry = f.file('dist/tree-page.js'), index = f.file('dist/index.js');
  const before = signature(entry), oldIndex = signature(index);
  f.put('src/render/sub.ts', 'export const generation = 2;\n');
  // Assert at the rename itself rather than racing a watcher against synchronous publishing.
  f.put('order.mjs', `import assert from 'node:assert/strict';
import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
const rename = fs.renameSync;
fs.renameSync = (src, dst) => {
  if (dst.endsWith('/dist/tree-page.js')) {
    assert.match(fs.readFileSync('dist/render/sub.js', 'utf8'), /generation = 2/);
    assert.notEqual(fs.statSync('dist/index.js').ino, ${oldIndex.ino});
  }
  rename(src, dst);
}; syncBuiltinESMExports();`);
  await f.run([], 'order.mjs');
  const updated = signature(entry), updatedIndex = signature(index);
  assert.notEqual(updated.ino, before.ino);
  f.put('src/render/sub.ts', 'export const generation = 2;\n// Not emitted\n');
  await f.run();
  assert.deepEqual(signature(entry), updated);
  assert.equal(signature(index).ino, updatedIndex.ino);
  assert.ok(signature(index).mtimeMs > updatedIndex.mtimeMs);
  f.put('src/mcp/thin-main.ts', 'export const mcp = false;\n');
  await f.run();
  assert.match(fs.readFileSync(f.file('dist/mcp/thin-main.js'), 'utf8'), /mcp = false/);
  assert.notEqual(signature(index).ino, updatedIndex.ino);
  assert.deepEqual(signature(entry), updated);
});

test('concurrent targets serialize compilation and recover dead PID stages', async (t) => {
  const f = fixture(t);
  f.put('.dist-stage-2147483647/partial.js', 'crashed build');
  f.put(`.dist-test-stage-${process.pid}/live.js`, 'live PID');
  f.put('exclusive.mjs', `import cp from 'node:child_process'; import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
const spawn = cp.spawnSync;
cp.spawnSync = (...args) => {
  fs.mkdirSync('compiler-active');
  try { return spawn(...args); } finally { fs.rmdirSync('compiler-active'); }
}; syncBuiltinESMExports();`);
  const results = await Promise.allSettled([[], ['--target', 'test']].map((args) => f.run(args, 'exclusive.mjs')));
  for (const result of results) if (result.status === 'rejected') throw result.reason;
  assert.ok(fs.existsSync(f.file('dist/tree-page.js')));
  assert.ok(fs.existsSync(f.file('dist-test/unit/sub.test.js')));
  assert.deepEqual(f.stages(), [`.dist-test-stage-${process.pid}`]);
});

test('the nested MCP package builds the root output; only explicit clean removes the legacy tree', async (t) => {
  const f = fixture(t), legacy = 'packages/hud-mcp/dist/legacy.js';
  f.put(legacy, 'kept for old workers');
  const manifest = new URL('../../packages/hud-mcp/package.json', import.meta.url);
  fs.copyFileSync(manifest, f.file('packages/hud-mcp/package.json'));
  const { stderr } = await exec('npm', ['run', 'build'], { cwd: f.file('packages/hud-mcp') });
  assert.match(stderr, /packages\/hud-mcp\/dist is obsolete/);
  assert.ok(fs.existsSync(f.file('dist/mcp/thin-main.js')));
  assert.equal(fs.readFileSync(f.file(legacy), 'utf8'), 'kept for old workers');
  f.put('dist-test/unit/orphan.js', 'test output');
  const { stdout } = await f.run(['--clean']);
  assert.match(stdout, /^Removing packages\/hud-mcp\/dist$/m);
  for (const output of ['dist', 'dist-test', 'packages/hud-mcp/dist']) assert.equal(fs.existsSync(f.file(output)), false);
});

test('PanelReload probes a published non-MCP generation after its quiet window and when clean', async (t) => {
  const f = fixture(t);
  await f.run();
  const reload = new PanelReload(f.file('dist/tree-page.js'));
  f.put('src/render/sub.ts', 'export const generation = 2;\n');
  await f.run();
  assert.equal(await reload.poll(() => false, 10000), false);
  assert.equal(await reload.poll(() => false, 11999), false);
  assert.equal(await reload.poll(() => true, 12000), false);
  assert.equal(await reload.poll(() => false, 12001), true);
  assert.equal(reload.failed, false);
});

test('incremental build keeps buildinfo outside stage/dist, prunes deleted sources, self-heals cache and cleans', async (t) => {
  const f = fixture(t);
  f.put('src/extra/removed.ts', 'export const gone = 1;\n');
  await f.run();
  await f.run(['--target', 'test']);
  assert.equal(fs.existsSync(f.file('.tsbuild/main.tsbuildinfo')), true);
  assert.equal(fs.existsSync(f.file('.tsbuild/test.tsbuildinfo')), true);
  assert.equal(fs.existsSync(f.file('dist/extra/removed.js')), true);
  assert.deepEqual(f.stages(), []);

  // Deleting a source file prunes emitted artifacts from both .tsbuild/dist and live dist.
  fs.unlinkSync(f.file('src/extra/removed.ts'));
  await f.run();
  assert.equal(fs.existsSync(f.file('dist/extra')), false);
  assert.equal(fs.existsSync(f.file('.tsbuild/dist/extra')), false);

  // Deleting a cached output while tsbuildinfo remains triggers a self-healing rebuild.
  fs.unlinkSync(f.file('.tsbuild/dist/render/sub.js'));
  fs.unlinkSync(f.file('dist/render/sub.js'));
  await f.run();
  assert.equal(fs.existsSync(f.file('dist/render/sub.js')), true);
  assert.equal(fs.existsSync(f.file('.tsbuild/dist/render/sub.js')), true);

  await f.run(['--clean']);
  assert.equal(fs.existsSync(f.file('.tsbuild')), false);
});

test('--publish-from publishes a prebuilt tree through the staged publisher without altering the source', async (t) => {
  const f = fixture(t), other = fixture(t);
  await f.run();
  f.put('dist/stale.js', 'prune me');
  other.put('src/render/sub.ts', 'export const generation = 99;\n');
  await other.run();
  const srcDist = other.file('dist');
  const beforeSrc = fs.readFileSync(join(srcDist, 'render/sub.js'), 'utf8');
  await f.run(['--publish-from', srcDist]);
  assert.match(fs.readFileSync(f.file('dist/render/sub.js'), 'utf8'), /generation = 99/);
  assert.equal(fs.existsSync(f.file('dist/stale.js')), false);
  assert.equal(fs.readFileSync(join(srcDist, 'render/sub.js'), 'utf8'), beforeSrc);
  assert.deepEqual(f.stages(), []);
  await assert.rejects(f.run(['--publish-from', f.file('missing-dir')]), /not a real directory/);
});
});
