import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultSettings, type HudSettings } from '../../src/settings.js';
import { renderSettingsPage,handleSettingsInput,SETTING_ROWS,modelCallsLine,settingInactiveReason,rowValue,withRowValue,
  settingsDirty,settingGroup,resetSettingsGroup,resetAllPreferences,type SettingsPageState } from '../../src/render/settings-page.js';
import { applyCardPreset, identifyCardPreset, CARD_PRESET_KEYS } from '../../src/card-presets.js';
import { setLanguage, t } from '../../src/render/i18n.js';
import { panelWidth } from '../../src/utils/pane-width.js';
import { stripAnsi, visualLength, theme, colors } from '../../src/render/colors.js';
import { useDisplayFixture } from '../fixtures/display.js';

useDisplayFixture();

const FULL_HEIGHT = SETTING_ROWS.length+14;

test('settings keyboard and mouse edit a draft, with explicit save/back actions',()=>{
  let state = {draft:defaultSettings(),selected:0,offset:0,message:''};
  let frame = renderSettingsPage(state,30,12);
  state = handleSettingsInput(state,{type:'key',key:'right'},frame).state;
  assert.equal(state.draft.theme,'titanium');
  assert.equal(defaultSettings().theme,'terminal');
  assert.equal(handleSettingsInput(state,{type:'key',key:'sort'},frame).action,'save');
  assert.equal(handleSettingsInput(state,{type:'mouse',button:'left',x:2,y:0},frame).action,'back');
  state.selected=SETTING_ROWS.findIndex(row=>row.key==='treeWidth');
  frame = renderSettingsPage(state,16,8);
  assert.ok(frame.state.offset>0);
  assert.ok(frame.lines.every(line=>visualLength(line)<=16));
  state=handleSettingsInput(frame.state,{type:'key',key:'right'},frame).state;
  assert.equal(state.draft.treeWidth,56,'the next width laid out for');
  state=handleSettingsInput(state,{type:'key',key:'left'},frame).state;
  state=handleSettingsInput(state,{type:'key',key:'left'},frame).state;
  assert.equal(state.draft.treeWidth,40,'two steps down from the default');
  for (const [from,key,to] of [[33,'right',40],[33,'left',32],[44,'right',48],[44,'left',40],[0,'right',32],[57,'left',56],[80,'right',32],[24,'left',56]] as const) {
    const odd=handleSettingsInput({...state,draft:{...state.draft,treeWidth:from}},{type:'key',key},frame).state;
    assert.equal(odd.draft.treeWidth,to,`${from} ${key}`);
  }
});
test('the widths the panel is laid out for, 48 by default, and the main session keeps its space',()=>{
  assert.deepEqual([32,44,56].map(w=>panelWidth(w,160)),[32,44,56]);
  assert.deepEqual(SETTING_ROWS.find(r=>r.key==='treeWidth')!.values,[32,40,48,56]);
  assert.equal(defaultSettings().treeWidth,48);
  assert.equal(panelWidth(0,100),48,'a width from older settings, 0, is the default');
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
  const frame=renderSettingsPage({draft,selected:0,offset:0,message:''},30,FULL_HEIGHT);
  const text=frame.lines.map(line=>stripAnsi(line).trimEnd());
  const groups=text.filter(line=>line.startsWith('── ')).map(line=>line.replace(/^── (.*?) ─*$/,'$1'));
  assert.deepEqual(groups,['Display','Panel','Agents','Cards','LLM','Status bar','Input']);
  const line=(key:string)=>text[frame.rows.indexOf(SETTING_ROWS.findIndex(row=>row.key===key))];
  assert.match(line('refreshMs'),/Refresh +1s$/);
  assert.match(line('treeWidth'),/Width +48 cols$/);
  assert.match(line('finishedLingerMs'),/Hide finished +never$/);
  assert.match(line('theme'),/^› +Theme +‹ terminal ›$/, 'the selected value shows it can be changed');
  assert.equal(text.at(-2),'Colours of bar and panel');
  // A row over several settings says what they make together.
  assert.match(line('agentLabels'),/Agent names +as name$/);
  assert.match(line('briefAgents'),/Periodic agent brief +on$/);
  assert.match(line('briefMain'),/Main recap +off$/);
  assert.match(line('agentProgress'),/Card progress +on$/);
  assert.match(line('briefingMs'),/Brief pace +5m · 15m$/);
  assert.match(line('notify'),/Notifications +off$/);
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
  assert.deepEqual(llm,['briefing','briefingPaused','briefAgents','briefMain','agentProgress','briefingMs','modelCallsPerHour',
    'resultDigest','agentLabels','failureCause','changeSummary','approvalDescription']);
  for (const key of ['resultDigest','failureCause','changeSummary','approvalDescription'] as const) assert.equal(defaultSettings()[key],false,key);
  // Labels are on by default: they wait on a backend, which is off by default, and send nothing until one is chosen.
  assert.equal(defaultSettings().agentLabels,true);
  assert.equal(defaultSettings().briefing,'off');
  assert.equal(defaultSettings().labelAsName,true);
  for (const row of SETTING_ROWS.filter(row=>row.group==='LLM'&&row.key!=='briefingMs'&&row.key!=='modelCallsPerHour'&&row.key!=='briefing'&&row.key!=='briefingPaused')) assert.match(row.help,/^Sends /,row.key);
  assert.equal(defaultSettings().briefMain,false,'sending the main session is opt-in');
  assert.equal(modelCallsLine(undefined),null);
  assert.equal(modelCallsLine({today:0,lastHour:0,cap:60}),null,'no calls yet: no line');
  assert.equal(stripAnsi(modelCallsLine({today:12,lastHour:3,cap:60})!),'Model calls today: 12 · last hour 3/60');
  const frame=renderSettingsPage({draft:defaultSettings(),selected:0,offset:0,message:''},45,20,{state:undefined,modelCalls:{today:5,lastHour:5,cap:5}});
  assert.ok(frame.lines.map(line=>stripAnsi(line).trimEnd()).includes('Model calls today: 5 · last hour 5/5'));
});

