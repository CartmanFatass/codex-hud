/** A detached process-group supervisor, not imported by the render path. */
import { spawn } from 'node:child_process';
import { readStatuslineInputBytes } from '../statusline-preview.js';
function stop(): never {
  try {
    process.kill(-process.pid, 'SIGKILL');
  } catch {
    /* already absent */
  }
  process.exit(0);
}
const timer = setTimeout(stop, 1500);
try {
  const argv: unknown = JSON.parse(process.argv[2] ?? 'null');
  if (!Array.isArray(argv) || !argv.length || !argv.every((v) => typeof v === 'string' && !v.includes('\0'))) stop();
  const bytes = await readStatuslineInputBytes(process.stdin, 500);
  const child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
  child.once('error', stop).once('exit', stop);
  child.stdin.on('error', () => {});
  child.stdin.end(bytes);
} catch {
  stop();
}
// The timer stays referenced until the whole owned process group has gone.
void timer;
