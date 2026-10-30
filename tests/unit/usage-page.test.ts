import test from 'node:test';
import assert from 'node:assert/strict';
import { initialUsagePageState,renderUsagePage,handleUsageInput,usageNumber,usageModelName,type UsageTab } from '../../src/render/usage-page.js';
import { usageSnapshot } from '../fixtures/usage-data.js';
import { setLanguage,t } from '../../src/render/i18n.js';
import { setDisplayConfig } from '../../src/render/hud-config.js';
import { stripAnsi,visualLength } from '../../src/render/colors.js';
import { useDisplayFixture } from '../fixtures/display.js';
import { quietOverviewSettings } from '../../src/settings-runtime.js';
import { defaultSettings } from '../../src/settings.js';
import { renderSettingsPage,handleSettingsInput,SETTING_ROWS } from '../../src/render/settings-page.js';
import { controlBar } from '../../src/render/control-bar.js';
import { handleMonitorInput,initialMonitorState,monitorSettings,renderMonitor } from '../../src/render/monitor.js';
import { node,treeOf } from '../fixtures/hud-data.js';
import { commandSequence,monitorKey,needsOpenPanel } from '../../src/utils/panel-command.js';
import { WorkbenchInputDecoder } from '../../src/utils/workbench-input.js';
useDisplayFixture();

