import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { appendExpEvent } from '../../dist/collectors/exp-ledger.js';
import { observeProxy, refreshProxyIfDue } from '../../dist/collectors/exp-proxy-refresh.js';
import { saveExpEdit } from '../../dist/collectors/exp-store.js';
import { adoptProjectJobs } from '../../dist/roles/job-project.js';
import { tryAbstractLock, withAbstractLock } from '../../dist/utils/abstract-lock.js';

test('tryAbstractLock and withAbstractLock serialize by scope and key', async (t) => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'hud-abstract-lock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const release = await tryAbstractLock('unit-test', dir);
  assert.ok(release);
  t.after(() => release());
  assert.equal(await tryAbstractLock('unit-test', dir), undefined);

  const otherScope = await tryAbstractLock('unit-other', dir);
  assert.ok(otherScope);
  await otherScope();

  await assert.rejects(() => withAbstractLock('unit-test', dir, () => 'never', { timeoutMs: 25 }), /abstract lock timeout \(unit-test\)/);
  await assert.rejects(() => tryAbstractLock('bad_scope', dir), /invalid abstract lock scope/);

  const waiting = withAbstractLock('unit-test', dir, () => 'acquired', { timeoutMs: 500 });
  await sleep(20);
  await release();
  await release(); // idempotent
  assert.equal(await waiting, 'acquired');
});

test('adoptProjectJobs uses abstract-lock (job-adopt) without flock', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'hud-job-adopt-lock-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'hud');
  const linkedHome = join(root, 'hud-link');
  const jobId = 'j00000000000000aa';
  const jobsDir = join(home, 'jobs');
  const jobDir = join(jobsDir, jobId);
  fs.mkdirSync(jobDir, { recursive: true });
  fs.symlinkSync(home, linkedHome);

  const receipt = {
    job: jobId,
    role: 'imp',
    cwd: root,
    project_root: root,
    herdr_pane: 'w4E:p9',
    created_at: '2030-01-01T00:00:00.000Z',
  };
  const jobFile = join(jobDir, 'job.json');
  fs.writeFileSync(jobFile, JSON.stringify(receipt, null, 2) + '\n');

  const fakeBin = join(root, 'bin');
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(
    join(fakeBin, 'herdr'),
    `#!${process.execPath}\nconsole.log(JSON.stringify({ result: { panes: [{ pane_id: 'w4E:p1', agent: 'pi', cwd: ${JSON.stringify(root)} }] } }));\n`,
    { mode: 0o700 }
  );
  // PATH has only fakeBin — no flock binary is reachable.
  const env = { PATH: fakeBin };
  const owes = () => true;

  const hold = await tryAbstractLock('job-adopt', fs.realpathSync(jobsDir));
  assert.ok(hold);
  t.after(() => hold());

  assert.equal(await adoptProjectJobs(linkedHome, 'w4E:p1', root, [receipt], env, owes), false);
  assert.equal(JSON.parse(fs.readFileSync(jobFile, 'utf8')).herdr_pane, 'w4E:p9');

  await hold();
  assert.equal(await adoptProjectJobs(linkedHome, 'w4E:p1', root, [receipt], env, owes), true);
  assert.equal(JSON.parse(fs.readFileSync(jobFile, 'utf8')).herdr_pane, 'w4E:p1');

  fs.rmSync(jobsDir, { recursive: true, force: true });
  assert.equal(await adoptProjectJobs(home, 'w4E:p1', root, [receipt], env, owes), false);
});

test('exp-ledger and exp-proxy-refresh share abstract-lock scopes', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'hud-exp-abstract-lock-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { HOME: join(root, 'home'), HUD_HOME: join(root, 'hud'), PATH: '' };
  const profile = join(env.HOME, '.codex');
  for (const dir of [profile, env.HUD_HOME]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(join(profile, 'config.toml'), '# synthetic\n');
  fs.writeFileSync(join(env.HUD_HOME, 'hud-settings.json'), JSON.stringify({ experiments: true }), { mode: 0o600 });

  const now = Date.parse('2026-11-20T10:30:00Z');
  saveExpEdit(env.HUD_HOME, { field: 'interval', value: 5 }, now, env);
  saveExpEdit(env.HUD_HOME, { field: 'proxy-enabled', value: true }, now, env);
  saveExpEdit(env.HUD_HOME, { field: 'binding', value: profile }, now, env);

  const observed = await observeProxy(env);
  assert.ok(observed);
  let rpcCalls = 0;
  const rpc = async () => {
    rpcCalls++;
    return {
      windows: {
        primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: (now + 300_000) / 1000 },
        secondary: { usedPercent: 20, windowDurationMins: 10080, resetsAt: (now + 604_800_000) / 1000 },
      },
    };
  };

  const holdProxy = await tryAbstractLock('exp-proxy', fs.realpathSync(env.HUD_HOME));
  assert.ok(holdProxy);
  t.after(() => holdProxy());
  assert.equal(await refreshProxyIfDue(env, observed, () => true, { now: () => now, rpc }), false);
  assert.equal(rpcCalls, 0);
  await holdProxy();
  assert.equal(await refreshProxyIfDue(env, observed, () => true, { now: () => now, rpc }), true);
  assert.equal(rpcCalls, 1);

  const ledgerPath = join(fs.realpathSync(join(env.HUD_HOME, 'exp')), 'ledger-openai-api.jsonl');
  const holdLedger = await tryAbstractLock('exp-ledger', ledgerPath);
  assert.ok(holdLedger);
  t.after(() => holdLedger());
  const writing = appendExpEvent(env.HUD_HOME, 'openai-api', {
    type: 'calibration',
    id: 'cal-1',
    at: '2026-11-20T10:30:00.000Z',
    remainingMicros: 5_000_000,
  });
  await sleep(25);
  assert.equal(fs.existsSync(ledgerPath), false);
  await holdLedger();
  await writing;
  const lines = fs.readFileSync(ledgerPath, 'utf8').trimEnd().split('\n').map(JSON.parse);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].id, 'cal-1');
});
