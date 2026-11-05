// Fixed synthetic executable: it never invokes a provider or reads credentials.
// Only the four prepared synthetic HUD environment overrides are consumed.
import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
const envKeys=Object.keys(process.env).sort();
writeFileSync(join(process.env.CODEX_HOME,'observed-env.json'),JSON.stringify(envKeys),{mode:0o600});
if (envKeys.some((k)=>['NODE_OPTIONS','EXAMPLE_SECRET','OPENAI_API_KEY','ANTHROPIC_API_KEY'].includes(k))) process.exit(3);
let input = '';
for await (const chunk of process.stdin) input += chunk;
if (!input.includes('synthetic workbench brief')) process.exit(2);
process.stdout.write('SIMULATED child received brief\n');
if (!input.includes('hold for cancellation')) {
  const config={};
  for (const arg of process.argv.slice(2)) {
    const match=/^mcp_servers\.hud\.env\.(HUD_CLAIM|HUD_RUN|HUD_LINK|HUD_HOME)=(.+)$/.exec(arg);
    if (match) config[match[1]]=JSON.parse(match[2]);
  }
  if (!config.HUD_CLAIM || !config.HUD_RUN || !config.HUD_LINK || config.HUD_HOME!==process.env.HUD_HOME) process.exit(4);
  const helper=spawn(process.execPath,[process.env.HUD_LAB_HELPER],{cwd:process.cwd(),env:{...process.env,...config},stdio:['ignore','pipe','pipe']});
  helper.stdout.resume(); helper.stderr.resume();
  const result=await new Promise((resolve,reject)=>{helper.once('error',reject);helper.once('exit',(code,signal)=>resolve({code,signal}));});
  if (result.code!==0) process.exit(5);
}
await new Promise((resolve) => setTimeout(resolve, input.includes('hold for cancellation') ? 30000 : 4000));
