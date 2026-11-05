#!/usr/bin/env node
import { createInterface } from 'node:readline';
const mode = process.env.FAKE_MODE || 'ok';
const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
  const m = JSON.parse(line);
  if (m.type !== 'prompt' || m.streamingBehavior !== 'steer') process.exit(8);
  if (mode === 'lost') process.exit(0);
  if (mode === 'timeout') continue;
  if (mode === 'wrong') { console.log(JSON.stringify({type:'response',id:'other',command:'prompt',success:true})); continue; }
  if (mode === 'ui') { console.log(JSON.stringify({type:'extension_ui_request',id:'x',method:'input'})); continue; }
  if (mode === 'reject') { console.log(JSON.stringify({type:'response',id:m.id,command:'prompt',success:false})); continue; }
  console.log(JSON.stringify({type:'response',id:m.id,command:'prompt',success:true}));
  console.log(JSON.stringify({type:'agent_start'}));
  console.log(JSON.stringify({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'你好'}}));
  console.log(JSON.stringify({type:'message_update',assistantMessageEvent:{type:'thinking_delta',delta:'private'}}));
  console.log(JSON.stringify({type:'agent_end'}));
}