test('wide values use the available space, with changed values in the accent and a stable help column',()=>{
  const draft={...defaultSettings(),density:'full' as const,treeWidth:0};
  const frame=renderSettingsPage({draft,selected:1,offset:0,message:''},90,FULL_HEIGHT);
  const text=frame.lines.map(line=>stripAnsi(line).trimEnd());
  const y=(key:string)=>frame.rows.indexOf(SETTING_ROWS.findIndex(row=>row.key===key));
  const valueAt=(key:string,value:string)=>text[y(key)].indexOf(value);
  assert.equal(valueAt('density','full')+4,valueAt('refreshMs','1s')+2,'values align at the right edge of their area');
  assert.ok(valueAt('density','full')>50,'values use the widened pane, not just the label column');
  assert.match(text[y('density')],/full +How much the bar/);
  assert.equal(text[y('density')].indexOf('How'),text[y('refreshMs')].indexOf('How'),'the hints line up');
  assert.ok(frame.lines[y('density')].includes(theme.accent('full')),'not the default: accent');
  assert.ok(!frame.lines[y('refreshMs')].includes(theme.accent('1s')),'the default: plain');
  assert.match(text[y('treeWidth')],/Width +auto/,'0 is the panel\'s own choice');
  assert.match(text[y('art')],/Picture /);
  assert.match(text[y('agentLog')],/Agent log /);
  assert.ok(frame.lines.every(line=>visualLength(line)<=90));
  // Below 70 columns no hints.
  const mid=renderSettingsPage({draft,selected:1,offset:0,message:''},60,FULL_HEIGHT).lines.map(line=>stripAnsi(line).trimEnd());
  assert.ok(!mid.some(line=>line.includes('How much the bar shows')&&line.includes('full')));
});

test('with no backend the model rows step back under a note, still selectable; with one they come forward',()=>{
  const row=(key:string)=>SETTING_ROWS.findIndex(entry=>entry.key===key);
  const off=renderSettingsPage({draft:{...defaultSettings(),briefing:'off'},selected:0,offset:0,message:''},90,FULL_HEIGHT);
  const text=off.lines.map(line=>stripAnsi(line).trimEnd());
  const backend=off.rows.indexOf(row('briefing'));
  assert.equal(text[backend+1].trim(),'takes effect with a backend');
  assert.equal(off.rows[backend+1],null,'the note is not a setting');
  const digest=off.rows.indexOf(row('resultDigest'));
  assert.ok(off.lines[digest].includes(colors.dim('Result digest')),'a model row is dim');
  assert.ok(!off.lines[off.rows.indexOf(row('panelStyle'))].includes(colors.dim('Layout')));
  const on=renderSettingsPage({draft:{...defaultSettings(),briefing:'api'},selected:row('resultDigest'),offset:0,message:''},90,FULL_HEIGHT);
  assert.ok(!on.lines.map(line=>stripAnsi(line).trimEnd()).some(line=>line.includes('takes effect with a backend')));
  assert.ok(!on.lines[on.rows.indexOf(row('briefingMs'))].includes(colors.dim('Brief pace')));
  // Agent names come from the brief, so they wait on a backend too.
  assert.ok(off.lines[off.rows.indexOf(row('agentLabels'))].includes(colors.dim('Agent names')));
  assert.ok(!on.lines[on.rows.indexOf(row('agentLabels'))].includes(colors.dim('Agent names')));
  // The pace paces the brief and the change summary, so it waits only on all of them.
  const none=renderSettingsPage({draft:{...defaultSettings(),briefing:'api',briefAgents:false,briefMain:false,changeSummary:false},selected:0,offset:0,message:''},90,FULL_HEIGHT);
  assert.ok(none.lines[none.rows.indexOf(row('briefingMs'))].includes(colors.dim('Brief pace')));
});

test('a row the panel\'s top shows previews it from the draft, above its help; the others, and a short page, do not',async()=>{
  const {withDisplaySettings}=await import('../../src/settings-runtime.js');
  const {displayConfig}=await import('../../src/render/hud-config.js');
  const row=(key:string)=>SETTING_ROWS.findIndex(entry=>entry.key===key);
  const seen:string[]=[];
  const preview=(draft:ReturnType<typeof defaultSettings>,width:number)=>{seen.push(draft.look);return [`bar ${draft.look} ${width}`,'title'];};
  const draft={...defaultSettings(),look:'pill' as const};
  const frame=renderSettingsPage({draft,selected:row('look'),offset:0,message:''},40,30,undefined,preview);
  const text=frame.lines.map(line=>stripAnsi(line).trimEnd());
  assert.deepEqual(text.slice(-5),[`── Preview ${'─'.repeat(29)}`,'bar pill 40','title','Bar and pane titles; sets their icons','↑↓ select  ←→ change']);
  assert.deepEqual(seen,['pill'],'drawn from the draft');
  assert.equal(frame.lines.length,30);
  assert.equal(frame.rowCount,30-3-3,'the list gives the preview its rows');
  for (const key of ['theme','paneLayout','icons']) {
    assert.ok(renderSettingsPage({draft,selected:row(key),offset:0,message:''},40,30,undefined,preview).lines.map(line=>stripAnsi(line).trimEnd()).includes('title'),key);
  }
  // A row the bar does not show, the model badge's among them, and a page too short to give up the rows, have none.
  for (const key of ['density','glyphs']) assert.ok(!renderSettingsPage({draft,selected:row(key),offset:0,message:''},40,30,undefined,preview).lines.map(line=>stripAnsi(line).trimEnd()).includes('title'),key);
  const plain=renderSettingsPage({draft,selected:row('density'),offset:0,message:''},40,30,undefined,preview);
  assert.equal(plain.rowCount,27);
  assert.ok(!renderSettingsPage({draft,selected:row('look'),offset:0,message:''},40,11,undefined,preview).lines.map(line=>stripAnsi(line).trimEnd()).includes('title'));
  assert.ok(renderSettingsPage({draft,selected:row('look'),offset:0,message:''},40,12,undefined,preview).lines.map(line=>stripAnsi(line).trimEnd()).includes('title'));
  // Drawn in the draft's display settings, which are put back after, even when the drawing fails.
  const before=displayConfig();
  assert.equal(withDisplaySettings({...defaultSettings(),look:'band',icons:'emoji'},()=>displayConfig().look+' '+displayConfig().icons),'band emoji');
  assert.deepEqual(displayConfig(),before);
  assert.throws(()=>withDisplaySettings({...defaultSettings(),look:'tile'},()=>{throw new Error('drawing failed');}),/drawing failed/);
  assert.deepEqual(displayConfig(),before);
});

