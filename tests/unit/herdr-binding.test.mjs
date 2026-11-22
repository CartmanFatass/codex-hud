import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { herdrId, tabIds, listedTabs, tabInfo, listedPanes, listedAgents } from '../../dist/roles/herdr-run.js';
import { validPane, validStamp } from '../../dist/integrations/panel/receipt.js';
import { bridgeHealthPath, readHerdrConfig, writeBridgeHealth } from '../../bin/codex-hud-herdr.mjs';

test('overlapping bridge health publications leave one complete private record and no temporary files', async (t) => {
  const home = fs.mkdtempSync(join(tmpdir(), 'bridge-health-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = bridgeHealthPath(home, 'demo');
  const records = [{ state: 'idle' }, { state: 'working' }];
  await Promise.all(records.map((record) => writeBridgeHealth(file, record)));
  assert.ok(records.some((record) => fs.readFileSync(file, 'utf8') === JSON.stringify(record) + '\n'));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dirname(file)), [`${process.pid}.json`]);
});

for (const id of ['w4E:p1', 'workspace / unicode 窗:tab?', ' '.repeat(300)])
  test(`herdr identities are opaque, not filename or format constrained: ${JSON.stringify(id.slice(0, 40))}`, t => {
    const encode = result => JSON.stringify({ result });
    assert.equal(herdrId(id), true);
    assert.equal(readHerdrConfig({ HERDR_ENV: '1', HERDR_SOCKET_PATH: '/tmp/synthetic.sock', HERDR_PANE_ID: id }).paneId, id);
    assert.deepEqual(tabIds(encode({ tab: { tab_id: id }, root_pane: { pane_id: id } })), { tabId: id, paneId: id });
    assert.deepEqual(listedTabs(encode({ tabs: [{ tab_id: id, workspace_id: id }] })), [{ tabId: id, label: null, workspaceId: id }]);
    assert.equal(tabInfo(encode({ tab: { tab_id: id, workspace_id: id } })).tabId, id);
    assert.deepEqual(listedPanes(encode({ panes: [{ pane_id: id, tab_id: id }] })), [{ paneId: id, tabId: id }]);
    assert.deepEqual(listedAgents(encode({ agents: [{ name: 'owned-agent', pane_id: id, tab_id: id }] })), [{ name: 'owned-agent', paneId: id, tabId: id, status: null }]);
    const process = { pid: 42, proc_start: '123', boot_id: 'synthetic', pid_domain: 'synthetic' };
    assert.equal(validStamp(process), true);
    assert.equal(validPane({ pane: id, tab: id, terminal: id, workspace: id, process }), true);
  });

test('empty and control-bearing herdr identities are refused, without changing a legal id', () => {
  for (const id of ['', null, undefined, 42, 'w4E:p1\n', 'w4E:\0p1', '\x7f', '\x85']) {
    assert.equal(herdrId(id), false);
    assert.equal(readHerdrConfig({ HERDR_ENV: '1', HERDR_SOCKET_PATH: '/tmp/synthetic.sock', HERDR_PANE_ID: id }), null);
    assert.equal(tabIds(JSON.stringify({ result: { tab: { tab_id: id }, root_pane: { pane_id: 'w4E:p1' } } })), null);
    assert.equal(listedPanes(JSON.stringify({ panes: [{ pane_id: id }] })), null);
  }
});
