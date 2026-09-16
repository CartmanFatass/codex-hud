import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultSettings } from '../../src/settings.js';
import { renderSettingsPage,handleSettingsInput,SETTING_ROWS } from '../../src/render/settings-page.js';
import { panelWidth } from '../../src/utils/pane-width.js';
import { visualLength } from '../../src/render/colors.js';

test('settings keyboard and mouse edit a draft, with explicit save/back actions',()=>{
  let state = {draft:defaultSettings(),selected:0,offset:0,message:''};
  let frame = renderSettingsPage(state,30,12);
  state = handleSettingsInput(state,{type:'key',key:'right'},frame).state;
  assert.equal(state.draft.density,'full');
  assert.equal(defaultSettings().density,'balanced');
  assert.equal(handleSettingsInput(state,{type:'key',key:'sort'},frame).action,'save');
  assert.equal(handleSettingsInput(state,{type:'mouse',button:'left',x:2,y:0},frame).action,'back');
  state.selected=SETTING_ROWS.length-1;
  frame = renderSettingsPage(state,16,8);
  assert.ok(frame.state.offset>0);
  assert.ok(frame.lines.every(line=>visualLength(line)<=16));
  state=handleSettingsInput(frame.state,{type:'key',key:'right'},frame).state;
  assert.equal(state.draft.treeWidth,45);
  state=handleSettingsInput(state,{type:'key',key:'right'},frame).state;
  assert.equal(state.draft.treeWidth,70);
  state=handleSettingsInput(state,{type:'key',key:'right'},frame).state;
  assert.equal(state.draft.treeWidth,16);
});
test('four width presets preserve original default and reserve main session space',()=>{
  assert.deepEqual([16,0,45,70].map(w=>panelWidth(w,160)),[16,30,45,70]);
  assert.equal(panelWidth(0,100),20);
  assert.equal(panelWidth(70,80),39);
  assert.ok(panelWidth(70,30)<30);
});
