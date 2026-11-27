import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { LandOutput } from '../../dist/mcp/land-evidence.js';
import { landNotice } from '../../dist/mcp/land-state.js';
import { landTask } from '../../dist/mcp/land.js';
import { isProcAlive, procStat } from '../../dist/utils/proc.js';
import { until } from '../helpers/thin-mcp-harness.mjs';
import { checkout, job } from '../helpers/thin-mcp-land.mjs';

for (const kind of ['gate', 'after']) test(`land bounds a hung ${kind} and kills children holding the output pipes`, async t => {
  // In the gate case the shell itself exits successfully, but its child still holds the pipes.
  const hung = `seq 50; (trap '' TERM; touch "$HOME/ready"; exec sleep 60) & echo $! > "$HOME/sleeper.tmp" && mv "$HOME/sleeper.tmp" "$HOME/sleeper"; ${kind === 'gate' ? 'exit 0' : 'wait'}`;
  const f = await checkout(t, kind === 'gate' ? [hung] : ['true'], { timeout_s: 3, ...(kind === 'after' ? { after: [hung] } : {}) });
  const { flow } = await f.call('hud_land', { job });
  await until(() => {
    const row = f.flowState(flow);
    assert.notEqual(row.state, 'failed', JSON.stringify(row));
    return fs.existsSync(join(f.env.HOME, 'ready')) && fs.existsSync(join(f.env.HOME, 'sleeper'));
  }, t.signal);
  const pid = Number(fs.readFileSync(join(f.env.HOME, 'sleeper'), 'utf8'));
  const start = procStat(pid)?.start;
  assert.ok(start && isProcAlive(pid, start));
  await until(() => f.flowState(flow).state === 'failed', t.signal);
  const done = await f.call('hud_read', { job: flow });
  assert.ok(done.step.startsWith(`${kind}[1]:`));
  assert.equal(done.error, 'timeout');
  assert.deepEqual(done.tail, Array.from({ length: 40 }, (_, i) => String(i + 11)));
  assert.equal(done.repairs, undefined);
  if (kind === 'gate') {
    assert.equal(done.reruns[0].rerun_ok, undefined);
    assert.equal(fs.readFileSync(done.reruns[0].output_path, 'utf8'), done.tail.join('\n'));
  } else assert.equal(done.reruns, undefined);
  assert.equal(isProcAlive(pid, start), false);
  assert.equal((await f.call('hud_lease', { name: 'main-checkout', wait_s: 2 })).granted, true);
  assert.equal(f.git(f.remote, 'rev-parse', 'base'), f.base_head);
  assert.equal(!!done.landed_sha, kind === 'after');
});

test('gate evidence drops panel frames and reserves the first assertion from each file', () => {
  const output = new LandOutput('/synthetic');
  const stream = output.stream();
  const panelRow = '\x1b[32m  ┃ synthetic panel card                \x1b[0m';
  const log = [
    'test at first.test.mjs:4:5', '✖ first check (1ms)', '  AssertionError: first assertion',
    '\x1b[32m   Home ?1  Project ?2  Control   models off  \x1b[0m',
    ...Array.from({ length: 900 }, () => [' '.repeat(80), panelRow]).flat(),
    ...Array.from({ length: 8 }, () => '      at ' + '✓'.repeat(700)),
    'test at first.test.mjs:8:5', '✖ another check (1ms)', '  AssertionError: another assertion',
    'test at second.test.mjs:2:5', '✖ second check (1ms)', '  AssertionError: second assertion',
    ...Array.from({ length: 60 }, (_, i) => `post-test output ${i}`),
  ];
  log.forEach(stream.line); stream.finish();
  const { excerpt, tail, tests } = output.evidence();
  assert.ok(Buffer.byteLength(excerpt) <= 8192);
  assert.ok(tail.length <= 40);
  assert.doesNotMatch(excerpt, /^\s*$|panel card|models off|post-test output|\uFFFD/m);
  for (const [name, assertion] of [['first check', 'first assertion'], ['another check', 'another assertion'], ['second check', 'second assertion']]) {
    assert.ok(excerpt.includes(`✖ ${name} (1ms)\n  AssertionError: ${assertion}`));
    assert.ok(tail.includes(`  AssertionError: ${assertion}`));
  }
  const step = 'gate[2]: npm run test:sample';
  const flow = { flow: 'f0000000000000123', job, state: 'failed', step: 'repair 1', error: 'worker stopped', tail,
    repairs: [{ step, outcome: 'worker stopped' }],
    reruns: [{ step, tests: [...tests, 'undisplayed fourth check'], output_path: 'sample.log', rerun_ok: false }] };
  const notice = landNotice(flow);
  const headline = /failed: gate\[2\]: npm run test:sample \(repair 1\).*failing tests: first check .*another check .*second check/;
  assert.match(notice.split('\n')[0], headline);
  assert.match(landTask('/synthetic', flow).statusMessage, headline);
  assert.doesNotMatch(notice, /undisplayed fourth check/);
});

