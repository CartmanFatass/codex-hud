import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { taskText } from '../../src/utils/task-text.js';
import { buildSubagentTree,resetSubagentLinkCache } from '../../src/collectors/subagent-tree.js';

test('task summaries remove injected metadata while preserving real task text',()=>{
  assert.equal(taskText('<recommended_plugins>Here is a list of plugins that are available but not installed.\n...</recommended_plugins>'),undefined);
  assert.equal(taskText('<recommended_plugin>unfinished injected list'),undefined);
  assert.equal(taskText('<environment_context><cwd>/tmp</cwd></environment_context>\nFix layout'), 'Fix layout');
  assert.equal(taskText('Here is a list of bugs to fix: navigation, resize'),'Here is a list of bugs to fix: navigation, resize');
  assert.equal(taskText('# AGENTS.md instructions for /tmp\n<INSTRUCTIONS>rules</INSTRUCTIONS>'),undefined);
});
test('later plugin recommendations never replace an agent task in rollout scanning',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hud-task-text-'));
  const old=process.env.CODEX_SESSIONS_PATH;
  process.env.CODEX_SESSIONS_PATH=dir;
  const now=new Date();
  const day=path.join(dir,String(now.getFullYear()),String(now.getMonth()+1).padStart(2,'0'),String(now.getDate()).padStart(2,'0'));
  fs.mkdirSync(day,{recursive:true});
  const file=path.join(day,`rollout-${now.toISOString().slice(0,10)}T00-00-00-abcd.jsonl`);
  const message=(text:string)=>JSON.stringify({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text}]}})+'\n';
  try {
    fs.writeFileSync(file,JSON.stringify({type:'session_meta',payload:{id:'child',parent_thread_id:'root',timestamp:now.toISOString()}})+'\n'+message('Fix the tree layout'));
    resetSubagentLinkCache();
    assert.equal(buildSubagentTree('root').nodes[0].task,'Fix the tree layout');
    fs.appendFileSync(file,message('<recommended_plugins>Here is a list of plugins that are available but not installed.</recommended_plugins>'));
    assert.equal(buildSubagentTree('root').nodes[0].task,'Fix the tree layout');
    resetSubagentLinkCache();
    assert.equal(buildSubagentTree('root').nodes[0].task,'Fix the tree layout');
  } finally {
    if(old===undefined)delete process.env.CODEX_SESSIONS_PATH;else process.env.CODEX_SESSIONS_PATH=old;
    resetSubagentLinkCache();fs.rmSync(dir,{recursive:true,force:true});
  }
});
