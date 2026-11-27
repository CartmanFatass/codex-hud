import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readSessionJobRows } from '../../dist/collectors/thin-jobs.js';
import { JobIndexCache } from '../../dist/roles/job-index-cache.js';
import { sharedRoot } from '../../dist/roles/projects.js';
import { claimDelivery } from '../../dist/utils/delivery-record.js';

const pane = 'w4E:p1', foreign = 'w4E:p2';

test('a quiet panel timer neither loads job receipts nor lists panes nor writes files', async t => {
  const home = fs.mkdtempSync(join(tmpdir(), 'hud-panel-idle-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const endpoint = join(home, 'herdr.sock');
  let paneRequests = 0;
  const herdr = createServer(socket => {
    paneRequests++;
    socket.once('data', data => {
      const { id } = JSON.parse(data.toString());
      socket.end(JSON.stringify({ id, result: { panes: [] } }) + '\n');
    });
  }).listen(endpoint);
  await once(herdr, 'listening');
  t.after(() => new Promise(resolve => herdr.close(resolve)));

  const env = { HUD_HOME: home, HERDR_PANE_ID: pane, HERDR_SOCKET_PATH: endpoint };
  const before = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const cwd = process.cwd(), root = sharedRoot(cwd), at = new Date().toISOString();
  const id = 'perm-0000000000000001', job = 'j0000000000000001', dir = join(home, 'jobs', job);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(join(dir, 'job.json'), JSON.stringify({ job, role: 'imp', cwd, project_root: root, herdr_pane: foreign, created_at: at }));
  fs.writeFileSync(join(dir, 'STATUS.json'), JSON.stringify({ state: 'blocked', updated_at: at }));
  fs.writeFileSync(join(dir, 'permissions.json'), JSON.stringify({ active: id, entries: [{ id, at,
    action: 'main', outcome: 'pending', text: 'Synthetic permission', reason: 'Manual review', options: [] }] }));
  const marker = join(dir, `${id}.noticed`);
  const accepted = JSON.stringify({ v: 1, state: 'accepted', epoch: id, at: Date.now(), via: 'watch-stdout' });
  fs.writeFileSync(marker, accepted);
  const inode = fs.statSync(marker).ino;

  const flows = join(home, 'flows');
  fs.mkdirSync(flows);
  const flow = 'f0000000000000001';
  fs.writeFileSync(join(flows, `${flow}.json`), JSON.stringify({ flow, pane, wt: { main_root: root }, state: 'completed', auto_land: true }));
  const other = 'j0000000000000002', otherDir = join(home, 'jobs', other);
  fs.mkdirSync(otherDir);
  fs.writeFileSync(join(otherDir, 'job.json'), JSON.stringify({ job: other, role: 'imp', cwd: home, project_root: home, herdr_pane: foreign, created_at: at }));
  for (const file of ['permissions.json', 'STATUS.json']) fs.copyFileSync(join(dir, file), join(otherDir, file));

  const { session } = await import('../../dist/mcp/mcp/session-state.js');
  const ops = await import('../../dist/mcp/mcp/operations.js');
  session.taskClient = true;
  t.after(async () => { session.taskClient = false; await ops.syncPanelDelivery(); });
  t.mock.timers.enable({ apis: ['setInterval'] });
  await ops.syncPanelDelivery(); // Cursor initialization is not part of a tick.

  const receipts = t.mock.method(JobIndexCache.prototype, 'readJob');
  const inventory = t.mock.method(JobIndexCache.prototype, 'listJobIds');
  const listings = t.mock.method(fs, 'readdirSync'), stats = t.mock.method(fs, 'lstatSync');
  const writes = t.mock.method(fs, 'writeFileSync');
  const unlinks = t.mock.method(fs, 'unlinkSync');
  syncBuiltinESMExports();
  try {
    t.mock.timers.tick(1000);
    await new Promise(setImmediate);
    assert.equal(inventory.mock.callCount(), 1, 'first tick checks the permission inventory');
    assert.deepEqual(receipts.mock.calls.map(call => call.arguments[0]), [other], 'accepted marker needs no receipt');
    listings.mock.resetCalls(); stats.mock.resetCalls();
    receipts.mock.resetCalls();
    t.mock.timers.tick(1000);
    await new Promise(setImmediate);
    await t.test('settled flow history costs no directory enumeration on the second tick', () => {
      assert.equal(listings.mock.callCount(), 0);
      assert.ok(!stats.mock.calls.some(call => String(call.arguments[0]).startsWith(flows + '/')), 'no historical header or marker probes');
    });
    await t.test('a different project’s pending permission does not bypass the quiet gate', () => {
      assert.equal(inventory.mock.callCount(), 1);
      assert.equal(receipts.mock.callCount(), 0);
    });
    await ops.ownerDelivery.stop();
    assert.equal(receipts.mock.callCount(), 0);
    assert.equal(paneRequests, 0);
    assert.equal(writes.mock.callCount(), 0);
    assert.equal(unlinks.mock.callCount(), 0);

    // The per-session watch also avoids asking HerdR about adoption of this foreign permission.
    assert.equal((await readSessionJobRows(home, pane, cwd, env)).panes, undefined);
    assert.equal(paneRequests, 0);

    assert.equal(claimDelivery(marker, id), null);
    assert.equal(writes.mock.callCount(), 0, 'an accepted marker does not even cause a temporary write');
    assert.equal(unlinks.mock.callCount(), 0);
    assert.equal(fs.statSync(marker).ino, inode);
    assert.equal(fs.readFileSync(marker, 'utf8'), accepted);
  } finally {
    listings.mock.restore(); stats.mock.restore();
    writes.mock.restore();
    unlinks.mock.restore();
    syncBuiltinESMExports();
  }
});
