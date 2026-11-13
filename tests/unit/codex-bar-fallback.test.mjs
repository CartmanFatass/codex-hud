/** Codex bar fallback must not adopt a HUD CLI worker's rollout. Synthetic files only. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const flag = 'CODEX_BAR_FALLBACK_CHILD';

if (process.env[flag] === '1') {
  const { findMostRecentRollout, SessionFinder } = await import('../../dist/collectors/session-finder.js');
  const cwd = fs.realpathSync(process.env.SYNTHETIC_CWD);
  const hud = process.env.HUD_HOME;
  const workerId = '019bc10d-c89d-7352-935c-76b351384357';
  const nextId = '019bc10d-aaaa-7352-935c-76b351384358';
  const mainId = '019bc10d-bbbb-7352-935c-76b351384359';
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const day = join(
    process.env.CODEX_HOME,
    'sessions',
    String(now.getFullYear()),
    pad(now.getMonth() + 1),
    pad(now.getDate())
  );
  fs.mkdirSync(day, { recursive: true });
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  const t0 = Date.now();
  function rollout(id, mtimeMs) {
    const file = join(day, `rollout-${stamp}-${id}.jsonl`);
    fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id, cwd } }) + '\n');
    fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
  }
  rollout(mainId, t0 - 120_000);
  rollout(nextId, t0 - 60_000);
  rollout(workerId, t0);
  const job = join(hud, 'jobs', 'j0000000000000001');
  const statusFile = join(job, 'STATUS.json');
  fs.mkdirSync(job, { recursive: true });
  const writeStatus = (body) => fs.writeFileSync(statusFile, JSON.stringify(body) + '\n');

  assert.equal(findMostRecentRollout(1, cwd).sessionId, workerId);
  writeStatus({ agent: 'codex', agent_session_id: workerId, state: 'working' });
  assert.equal(findMostRecentRollout(1, cwd).sessionId, nextId);
  writeStatus({ agent: 'grok', agent_session_id: workerId, state: 'working' });
  assert.equal(findMostRecentRollout(1, cwd).sessionId, workerId);
  writeStatus({ agent: 'codex', agent_session_id: workerId, state: 'closed' });
  assert.equal(findMostRecentRollout(1, cwd).sessionId, nextId);
  writeStatus({ agent: 'codex', agent_session_id: null, state: 'working' });
  assert.equal(findMostRecentRollout(1, cwd).sessionId, workerId);
  fs.writeFileSync(statusFile, '{');
  assert.equal(findMostRecentRollout(1, cwd).sessionId, workerId);
  writeStatus({ agent: 'codex', agent_session_id: nextId, state: 'idle_grace' });
  assert.equal(findMostRecentRollout(1, cwd).sessionId, workerId);

  process.env.CODEX_HUD_MAIN_PANE = 'w4E:p1';
  process.env.CODEX_HUD_TMUX_BIN = join(process.env.SYNTHETIC_CWD, 'no-tmux');
  writeStatus({ agent: 'codex', agent_session_id: workerId, state: 'working' });
  const bound = new SessionFinder(cwd, undefined, new Date(t0 - 180_000));
  assert.equal(bound.check()?.sessionId, nextId);

  fs.rmSync(statusFile);
  delete process.env.CODEX_HUD_MAIN_PANE;
  const sticky = new SessionFinder(cwd);
  assert.equal(sticky.check()?.sessionId, workerId);
  writeStatus({ agent: 'codex', agent_session_id: workerId, state: 'working' });
  await new Promise((done) => setTimeout(done, 2100));
  assert.equal(sticky.check()?.sessionId, nextId);
  assert.notEqual(sticky.getCurrentSession()?.sessionId, workerId);
} else {
  test('the Codex bar fallback skips a HUD CLI worker rollout', { timeout: 15000 }, () => {
    const root = fs.mkdtempSync(join(tmpdir(), 'codex-bar-'));
    const env = {
      ...process.env,
      [flag]: '1',
      HOME: join(root, 'home'),
      HUD_HOME: join(root, 'hud'),
      CODEX_HOME: join(root, 'codex'),
      SYNTHETIC_CWD: join(root, 'project'),
    };
    for (const key of ['CODEX_HUD_MAIN_PANE', 'CODEX_SESSIONS_PATH', 'CODEX_HUD_SESSION_START', 'CODEX_HUD_TMUX_BIN']) {
      delete env[key];
    }
    fs.mkdirSync(env.HOME);
    fs.mkdirSync(env.HUD_HOME);
    fs.mkdirSync(env.CODEX_HOME);
    fs.mkdirSync(env.SYNTHETIC_CWD);
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { env, encoding: 'utf8' });
    fs.rmSync(root, { recursive: true, force: true });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  });
}
