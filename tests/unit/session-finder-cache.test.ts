/**
 * The session finder's listing caches. With Codex 0.159's daemon writing
 * every session's shell snapshot into one folder, re-reading that folder on
 * every check cost milliseconds a second; an unchanged folder is now answered
 * from the last scan. These tests pin the key: the folder's own mtime, and
 * never a folder that changed a moment ago.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SessionFinder } from '../../src/collectors/session-finder.js';

const pad = (n: number) => String(n).padStart(2, '0');

function rollout(home: string, id: string): string {
  const now = new Date();
  const dir = join(home, 'sessions', String(now.getFullYear()), pad(now.getMonth() + 1), pad(now.getDate()));
  mkdirSync(dir, { recursive: true });
  const label = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  const file = join(dir, `rollout-${label}-${id}.jsonl`);
  writeFileSync(file, `${JSON.stringify({ type: 'session_meta', payload: { id, cwd: home } })}\n`);
  return file;
}

function snapshot(home: string, id: string, pane: string, nonce: bigint): void {
  const dir = join(home, 'shell_snapshots');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.${nonce}.sh`), `export TMUX_PANE='${pane}'\n`);
}

/** Set the snapshot folder's mtime, as a folder last changed at `at` reports it. */
function settle(home: string, at: Date): void {
  utimesSync(join(home, 'shell_snapshots'), at, at);
}

function withEnv<T>(env: Record<string, string | undefined>, run: () => T): T {
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  try { return run(); } finally {
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}

const FIRST = '019d0000-0000-7000-8000-000000000001';
const SECOND = '019d0000-0000-7000-8000-000000000002';

test('an unchanged snapshot folder is answered from the last scan, a changed one is read again', () => {
  const home = mkdtempSync(join(tmpdir(), 'hud-finder-cache-'));
  try {
    withEnv({ CODEX_HOME: home, CODEX_SESSIONS_PATH: undefined, CODEX_HUD_MAIN_PANE: '%9', TMUX: undefined }, () => {
      rollout(home, FIRST);
      rollout(home, SECOND);
      const nonce = BigInt(Date.now()) * 1_000_000n;
      snapshot(home, FIRST, '%9', nonce);
      const settled = new Date(Date.now() - 60_000);
      settle(home, settled);
      const finder = new SessionFinder(home);
      assert.equal(finder.check()?.sessionId, FIRST);

      // A newer binding for the pane, with the folder's mtime put back: to a
      // cache keyed on the folder, nothing happened.
      snapshot(home, SECOND, '%9', nonce + 1_000_000_000n);
      settle(home, settled);
      assert.equal(finder.check()?.sessionId, FIRST, 'served from the cached scan');

      // The folder changed: the scan runs again and finds the new binding.
      settle(home, new Date(settled.getTime() + 30_000));
      assert.equal(finder.check()?.sessionId, SECOND);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a folder that changed a moment ago is never served from a cache', () => {
  const home = mkdtempSync(join(tmpdir(), 'hud-finder-cache-'));
  try {
    withEnv({ CODEX_HOME: home, CODEX_SESSIONS_PATH: undefined, CODEX_HUD_MAIN_PANE: '%9', TMUX: undefined }, () => {
      rollout(home, FIRST);
      rollout(home, SECOND);
      const nonce = BigInt(Date.now()) * 1_000_000n;
      snapshot(home, FIRST, '%9', nonce);
      const recent = new Date(Date.now() - 500);
      settle(home, recent);
      const finder = new SessionFinder(home);
      assert.equal(finder.check()?.sessionId, FIRST);
      // The same mtime as the scan saw, as a filesystem with coarse
      // timestamps would report it, but within the settling window.
      snapshot(home, SECOND, '%9', nonce + 1_000_000_000n);
      settle(home, recent);
      assert.equal(finder.check()?.sessionId, SECOND);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a bound thread is found in the archive when the live tree does not have it', () => {
  const home = mkdtempSync(join(tmpdir(), 'hud-finder-cache-'));
  try {
    withEnv({ CODEX_HOME: home, CODEX_SESSIONS_PATH: undefined, CODEX_HUD_MAIN_PANE: '%9', TMUX: undefined }, () => {
      mkdirSync(join(home, 'sessions'), { recursive: true });
      const archived = join(home, 'archived_sessions');
      mkdirSync(archived, { recursive: true });
      const file = join(archived, `rollout-2026-01-01T00-00-00-${FIRST}.jsonl`);
      writeFileSync(file, `${JSON.stringify({ type: 'session_meta', payload: { id: FIRST, cwd: home } })}\n`);
      snapshot(home, FIRST, '%9', BigInt(Date.now()) * 1_000_000n);
      assert.equal(new SessionFinder(home).check()?.path, file);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
