import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { until } from '../helpers/thin-mcp-harness.mjs';
import { checkout, job, jobDir } from '../helpers/thin-mcp-land.mjs';

async function buildableCheckout(t, { gate = ['npm run build'], after = ['npm run build'], native = false } = {}) {
  const f = await checkout(t, gate, { after });
  const put = (base, rel, body) => {
    const full = join(base, rel);
    fs.mkdirSync(join(full, '..'), { recursive: true });
    fs.writeFileSync(full, body);
  };
  put(f.main, '.gitignore', 'dist/\ndist-test/\n.tsbuild/\n.dist-stage-*/\n.dist-test-stage-*/\n');
  put(f.main, 'package.json', JSON.stringify({ type: 'module', scripts: { build: 'node scripts/build.mjs' } }));
  fs.copyFileSync(resolve('tsconfig.json'), join(f.main, 'tsconfig.json'));
  fs.mkdirSync(join(f.main, 'scripts'), { recursive: true });
  for (const name of ['build.mjs', 'build-native.mjs', 'dist-lock.mjs', 'dist-lock.d.mts']) {
    fs.copyFileSync(resolve('scripts', name), join(f.main, 'scripts', name));
  }
  fs.symlinkSync(resolve('node_modules'), join(f.main, 'node_modules'), 'dir');
  const binder = 'packages/hud-mcp/bin/agy-events.d.mts';
  put(f.main, binder, fs.readFileSync(resolve(binder)));
  put(f.main, 'src/index.ts', "export { buildStamp } from '../scripts/dist-lock.mjs';\nexport { hasAgyEvents } from '../packages/hud-mcp/bin/agy-events.mjs';\n");
  put(f.main, 'src/tree-page.ts', 'export const page = 1;\n');
  put(f.main, 'src/mcp/thin-main.ts', 'export const version = 1;\n');
  put(f.main, '.hud/project.json', JSON.stringify({
    worktree: { disposable: ['dist/**', 'dist-test/**', '.tsbuild/**'] },
    land: { base: 'base', gate, after, push: true, wrapper: 'wrap' },
  }));
  if (native) put(f.main, 'native/Cargo.toml', '# synthetic native sources\n');
  f.git(f.main, 'add', '.gitignore', 'package.json', 'tsconfig.json', 'scripts', 'packages', 'node_modules', 'src', '.hud/project.json',
    ...(native ? ['native'] : []));
  f.git(f.main, 'commit', '-qm', 'add buildable project');
  const seeded = f.git(f.main, 'rev-parse', 'HEAD');
  f.git(f.main, 'push', '-q', 'origin', 'base');
  f.git(f.worktree, 'rebase', 'base');
  put(f.worktree, 'src/mcp/thin-main.ts', 'export const version = 2;\n');
  f.git(f.worktree, 'commit', '-qam', 'bump version');
  return { ...f, seeded, put };
}

test('after npm run build is skipped via staged publish when inputs match, even with a folded ticket commit', async t => {
  const f = await buildableCheckout(t);
  const dir = jobDir(f), ticket = '.scratch/feature/issues/01-example.md', receipt = join(dir, 'job.json');
  fs.writeFileSync(receipt, JSON.stringify({ ...JSON.parse(fs.readFileSync(receipt)), ticket: 'feature/01' }));
  f.put(f.main, ticket, '# 01: Example\n**Status:** ready-for-agent\n**Owner try:** no\n- [ ] done\n');
  f.git(f.main, 'add', ticket); f.git(f.main, 'commit', '-qm', 'seed ticket');
  f.git(f.worktree, 'rebase', 'base');
  const { flow } = await f.call('hud_land', { job });
  await until(() => ['failed', 'completed'].includes(f.flowState(flow).state), 20000);
  const done = f.flowState(flow);
  assert.equal(done.state, 'completed', JSON.stringify(done));
  assert.notEqual(done.landed_sha, done.tested_sha);
  const afterTiming = done.timings.find(e => e.step === 'after[1]: npm run build');
  assert.equal(afterTiming?.ok, true);
  assert.equal(afterTiming?.skipped, true);
  assert.match(fs.readFileSync(join(f.main, 'dist/mcp/thin-main.js'), 'utf8'), /version = 2/);
  // No compiler run occurred in main checkout because dist was published from the tested integration checkout.
  assert.equal(fs.existsSync(join(f.main, '.tsbuild')), false);
});

