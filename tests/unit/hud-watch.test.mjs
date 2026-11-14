import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { main } from '../../dist/cli/hud-main.js';
import { watchCommand } from '../../dist/cli/watch.js';
import { procStat } from '../../packages/hud-mcp/dist/packages/hud-mcp/src/cli-judge.js';

function writeJob(hudHome, id, pane, pkg, status, report = false) {
  const dir = join(hudHome, 'jobs', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    join(dir, 'job.json'),
    JSON.stringify({
      job: id,
      role: 'imp',
      package: pkg,
      herdr_pane: pane,
      created_at: new Date().toISOString(),
      cli: { agent: 'claude' },
      dispatch_exit_code: 0,
      stderr_tail: '',
    })
  );
  if (status !== null) {
    fs.writeFileSync(join(dir, 'STATUS.json'), JSON.stringify(status));
  }
  if (report) {
    fs.writeFileSync(join(dir, 'report.md'), 'Synthetic report.');
  }
  return dir;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(check, timeoutMs = 4000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (check()) return;
    await wait(25);
  }
  assert.fail('timed out waiting for expected watcher output');
}

test('dead supervisor watcher preserves a live worker; both gone fail or close by the explicit report baseline', { timeout: 10000 }, async (t) => {
  const home = fs.mkdtempSync(join(tmpdir(), 'dead-supervisor-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, HUD_HOME: join(home, 'hud'), HUD_WATCH_CLI_CHECK_MS: '30' };
  const worker = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { env, stdio: 'ignore' });
  const supervisor = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { env, stdio: 'ignore' });
  t.after(() => { worker.kill('SIGKILL'); supervisor.kill('SIGKILL'); });
  await until(() => procStat(worker.pid) !== null);
  const initial = { state: 'working', pid: worker.pid, pid_start_time: procStat(worker.pid).start, supervisor_pid: supervisor.pid };
  const failed = writeJob(env.HUD_HOME, 'j00000000000000f1', 'w4E:p1', 'no-report', initial);
  const closed = writeJob(env.HUD_HOME, 'j00000000000000f2', 'w4E:p1', 'with-report', initial, true);
  for (const dir of [failed, closed]) fs.writeFileSync(join(dir, 'turn.json'), JSON.stringify({ seq: 1, sent_at: new Date().toISOString(), report_sig: null }));
  const watcher = spawn(process.execPath, [resolve('packages/hud-mcp/bin/hud-watch.mjs')], { env, stdio: 'ignore' });
  t.after(() => watcher.kill('SIGKILL'));
  supervisor.kill('SIGKILL');
  await new Promise((r) => supervisor.once('exit', r));
  const status = (dir) => JSON.parse(fs.readFileSync(join(dir, 'STATUS.json')));
  await until(() => status(failed).state === 'waiting_orchestrator');
  assert.equal(status(failed).reason, 'supervisor exited; worker still running');
  assert.equal(status(failed).error, null);
  assert.equal(status(closed).state, 'waiting_orchestrator');
  const stamp = fs.statSync(join(failed, 'STATUS.json')).mtimeMs;
  await wait(120);
  assert.equal(fs.statSync(join(failed, 'STATUS.json')).mtimeMs, stamp, 'unchanged observation does not rewrite STATUS');
  worker.kill('SIGKILL');
  await new Promise((r) => worker.once('exit', r));
  await until(() => status(failed).state === 'failed' && status(closed).state === 'closed');
  assert.equal(status(failed).exit_reason, 'worker exited');
  assert.equal(status(closed).output_written, true);
});