const TABS:UsageTab[]=['overview','tasks','models','efforts','roles'];
test('Usage fits EN/ZH, no-colour and teal, every view and narrow panel width; controls stay reachable',()=>{
  for(const language of ['en','zh'] as const) {
    const old=setLanguage(language);
    try {
      for(const theme of ['none','teal'] as const)for(const width of [16,24,32,40,48,56,80])for(const height of [12,24,32])for(const tab of TABS) {
        setDisplayConfig({theme});
        const frame=renderUsagePage({...initialUsagePageState(),tab},usageSnapshot(),width,height);
        assert.equal(frame.lines.length,height);
        frame.lines.forEach(line=>assert.equal(visualLength(line),width,`${language}/${width}/${height}/${tab}: ${stripAnsi(line)}`));
        frame.lines.forEach(line=>assert.doesNotMatch(stripAnsi(line),/[\x00-\x1f]/,'wrapping never leaves partial ANSI escapes'));
        for(const c of frame.controls)assert.ok(c.x>=0&&c.width>0&&c.x+c.width<=width&&c.y<height);
        assert.ok(frame.controls.some(c=>c.kind==='back'));
        if(width>=24)for(const kind of ['period','scope','refresh',...TABS])assert.ok(frame.controls.some(c=>c.kind===kind),`${width}/${height}: ${kind}`);
        if(theme==='none')frame.lines.forEach(line=>assert.equal(line,stripAnsi(line)));
      }
    } finally {setLanguage(old);}
  }
});
test('toktrack dashboard shows price, tokens, hit, composition, shared ranking and a vertical trend',()=>{
  const state=initialUsagePageState(),snapshot=usageSnapshot();
  const text=stripAnsi(renderUsagePage(state,snapshot,56,60).lines.join('\n'));
  assert.match(text,/OVERVIEW/);assert.match(text,/Cost\s+\$1\.32\*/);assert.match(text,/Tokens\s+1\.3K/);
  assert.match(text,/Cache hit\s+20%/);assert.match(text,/TOKEN MIX/);assert.match(text,/MODELS/);assert.match(text,/USAGE TREND/);
  assert.match(text,/█/);assert.doesNotMatch(text,/Source:|Coverage|part of input|subscription bill/);
  for(const [n,expected] of [[0,'0'],[999,'999'],[1000,'1.0K'],[12800,'12.8K'],[12800000,'12.8M'],[1200000000,'1.2B']] as const)assert.equal(usageNumber(n),expected);
  assert.equal(usageNumber(null),'Unknown');
  const detail=handleUsageInput(state,{type:'key',key:'details'},renderUsagePage(state,snapshot,56,40)).state;
  assert.equal(detail.details,true);
  const exact=stripAnsi(renderUsagePage(detail,snapshot,56,60).lines.join('\n'));
  assert.match(exact,/Total tokens\s+1,320/);assert.match(exact,/Cached input \(part of input\)\s+240/);
  assert.match(exact,/Source: sessions \+ archived_sessions/);assert.match(exact,/\/synthetic\/codex-home/);assert.match(exact,/COVERAGE/);
  const back=handleUsageInput(detail,{type:'key',key:'escape'},renderUsagePage(detail,snapshot,56,40));
  assert.equal(back.state.details,false);assert.equal(back.action,undefined);
  const tasks=stripAnsi(renderUsagePage({...state,tab:'tasks'},snapshot,48,40).lines.join('\n'));
  assert.match(tasks,/Self\s+1\.1K/);assert.match(tasks,/Descendants\s+220/);assert.match(tasks,/Task total\s+1\.3K/);assert.match(tasks,/\$1\.32/);
});
test('Usage keyboard, mouse and wheel reach all periods, scopes and views; paste and unrelated keys stay owned',()=>{
  let state=initialUsagePageState();
  const draw=()=>renderUsagePage(state,usageSnapshot(),32,24);
  const key=(key:string)=>{state=handleUsageInput(state,{type:'key',key},draw()).state;};
  for(const period of ['7d','30d','all','today']){key('filter');assert.equal(state.period,period);}
  key('sort');assert.equal(state.scope,'task');key('sort');assert.equal(state.scope,'all');
  for(const tab of [...TABS.slice(1),TABS[0]]){key('tab');assert.equal(state.tab,tab);}
  key('left');assert.equal(state.tab,'roles');
  state={...state,details:true};key('end');assert.ok(state.scroll>0);key('home');state={...state,details:false};assert.equal(state.scroll,0);
  let frame=draw();
  for(const c of frame.controls) {
    const result=handleUsageInput(state,{type:'mouse',button:'left',x:c.x,y:c.y},frame);
    if(TABS.includes(c.kind as UsageTab))assert.equal(result.state.tab,c.kind);
    if(c.kind==='back')assert.equal(result.action,'close');
    if(c.kind==='refresh')assert.equal(result.action,'refresh');
    if(c.kind==='period')assert.equal(result.state.period,'7d');
    if(c.kind==='scope')assert.equal(result.state.scope,'task');
  }
  const longFrame=renderUsagePage({...state,details:true},usageSnapshot(),32,24);
  assert.ok(handleUsageInput({...state,details:true},{type:'mouse',button:'wheel-down',x:0,y:10},longFrame).state.scroll>0);
  assert.equal(handleUsageInput(state,{type:'key',key:'escape'},frame).action,'close');
  assert.equal(handleUsageInput(state,{type:'key',key:'close'},frame).action,'close');
  assert.equal(handleUsageInput(state,{type:'key',key:'reset'},frame).action,'refresh');
  assert.deepEqual(handleUsageInput(state,{type:'paste',text:'secret paste'},frame),{state});
  assert.deepEqual(handleUsageInput(state,{type:'key',key:'',raw:'λ'},frame),{state});
  const decoder=new WorkbenchInputDecoder('monitor',{forward:true});
  assert.deepEqual(decoder.push(Buffer.from(commandSequence('usage'))),[{type:'command',command:'usage'}]);
  assert.equal(monitorKey('usage'),'usage');assert.equal(needsOpenPanel('usage'),true);
});
test('Usage selected view has a non-colour marker in EN/ZH at sidebar widths',()=>{
  for(const language of ['en','zh'] as const){
    const previous=setLanguage(language);
    try {for(const width of [32,40,48,56])for(const tab of TABS){
      setDisplayConfig({theme:'none'});
      const frame=renderUsagePage({...initialUsagePageState(),tab},usageSnapshot(),width,24);
      const active=frame.controls.find(c=>c.kind===tab)!;
      const label=stripAnsi(frame.lines[active.y]).slice(active.x,active.x+active.width);
      // EN uses one cell per character; CJK assertions inspect the whole row.
      assert.ok(frame.lines[active.y].includes('[› '));
      assert.ok(frame.controls.some(c=>c.kind===tab));
      assert.equal(frame.lines.filter(line=>line.includes('[› ')).length,1);
      if(language==='en')assert.ok(label.startsWith('[› '));
      frame.lines.forEach(line=>assert.equal(line,stripAnsi(line)));
    }}finally{setLanguage(previous);}
  }
});
test('Usage empty partial/unavailable views do not claim there were no usage events',()=>{
  for(const language of ['en','zh'] as const){
    const previous=setLanguage(language);
    try {for(const status of ['loading','partial','unavailable','ready'] as const)for(const tab of TABS){
      const snapshot=usageSnapshot();
      Object.assign(snapshot,{status,daily:[],tasks:[],models:[],efforts:[],roles:[],
        totals:{input:null,cachedInput:null,output:null,reasoningOutput:null,total:null,events:0,threads:0}});
      const frame=renderUsagePage({...initialUsagePageState(),tab},snapshot,56,40);
      const text=stripAnsi(frame.lines.join('\n'));
      if(status==='ready')assert.ok(text.includes(t('No usage events in this range')));
      else {
        assert.ok(!text.includes(t('No usage events in this range')),`${status}/${tab}: absence is not established`);
        if(status!=='loading')assert.ok(text.includes(t('No indexed rows available for this view')));
      }
    }}finally{setLanguage(previous);}
  }
});
test('clean Settings navigation keys open Usage, Activity and Evidence just as their monitor mouse controls do',()=>{
  const settings=quietOverviewSettings(defaultSettings());setDisplayConfig(settings);
  const state={...initialMonitorState(),...monitorSettings(settings)};
  const tree=treeOf([]);
  for(const width of [32,48]){
    const navigation=controlBar(state,{expired:0,settingsActive:true},width);
    const pageState={draft:settings,original:{...settings},selected:0,offset:0,message:''};
    const page=renderSettingsPage(pageState,width,24,undefined,undefined,navigation);
    for(const kind of ['usage','activity-hub','observability'] as const){
      const control=page.navigationControls.find(c=>c.kind===kind);assert.ok(control);
      // A clean Settings departure dispatches the navigation intent directly
      // into the monitor; a dirty departure replays it after confirmation.
      const direct=handleMonitorInput(state,{type:'key',key:kind},{tree,navigationOverlay:true});
      assert.equal(direct.action?.type,kind,`${width}: ${kind} clean Settings departure`);
      const frame=renderMonitor({tree,state,nowMs:0,width,height:24});
      const mouse=frame.controls.find(c=>c.kind===kind)!;
      const clicked=handleMonitorInput(state,{type:'mouse',button:'left',x:mouse.x,y:mouse.y},{tree,frame});
      assert.deepEqual(direct.action,clicked.action,`${width}: ${kind} consistent destination`);
    }
  }
});
test('Quiet overview is an explicit Settings draft choice and preserves model connection and unrelated preferences',()=>{
  const original={...defaultSettings(),theme:'mocha' as const,briefingApiBase:'https://synthetic.invalid/v1',briefingApiKey:'fixture-key',notify:true,treeWidth:56};
  const preset=quietOverviewSettings(original);
  assert.equal(original.look,'tab');assert.equal(original.panelStyle,'rich');
  assert.equal(preset.look,'quiet');assert.equal(preset.theme,'teal');assert.equal(preset.panelStyle,'compact');
  assert.equal(preset.paneLayout,'tabs');assert.equal(preset.statusCard,'status');assert.equal(preset.agentColors,'off');
  for(const key of ['briefingApiBase','briefingApiKey','notify','treeWidth','briefing','briefingPaused'] as const)assert.equal(preset[key],original[key]);
  assert.equal(quietOverviewSettings({...original,theme:'none'}).theme,'none');
  const selected=SETTING_ROWS.findIndex(row=>row.key==='look');
  const state={draft:{...original,look:'pill' as const},selected,offset:0,message:''};
  const result=handleSettingsInput(state,{type:'key',key:'right'},renderSettingsPage(state,48,24));
  assert.equal(result.state.draft.look,'quiet');assert.equal(result.state.draft.panelStyle,'compact');
  assert.equal(result.action,undefined,'activation still requires Save');
});
test('Quiet overview keeps labelled navigation and a compact selection with Inspector access at sidebar widths',()=>{
  const settings=quietOverviewSettings(defaultSettings());setDisplayConfig(settings);
  const tree=treeOf([node('active','Parser','running'),node('done','Reviewer','completed')]);
  const state={...initialMonitorState(),...monitorSettings(settings)};
  state.tree={...state.tree,selectedId:'active'};
  for(const width of [32,40,48,56]) {
    const bar=controlBar(state,{expired:2,brief:{}},width);
    assert.match(stripAnsi(bar.lines.join('\n')),/\[Overview\].*Usage.*Activity/);
    for(const kind of ['usage','activity-hub','observability','settings','help','main','brief','older']){
      const control=bar.controls.find(c=>c.kind===kind);assert.ok(control,`${width}: ${kind}`);
      const frame=renderMonitor({tree,state,nowMs:0,width,height:24});
      const c=frame.controls.find(c=>c.kind===kind);
      if(['usage','activity-hub','observability','settings'].includes(kind)) {
        assert.ok(c);assert.equal(handleMonitorInput(frame.state,{type:'mouse',button:'left',x:c.x,y:c.y},{tree,frame}).action?.type,kind);
      }
    }
    const frame=renderMonitor({tree,state,nowMs:0,width,height:24});
    const text=stripAnsi(frame.lines.join('\n'));
    assert.match(text,/Parser/);assert.match(text,/Reviewer/);
    assert.doesNotMatch(text,/[┌╭].*Parser/,'compact rows do not wrap each agent in a card');
    assert.equal(handleMonitorInput(frame.state,{type:'key',key:'enter'},{tree,frame}).state.focus,'details');
  }
});

