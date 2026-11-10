/** Keep the panel's independent read-only sampler off every ambient herdr instance. */
import * as fs from 'node:fs';
import { join } from 'node:path';
export function isolatePanelHerdr(env: NodeJS.ProcessEnv, directory: string): string {
  for (const name of ['HERDR_SOCKET_PATH', 'HERDR_SOCKET', 'HERDR_PANE_ID', 'HERDR_ENV']) delete env[name];
  const bin = join(directory, 'fake-bin');
  fs.mkdirSync(bin, { mode: 0o700 });
  fs.symlinkSync(process.execPath, join(bin, 'node'));
  const log = join(directory, 'fake-herdr-calls.jsonl');
  fs.writeFileSync(
    join(bin, 'herdr'),
    `#!${process.execPath}\nimport fs from 'node:fs';
const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');
if(JSON.stringify(args)!==JSON.stringify(['agent','list','--json']))process.exit(2);
console.log(JSON.stringify({result:{agents:[]}}));\n`,
    { mode: 0o700 }
  );
  // Nothing in the inherited PATH can resolve a real herdr (or another external tool).
  env.PATH = bin;
  return log;
}
