// Fixed synthetic Pi-labelled workload. It invokes no provider and binds no session.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const keys=Object.keys(process.env).sort();
writeFileSync(join(process.env.HUD_HOME,'observed-env.json'),JSON.stringify(keys),{mode:0o600});
if (keys.some((k)=>['NODE_OPTIONS','EXAMPLE_SECRET','OPENAI_API_KEY','ANTHROPIC_API_KEY'].includes(k))) process.exit(3);
let input=''; for await (const chunk of process.stdin) input+=chunk;
if (!input.includes('synthetic workbench brief')) process.exit(2);
console.log('SIMULATED Pi workload received brief');
await new Promise((resolve)=>setTimeout(resolve,input.includes('hold for cancellation')?30000:1800));
