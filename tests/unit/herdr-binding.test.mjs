import test from 'node:test';
import assert from 'node:assert/strict';
import { herdrId, tabIds, listedTabs, tabInfo, listedAgents } from '../../dist/roles/herdr-run.js';

for (const id of ['w4E:p1', 'workspace / unicode 窗:tab?', ' '.repeat(300)])
  test(`herdr identities are opaque, not filename or format constrained: ${JSON.stringify(id.slice(0, 40))}`, () => {
    const encode = (result) => JSON.stringify({ result });
    assert.equal(herdrId(id), true);
    assert.deepEqual(tabIds(encode({ tab: { tab_id: id }, root_pane: { pane_id: id } })), { tabId: id, paneId: id });
    assert.deepEqual(listedTabs(encode({ tabs: [{ tab_id: id, workspace_id: id }] })), [
      { tabId: id, label: null, workspaceId: id },
    ]);
    assert.equal(tabInfo(encode({ tab: { tab_id: id, workspace_id: id } })).tabId, id);
    assert.deepEqual(listedAgents(encode({ agents: [{ name: 'owned-agent', pane_id: id, tab_id: id }] })), [
      { name: 'owned-agent', paneId: id, tabId: id, status: null },
    ]);
  });

test('empty and control-bearing herdr identities are refused, without changing a legal id', () => {
  for (const id of ['', null, undefined, 42, 'w4E:p1\n', 'w4E:\0p1', '\x7f', '\x85']) {
    assert.equal(herdrId(id), false);
    assert.equal(tabIds(JSON.stringify({ result: { tab: { tab_id: id }, root_pane: { pane_id: 'w4E:p1' } } })), null);
  }
});