test('hud watch emits four lines for three transitions and qa/q1.md without writing HUD_HOME', async (t) => {
  const hudHome = fs.mkdtempSync(join(tmpdir(), 'hud-watch-'));
  t.after(() => fs.rmSync(hudHome, { recursive: true, force: true }));

  const callerDir = writeJob(hudHome, 'j00000000000000a1', 'w4E:p1', 'pkg-a', { state: 'working' });
  const foreignDir = writeJob(hudHome, 'j00000000000000b2', 'w4E:p9', 'pkg-b', { state: 'working' });

  const env = { ...process.env, HUD_HOME: hudHome, HERDR_PANE_ID: 'w4E:p1' };
  const lines = [];
  const ac = new AbortController();
  const running = watchCommand(
    [],
    {
      env,
      stdout: (text) => {
        lines.push(text.replace(/\n$/, ''));
      },
      stderr: () => {},
    },
    { rescanMs: 30000, signal: ac.signal }
  );

  await wait(80);
  assert.deepEqual(lines, []);

  // Foreign-pane changes must stay silent, and mutating HERDR_PANE_ID after startup must not switch panes.
  env.HERDR_PANE_ID = 'w4E:p9';
  fs.writeFileSync(join(foreignDir, 'STATUS.json'), JSON.stringify({ state: 'failed', exit_reason: 'tab closed' }));
  await wait(80);
  assert.deepEqual(lines, []);

  // 1: working -> waiting_orchestrator
  fs.writeFileSync(
    join(callerDir, 'STATUS.json'),
    JSON.stringify({ state: 'waiting_orchestrator', blocked: false, reason: 'quiet', harness: 'cli' })
  );
  await until(() => lines.length === 1);

  // 2: qa/q1.md appears -> QUESTION
  fs.mkdirSync(join(callerDir, 'qa'), { recursive: true });
  fs.writeFileSync(join(callerDir, 'qa', 'q1.md'), 'Synthetic question?\n');
  await until(() => lines.length === 2);

  // 3: qa/q1.answer.md + report.md -> report (QUESTION cleared)
  fs.writeFileSync(join(callerDir, 'qa', 'q1.answer.md'), 'Proceed.\n');
  fs.writeFileSync(join(callerDir, 'report.md'), 'Done report.\n');
  await until(() => lines.length === 3);

  // 4: STATUS -> done
  fs.writeFileSync(join(callerDir, 'STATUS.json'), JSON.stringify({ state: 'done', exit_reason: null }));
  await until(() => lines.length === 4);

  // New job appearing already failed after startup also prints.
  writeJob(hudHome, 'j00000000000000c3', 'w4E:p1', 'pkg-c', { state: 'failed', exit_reason: 'tab closed' });
  await until(() => lines.length === 5);

  ac.abort();
  assert.equal(await running, 0);

  assert.deepEqual(lines, [
    'j00000000000000a1 imp pkg-a: waiting_orchestrator | quiet',
    'j00000000000000a1 imp pkg-a: waiting_orchestrator | quiet | QUESTION',
    'j00000000000000a1 imp pkg-a: waiting_orchestrator | quiet | report',
    'j00000000000000a1 imp pkg-a: done | report',
    'j00000000000000c3 imp pkg-c: failed | tab closed',
  ]);
  assert.equal(fs.existsSync(join(hudHome, 'display')), false);
  assert.equal(fs.existsSync(join(hudHome, 'watch.pid')), false);
  assert.equal(fs.existsSync(join(hudHome, 'watch.log')), false);
});

test('hud watch --all watches every pane and exits cleanly on help, usage errors, and EPIPE', async (t) => {
  const hudHome = fs.mkdtempSync(join(tmpdir(), 'hud-watch-all-'));
  t.after(() => fs.rmSync(hudHome, { recursive: true, force: true }));

  let helpText = '';
  const helpCode = await main(['watch', '--help'], {
    env: { ...process.env, HUD_HOME: hudHome },
    stdout: (text) => {
      helpText += text;
    },
    stderr: () => {},
  });
  assert.equal(helpCode, 0);
  assert.match(helpText, /hud watch \[--all\]/);

  let errText = '';
  const badCode = await main(['watch', '--unknown'], {
    env: { ...process.env, HUD_HOME: hudHome },
    stdout: () => {},
    stderr: (text) => {
      errText += text;
    },
  });
  assert.equal(badCode, 2);
  assert.match(errText, /usage: hud watch \[--all\]/);

  const otherDir = writeJob(hudHome, 'j00000000000000d4', 'w9X:p2', 'pkg-other', { state: 'working' });
  const seen = [];
  const ac = new AbortController();
  const running = watchCommand(
    ['--all'],
    {
      env: { ...process.env, HUD_HOME: hudHome },
      stdout: (text) => {
        seen.push(text.trim());
        const epipe = Object.assign(new Error('broken pipe'), { code: 'EPIPE' });
        throw epipe;
      },
      stderr: () => {},
    },
    { rescanMs: 30000, signal: ac.signal }
  );

  await wait(60);
  fs.writeFileSync(join(otherDir, 'STATUS.json'), JSON.stringify({ state: 'failed', exit_reason: 'tab closed' }));
  assert.equal(await running, 0);
  assert.deepEqual(seen, ['j00000000000000d4 imp pkg-other: failed | tab closed']);
});