test('Key roles steps through none, the roles the subtasks have and what is set, a list from the settings file kept',()=>{
  const index=SETTING_ROWS.findIndex(row=>row.key==='importantRoles');
  let state:SettingsPageState={draft:{...defaultSettings(),importantRoles:'critic, oracle'},selected:index,offset:0,message:'',roles:['implementer','reviewer']};
  let frame=renderSettingsPage(state,40,FULL_HEIGHT);
  const line=()=>stripAnsi(frame.lines[frame.rows.indexOf(index)]).trimEnd();
  assert.match(line(),/Key roles +‹ critic, oracle ›/);
  const seen:string[]=[];
  for (let i=0;i<4;i++) {
    state=handleSettingsInput(frame.state,{type:'key',key:'right'},frame).state;
    frame=renderSettingsPage(state,40,FULL_HEIGHT);
    seen.push(state.draft.importantRoles);
    if (i===0) assert.match(line(),/Key roles +‹ none ›/);
  }
  assert.deepEqual(seen,['','implementer','reviewer','critic, oracle'],'round to the list again, though it is no role of its own');
  state=handleSettingsInput(frame.state,{type:'key',key:'left'},frame).state;
  assert.equal(state.draft.importantRoles,'reviewer');
  // A role is a name: said as it is in Chinese too, where none is a word.
  setLanguage('zh');
  try {
    assert.match(stripAnsi(renderSettingsPage({...state,draft:{...state.draft,importantRoles:'general'}},40,FULL_HEIGHT).lines.join('\n')),/重点角色 +‹ general ›/);
    assert.match(stripAnsi(renderSettingsPage({...state,draft:{...state.draft,importantRoles:''}},40,FULL_HEIGHT).lines.join('\n')),/重点角色 +‹ 无 ›/);
  } finally { setLanguage('en'); }
});

test('backend selector offers off, AGY, and API only',()=>{
  const backend=SETTING_ROWS.find(row=>row.key==='briefing')!;
  assert.deepEqual(backend.values,['off','agy','api']);
  let state:SettingsPageState={draft:defaultSettings(),selected:SETTING_ROWS.indexOf(backend),offset:0,message:''};
  for (const expected of ['agy','api','off'] as const) {
    const frame=renderSettingsPage(state,48,FULL_HEIGHT);
    state=handleSettingsInput(state,{type:'key',key:'right'},frame).state;
    assert.equal(state.draft.briefing,expected);
  }
});


test('rows have unique keys and contiguous groups, with separate display and generation switches',()=>{
  assert.equal(new Set(SETTING_ROWS.map(row=>row.key)).size,SETTING_ROWS.length);
  const groups = SETTING_ROWS.filter((row,index)=>index===0||row.group!==SETTING_ROWS[index-1].group).map(row=>row.group);
  assert.deepEqual(groups,['Display','Panel','Agents','Cards','LLM','Status bar','Input']);
  assert.deepEqual(SETTING_ROWS.filter(row=>row.group==='Agents').map(row=>row.key),['sort','finishedLingerMs','importantRoles','agentLog']);
  assert.equal(SETTING_ROWS.filter(row=>row.group==='Cards').length,16,'virtual preset, corners, thirteen switches, child scope');
  assert.ok(!SETTING_ROWS.some(row=>row.label==='Brief covers'||String(row.key)==='cardNotes'));
  const backend = SETTING_ROWS.findIndex(row=>row.key==='briefing');
  assert.equal(SETTING_ROWS[backend+1].key,'briefingPaused');
  assert.equal(SETTING_ROWS[backend+1].label,'Pause models');
});