test('gate reruns only the failing step once and reports its recovery without dispatch', async t => {
  const f = await checkout(t, ['echo first >> "$HOME/count"', `echo flaky >> "$HOME/count"; test -f "$HOME/once" || {
    touch "$HOME/once"; node -e 'console.log("✓".repeat(4000)); console.log("synthetic final line")'; exit 1;
  }`]);
  const { flow } = await f.call('hud_land', { job });
  await until(() => f.flowState(flow).state === 'completed', 15000);
  const done = await f.call('hud_read', { job: flow });
  assert.equal(done.repairs, undefined); assert.equal(done.reruns.length, 1);
  assert.match(done.changes.join('\n'), /gate\[2\].*passed on immediate rerun/);
  const excerpt = fs.readFileSync(done.reruns[0].output_path);
  assert.ok(excerpt.length <= 8192);
  assert.match(excerpt.toString('utf8'), /^✓+\nsynthetic final line$/);
  assert.equal(fs.readFileSync(join(f.env.HOME, 'count'), 'utf8'), 'first\nflaky\nflaky\n');
});

test('gate reruns only the node:test files that failed and reports the flaky test names', async t => {
  const f = await checkout(t, ['npm run test:sample']);
  fs.writeFileSync(join(f.worktree, 'package.json'), JSON.stringify({ scripts: { 'test:sample': 'node --test -- sample/*.test.mjs' } }));
  fs.mkdirSync(join(f.worktree, 'sample'));
  for (const [file, names] of [['alpha.test.mjs', ['alpha recovers', 'another alpha recovers']], ["beta's test.test.mjs", ['beta recovers']], ['green.test.mjs', []]]) {
    fs.writeFileSync(join(f.worktree, 'sample', file), `
import assert from 'node:assert/strict';
import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
const marker = join(process.env.HOME, ${JSON.stringify(file)});
const seen = existsSync(marker);
appendFileSync(marker, 'run\\n');
for (const name of ${JSON.stringify(names)}) test(name, () => assert.ok(seen, 'synthetic assertion: ' + name));
`);
  }
  f.git(f.worktree, 'add', 'sample', 'package.json'); f.git(f.worktree, 'commit', '-qm', 'add tests');
  const { flow } = await f.call('hud_land', { job });
  await until(() => ['failed', 'completed'].includes(f.flowState(flow).state), 15000);
  const done = await f.call('hud_read', { job: flow });
  assert.equal(done.state, 'completed', JSON.stringify(done));
  assert.equal(done.repairs, undefined);
  assert.deepEqual(done.reruns[0].tests, [
    'alpha recovers (sample/alpha.test.mjs)', 'another alpha recovers (sample/alpha.test.mjs)', "beta recovers (sample/beta's test.test.mjs)",
  ]);
  const { output_path: path, rerun_output_path } = done.reruns[0];
  const notice = done.changes.find(line => line.includes('flaky tests:'));
  assert.match(notice, /flaky tests: alpha recovers .*another alpha recovers .*beta recovers/);
  assert.ok(notice.includes(path));
  assert.equal(rerun_output_path, undefined);
  assert.equal(fs.statSync(path).mode & 0o777, 0o600);
  const excerpt = fs.readFileSync(path, 'utf8');
  assert.ok(path.startsWith(join(f.home, 'flows', `${flow}.json.`)));
  assert.match(excerpt, /^test at .*alpha\.test\.mjs:/);
  for (const name of ['alpha recovers', 'another alpha recovers', 'beta recovers'])
    assert.ok(excerpt.includes(`AssertionError [ERR_ASSERTION]: synthetic assertion: ${name}`));
  assert.doesNotMatch(excerpt, /ℹ tests|✖ failing tests:/);
  assert.equal(fs.readFileSync(join(f.env.HOME, 'green.test.mjs'), 'utf8'), 'run\n');
  for (const file of ['alpha.test.mjs', "beta's test.test.mjs"])
    assert.equal(fs.readFileSync(join(f.env.HOME, file), 'utf8'), 'run\nrun\n');
  assert.equal((await f.call('hud_read', { job: flow })).reruns[0].output_path, path);
  fs.unlinkSync(join(f.home, 'flows', `${flow}.json`));
  assert.equal((await f.call('hud_read', { job: flow })).code, 'flow_not_found');
  assert.equal(fs.readFileSync(path, 'utf8'), excerpt, 'the orphan log stays intact for archive-first retention');
});

