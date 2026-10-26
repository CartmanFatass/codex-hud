import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkbenchInputDecoder, type WorkbenchInput } from '../../src/utils/workbench-input.js';
import { commandSequence } from '../../src/utils/panel-command.js';

test('Escape before a prefix command or another Escape preserves both inputs', () => {
  for (const split of [false, true]) {
    const decoder = new WorkbenchInputDecoder('monitor', {forward:true});
    if (split) assert.deepEqual(decoder.push(Buffer.from('\x1b')), []);
    assert.deepEqual(decoder.push(Buffer.from((split ? '' : '\x1b') + commandSequence('activity'))), [
      {type:'key',key:'escape',raw:'\x1b'}, {type:'command',command:'activity'},
    ]);
  }
  const decoder = new WorkbenchInputDecoder('monitor', {forward:true});
  assert.deepEqual([...decoder.push(Buffer.from('\x1b\x1b')), ...decoder.flushEscape()], [
    {type:'key',key:'escape',raw:'\x1b'}, {type:'key',key:'escape',raw:'\x1b'},
  ]);
});

test('both decoder profiles map Space and Enter to Inspector keys and have no e action', () => {
  for (const profile of ['monitor', 'workbench'] as const) {
    assert.deepEqual(new WorkbenchInputDecoder(profile).push(Buffer.from('e \r')), [
      {type:'key', key:'enter'}, {type:'key', key:'enter'},
    ]);
    assert.deepEqual(new WorkbenchInputDecoder(profile, {forward:true}).push(Buffer.from('e \r')), [
      {type:'key', key:'', raw:'e'}, {type:'key', key:'enter', raw:' '}, {type:'key', key:'enter', raw:'\r'},
    ]);
  }
});

test('split Inspector command descriptors retain ordering, with removed card commands dropped', () => {
  const d = new WorkbenchInputDecoder('monitor', {forward:true});
  const input = `e${commandSequence('inspect')}\x1b_codex-hud:open\x1b\\\x1b_codex-hud:expand\x1b\\h${commandSequence('left')}${commandSequence('right')}`;
  const out: WorkbenchInput[] = [];
  for (const byte of Buffer.from(input)) out.push(...d.push(Buffer.from([byte])));
  assert.deepEqual(out, [
    {type:'key', key:'', raw:'e'},
    {type:'command', command:'inspect'},
    {type:'key', key:'left', raw:'h'},
    {type:'command', command:'left'},
    {type:'command', command:'right'},
  ]);
});