for (const scenario of ['publish changed native', 'reuse tested native despite a TS rebuild', 'keep existing native', 'missing Cargo']) test(`land: ${scenario}`, {
  skip: process.platform !== 'linux' || process.arch !== 'x64',
}, async t => {
  const f = await buildableCheckout(t, {
    native: true,
    gate: scenario === 'keep existing native' ? ['npm run build', '/bin/rm -r dist/native'] : undefined,
    after: scenario === 'missing Cargo' ? ['npm run build', 'npm run build'] : undefined,
  });
  const tools = join(f.main, 'tools'), cargo = join(tools, 'cargo'), log = join(f.main, 'cargo.log');
  fs.mkdirSync(tools);
  fs.symlinkSync(process.execPath, join(tools, 'node'));
  fs.symlinkSync(execFileSync('sh', ['-c', 'command -v npm'], { encoding: 'utf8' }).trim(), join(tools, 'npm'));
  fs.symlinkSync('/bin/sh', join(tools, 'sh'));
  fs.writeFileSync(join(f.main, 'wrap'), `#!/bin/sh
unset NODE_TEST_CONTEXT
export PATH="\${0%/*}/tools" HOME="$HOME/wrapped" CARGO_LOG="\${0%/*}/cargo.log"
exec "$@"
`);
  fs.writeFileSync(cargo, `#!/bin/sh
set -eu
# Simulate a rustup shim requiring the original toolchain homes under a wrapped HOME.
[ -n "$RUSTUP_HOME" ] && [ "$RUSTUP_HOME" != "$HOME/.rustup" ]
[ -n "$CARGO_HOME" ] && [ "$CARGO_HOME" != "$HOME/.cargo" ]
printf '%s\\n' "$1" >> "$CARGO_LOG"
[ "$1" != --version ] || exit 0
while [ "$1" != --target-dir ]; do shift; done
out=$2/x86_64-unknown-linux-gnu/release
/bin/mkdir -p "$out"
/bin/cp Cargo.toml "$out/hud-statusline"
`, { mode: 0o700 });
  const binary = join(f.main, 'dist/native/hud-statusline'), stamp = join(f.main, 'dist/native/source.sha256');
  let before;
  if (scenario === 'keep existing native' || scenario === 'missing Cargo') {
    execFileSync(join(f.main, 'wrap'), ['npm', 'run', 'build'], { cwd: f.main, env: {
      ...f.env, RUSTUP_HOME: join(f.env.HOME, '.rustup'), CARGO_HOME: join(f.env.HOME, '.cargo'),
    } });
    before = fs.statSync(binary).ino;
    fs.rmSync(join(f.main, '.tsbuild/native'), { recursive: true });
    fs.unlinkSync(cargo);
  }
  if (scenario !== 'keep existing native') {
    f.put(f.worktree, 'native/Cargo.toml', '# changed native sources\n');
    f.git(f.worktree, 'commit', '-qam', 'change native sources');
  }
  const rebuild = scenario === 'reuse tested native despite a TS rebuild';
  if (rebuild) f.put(f.main, 'src/local-extra.ts', 'export const localExtra = true;\n');
  const { flow } = await f.call('hud_land', { job });
  await until(() => ['failed', 'completed'].includes(f.flowState(flow).state), 20000);
  const done = await f.call('hud_read', { job: flow });
  assert.equal(done.state, 'completed', JSON.stringify(done));
  const after = done.timings.filter(e => e.step.startsWith('after['));
  assert.ok(after.length && after.every(e => e.ok && Boolean(e.skipped) === !rebuild), JSON.stringify(after));
  if (scenario === 'missing Cargo') {
    assert.equal(fs.existsSync(binary), false);
    assert.equal(fs.existsSync(stamp), false);
    const note = 'Cargo unavailable; the TS statusline stays in use.';
    assert.equal(done.after_note, note);
    const notice = done.changes.find(line => line.includes(flow));
    assert.equal(notice?.split(note).length, 2, notice);
  } else {
    const source = fs.readFileSync(join(f.main, 'native/Cargo.toml'));
    assert.deepEqual(fs.readFileSync(binary), source);
    const [sourceHash, binaryHash] = fs.readFileSync(stamp, 'utf8').split('\n');
    assert.match(sourceHash, /^[a-f0-9]{64}$/);
    assert.equal(binaryHash, createHash('sha256').update(source).digest('hex'));
    assert.equal(fs.statSync(binary).mode & 0o111, 0o111);
    assert.equal(done.after_note, undefined);
    assert.equal(fs.readFileSync(log, 'utf8'), '--version\nbuild\n');
    if (before !== undefined) assert.equal(fs.statSync(binary).ino, before);
  }
});

for (const reason of ['dirty main src', 'dirty declaration', 'replayed base']) test(`after npm run build rebuilds when inputs do not match (${reason})`, async t => {
  const f = await buildableCheckout(t, {
    gate: reason === 'replayed base' ? ['npm run build', 'while test ! -f "$HOME/release"; do sleep .05; done'] : ['npm run build'],
  });
  if (reason === 'dirty main src') f.put(f.main, 'src/local-extra.ts', 'export const localExtra = true;\n');
  if (reason === 'dirty declaration') f.put(f.main, 'packages/hud-mcp/bin/agy-events.d.mts', 'export function hasAgyEvents(): false;\n');
  const { flow } = await f.call('hud_land', { job });
  if (reason === 'replayed base') {
    await until(() => f.flowState(flow).step.startsWith('gate[2]'), 15000);
    f.put(f.main, 'src/unrelated.ts', 'export const unrelated = 7;\n');
    f.git(f.main, 'add', 'src/unrelated.ts'); f.git(f.main, 'commit', '-qm', 'unrelated src on base');
    fs.writeFileSync(join(f.env.HOME, 'release'), 'go');
  }
  await until(() => ['failed', 'completed'].includes(f.flowState(flow).state), 20000);
  const done = f.flowState(flow);
  assert.equal(done.state, 'completed', JSON.stringify(done));
  const afterTiming = done.timings.find(e => e.step === 'after[1]: npm run build');
  assert.equal(afterTiming?.ok, true);
  assert.equal(afterTiming?.skipped, undefined);
  assert.equal(fs.existsSync(join(f.main, '.tsbuild/main.tsbuildinfo')), true);
  assert.match(fs.readFileSync(join(f.main, 'dist/mcp/thin-main.js'), 'utf8'), /version = 2/);
  if (reason === 'dirty main src') {
    assert.match(fs.readFileSync(join(f.main, 'dist/local-extra.js'), 'utf8'), /localExtra = true/);
  } else if (reason === 'replayed base') {
    assert.match(fs.readFileSync(join(f.main, 'dist/unrelated.js'), 'utf8'), /unrelated = 7/);
  }
});
