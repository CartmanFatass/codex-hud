import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hostSocket, nativeHostEntryPath, NativeHostClient } from '../../src/managed/host-ipc.js';
import type { NativeOwner } from '../../src/managed/relations.js';

const owner: NativeOwner = {
  harness: 'codex',
  sourceId: 'synthetic-source',
  sessionId: 'synthetic-session',
  threadId: null,
};

async function stopOwned(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const exited = await Promise.race([
    once(child, 'exit').then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000)),
  ]);
  if (!exited && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
}

test('default NativeHostClient entry exists and starts', { timeout: 20_000 }, async (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'hud-host-entry-')));
  chmodSync(home, 0o700);
  let child: ChildProcess | undefined;
  const stderr: Buffer[] = [];
  t.after(async () => {
    if (child) await stopOwned(child);
    rmSync(home, { recursive: true, force: true });
  });
  const entry = nativeHostEntryPath();
  const client = new NativeHostClient(home, false);
  assert.equal((client as unknown as { entry: string }).entry, entry);
  assert.equal(entry, fileURLToPath(new URL('../../src/managed/host-entry.js', import.meta.url)));
  assert.equal(existsSync(entry), true, entry);
  assert.equal(fileURLToPath(import.meta.resolve(pathToFileURL(entry).href)), entry);
  child = spawn(process.execPath, [entry, home, JSON.stringify(owner)], {
    env: { ...process.env, HOME: home, HUD_HOME: home },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    if (Buffer.concat(stderr).length < 8192) stderr.push(chunk);
  });
  const socket = hostSocket(home, owner);
  const deadline = Date.now() + 10_000;
  let started = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) break;
    try {
      const stat = lstatSync(socket);
      if (stat.isSocket() && !stat.isSymbolicLink() && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0) {
        started = true;
        break;
      }
    } catch {
      // The listener creates the socket after startup.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(started, true, Buffer.concat(stderr).toString('utf8'));
  await stopOwned(child);
  child = undefined;
});