test('Usage is labelled menu navigation in every look; Inspector is reached through its command',()=>{
  for(const look of ['tab','band','tile','frame','pill','quiet'] as const)for(const language of ['en','zh'] as const)for(const width of [24,32,40,48,80]){
    const old=setLanguage(language);
    try{
      setDisplayConfig({look,icons:'unicode'});
      const state=initialMonitorState();
      const navigation=controlBar(state,{expired:0,usageActive:true},width);
      const usage=navigation.controls.find(c=>c.kind==='usage');assert.ok(usage,`${look}/${language}/${width}`);
      assert.ok(navigation.lines[usage.y].includes(t('Usage')));
      assert.ok(!navigation.controls.some(c=>c.kind==='tab'&&c.pane==='details'));
      const frame=renderUsagePage(initialUsagePageState(),usageSnapshot(),width,48,navigation);
      assert.ok(frame.navigationControls.some(c=>c.kind==='usage'));
      assert.ok(!frame.controls.some(c=>String(c.kind)==='details'));
      const detail=handleUsageInput(frame.state,{type:'key',key:monitorKey('pane-4')},frame);
      assert.equal(detail.state.details,true);
      const main=renderMonitor({tree:treeOf([]),state,width,height:48});
      assert.equal(handleMonitorInput(state,{type:'key',key:monitorKey('pane-4')},{tree:treeOf([]),frame:main}).state.focus,'details');
    }finally{setLanguage(old);}
  }
});

