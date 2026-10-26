import test from 'node:test';
import assert from 'node:assert/strict';
import { scopedActivityObservation } from '../../src/utils/activity-observation.js';
import { ActivityJournal } from '../../src/collectors/activity-journal.js';
import { makeHudData, treeOf, node, FIXED_NOW } from '../fixtures/hud-data.js';
import type { AgentLogEntry } from '../../src/collectors/agent-log.js';

test('a new root never journals an old log after a failed scan or a retained stale display', () => {
  const tree = treeOf([node('new-agent','New','running')], 'new-root');
  const data = makeHudData({session:{...makeHudData().session!,id:'new-root'},subagentTree:tree,stale:false});
  const logs = new Map<string,AgentLogEntry[]>([['old-agent',[{at:FIXED_NOW.getTime(),kind:'note',text:'OLD_ROOT_SUMMARY_SENTINEL'}]]]);
  const journal = new ActivityJournal({rootId:'new-root',now:()=>FIXED_NOW.getTime()});
  journal.observe(scopedActivityObservation('new-root','old-root',{data,tree,logs}));
  assert.ok(!JSON.stringify(journal.view()).includes('OLD_ROOT_SUMMARY_SENTINEL'));
  const stale = scopedActivityObservation('new-root','new-root',{data:{...data,stale:true},tree,logs});
  assert.equal(stale.logs,undefined);
  assert.equal(stale.tree,undefined);
  assert.equal(stale.data?.subagentTree,undefined);
  const oldData = {...data,session:{...data.session!,id:'old-root'}};
  const mismatched = scopedActivityObservation('new-root','old-root',{data:oldData,tree,logs,gitFresh:true,
    healthSignals:[{key:'collector:tree',kind:'health',active:false,at:FIXED_NOW.getTime()}]});
  assert.equal(mismatched.data,undefined);
  assert.equal(mismatched.healthSignals,undefined);
  assert.equal(mismatched.gitFresh,false);
  const validLogs = new Map<string,AgentLogEntry[]>([['new-agent',[{at:FIXED_NOW.getTime()+1,kind:'note',text:'NEW_ROOT_SUMMARY'}]]]);
  journal.observe(scopedActivityObservation('new-root','new-root',{data,tree,logs:validLogs}));
  assert.ok(JSON.stringify(journal.view()).includes('NEW_ROOT_SUMMARY'));
});