test('hud watch without HERDR_PANE_ID or --all prints one error line and exits 1', async (t) => {
  const hudHome = fs.mkdtempSync(join(tmpdir(), 'hud-watch-nopane-'));
  t.after(() => fs.rmSync(hudHome, { recursive: true, force: true }));
  let out = '';
  let err = '';
  const code = await main(['watch'], {
    env: { HUD_HOME: hudHome },
    stdout: (text) => { out += text; },
    stderr: (text) => { err += text; },
  });
  assert.equal(code, 1);
  assert.equal(out, '');
  assert.equal(err.trim().split('\n').length, 1);
  assert.match(err, /no pane.*--all/i);
});

test('idle hud watch reads nothing between safety rescans', async (t) => {
  const hudHome = fs.mkdtempSync(join(tmpdir(), 'hud-watch-idle-'));
  t.after(() => fs.rmSync(hudHome, { recursive: true, force: true }));
  const callerDir = writeJob(hudHome, 'j00000000000000e8', 'w4E:p1', 'pkg-idle', { state: 'working' });
  const jobsDir = join(hudHome, 'jobs');

  let jobLists = 0;
  let statusStats = 0;
  const originals = { readdirSync: fs.readdirSync, lstatSync: fs.lstatSync };
  fs.readdirSync = (file, ...args) => {
    if (String(file) === jobsDir) jobLists++;
    return originals.readdirSync(file, ...args);
  };
  fs.lstatSync = (file, ...args) => {
    if (String(file) === join(callerDir, 'STATUS.json')) statusStats++;
    return originals.lstatSync(file, ...args);
  };
  syncBuiltinESMExports();
  t.after(() => { Object.assign(fs, originals); syncBuiltinESMExports(); });

  const { watchCommand: freshWatch } = await import('../../dist/cli/watch.js?idle');
  const ac = new AbortController();
  t.after(() => ac.abort());
  const running = freshWatch([], { env: { HUD_HOME: hudHome, HERDR_PANE_ID: 'w4E:p1' }, stdout: () => {}, stderr: () => {} }, { rescanMs: 400, signal: ac.signal });

  // The baseline scan and the recursive watch's one-time attach may read the directory; after that, nothing.
  await wait(60);
  const lists = jobLists, stats = statusStats;
  assert.equal(stats, 1, 'one baseline read of STATUS.json');
  await wait(200);
  assert.equal(jobLists, lists, 'idle watch must not list jobs between rescans');
  assert.equal(statusStats, stats, 'idle watch must not stat STATUS.json between rescans');

  await until(() => statusStats > stats, 1000);
  assert.equal(statusStats, stats + 1, 'safety rescan reads once after rescanMs');

  ac.abort();
  assert.equal(await running, 0);
});

test('bin/hud watch flushes already-failed arrivals and exits cleanly on SIGTERM', { timeout: 10000 }, async (t) => {
  const hudHome = fs.mkdtempSync(join(tmpdir(), 'hud-watch-bin-'));
  t.after(() => fs.rmSync(hudHome, { recursive: true, force: true }));
  writeJob(hudHome, 'j00000000000000e5', 'w4E:p1', 'baseline', { state: 'working' });

  const child = spawn(process.execPath, [resolve('bin/hud'), 'watch'], {
    env: { ...process.env, HUD_HOME: hudHome, HERDR_PANE_ID: 'w4E:p1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk) => {
    stderr += chunk;
  });

  await wait(300);
  assert.equal(stdout, '');

  writeJob(hudHome, 'j00000000000000f6', 'w4E:p1', 'tab-gone', { state: 'failed', exit_reason: 'tab closed' });
  await until(() => stdout.includes('j00000000000000f6 imp tab-gone: failed | tab closed\n'), 6000);

  child.kill('SIGTERM');
  const [code, signal] = await new Promise((resolveExit) => child.once('exit', (c, s) => resolveExit([c, s])));
  assert.equal(signal, null);
  assert.equal(code, 0);
  assert.equal(stderr, '');
});