test('periodic briefs, main recap, progress generation and card display toggle independently',()=>{
  const original = {...defaultSettings(),briefingApiKey:'synthetic-only-key',briefingApiBase:'https://synthetic.invalid/v1'};
  let state:SettingsPageState={draft:{...original},original,selected:0,offset:0,message:''};
  const toggle=(key:typeof SETTING_ROWS[number]['key'])=>{
    state.selected=SETTING_ROWS.findIndex(row=>row.key===key);
    const frame=renderSettingsPage(state,48,18);
    state=handleSettingsInput(frame.state,{type:'key',key:'right'},frame).state;
  };
  toggle('briefAgents');
  assert.equal(state.draft.briefAgents,false);
  assert.equal(state.draft.agentProgress,true);
  assert.equal(state.draft.briefMain,false);
  toggle('briefMain');
  assert.equal(state.draft.briefMain,true);
  assert.equal(state.draft.briefAgents,false);
  toggle('agentProgress');
  assert.equal(state.draft.agentProgress,false);
  assert.equal(state.draft.briefMain,true);
  toggle('cardLabel');
  assert.equal(state.draft.cardLabel,false);
  assert.equal(state.draft.agentLabels,true);
  assert.equal(state.draft.labelAsName,true);
  toggle('cardSummary');
  assert.equal(state.draft.cardSummary,false);
  assert.equal(state.draft.briefMain,true);
  assert.equal(state.draft.briefingApiKey,original.briefingApiKey);
  assert.equal(state.draft.briefingApiBase,original.briefingApiBase);
  assert.deepEqual(state.original,original,'original and credential fields survive draft edits');
  const frame=renderSettingsPage(state,90,FULL_HEIGHT);
  for (const key of ['briefAgents','briefMain','agentProgress','cardLabel','cardSummary']) {
    const row=SETTING_ROWS.findIndex(entry=>entry.key===key);
    assert.match(stripAnsi(frame.lines[frame.rows.indexOf(row)]),/\*/);
  }
  assert.ok(!stripAnsi(frame.lines.join('\n')).includes('synthetic-only-key'));
  assert.ok(!stripAnsi(frame.lines.join('\n')).includes('https://synthetic.invalid/v1'));
  for (const [key,action] of [['sort','save'],['reset','reset'],['escape','back']] as const) {
    const result=handleSettingsInput(state,{type:'key',key},frame);
    assert.equal(result.action,action);
    assert.deepEqual(result.state.draft,state.draft,'actions do not mutate the draft');
  }
  assert.equal(original.cardLabel,true,'editing never changes the original');
});

test('inactive reasons follow card dependencies without hiding stored summaries',()=>{
  const base:HudSettings={...defaultSettings(),briefing:'api'};
  const reason=(key:typeof SETTING_ROWS[number]['key'],patch:Partial<typeof base>={})=>settingInactiveReason(key,{...base,...patch});
  for (const row of SETTING_ROWS.filter(row=>row.group==='Cards')) {
    assert.equal(settingInactiveReason(row,{...base,panelStyle:'compact'}),'Requires rich card layout',row.key);
  }
  for (const key of ['cardSubagentSummary','cardSubagentScope'] as const) assert.equal(reason(key,{cardSubagents:false}),'Requires child agent lines');
  for (const patch of [{cardLabel:false},{agentLabels:false},{labelAsName:false}]) assert.equal(reason('cardOriginalName',patch),'Requires task label and names replacing Codex names');
  assert.equal(reason('cardLabel',{agentLabels:false}),'Requires agent names enabled');
  for (const key of ['cardSummary','cardSubagentSummary'] as const) {
    assert.equal(reason(key,{briefing:'off'}),null,key);
    assert.equal(reason(key,{briefingPaused:true}),null,key);
  }
  assert.equal(reason('cardLabel',{briefing:'off'}),null,'display uses stored names');
  assert.equal(reason('agentLog'),'Log is always shown with a model backend');
  assert.equal(reason('agentLog',{briefing:'off'}),null);
});

test('model reasons reflect backend, pause and progress targets, not periodic brief scope',()=>{
  const base:HudSettings={...defaultSettings(),briefing:'api'};
  const reason=(key:typeof SETTING_ROWS[number]['key'],patch:Partial<typeof base>={})=>settingInactiveReason(key,{...base,...patch});
  for (const key of ['briefingPaused','briefAgents','briefMain','agentProgress','resultDigest','agentLabels','failureCause','changeSummary','approvalDescription'] as const) {
    assert.equal(reason(key,{briefing:'off'}),'Model backend is off; nothing is sent',key);
    if (key!=='briefingPaused') assert.equal(reason(key,{briefingPaused:true}),'Model generation is paused; stored text remains',key);
  }
  assert.equal(reason('briefingPaused',{briefingPaused:true}),null,'paused switch itself stays active');
  assert.equal(reason('agentProgress',{briefAgents:false,briefMain:false}),null);
  assert.equal(reason('agentProgress',{panelStyle:'compact'}),'Requires rich card layout');
  assert.equal(reason('agentProgress',{cardSummary:false,cardSubagents:false}),'Requires agent summary or child lines with summaries');
  assert.equal(reason('agentProgress',{cardSummary:false,cardSubagentSummary:false}),'Requires agent summary or child lines with summaries');
  assert.equal(reason('agentProgress',{cardSummary:false}),null,'child summaries can request progress');
  assert.equal(reason('agentProgress',{cardSubagents:false,cardSubagentSummary:false}),null,'L1 summary can request progress');
  const none={briefAgents:false,briefMain:false,changeSummary:false};
  assert.equal(reason('briefingMs',none),'Requires periodic agent brief, main recap or change summary');
  for (const patch of [{briefAgents:true},{briefMain:true},{changeSummary:true}]) {
    assert.equal(reason('briefingMs',{...none,...patch,briefing:'off',briefingPaused:true}),null,'pace depends only on periodic consumers');
  }
});

