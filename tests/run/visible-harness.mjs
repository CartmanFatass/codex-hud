// Synthetic terminal consumer. Never loads a coding agent or touches a user home.
import { writeFileSync, appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
const home = process.env.HUD_HOME;
if (!home) throw new Error('test requires private HUD_HOME');
writeFileSync(
  `${home}/harness.json`,
  JSON.stringify({
    pid: process.pid,
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    parent: process.ppid,
    tty: process.stdin.isTTY,
    context: process.env.SYNTHETIC_CONTEXT,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('HERDR_'))),
  })
);
if (process.env.VISIBLE_MEMBER === '1') {
  const member = spawn(process.execPath, ['-e', "process.on('SIGINT',()=>{});setInterval(()=>{},60000)"], {
    stdio: 'ignore',
  });
  writeFileSync(`${home}/member.json`, JSON.stringify({ pid: member.pid }));
  member.unref();
}
if (process.env.VISIBLE_IGNORE === '1') {
  process.on('SIGINT', () => appendFileSync(`${home}/signals`, 'INT\n'));
  process.on('SIGTERM', () => appendFileSync(`${home}/signals`, 'TERM\n'));
}
if (process.env.VISIBLE_SHORT === '1') process.exit(0);
const reader = createInterface({ input: process.stdin, terminal: false });
reader.on('line', (line) => {
  appendFileSync(`${home}/input.log`, `${line}\n`);
  if (line === 'quit') process.exit(0);
  if (line === 'exit137') process.exit(137);
});
process.stdout.write('SYNTHETIC READY\n');
