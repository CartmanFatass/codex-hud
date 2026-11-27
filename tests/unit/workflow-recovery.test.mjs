import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { batchIndex, batchLock, saveBatch } from '../../dist/mcp/batch-state.js';
import { stopChild } from '../helpers/process-cleanup.mjs';
import { fixture, rpcClient, resultValue, until } from '../helpers/thin-mcp-harness.mjs';

function holdSonic(f) {
  const home = f.env.HUD_HOME;
  fs.mkdirSync(join(home, 'roles'), { recursive: true });
  fs.writeFileSync(join(home, 'roles/sonic.json'), JSON.stringify({ role: 'sonic', instructions: 'sonic', can_continue: false,
    run: [{ harness: 'pi', pi_role: 'sonic', model: 'synthetic/example' }] }));
  fs.writeFileSync(f.env.HUD_SETTINGS_PATH, JSON.stringify({ autoPrewalk: false, roleCaps: { sonic: 3 } }));
  fs.writeFileSync(join(f.env.HOME, 'hold-sonic'), '');
}
// All processes including the watcher and fake pi are scoped to this fixture's HOME/HUD_HOME.
test('3 Sonic briefs: concurrent host loses election; replacement binds the crashed admission and delivers one end', { timeout: 30_000 }, async t => {
  const f = await fixture(t, { failedRetentionMs: 60_000 }), home = f.env.HUD_HOME;
  holdSonic(f);
  const items = ['Name the three synthetic colours.', 'Name a shape.', 'Name a tree.'].map((s,k) => {
    const brief_file = `sample-${k}.md`; fs.writeFileSync(join(f.root, brief_file), s); return { brief_file };
  });
  const { flow } = await f.call('hud_create', { role: 'sonic', items, cwd: f.root });
  const snapshot = () => batchIndex(home, flow), runner = resolve('packages/hud-mcp/bin/workflow-runner.mjs');
  await until(() => snapshot().items[0].job, t.signal);
  const pilot = snapshot().items[0].job, pid = snapshot().batch.pid;
  execFileSync(process.execPath, [runner, flow], { env: f.env, cwd: f.root, timeout: 4000 });
  assert.equal(snapshot().batch.pid, pid, 'second host must exit without writing a receipt');
  // Crash after publication of the keyed job but before binding it into index.json.
  await batchLock(home, flow, () => {
    const current = snapshot();
    assert.ok(fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(`HUD_HOME=${home}`));
    assert.ok(fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').includes(runner));
    process.kill(pid, 'SIGKILL');
    delete current.items[0].job;
    saveBatch(home, current.batch, current.items);
  });
  // No control call: the on-demand watcher must adopt the live batch.
  await until(() => snapshot().batch.pid !== pid && snapshot().items[0].job === pilot, t.signal);
  for (let k = 0; k < 3; k++) {
    await until(() => snapshot().items[k].job, t.signal);
    fs.writeFileSync(join(home, 'jobs', snapshot().items[k].job, 'release-sonic'), '');
  }
  await until(() => snapshot().batch.state === 'completed', t.signal);
  const result = await f.call('hud_read', { job: flow }), b = snapshot().batch;
  assert.equal(result.totals.done, 3); assert.equal(b.steps.items.state, 'done');
  assert.deepEqual(Object.keys(b.notices), ['end-0']);
  const delivered = () => (result.changes ?? []).filter(l => l === b.notices['end-0']).length +
    f.commands().filter(cmd => cmd.args.includes(b.notices['end-0'])).length;
  await until(() => delivered() > 0, t.signal);
  assert.equal(delivered(), 1);
  assert.ok(!(await f.call('hud_read', { job: flow })).changes?.includes(b.notices['end-0']));
  const members = fs.readdirSync(join(home, 'jobs')).filter(j => /^j[0-9a-f]{16}$/.test(j)).map(j =>
    JSON.parse(fs.readFileSync(join(home,'jobs',j,'job.json')))).filter(j => j.workflow === flow);
  assert.equal(members.length, 3); assert.equal(new Set(members.map(j => j.request_key)).size, 3);
  for (const path of [`${flow}.json`, ...['graph','manifest','index'].map(n => `${flow}/${n}.json`)])
    assert.equal(fs.statSync(join(home,'flows',path)).mode & 0o777, 0o600);
});

test('losing the dispatching pane and MCP does not stop admissions; the next project main receives the pending end', { timeout: 30_000 }, async t => {
  const f = await fixture(t), home = f.env.HUD_HOME;
  holdSonic(f);
  const { flow } = await f.call('hud_create', { role: 'sonic', cwd: f.root, items: [{ task: 'Find the longer synthetic pilot.' }, { task: 'Find red.' }] });
  const snapshot = () => batchIndex(home, flow);
  await until(() => snapshot().items[0].job, t.signal);
  const { pane, origin_mcp: { pid } } = snapshot().batch;
  // The pane no longer exists. Even a transport reporting a stale successful prompt must
  // not consume the end notice on behalf of the dead originating MCP.
  f.overrideBin('herdr', `#!/bin/sh\nif [ "$1 $2 $3" = 'pane get ${pane}' ]; then exit 1; fi\nexec node "$FAKE_BIN" herdr "$@"\n`);
  assert.ok(fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(`HUD_HOME=${home}`));
  process.kill(pid, 'SIGKILL'); await f.stopMcp();
  for (let k = 0; k < 2; k++) {
    await until(() => snapshot().items[k].job, t.signal);
    fs.writeFileSync(join(home, 'jobs', snapshot().items[k].job, 'release-sonic'), '');
  }
  await until(() => snapshot().batch.state === 'completed', t.signal);
  const line = snapshot().batch.notices['end-0']; assert.match(line, /2 done.*final/);
  const marker = join(home,'flows',flow,'end-0.noticed'); assert.ok(!fs.existsSync(marker));
  function nextMain(cwd) {
    const child = spawn(process.execPath, [resolve('packages/hud-mcp/bin/hud-mcp.mjs')], { cwd,
      env: { ...f.env, HERDR_PANE_ID: 'w4E:p8' }, stdio: ['pipe','pipe','inherit'] });
    const exited = once(child, 'exit'); f.onCleanup(() => stopChild(child, exited, { closeStdin: true }));
    const rpc = rpcClient(child);
    return async () => resultValue((await rpc('tools/call', { name: 'hud_read', arguments: { job: flow } })).result);
  }
  const unrelated = join(f.root, 'other'); fs.mkdirSync(unrelated);
  const stranger = await nextMain(unrelated)();
  assert.equal(stranger.code, 'flow_not_found'); assert.ok(!stranger.changes?.includes(line)); assert.ok(!fs.existsSync(marker));
  fs.writeFileSync(join(f.env.HOME, 'pane-list.json'), JSON.stringify({ result: { panes: [
    { pane_id: 'w4E:p8', agent: 'claude', cwd: f.root },
  ] } }));
  const read = nextMain(f.root), first = await read();
  assert.equal(first.totals.done, 2); assert.deepEqual(first.changes.filter(l => l === line), [line]);
  assert.ok(fs.existsSync(marker)); assert.ok(!(await read()).changes?.includes(line));
});