test('selected inactive reasons stay readable and translated at narrow CJK widths',()=>{
  const previous=setLanguage('zh');
  try {
    for (const width of [16,20,24,32,48]) {
      for (const key of ['cardSummary','cardSubagentScope','agentProgress','briefingPaused','agentLog'] as const) {
        const draft={...defaultSettings(),panelStyle:'compact' as const,briefing:key==='agentLog'?'api' as const:'off' as const};
        const selected=SETTING_ROWS.findIndex(row=>row.key===key);
        const state:SettingsPageState={draft,original:{...draft},selected,offset:0,message:''};
        const frame=renderSettingsPage(state,width,24);
        assert.ok(frame.lines.every(line=>visualLength(line)<=width),`${key} width ${width}`);
        const reason=settingInactiveReason(key,draft)!;
        assert.ok(reason && !/[A-Z][a-z]+/.test(reason),'reason is translated');
        assert.ok(frame.lines.map(line=>stripAnsi(line).trimEnd()).join('').includes(reason),`${key}: complete reason at ${width}`);
        assert.notEqual(frame.rows.indexOf(selected),-1,'selected row remains visible');
        const changed=handleSettingsInput(frame.state,{type:'key',key:'right'},frame).state;
        assert.notEqual(rowValue(SETTING_ROWS[selected],changed.draft),rowValue(SETTING_ROWS[selected],draft),'inactive is still editable');
        const edited=renderSettingsPage(changed,width,24);
        assert.ok(stripAnsi(edited.lines[edited.rows.indexOf(selected)]).includes('*'),'dirty state stays visible');
        assert.equal(handleSettingsInput(edited.state,{type:'key',key:'escape'},edited).action,'back');
      }
    }
    assert.equal(t('Pause models'),'暂停模型');
    assert.equal(t('Resume models'),'继续模型');
    assert.equal(t('Child agents'),'子 agent');
    assert.equal(t('Agent summary'),'Agent 总结');
  } finally {setLanguage(previous);}
});

test('descending numeric presets step from off-preset values in list order',()=>{
  const selected=SETTING_ROWS.findIndex(row=>row.key==='timelineHours');
  const row=SETTING_ROWS[selected];
  const original=row.values;
  // Exercise descending presets without imposing an order on the live timeline menu.
  row.values=[24,12,6,3,1];
  try {
    for (const [from,key,to] of [[10,'right',6],[10,'left',12],[25,'right',24],[25,'left',1],[0,'left',1],[0,'right',24]] as const) {
      const state:SettingsPageState={draft:{...defaultSettings(),timelineHours:from as 1},selected,offset:0,message:''};
      const frame=renderSettingsPage(state,32,12);
      const result=handleSettingsInput(frame.state,{type:'key',key},frame).state;
      assert.equal(result.draft.timelineHours,to,`${from} ${key}`);
    }
  } finally {row.values=original;}
});

test('actual pane width moves values right without resizing from a draft width, and keeps row/back clicks aligned',()=>{
  const previous=setLanguage('en');
  try {
    const state:SettingsPageState={draft:defaultSettings(),selected:0,offset:0,message:''};
    const positions:number[]=[];
    for (const width of [40,56,80]) {
      const frame=renderSettingsPage(state,width,18);
      const y=frame.rows.indexOf(0);
      const line=stripAnsi(frame.lines[y]);
      const x=line.indexOf('terminal');
      positions.push(x);
      assert.equal(frame.state.draft.treeWidth,48,'layout uses actual width, not the saved or draft width');
      assert.equal(frame.lines.length,18);
      assert.ok(frame.lines.every(line=>visualLength(line)===width));
      assert.ok(frame.back && frame.back.y===y);
      assert.equal(line[frame.back.x],'‹');
      const forward=handleSettingsInput(frame.state,{type:'mouse',button:'left',x,y},frame);
      assert.equal(forward.state.draft.theme,'titanium');
      const backward=handleSettingsInput(frame.state,{type:'mouse',button:'left',x:frame.back.x,y},frame);
      assert.equal(backward.state.draft.theme,'none');
      assert.equal(handleSettingsInput(frame.state,{type:'mouse',button:'left',x:frame.actions[0].x,y:frame.headerY},frame).action,'back');
      const draftWidth=renderSettingsPage({...state,draft:{...state.draft,treeWidth:56}},width,18);
      assert.equal(stripAnsi(draftWidth.lines[draftWidth.rows.indexOf(0)]).indexOf('terminal'),x,'editing Width does not live-resize the menu');
    }
    assert.ok(positions[1]-positions[0]>=12,`40 -> 56: ${positions}`);
    assert.ok(positions[2]-positions[1]>=5,`56 -> 80: ${positions}`);
  } finally {setLanguage(previous);}
});

test('one- and two-row navigation sit above settings actions and consume the viewport budget',()=>{
  const previous=setLanguage('en');
  try {
    const state:SettingsPageState={draft:defaultSettings(),selected:0,offset:0,message:''};
    const plain=renderSettingsPage(state,56,18);
    assert.deepEqual(plain.navigationControls,[],'old callers need no navigation');
    assert.equal(plain.headerY,0);
    assert.ok(stripAnsi(plain.lines[0]).includes('Settings'));
    for (const navHeight of [1,2]) {
      const navigation={
        lines:[theme.accent('Main  Agents  Settings'),colors.dim('Timeline  Changes  Inspector')].slice(0,navHeight),
        controls:[{kind:'main' as const,x:0,y:0,width:4},{kind:'settings' as const,x:14,y:0,width:8},
          ...(navHeight===2 ? [{kind:'tab' as const,pane:'timeline' as const,x:0,y:1,width:8}] : [])],
      };
      const frame=renderSettingsPage(state,56,18,undefined,undefined,navigation);
      assert.equal(frame.lines.length,18);
      assert.ok(frame.lines.every(line=>visualLength(line)===56));
      assert.deepEqual(frame.navigationControls,navigation.controls);
      assert.equal(frame.headerY,navHeight);
      assert.equal(frame.rowStart,plain.rowStart+navHeight);
      assert.equal(frame.rowCount,plain.rowCount-navHeight);
      assert.ok(frame.rows.slice(0,navHeight+1).every(row=>row===null));
      assert.equal(frame.rows.indexOf(0),plain.rows.indexOf(0)+navHeight);
      assert.ok(!stripAnsi(frame.lines[frame.headerY]).includes('Settings'),'the navigation already names Settings');
      for (const action of frame.actions) {
        assert.equal(handleSettingsInput(frame.state,{type:'mouse',button:'left',x:action.x,y:frame.headerY},frame).action,action.action);
        const onNav=handleSettingsInput(frame.state,{type:'mouse',button:'left',x:action.x,y:0},frame);
        assert.equal(onNav.action,undefined,'settings handler does not route navigation');
        assert.deepEqual(onNav.state.draft,state.draft);
      }
      const y=frame.rows.indexOf(0);
      assert.ok(frame.back && frame.back.y===y);
      assert.equal(stripAnsi(frame.lines[y])[frame.back.x],'‹');
      assert.equal(handleSettingsInput(frame.state,{type:'mouse',button:'left',x:frame.back.x,y},frame).state.draft.theme,'none');
      assert.equal(handleSettingsInput(frame.state,{type:'mouse',button:'left',x:40,y},frame).state.draft.theme,'titanium');
      const preview=()=>['preview bar','preview title'];
      const withPreview=renderSettingsPage(state,56,18,undefined,preview,navigation);
      assert.equal(withPreview.rowCount,frame.rowCount-3,'preview and navbar both consume their own rows');
      assert.equal(withPreview.lines.length,18);
    }
  } finally {setLanguage(previous);}
});

