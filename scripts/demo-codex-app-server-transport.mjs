import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexAppServerTransport } from '../dist/harness/codex/app-server-transport.js';
const home = mkdtempSync(join(tmpdir(), 'hud-app-server-demo-'));
const client = new CodexAppServerTransport({
  executable: process.execPath,
  args: [fileURLToPath(new URL('../tests/fixtures/codex-app-server/synthetic-server.mjs', import.meta.url))],
  cwd: home,
  env: { HOME: home, HUD_HOME: join(home, '.hud') },
});
try {
  console.log('SIMULATED app-server: actual child process and HUD transport; no Codex/provider.');
  await client.initialize();
  await client.threadStart();
  await client.threadResume('synthetic-thread');
  console.log(JSON.stringify(client.snapshot(), null, 2));
  assert.equal(client.snapshot().observation.threadId, 'synthetic-thread');
} finally {
  const closed = await client.shutdown();
  console.log(JSON.stringify({ shutdown: closed }));
  assert.equal(closed.reaped, true);
  rmSync(home, { recursive: true, force: true });
}
