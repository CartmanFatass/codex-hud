// Synthetic owned harness: MCP inherits the harness's stdin and stdout so killing
// this process does not itself close the pipe still held by the test/subreaper.
import { spawn } from 'node:child_process';
const child = spawn(process.execPath, ['packages/hud-mcp/dist/packages/hud-mcp/src/main.js'], {
  env: { ...process.env, HUD_HOME: process.argv[2] },
  stdio: ['inherit', 'inherit', 'inherit'],
});
process.stdout.write(JSON.stringify({ harness: process.pid, mcp: child.pid }) + '\n');
child.once('exit', () => {
  process.stdout.write(JSON.stringify({ reaped: child.pid }) + '\n', () => process.exit(0));
});