test('navigation clips safely at tiny heights and fits ANSI/CJK rows to exact terminal width',()=>{
  const previous=setLanguage('zh');
  try {
    const navigation={
      lines:[theme.accent('主界面 设置 标签'),colors.dim('时间线 变更 检查器')],
      controls:[{kind:'main' as const,x:-2,y:0,width:8},{kind:'settings' as const,x:7,y:0,width:12},
        {kind:'tab' as const,pane:'timeline' as const,x:0,y:1,width:8},
        {kind:'help' as const,x:0,y:2,width:8}],
    };
    const selected=SETTING_ROWS.findIndex(row=>row.key==='agentProgress');
    const state:SettingsPageState={draft:defaultSettings(),selected,offset:0,message:''};
    for (const width of [0,1,2,7,16,24,40,56,70,80]) {
      for (const height of [0,1,2,3,4,5,6,8,12]) {
        const frame=renderSettingsPage(state,width,height,{state:undefined,modelCalls:{today:4,lastHour:1,cap:60}},()=>['界面预览'],navigation);
        assert.equal(frame.lines.length,height,`${width} x ${height}`);
        assert.equal(frame.rows.length,height);
        assert.ok(frame.lines.every(line=>visualLength(line)===width),`${width} x ${height}: exact display width`);
        assert.ok(frame.rowCount>=0 && frame.rowCount<=Math.max(0,height-navigation.lines.length-1));
        for (const control of frame.navigationControls) {
          assert.ok(control.y>=0 && control.y<Math.min(height,navigation.lines.length));
          assert.ok(control.x>=0 && control.width>0 && control.x+control.width<=width);
        }
        assert.ok(!frame.navigationControls.some(control=>control.kind==='help'),'off-navbar controls are not exposed');
        if (height<=navigation.lines.length) assert.deepEqual(frame.actions,[],'no invisible settings header targets');
        if (frame.back) assert.ok(frame.back.y<height && frame.back.x<width);
        assert.deepEqual(navigation.controls[0],{kind:'main',x:-2,y:0,width:8},'navigation is never mutated');
      }
    }
  } finally {setLanguage(previous);}
});

test('Child role counts clearly names footer statistics and never toggles child lines or summaries',()=>{
  const previous=setLanguage('en');
  try {
    const selected=SETTING_ROWS.findIndex(row=>row.key==='cardRoleCounts');
    const row=SETTING_ROWS[selected];
    assert.equal(row.label,'Child role counts');
    assert.equal(defaultSettings().cardRoleCounts,true);
    assert.match(row.help,/2 scout \/ 1 implementer/);
    assert.match(row.help,/off keeps child lines and summaries/);
    const state:SettingsPageState={draft:defaultSettings(),selected,offset:0,message:''};
    const frame=renderSettingsPage(state,56,18);
    assert.match(stripAnsi(frame.lines[frame.rows.indexOf(selected)]),/Child role counts +‹ on ›/);
    const changed=handleSettingsInput(frame.state,{type:'key',key:'right'},frame).state;
    assert.equal(changed.draft.cardRoleCounts,false);
    assert.equal(changed.draft.cardSubagents,state.draft.cardSubagents);
    assert.equal(changed.draft.cardSubagentSummary,state.draft.cardSubagentSummary);
    assert.equal(changed.draft.cardSummary,state.draft.cardSummary);
    setLanguage('zh');
    assert.equal(t(row.label),'子 agent 数量统计');
    assert.match(t(row.help),/2 scout \/ 1 implementer/);
    assert.match(t(row.help),/关闭保留子 agent 行和总结/);
    assert.match(stripAnsi(renderSettingsPage(state,56,18).lines[16]),/关闭保留子 agent 行和总结/,
      'the meaning stays visible before examples are clipped');
    for (const width of [16,24,40,56,80]) {
      const zh=renderSettingsPage(state,width,18);
      assert.ok(zh.lines.every(line=>visualLength(line)===width));
      assert.notEqual(zh.rows.indexOf(selected),-1);
      if (width>=40) {
        assert.ok(stripAnsi(zh.lines[zh.rows.indexOf(selected)]).includes('子 agent 数量统计'));
        assert.ok(zh.back);
        const line=stripAnsi(zh.lines[zh.back.y]);
        assert.equal(visualLength(line.slice(0,line.indexOf('‹'))),zh.back.x,'back uses display columns, not CJK string offsets');
        assert.equal(handleSettingsInput(zh.state,{type:'mouse',button:'left',x:zh.back.x,y:zh.back.y},zh).state.draft.cardRoleCounts,false);
      }
    }
  } finally {setLanguage(previous);}
});

