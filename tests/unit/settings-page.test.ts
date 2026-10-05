import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultSettings } from '../../src/settings.js';
import { renderSettingsPage,handleSettingsInput,SETTING_ROWS,modelCallsLine } from '../../src/render/settings-page.js';
import { panelWidth } from '../../src/utils/pane-width.js';
import { stripAnsi, visualLength, theme, colors } from '../../src/render/colors.js';

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
  assert.equal(state.draft.treeWidth,34,'two columns at a step');
  state=handleSettingsInput(state,{type:'key',key:'left'},frame).state;
  state=handleSettingsInput(state,{type:'key',key:'left'},frame).state;
  assert.equal(state.draft.treeWidth,30);
  for (const [from,key,to] of [[33,'right',34],[33,'left',32],[0,'right',24],[57,'left',56],[80,'right',24],[24,'left',80]] as const) {
    const odd=handleSettingsInput({...state,draft:{...state.draft,treeWidth:from}},{type:'key',key},frame).state;
    assert.equal(odd.draft.treeWidth,to,`${from} ${key}`);
  }
});
test('any even width from 24 to 80, 32 by default, and the main session keeps its space',()=>{
  assert.deepEqual([32,44,56].map(w=>panelWidth(w,160)),[32,44,56]);
  const widths=SETTING_ROWS.find(r=>r.key==='treeWidth')!.values;
  assert.equal(widths[0],24);assert.equal(widths.at(-1),80);
  assert.ok(widths.every((w,i)=>i===0||Number(w)-Number(widths[i-1])===2),'a step of two');
  assert.equal(defaultSettings().treeWidth,32);
  assert.equal(panelWidth(0,100),32,'a width from older settings, 0, is narrow');
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
  const frame=renderSettingsPage({draft,selected:0,offset:0,message:''},30,50);
  const text=frame.lines.map(stripAnsi);
  for (const group of ['Status bar','Agents','LLM','Panel']) assert.ok(text.some(line=>line.startsWith(`── ${group} `)),group);
  const line=(key:string)=>text[frame.rows.indexOf(SETTING_ROWS.findIndex(row=>row.key===key))];
  assert.match(line('refreshMs'),/Refresh +1s$/);
  assert.match(line('treeWidth'),/Width +32 cols$/);
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

test('every model feature sits in the LLM group, and the calls made today show under the list',()=>{
  const llm=SETTING_ROWS.filter(row=>row.group==='LLM').map(row=>row.key);
  assert.deepEqual(llm,['briefing','briefingMs','recapFloorMs','modelCallsPerHour','briefAgents','briefMain',
    'resultDigest','agentLabels','failureCause','changeSummary','approvalDescription']);
  for (const key of ['resultDigest','failureCause','changeSummary','approvalDescription'] as const) assert.equal(defaultSettings()[key],false,key);
  // Labels are on by default: they wait on a backend, which is off by default, and send nothing until one is chosen.
  assert.equal(defaultSettings().agentLabels,true);
  assert.equal(defaultSettings().briefing,'off');
  assert.equal(defaultSettings().labelAsName,true);
  for (const row of SETTING_ROWS.filter(row=>row.group==='LLM'&&row.key!=='briefingMs'&&row.key!=='recapFloorMs'&&row.key!=='modelCallsPerHour'&&row.key!=='briefing')) assert.match(row.help,/^Sends /,row.key);
  assert.equal(defaultSettings().briefMain,false,'sending the main session is opt-in');
  assert.equal(modelCallsLine(undefined),null);
  assert.equal(modelCallsLine({today:0,lastHour:0,cap:60}),null,'no calls yet: no line');
  assert.equal(stripAnsi(modelCallsLine({today:12,lastHour:3,cap:60})!),'Model calls today: 12 · last hour 3/60');
  const frame=renderSettingsPage({draft:defaultSettings(),selected:0,offset:0,message:''},45,20,{state:undefined,modelCalls:{today:5,lastHour:5,cap:5}});
  assert.ok(frame.lines.map(stripAnsi).includes('Model calls today: 5 · last hour 5/5'));
});

test('wide, each value sits beside its label in one column, a changed one in the accent, with a short hint after it',()=>{
  const draft={...defaultSettings(),density:'full' as const,treeWidth:0};
  const frame=renderSettingsPage({draft,selected:1,offset:0,message:''},90,50);
  const text=frame.lines.map(stripAnsi);
  const y=(key:string)=>frame.rows.indexOf(SETTING_ROWS.findIndex(row=>row.key===key));
  const valueAt=(key:string,value:string)=>text[y(key)].indexOf(value);
  assert.equal(valueAt('density','full'),valueAt('refreshMs','1s'),'one value column');
  assert.ok(valueAt('density','full')<30,'beside the labels, not at the right edge');
  assert.match(text[y('density')],/full +How much the bar shows$/);
  assert.equal(text[y('density')].indexOf('How'),text[y('refreshMs')].indexOf('How'),'the hints line up');
  assert.ok(frame.lines[y('density')].includes(theme.accent('full')),'not the default: accent');
  assert.ok(!frame.lines[y('refreshMs')].includes(theme.accent('1s')),'the default: plain');
  assert.match(text[y('treeWidth')],/Width +auto/,'0 is the panel\'s own choice');
  assert.match(text[y('art')],/Picture /);
  assert.match(text[y('agentLog')],/Agent log /);
  assert.ok(frame.lines.every(line=>visualLength(line)<=90));
  // Below 70 columns no hints.
  const mid=renderSettingsPage({draft,selected:1,offset:0,message:''},60,50).lines.map(stripAnsi);
  assert.ok(!mid.some(line=>line.includes('How much the bar shows')&&line.includes('full')));
});

test('with no backend the model rows step back under a note, still selectable; with one they come forward',()=>{
  const row=(key:string)=>SETTING_ROWS.findIndex(entry=>entry.key===key);
  const off=renderSettingsPage({draft:{...defaultSettings(),briefing:'off'},selected:0,offset:0,message:''},90,50);
  const text=off.lines.map(stripAnsi);
  const backend=off.rows.indexOf(row('briefing'));
  assert.equal(text[backend+1].trim(),'takes effect with a backend');
  assert.equal(off.rows[backend+1],null,'the note is not a setting');
  const digest=off.rows.indexOf(row('resultDigest'));
  assert.ok(off.lines[digest].includes(colors.dim('Result digest')),'a model row is dim');
  assert.ok(!off.lines[off.rows.indexOf(row('panelStyle'))].includes(colors.dim('Layout')));
  const on=renderSettingsPage({draft:{...defaultSettings(),briefing:'omp'},selected:row('resultDigest'),offset:0,message:''},90,50);
  assert.ok(!on.lines.map(stripAnsi).some(line=>line.includes('takes effect with a backend')));
  assert.ok(!on.lines[on.rows.indexOf(row('briefingMs'))].includes(colors.dim('Brief every')));
  // Desktop notices wait on notifications the same way.
  const quiet=renderSettingsPage({draft:{...defaultSettings(),notify:false},selected:0,offset:0,message:''},90,50);
  assert.ok(quiet.lines[quiet.rows.indexOf(row('notifyDesktop'))].includes(colors.dim('Desktop notices')));
});
