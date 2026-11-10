#!/usr/bin/env node
// Subprocess-only Herdr effects. Never connects to a real instance.
import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
if (process.env.PANEL_FAKE_LOG) {
  const argv = process.argv.slice(2);
  fs.appendFileSync(process.env.PANEL_FAKE_LOG, JSON.stringify(argv) + '\n');
  if (argv[0] === '--version') process.stdout.write('herdr 0.9.5\n');
  else if (argv[0] === 'api') process.stdout.write(fs.readFileSync(process.env.PANEL_FAKE_SCHEMA_FILE, 'utf8'));
  else if (argv[2] === '--help')
    process.stdout.write('Run a command in a pane\nUsage: herdr pane run <PANE_ID> <COMMAND>...\n');
  else
    process.stdout.write(
      JSON.stringify({
        result: argv[1] === 'split' ? { pane: { pane_id: 'panel-1', workspace_id: 'workspace-1' } } : {},
      })
    );
  process.exit(0);
}
const [log, operation, ...args] = process.argv.slice(2);
fs.appendFileSync(log, JSON.stringify({ operation, args }) + '\n');
if (operation === 'leak') {
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 10000)'], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  fs.writeFileSync(log + '.pid', String(child.pid));
} else if (operation === 'split') {
  const [intent] = args;
  if (JSON.parse(fs.readFileSync(intent, 'utf8')).phase !== 'opening') process.exit(9);
  process.stdout.write(JSON.stringify({ pane: 'panel-1' }));
} else {
  process.stdout.write('{}');
}
