import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultSettings } from '../../src/settings.js';
import { renderSettingsPage,handleSettingsInput,SETTING_ROWS } from '../../src/render/settings-page.js';
import { panelWidth } from '../../src/utils/pane-width.js';
import { stripAnsi, visualLength } from '../../src/render/colors.js';

test('settings keyboard and mouse edit a draft, with explicit save/back actions',()=>{
  let state = {draft:defaultSettings(),selected:0,offset:0,message:''};
  let frame = renderSettingsPage(state,30,12);
  state = handleSettingsInput(state,{type:'key',key:'right'},frame).state;
  assert.equal(state.draft.density,'full');
  assert.equal(defaultSettings().density,'balanced');
  assert.equal(handleSettingsInput(state,{type:'key',key:'sort'},frame).action,'save');
  assert.equal(handleSettingsInput(state,{type:'mouse',button:'left',x:2,y:0},frame).action,'back');
  state.selected=SETTING_ROWS.findIndex(row=>row.key==='treeWidth');
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

test('narrow settings keep visible buttons aligned with hit targets and mark unsaved fields',()=>{
  const state={draft:defaultSettings(),selected:0,offset:0,message:''};
  const frame=renderSettingsPage(state,16,12);
  assert.equal(frame.actions.some(a=>a.action==='reset'),false);
  assert.equal(handleSettingsInput(frame.state,{type:'mouse',button:'left',x:15,y:0},frame).action,undefined);
  assert.equal(handleSettingsInput(frame.state,{type:'mouse',button:'left',x:8,y:0},frame).action,'save');
  const edited=handleSettingsInput(frame.state,{type:'key',key:'right'},frame).state;
  const after=renderSettingsPage(edited,16,12);
  const densityLine=(frame:ReturnType<typeof renderSettingsPage>)=>frame.lines[frame.rows.indexOf(0)];
  assert.ok(densityLine(after).includes('*'));
  assert.ok(after.lines.every(line=>visualLength(line)<=16));
  const reverted=handleSettingsInput(after.state,{type:'key',key:'left'},after).state;
  assert.ok(!densityLine(renderSettingsPage(reverted,16,12)).includes('*'));
  const bar=renderSettingsPage({...frame.state,selected:SETTING_ROWS.findIndex(r=>r.key==='statusline')},16,12);
  assert.ok(bar.lines.some(line=>line.includes('Next launch')));
});

test('settings read in sections, values aligned on the right and written for people',()=>{
  const draft={...defaultSettings(),finishedLingerMs:0};
  const frame=renderSettingsPage({draft,selected:0,offset:0,message:''},30,24);
  const text=frame.lines.map(stripAnsi);
  for (const group of ['Status bar','Agents','Panel']) assert.ok(text.some(line=>line.startsWith(`── ${group} `)),group);
  const line=(key:string)=>text[frame.rows.indexOf(SETTING_ROWS.findIndex(row=>row.key===key))];
  assert.match(line('refreshMs'),/Refresh +1s$/);
  assert.match(line('treeWidth'),/Width +auto$/);
  assert.match(line('finishedLingerMs'),/Hide finished +never$/);
  assert.match(line('density'),/^› +Density +‹ balanced ›$/, 'the selected value shows it can be changed');
  assert.equal(text.at(-2),'How much the bar shows');
  // Each value ends in the same column.
  const ends=frame.rows.flatMap((row,y)=>row===null?[]:[text[y].length]);
  assert.equal(new Set(ends).size,1);
  for (const width of [16,20,24,30,45,70]) {
    const any=renderSettingsPage({draft,selected:SETTING_ROWS.length-1,offset:0,message:''},width,14);
    assert.ok(any.lines.every(line=>visualLength(line)<=width),`width ${width}`);
  }
});

test('hide-finished steps through its presets, and mouse clicks respect headings and chevrons',()=>{
  const row=SETTING_ROWS.findIndex(entry=>entry.key==='finishedLingerMs');
  let state={draft:defaultSettings(),selected:row,offset:0,message:'Saved'};
  let frame=renderSettingsPage(state,30,24);
  const seen:number[]=[];
  for (let i=0;i<5;i++) { state=handleSettingsInput(state,{type:'key',key:'right'},frame).state; seen.push(state.draft.finishedLingerMs); }
  assert.deepEqual(seen,[600_000,1_800_000,0,60_000,180_000]);
  assert.equal(state.message,'','an edit clears the old status message');
  // A heading is not a setting.
  frame=renderSettingsPage(state,30,24);
  const heading=frame.rows.findIndex((entry,y)=>y>0&&entry===null);
  assert.deepEqual(handleSettingsInput(state,{type:'mouse',button:'left',x:4,y:heading},frame).state.draft,state.draft);
  // Clicking a row selects it and moves it on; the "‹" moves it back.
  const y=frame.rows.indexOf(row);
  assert.equal(handleSettingsInput(state,{type:'mouse',button:'left',x:4,y},frame).state.draft.finishedLingerMs,600_000);
  assert.ok(frame.back && frame.back.y===y);
  assert.equal(stripAnsi(frame.lines[y])[frame.back.x],'‹');
  assert.equal(handleSettingsInput(state,{type:'mouse',button:'left',x:frame.back.x,y},frame).state.draft.finishedLingerMs,60_000);
  // Moving on shows the next row's help instead of an old message.
  const moved=handleSettingsInput({...state,message:'Saved'},{type:'key',key:'down'},frame).state;
  assert.equal(moved.message,'');
});
