// Start the entire finite lab with a fresh allowlisted environment.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const home = mkdtempSync(join(tmpdir(), 'hud-chat-launch-'));
try {
  const child = spawn(process.execPath, [resolve('scripts/workbench/chat-scenario.mjs')], {
    cwd: process.cwd(),
    env: { HOME: home, HUD_HOME: home, CODEX_HOME: home, TMPDIR: tmpdir(), PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    stdio: 'inherit',
  });
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  if (result.code !== 0) process.exitCode = 1;
} finally {
  rmSync(home, { recursive: true, force: true });
}
