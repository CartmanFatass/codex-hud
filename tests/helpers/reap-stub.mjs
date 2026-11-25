import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Only replace HUD's bundled reaper in synthetic subprocess fixtures. execve
// keeps the stub in the actual reaper PID/group for shutdown and ancestry tests.
export function reapStubOptions(bin, options = process.env.NODE_OPTIONS ?? '') {
  const entry = fileURLToPath(new URL('../../packages/hud-mcp/bin/hud-reap.mjs', import.meta.url));
  const stub = JSON.stringify(join(bin, 'hud-reap'));
  const probe = `if (process.argv[1] === ${JSON.stringify(entry)}) process.execve(${stub}, [${stub}, ...process.argv.slice(2)], process.env);`;
  return `${options} --import=data:text/javascript,${encodeURIComponent(probe)}`.trim();
}