test('the virtual Cards preset is derived, edits draft content only and custom selection is a no-op',()=>{
  const row=SETTING_ROWS.find(entry=>entry.key==='cardPreset')!;
  const original={...defaultSettings(),briefing:'api' as const,briefingApiKey:'synthetic-key',briefAgents:false,
    agentProgress:false,cardCorners:'round' as const,cardSubagentScope:'all' as const,sort:'created' as const,treeWidth:56};
  let state:SettingsPageState={draft:{...original},original,selected:SETTING_ROWS.indexOf(row),offset:0,message:''};
  assert.equal(rowValue(row,state.draft),'monitor');
  assert.equal(settingGroup(state),'Cards');
  assert.equal(settingGroup(row),'Cards');
  assert.equal(settingsDirty(state),false);
  const frame=renderSettingsPage(state,48,18);
  state=handleSettingsInput(frame.state,{type:'key',key:'left'},frame).state;
  assert.equal(rowValue(row,state.draft),'progress');
  assert.equal(settingsDirty(state),true);
  assert.deepEqual(state.draft,applyCardPreset(original,'progress'));
  assert.deepEqual(state.original,original);
  assert.ok(!Object.hasOwn(state.draft,'cardPreset'),'only existing fields will be saved');
  state.draft=withRowValue(state.draft,row,'minimal');
  assert.equal(identifyCardPreset(state.draft),'minimal');
  state.draft=withRowValue(state.draft,SETTING_ROWS.find(entry=>entry.key==='cardClock')!,true);
  assert.equal(rowValue(row,state.draft),'custom','a manual tweak immediately changes the derived value');
  assert.equal(withRowValue(state.draft,row,'custom'),state.draft);
  // Named presets cycle without getting trapped in custom's no-op.
  state.draft=applyCardPreset(original,'monitor');
  for (const preset of ['minimal','progress','monitor','minimal'] as const) {
    state=handleSettingsInput(state,{type:'key',key:'right'},frame).state;
    assert.equal(rowValue(row,state.draft),preset);
  }
  state=handleSettingsInput(state,{type:'key',key:'left'},frame).state;
  assert.equal(rowValue(row,state.draft),'monitor');
  state.draft={...state.draft,cardOriginalName:true};
  assert.equal(rowValue(row,state.draft),'custom');
  assert.equal(rowValue(row,handleSettingsInput(state,{type:'key',key:'right'},frame).state.draft),'minimal');
  assert.equal(rowValue(row,handleSettingsInput(state,{type:'key',key:'left'},frame).state.draft),'monitor');
});

const syntheticConfigured=():HudSettings=>({...applyCardPreset(defaultSettings(),'minimal'),theme:'mocha',look:'pill',icons:'text',glyphs:'text',motion:'reduced',
  language:'zh',panelStyle:'compact',paneLayout:'tabs',statusCard:'min',timelineStyle:'lanes',timelineHours:24,treeWidth:56,art:'ascii',
  artImage:'/synthetic/image.png',sort:'created',finishedLingerMs:0,importantRoles:'synthetic-role',agentLog:true,
  cardCorners:'round',cardSubagentScope:'all',
  briefing:'api',briefingApiBase:'https://synthetic.invalid/v1',briefingApiKey:'synthetic-secret',briefingApiModel:'synthetic-model',
  briefingApiLiteModel:'synthetic-lite',briefingApiLowModel:'synthetic-low',briefingApiMediumModel:'synthetic-medium',briefingApiReasoning:true,
  modelCallsPerHour:1,briefingPaused:false,briefAgents:false,briefMain:true,agentProgress:false,agentLabels:false,labelAsName:false,
  briefingMs:60_000,recapFloorMs:300_000,resultDigest:true,failureCause:true,changeSummary:true,approvalDescription:true,
  statusline:false,density:'full',context:'remaining',notify:true,notifyDesktop:true,mouse:false,prefixKey:'C-\\',refreshMs:500,
  worktreeRoot:'/synthetic/worktrees',agentsPane:'closed',timelinePane:'open'});
const connectionKeys=['briefing','briefingApiBase','briefingApiKey','briefingApiModel','briefingApiLiteModel','briefingApiLowModel',
  'briefingApiMediumModel','briefingApiReasoning','modelCallsPerHour'] as const;
const permissionKeys=['briefAgents','briefMain','agentProgress','agentLabels','resultDigest','failureCause','changeSummary','approvalDescription'] as const;

