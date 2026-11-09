import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

test(
  'shipped role-main resolves the current ordinary Claude session on every stdio call',
  { timeout: 15000 },
  async (t) => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'hud-role-entry-')));
    const home = join(dir, 'hud'),
      root = join(dir, '.claude');
    await mkdir(home, { mode: 0o700 });
    await mkdir(join(root, 'sessions'), { recursive: true });
    await copyFile('docs/examples/routing.toml', join(home, 'routing.toml'));
    const child = spawn(process.execPath, ['tests/fixtures/native-role-host.mjs'], {
      cwd: resolve('.'),
      env: {
        HOME: dir,
        HUD_HOME: home,
        CLAUDE_CONFIG_DIR: root,
        HUD_TEST_REPO: resolve('.'),
        CLAUDE_CODE_SESSION_ID: 'forged-inherited',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let readyResolve,
      readyReject,
      stderr = '',
      id = 0;
    const ready = new Promise((r, j) => {
      readyResolve = r;
      readyReject = j;
    });
    const pending = new Map();
    child.stderr.on('data', (c) => (stderr += c));
    const ended = new Promise((r) => child.once('close', r));
    child.once('close', () => {
      readyReject(Error(stderr));
      for (const p of pending.values()) p.reject(Error(stderr || 'host exited'));
    });
    createInterface({ input: child.stdout }).on('line', (line) => {
      const row = JSON.parse(line);
      if (row.ready) readyResolve();
      else {
        const p = pending.get(row.id);
        pending.delete(row.id);
        clearTimeout(p.timer);
        p.resolve(row);
      }
    });
    t.after(async () => {
      child.stdin.end();
      await ended;
      await rm(dir, { recursive: true, force: true });
    });
    await ready;
    const request = (value) =>
      new Promise((resolve, reject) => {
        const number = ++id;
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(Error('native host deadline: ' + stderr));
        }, 10000);
        pending.set(number, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ id: number, ...value }) + '\n');
      });
    const list = await request({ method: 'tools/list' });
    assert.deepEqual(
      list.result.tools.map((t) => t.name),
      ['hud_roster', 'hud_create', 'hud_read', 'hud_send', 'hud_respond', 'hud_close']
    );
    for (const session of ['synthetic-initial', 'synthetic-clear', 'synthetic-resumed']) {
      const row = await request({ session });
      assert.equal(row.result.structuredContent.ok, true, JSON.stringify(row));
      assert.ok(JSON.stringify(row).includes('/' + session));
    }
  }
);
