// Run after npm run build && npm run build:test. Synthetic data only.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderMonitor, initialMonitorState, handleMonitorInput } from '../../dist/render/monitor.js';
import { renderSettingsPage, SETTING_ROWS } from '../../dist/render/settings-page.js';
import { defaultSettings } from '../../dist/settings.js';
import { setDisplayConfig } from '../../dist/render/hud-config.js';
import { stripAnsi, visualLength } from '../../dist/render/colors.js';
import { buildBarModules } from '../../dist/render/layout/bar-modules.js';
import { fitModules } from '../../dist/render/layout/engine.js';
import { WorkbenchInputDecoder } from '../../dist/utils/workbench-input.js';
import { makeHudData, makeNestedTree, FIXED_NOW } from '../../dist-test/tests/fixtures/hud-data.js';

const now = FIXED_NOW.getTime();
const tree = makeNestedTree();
tree.nodes[0].name = 'context-parser-reviewer';
tree.nodes[0].turnStartedAt = new Date(now - 125000);
const worktrees = { sourcePath: '/project', updatedAt: now, entries: [
  { path:'/project/codex-hud',branch:'main',bare:false,detached:false,observedAt:now,status:{changed:0,staged:0,unstaged:0,untracked:0,conflicts:0,ahead:0,behind:0} },
  { path:'/project/hud-wheel-fix',branch:'fix/mouse-scroll-passthrough',bare:false,detached:false,observedAt:now,status:{changed:7,staged:2,unstaged:4,untracked:1,conflicts:0,ahead:1,behind:0} },
] };
const git = { root:'/project/codex-hud',branch:'main',ahead:1,behind:0,files:[
  {path:'src/collectors/context-usage.ts',index:' ',worktree:'M',added:8,removed:3,binary:false,conflict:false},
  {path:'src/render/layout/bar-modules.ts',index:'M',worktree:' ',added:6,removed:0,binary:false,conflict:false},
] };
const diff = ['Unstaged','--- a/src/collectors/context-usage.ts','+++ b/src/collectors/context-usage.ts','@@ -10,2 +10,2 @@','- const used = tokens + BASELINE;','+ const used = Math.max(0, tokens - BASELINE);'];
const base = {tree,git,worktrees,diff,nowMs:now};
const widths=[16,20,30,45,70], heights=[12,24,40], themes=['terminal','mocha','latte','none'];
const samples=[]; const failures=[]; let monitorCases=0,settingsCases=0,barCases=0;
function check(lines,width,height,label) {
  if(lines.length>height||lines.some(line=>visualLength(line)>width)) failures.push(label);
}
function stateFor(name) {
  const state=initialMonitorState();
  if(['all','diff','diff-zoom'].includes(name))state.modes={agents:'open',worktrees:'open',changes:'open',details:'open'};
  if(name==='inspector'){state.modes.details='open';state.focus='details';}
  if(name==='diff'||name==='diff-zoom'){state.focus='details';state.preview='file';state.zoom=name==='diff-zoom';}
  if(name==='help')state.help=true;
  return state;
}
for(const theme of themes) {
  setDisplayConfig({theme,glyphs:'both',density:'balanced'});
  for(const width of widths) for(const height of heights) {
    for(const name of ['default','all','inspector','diff','diff-zoom','help','empty']) {
      const input={...base,state:stateFor(name),width,height};
      if(name==='empty')input.tree={...tree,nodes:[],totalCount:0};
      const frame=renderMonitor(input);monitorCases++;check(frame.lines,width,height,`${theme}/${name}/${width}x${height}`);
      if(height===24&&(theme==='terminal'||(width===45&&name==='inspector')))
        samples.push({title:`${name} · ${width}×${height} · ${theme}`,kind:name,width,height,theme,lines:frame.lines});
    }
    for(let selected=0;selected<SETTING_ROWS.length;selected++) {
      const frame=renderSettingsPage({draft:defaultSettings(),selected,offset:0,message:''},width,height);
      settingsCases++;check(frame.lines,width,height,`settings/${theme}/${width}/${height}/${selected}`);
      if(height===24&&selected===4&&theme==='terminal')samples.push({title:`settings · ${width}×${height}`,kind:'settings',width,height,theme,lines:frame.lines});
    }
  }
  for(const width of [40,60,80,100,120,160]) for(const density of ['focus','balanced','full']) for(const age of [8,25,30]) {
    const data=makeHudData({tokenUsageAt:new Date(now-age*60_000),activity:{state:'working',updatedAt:new Date(now),turnStartedAt:new Date(now-60_000)}});
    const result=fitModules(buildBarModules(data,{nowMs:now,density}),{width,separator:' | '});
    barCases++;check([result.line],width,1,`bar/${theme}/${width}/${density}/${age}`);
    if(theme==='terminal'&&density==='balanced'&&age===25)samples.push({title:`bar · ${width} columns · cache 25m`,kind:'bar',theme,width,height:1,lines:[result.line],kept:result.kept});
  }
}
setDisplayConfig({theme:'terminal',glyphs:'both'});
const inspector=renderMonitor({...base,state:stateFor('inspector'),width:45,height:24});
const normal=renderMonitor({...base,state:stateFor('default'),width:30,height:40});
const pane=normal.panes.find(p=>p.id==='agents');
const blankY=pane.y+1+pane.rows.length;
const blank=handleMonitorInput(normal.state,{type:'mouse',button:'left',x:5,y:blankY},{...base,frame:normal});
const narrow=renderMonitor({...base,state:stateFor('all'),width:30,height:24});
const settings=renderSettingsPage({draft:defaultSettings(),selected:4,offset:0,message:''},16,24);
const probes={
  inspectorEscapes:inspector.lines.map(stripAnsi).filter(line=>line.includes('\\x1b')),
  blankClick:{blankY,visibleLine:stripAnsi(normal.lines[blankY]),action:blank.action},
  rightClick:new WorkbenchInputDecoder('monitor').push(Buffer.from('\x1b[<2;5;5M\x1b[<2;5;5m')),
  narrowChangeRows:narrow.panes.find(p=>p.id==='changes').rows.map(r=>stripAnsi(r.text)),
  narrowSettings:settings.lines.slice(0,7).map(stripAnsi),
  barWidths:samples.filter(s=>s.kind==='bar').map(s=>({width:s.width,kept:s.kept,text:stripAnsi(s.lines[0])})),
};
function luminance(hex){const c=hex.match(/\w\w/g).map(x=>parseInt(x,16)/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4);return c[0]*.2126+c[1]*.7152+c[2]*.0722;}
probes.mutedContrast=Object.fromEntries([['mocha','9399B2','1E1E2E'],['latte','6C6F85','EFF1F5']].map(([name,a,b])=>{const x=luminance(a),y=luminance(b);return [name,Number(((Math.max(x,y)+.05)/(Math.min(x,y)+.05)).toFixed(2))];}));
let unicodeCases=0;
const unicodeTree=makeNestedTree();unicodeTree.nodes[0].name='上下文审查员🧪e\u0301';
for(const width of widths)for(const glyphs of ['glyph','both','text']){
  setDisplayConfig({glyphs});
  const frame=renderMonitor({tree:unicodeTree,state:initialMonitorState(),width,height:24,nowMs:now});
  unicodeCases++;check(frame.lines,width,24,`unicode/${width}/${glyphs}`);
}
const summary={monitorCases,settingsCases,barCases,unicodeCases,failures,probes};
const out=fileURLToPath(new URL('./ui-audit/',import.meta.url));fs.mkdirSync(out,{recursive:true});
fs.writeFileSync(`${out}/results.json`,JSON.stringify(summary,null,2)+'\n');
fs.writeFileSync(`${out}/samples.json`,JSON.stringify(samples,null,2)+'\n');
const esc=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll(' ','&#32;');
function htmlAnsi(text,theme){
  const basic={31:'#f38ba8',32:'#a6e3a1',33:'#f9e2af',35:'#cba6f7',36:'#89dceb',96:'#89b4fa'};
  let html='',color='',background='',inverse=false,dim=false,bold=false,last=0;
  const defaultFg=theme==='latte'?'#4c4f69':'#cdd6f4',defaultBg=theme==='latte'?'#eff1f5':'#1e1e2e';
  for(const match of text.matchAll(/\x1b\[([0-9;]*)m/g)){
    const fg=inverse?(background||defaultBg):(color||defaultFg),bg=inverse?(color||defaultFg):background;
    html+=`<span style="color:${fg};${bg?`background:${bg};`:''}${dim?'opacity:.6;':''}${bold?'font-weight:bold;':''}">${esc(text.slice(last,match.index))}</span>`;
    const codes=match[1].split(';').map(Number);
    for(let i=0;i<codes.length;i++){const n=codes[i];if(n===0){color='';background='';inverse=false;dim=false;bold=false;}else if(n===2)dim=true;else if(n===1)bold=true;else if(n===7)inverse=true;else if(n===27)inverse=false;else if(n===39)color='';else if(n===49)background='';else if((n===38||n===48)&&codes[i+1]===2){const rgb=`rgb(${codes.slice(i+2,i+5).join(',')})`;if(n===38)color=rgb;else background=rgb;i+=4;}else if(basic[n])color=basic[n];}
    last=match.index+match[0].length;
  }
  return html+esc(text.slice(last));
}
fs.writeFileSync(`${out}/preview.html`,`<!doctype html><meta charset="utf-8"><title>HUD current UI audit</title>
<style>body{background:#10131a;color:#ddd;font:15px system-ui;margin:24px}select{font:inherit}main{display:flex;flex-wrap:wrap;gap:20px;align-items:start}section{border:1px solid #444;padding:12px;border-radius:8px}h2{font:14px system-ui}pre{font:15px/1.4 "DejaVu Sans Mono",monospace;white-space:pre;margin:0;background:#1e1e2e;color:#cdd6f4;padding:10px}.latte pre{background:#eff1f5;color:#4c4f69}p{max-width:900px}</style>
<h1>当前 HUD 实际渲染样本</h1><p>合成会话数据，直接调用当前 renderer；不是设计稿。终端主题在此映射为示例暗色 ANSI 配色，实际颜色随终端配置变化。可比较不同列宽、页面和主题。</p>
<p><select onchange="document.querySelectorAll('section').forEach(x=>x.hidden=this.value!=='all'&&x.dataset.kind!==this.value)"><option value="all">全部</option>${['default','all','inspector','diff','diff-zoom','help','empty','settings','bar'].map(x=>`<option>${x}</option>`).join('')}</select></p><main>${samples.map(s=>`<section data-kind="${s.kind}" class="${s.theme}"><h2>${esc(s.title)}</h2><pre>${s.lines.map(line=>htmlAnsi(line,s.theme)).join('\n')}</pre></section>`).join('')}</main>`);
console.log(JSON.stringify(summary,null,2));