test('each group reset owns explicit fields, including composite hidden fields, without touching other groups or connections',()=>{
  const draft=syntheticConfigured();
  const before={...draft};
  const owned:Record<string,readonly (keyof HudSettings)[]>={
    Display:['theme','look','icons','glyphs','motion'],
    Panel:['language','panelStyle','paneLayout','statusCard','timelineStyle','timelineHours','treeWidth','art'],
    Agents:['sort','finishedLingerMs','importantRoles','agentLog'],
    Cards:[...CARD_PRESET_KEYS,'cardCorners','cardSubagentScope'],
    LLM:['briefingPaused','briefAgents','briefMain','agentProgress','briefingMs','recapFloorMs','resultDigest','agentLabels','labelAsName',
      'failureCause','changeSummary','approvalDescription'],
    'Status bar':['statusline','density','context','notify','notifyDesktop'],Input:['mouse','prefixKey','refreshMs'],
  };
  for (const [group,keys] of Object.entries(owned)) {
    const result=resetSettingsGroup(draft,group);
    assert.notEqual(result,draft);
    for (const key of Object.keys(draft) as Array<keyof HudSettings>) {
      if (!keys.includes(key)) assert.equal(result[key],draft[key],`${group} preserves ${key}`);
      else if (group==='LLM' && permissionKeys.some(permission=>permission===key)) assert.equal(result[key],false,`${key} disabled`);
      else if (key==='briefingPaused') assert.equal(result[key],true,'LLM reset pauses');
      else assert.equal(result[key],defaultSettings()[key],`${group} resets ${key}`);
    }
    for (const key of connectionKeys) assert.equal(result[key],draft[key],`${group} preserves ${key}`);
    assert.deepEqual(draft,before,'reset is pure');
  }
  assert.equal(resetSettingsGroup(draft,'Unknown'),draft);
  assert.equal(resetSettingsGroup(draft,'__proto__'),draft);
  const llm=resetSettingsGroup(draft,'LLM');
  assert.equal(llm.recapFloorMs,defaultSettings().recapFloorMs,'hidden half of Brief pace resets');
  assert.equal(llm.labelAsName,defaultSettings().labelAsName,'hidden half of disabled Agent names resets');
  assert.equal(resetSettingsGroup({...draft,notify:false,notifyDesktop:true},'Status bar').notifyDesktop,false,'hidden notification flag resets');
});

test('all preferences reset preserves model configuration and assets, never enabling privacy permissions',()=>{
  const draft=syntheticConfigured();
  const result=resetAllPreferences(draft);
  for (const key of connectionKeys) assert.equal(result[key],draft[key],key);
  for (const key of permissionKeys) assert.equal(result[key],false,key);
  assert.equal(result.briefingPaused,true);
  for (const key of ['artImage','worktreeRoot','agentsPane','timelinePane'] as const) assert.equal(result[key],draft[key],key);
  assert.equal(result.theme,defaultSettings().theme);
  assert.equal(result.treeWidth,defaultSettings().treeWidth);
  assert.equal(result.notifyDesktop,false);
  assert.equal(result.cardSubagentScope,defaultSettings().cardSubagentScope);
  for (const briefing of ['off','agy','api'] as const) {
    for (const briefingPaused of [false,true]) {
      const privateDraft={...draft,briefing,briefingPaused};
      for (const key of permissionKeys) privateDraft[key]=false;
      for (const restored of [resetSettingsGroup(privateDraft,'LLM'),resetAllPreferences(privateDraft)]) {
        assert.equal(restored.briefing,briefing);
        assert.equal(restored.briefingPaused,true,'a reset never resumes requests');
        for (const key of permissionKeys) assert.equal(restored[key],false,`never grants ${key}`);
      }
    }
  }
});

test('dirty comparison sees hidden coupled fields but not the derived preset',()=>{
  const original=defaultSettings();
  assert.equal(settingsDirty({draft:{...original}}),false,'no baseline is treated as clean');
  assert.equal(settingsDirty({draft:{...original},original}),false);
  for (const patch of [{recapFloorMs:60_000},{notifyDesktop:true},{agentLabels:false,labelAsName:false},
    {briefingApiKey:'synthetic-draft-secret'},{cardClock:false}]) {
    assert.equal(settingsDirty({draft:{...original,...patch},original}),true);
  }
  const hiddenOriginal={...original,agentLabels:false};
  assert.equal(rowValue(SETTING_ROWS.find(row=>row.key==='agentLabels')!,hiddenOriginal),'off');
  assert.equal(settingsDirty({draft:{...hiddenOriginal,labelAsName:false},original:hiddenOriginal}),true,
    'disabled name generation does not hide a changed naming preference');
});

test('header resets have distinct labels and hit maps; narrow widths retain Back/Save and keyboard group reset',()=>{
  const previous=setLanguage('en');
  try {
    const state:SettingsPageState={draft:syntheticConfigured(),selected:SETTING_ROWS.findIndex(row=>row.key==='cardPreset'),offset:0,message:''};
    for (const width of [16,20,24,28,32,40,48,56,80]) {
      for (const navHeight of [0,1,2]) {
        const nav=navHeight ? {lines:['navigation','second row'].slice(0,navHeight),controls:[]} : undefined;
        const frame=renderSettingsPage(state,width,18,undefined,undefined,nav);
        assert.ok(frame.actions.some(action=>action.action==='back'),`Back ${width}`);
        assert.ok(frame.actions.some(action=>action.action==='save'),`Save ${width}`);
        assert.equal(frame.headerY,navHeight);
        assert.ok(frame.lines.every(line=>visualLength(line)===width));
        const header=stripAnsi(frame.lines[frame.headerY]);
        for (const action of frame.actions) {
          const label=header.slice(action.x,action.x+action.width);
          assert.equal(label,{back:'[Back]',save:'[Save]',reset:'[Reset group]','reset-all':'[Reset all]'}[action.action]);
          assert.equal(handleSettingsInput(frame.state,{type:'mouse',button:'left',x:action.x,y:frame.headerY},frame).action,action.action);
        }
        const reset=handleSettingsInput(frame.state,{type:'key',key:'reset'},frame);
        assert.equal(reset.action,'reset');
        assert.equal(settingGroup(reset.state),'Cards');
        assert.deepEqual(reset.state.draft,state.draft,'caller routes reset and confirmation');
        if (width<27) assert.ok(!frame.actions.some(action=>action.action==='reset'));
        if (width<39) assert.ok(!frame.actions.some(action=>action.action==='reset-all'));
      }
    }
  } finally {setLanguage(previous);}
});
