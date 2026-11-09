// Synthetic native Claude process + native session store, actual role entry and stdio.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
process.title = 'claude';
const fields = readFileSync(`/proc/${process.pid}/stat`, 'utf8').split(') ').at(-1).trim().split(/\s+/);
const record = (sessionId) =>
  writeFileSync(
    join(process.env.CLAUDE_CONFIG_DIR, 'sessions', `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, procStart: fields[19], sessionId })
  );
record('synthetic-initial');
const child = spawn(
  process.execPath,
  [
    '--import',
    process.env.HUD_TEST_REPO + '/tests/fixtures/role-import-guard.mjs',
    process.env.HUD_TEST_REPO + '/packages/hud-mcp/bin/hud-mcp.mjs',
  ],
  { env: { ...process.env, HUD_MCP_SURFACE: 'roles' }, stdio: ['pipe', 'pipe', 'inherit'] }
);
const ended = new Promise((r) => child.once('close', r));
const pending = new Map();
createInterface({ input: child.stdout }).on('line', (line) => {
  const row = JSON.parse(line),
    resolve = pending.get(row.id);
  pending.delete(row.id);
  resolve(row);
});
process.stdout.write('{"ready":true}\n');
for await (const line of createInterface({ input: process.stdin })) {
  const req = JSON.parse(line);
  if (req.session) record(req.session);
  const reply = await new Promise((resolve) => {
    pending.set(req.id, resolve);
    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: req.id,
        method: req.method ?? 'tools/call',
        params: req.params ?? { name: 'hud_roster', arguments: { action: 'show' } },
      }) + '\n'
    );
  });
  process.stdout.write(JSON.stringify(reply) + '\n');
}
child.stdin.end();
await ended;
