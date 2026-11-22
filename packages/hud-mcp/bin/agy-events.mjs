// Keep the Antigravity PreInvocation mailbox hook usable before dist is built.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_BYTES = 16 * 1024;
const { O_CREAT, O_NOFOLLOW, O_NONBLOCK, O_RDONLY, O_WRONLY } = fs.constants;
const pendingFile = (pane, home) => home && /^[A-Za-z0-9:_-]+$/.test(pane ?? '')
  ? join(home, 'watchers', `${pane}.agy-pending`) : null;

export function hasAgyEvents(pane, home) {
  const file = pendingFile(pane, home);
  return !!file && fs.existsSync(file);
}

// Use the same open-file-description flock as hud_lease. Do not lock the pending
// inode itself: publishing or claiming replaces it. The hook never waits for a lock.
async function locked(file, env, hook, run) {
  const fd = fs.openSync(`${file}.lock`, O_CREAT | O_WRONLY | O_NOFOLLOW | O_NONBLOCK, 0o600);
  try {
    const lock = spawn('flock', hook ? ['-nx', '3'] : ['-x', '-w', '0.25', '3'], {
      env, stdio: ['ignore', 'ignore', 'ignore', fd], timeout: hook ? 50 : 500,
    });
    const [code, signal] = await once(lock, 'close');
    if (code === 1) return;
    if (code !== 0) throw new Error(`Antigravity mailbox lock failed (${code ?? signal})`);
    // Keep the same lock until the async prompt's claim has been resolved.
    return await run();
  } finally {
    fs.closeSync(fd);
  }
}

function read(file) {
  let fd;
  try { fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK); }
  catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('Invalid Antigravity mailbox');
    return fs.readFileSync(fd, 'utf8');
  } finally { fs.closeSync(fd); }
}

// Both consumers must own this rename before reading for delivery. Writers and
// readers cooperate under the same lock, so no append can land in a claimed file.
async function consume(file, deliver) {
  const claim = `${file}.${randomUUID()}.claim`;
  try { fs.renameSync(file, claim); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  try {
    const text = read(claim).replace(/\n$/, ''); // Strip only the mailbox's trailing newline.
    const delivered = !text || await deliver(text, claim);
    if (delivered === null) return; // Unknown external outcome: retain the claim without replaying it.
    if (delivered) {
      try { fs.unlinkSync(claim); } catch { /* Already delivered; do not replay. */ }
      return;
    }
  } catch (error) {
    fs.renameSync(claim, file);
    throw error;
  }
  fs.renameSync(claim, file); // A failed prompt leaves the batch for the next wake or hook.
}

function eventLine(message) {
  const line = message.replaceAll('\0', ' ');
  if (Buffer.byteLength(line) < MAX_BYTES) return line + '\n';
  // Keep the event and its reply/report reference even if a display field is pathological.
  const bytes = Buffer.from(line), edge = (MAX_BYTES / 2) - 8;
  return `${bytes.subarray(0, edge).toString('utf8')} … ${bytes.subarray(-edge).toString('utf8')}\n`;
}

// Return how many notices were persisted. A live watcher retains overflow and
// retries on its next regular wake rather than dropping older pending events.
export async function pushAgyEvents(pane, home, messages, env, type) {
  const file = pendingFile(pane, home);
  let accepted = 0;
  try {
    if (!file) throw new Error('Missing Antigravity mailbox pane or home');
    // The standalone PreInvocation hook only consumes claims; it doesn't need a build.
    const { writePrivateFile } = await import('../../../dist/utils/atomic-fs.js');
    fs.mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    return await locked(file, env, false, async () => {
      if (messages.length) {
        let text = read(file), bytes = Buffer.byteLength(text), count = 0;
        for (const message of messages) {
          const line = eventLine(message);
          bytes += Buffer.byteLength(line);
          if (bytes > MAX_BYTES) break;
          text += line;
          count++;
        }
        if (count) {
          writePrivateFile(file, text, { mkdir: false });
          accepted = count;
        }
      }
      let sent = { status: 0, detail: 'pending for Antigravity delivery' };
      if (type) await consume(file, async (text, claim) => {
        sent = await type(text);
        if (sent.retry) return false;
        if (sent.status === 0) return true;
        sent.detail = `Antigravity prompt outcome unknown; retained ${claim} without retrying`;
        return null;
      });
      return { ...sent, accepted };
    }) ?? { status: 0, accepted }; // Busy; leave the batch and retry on the next wake.
  } catch (error) {
    return { status: 1, accepted, error };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = pendingFile(process.env.HERDR_PANE_ID, process.env.HUD_HOME);
  let injected = false;
  try {
    if (file) await locked(file, process.env, true, () => consume(file, (text) => {
      fs.writeFileSync(1, JSON.stringify({ injectSteps: [{ userMessage: `[HUD job events]\n${text}` }] }) + '\n');
      injected = true;
      return true;
    }));
  } catch { /* Fail open: never interrupt an invocation over a notice. */ }
  if (!injected) try { fs.writeFileSync(1, '{}\n'); } catch { /* stdout closed */ }
}
