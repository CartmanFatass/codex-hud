// Fixed synthetic executable: it never invokes a provider or reads credentials.
// All injected Codex-style arguments are intentionally ignored.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const envKeys=Object.keys(process.env).sort();
writeFileSync(join(process.env.CODEX_HOME,'observed-env.json'),JSON.stringify(envKeys),{mode:0o600});
if (envKeys.some((k)=>['NODE_OPTIONS','EXAMPLE_SECRET','OPENAI_API_KEY','ANTHROPIC_API_KEY'].includes(k))) process.exit(3);
let input = '';
for await (const chunk of process.stdin) input += chunk;
if (!input.includes('synthetic workbench brief')) process.exit(2);
process.stdout.write('SIMULATED child received brief\n');
await new Promise((resolve) => setTimeout(resolve, input.includes('hold for cancellation') ? 30000 : 1500));