test('sidebar keeps shared toktrack bands, compact category controls and no duplicate title',()=>{
  for(const language of ['en','zh'] as const)for(const width of [32,40,48]){
    const previous=setLanguage(language);
    try{
      setDisplayConfig({look:'pill',icons:'unicode',theme:'none'});
      const navigation=controlBar({...initialMonitorState(),tabbed:true},{expired:0,usageActive:true},width);
      const frame=renderUsagePage(initialUsagePageState(),usageSnapshot(),width,44,navigation);
      const tabs=frame.controls.filter(c=>TABS.includes(c.kind as UsageTab));
      assert.equal(new Set(tabs.map(c=>c.y)).size,1);
      assert.ok(frame.lines.every(line=>visualLength(line)===width));
      assert.ok(!frame.lines.some(line=>line.includes('Codex '+t('Usage'))));
      const text=frame.lines.join('\n');assert.ok(text.includes(t('Token mix').toUpperCase()));
      assert.ok(text.includes(t('Usage trend').toUpperCase()));
    }finally{setLanguage(previous);}
  }
});

test('toktrack measures, grouping, selection and drill-down preserve the query and have mouse equivalents',()=>{
  const snapshot=usageSnapshot();let state=initialUsagePageState();
  const frame=()=>renderUsagePage(state,snapshot,40,44);
  state=handleUsageInput(state,{type:'key',key:'main'},frame()).state;
  assert.equal(state.measure,'cost');assert.match(stripAnsi(frame().lines.join('\n')),/\$1\.32/);
  const measure=frame().controls.find(c=>c.kind==='measure')!;
  state=handleUsageInput(state,{type:'mouse',button:'left',x:measure.x,y:measure.y},frame()).state;
  assert.equal(state.measure,'tokens');
  state=handleUsageInput(state,{type:'key',key:'detail-toggle'},frame()).state;
  assert.equal(state.group,'projects');assert.ok(frame().lines.join('\n').includes('/synthetic/project'));
  state=handleUsageInput(state,{type:'key',key:'enter'},frame()).state;
  assert.deepEqual(state.filter,{by:'project',key:'/synthetic/project'});
  const back=handleUsageInput(state,{type:'key',key:'escape'},frame());
  assert.equal(back.action,undefined);assert.equal(back.state.filter,undefined);
});

test('model names follow toktrack display names while provider and Fast identities remain in raw keys',()=>{
  assert.equal(usageModelName('gpt-6-1-sol:fast::openai'),'GPT-6.1 Sol · Fast');
  assert.equal(usageModelName('gpt-6.1-terra'),'GPT-6.1 Terra');
  assert.equal(usageModelName('o4-mini'),'o4 Mini');
  assert.equal(usageModelName('custom-model'),'custom-model');
});

test('task headings use readable titles or project and date, never thread IDs',()=>{
  const snapshot=usageSnapshot(),state={...initialUsagePageState(),tab:'tasks' as const};
  const draw=()=>stripAnsi(renderUsagePage(state,snapshot,48,40).lines.join('\n'));
  assert.match(draw(),/Improve usage dashboard/);
  assert.doesNotMatch(draw(),/synthetic-root/);
  snapshot.tasks[0].title=undefined;
  assert.match(draw(),/project · 2026-10-28/);
  assert.doesNotMatch(draw(),/synthetic-root/);
  snapshot.tasks[0].project=undefined;snapshot.tasks[0].firstAtMs=undefined;
  assert.match(draw(),/Task/);assert.doesNotMatch(draw(),/synthetic-root/);
});