test('gate reruns a timed-out test file once, not its passing neighbor', async t => {
  const f = await checkout(t, ['node --test --test-timeout=200 --test-force-exit -- *.test.mjs']);
  fs.writeFileSync(join(f.worktree, 'hung.test.mjs'), `
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
test('times out on the first run', async () => {
  const marker = join(process.env.HOME, 'timeout-ran');
  if (existsSync(marker)) return;
  writeFileSync(marker, 'yes');
  setInterval(() => {}, 1000);
  await new Promise(() => {});
});
`);
  fs.writeFileSync(join(f.worktree, 'green.test.mjs'), `
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
test('passing neighbor', () => appendFileSync(join(process.env.HOME, 'green-ran'), 'run\\n'));
`);
  f.git(f.worktree, 'add', 'hung.test.mjs', 'green.test.mjs'); f.git(f.worktree, 'commit', '-qm', 'add timed test');
  const { flow } = await f.call('hud_land', { job });
  await until(() => ['failed', 'completed'].includes(f.flowState(flow).state), 15000);
  const done = f.flowState(flow);
  assert.equal(done.state, 'completed', JSON.stringify(done));
  assert.deepEqual(done.reruns[0].tests, ['times out on the first run (hung.test.mjs)']);
  assert.equal(fs.readFileSync(join(f.env.HOME, 'green-ran'), 'utf8'), 'run\n');
});

test('flow receipt records per-step timings including separate gate reruns', async t => {
  const f = await checkout(t, ['true', 'test -f "$HOME/once" || { touch "$HOME/once"; exit 1; }']);
  const { flow } = await f.call('hud_land', { job });
  await until(() => f.flowState(flow).state === 'completed', 15000);
  const state = f.flowState(flow);
  const view = await f.call('hud_read', { job: flow });
  assert.deepEqual(view.timings, state.timings);
  const steps = state.timings.map(e => `${e.step}${e.rerun ? ':rerun' : ''}:${e.ok}`);
  assert.ok(steps.includes('create integration:true'), JSON.stringify(steps));
  assert.ok(steps.includes('gate[1]: true:true'), JSON.stringify(steps));
  assert.ok(steps.some(s => s.startsWith('gate[2]:') && s.endsWith(':false')), JSON.stringify(steps));
  assert.ok(steps.some(s => s.startsWith('gate[2]:') && s.endsWith(':rerun:true')), JSON.stringify(steps));
  assert.ok(steps.includes('records:true') && steps.includes('fast-forward:true') && steps.includes('push:true') && steps.includes('cleanup:true'));
  for (const entry of state.timings) {
    assert.equal(typeof entry.ms, 'number');
    assert.ok(Number.isInteger(entry.ms) && entry.ms >= 0);
  }
});
