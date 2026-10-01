import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SessionFinder, findMostRecentRollout } from '../../dist/collectors/session-finder.js';

function makeTempCodexHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-session-finder-'));
}

function todayParts() {
  const now = new Date();
  const year = now.getFullYear().toString();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return { year, month, day };
}

function rolloutTimestampLabel(offsetMinutes = 0) {
  const now = new Date(Date.now() + offsetMinutes * 60_000);
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hour = String(now.getHours()).padStart(2, '0');
  const minute = String(now.getMinutes()).padStart(2, '0');
  const second = String(now.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day}T${hour}-${minute}-${second}`;
}

function writeRollout(home, { sessionId, cwd, fileOffsetMinutes = 0, modifiedAt, extraLines = [], parentThreadId }) {
  const { year, month, day } = todayParts();
  const dir = path.join(home, 'sessions', year, month, day);
  fs.mkdirSync(dir, { recursive: true });

  const filePath = path.join(dir, `rollout-${rolloutTimestampLabel(fileOffsetMinutes)}-${sessionId}.jsonl`);
  const lines = [
    JSON.stringify({
      timestamp: new Date().toISOString(),
      type: 'session_meta',
      payload: {
        id: sessionId,
        timestamp: new Date().toISOString(),
        cwd,
        originator: 'codex-tui',
        cli_version: '0.118.0',
        source: 'cli',
        model_provider: 'openai',
        parent_thread_id: parentThreadId,
        thread_source: parentThreadId ? 'subagent' : 'user',
      },
    }),
    ...extraLines.map((line) => JSON.stringify(line)),
  ];

  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');

  if (modifiedAt) {
    fs.utimesSync(filePath, modifiedAt, modifiedAt);
  }

  return filePath;
}

function writeSnapshot(home, threadId, paneId, nonce, tmux) {
  const dir = path.join(home, 'shell_snapshots');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${threadId}.${nonce}.sh`);
  fs.writeFileSync(
    filePath,
    [
      '# Snapshot file',
      ...(tmux ? [`export TMUX=${tmux}`] : []),
      `export TMUX_PANE='${paneId}'`,
      "export PATH='/usr/bin'",
      '',
    ].join('\n'),
    'utf8'
  );
  return filePath;
}

const originalCodexHome = process.env.CODEX_HOME;
const originalMainPane = process.env.CODEX_HUD_MAIN_PANE;
const originalSessionsPath = process.env.CODEX_SESSIONS_PATH;
const originalTmux = process.env.TMUX;

try {
  {
    const home = makeTempCodexHome();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-cwd-'));
    process.env.CODEX_HOME = home;
    delete process.env.CODEX_SESSIONS_PATH;
    process.env.CODEX_HUD_MAIN_PANE = '%70';

    const modifiedAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
    writeRollout(home, {
      sessionId: '019d7291-a135-7fe1-b46f-8f3eca4fa451',
      cwd,
      modifiedAt,
    });

    const finder = new SessionFinder(cwd);
    assert.equal(
      finder.check(),
      null,
      'fresh launch without a bound shell snapshot should stay in initialization state'
    );
  }

  {
    const home = makeTempCodexHome();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-cwd-'));
    process.env.CODEX_HOME = home;
    delete process.env.CODEX_SESSIONS_PATH;
    process.env.CODEX_HUD_MAIN_PANE = '%70';

    const activeThread = '019d7291-a135-7fe1-b46f-8f3eca4fa451';
    const boundThread = '019d7295-3ef8-7292-a039-fdf7ecd4f53e';

    writeRollout(home, {
      sessionId: activeThread,
      cwd,
      modifiedAt: new Date(),
    });
    const boundRollout = writeRollout(home, {
      sessionId: boundThread,
      cwd,
      fileOffsetMinutes: -1,
      modifiedAt: new Date(Date.now() - 5 * 60 * 1000),
    });
    writeSnapshot(home, boundThread, '%70', 1775743876858615370n);

    const finder = new SessionFinder(cwd);
    const resolved = finder.check();
    assert.ok(resolved, 'expected a pane-bound session to resolve');
    assert.equal(
      resolved.path,
      boundRollout,
      'pane-bound shell snapshot should override the newest unrelated rollout'
    );
  }

  {
    const home = makeTempCodexHome();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-cwd-'));
    process.env.CODEX_HOME = home;
    delete process.env.CODEX_SESSIONS_PATH;

    const paneOneThread = '019d7291-a135-7fe1-b46f-8f3eca4fa451';
    const paneTwoThread = '019d7295-3ef8-7292-a039-fdf7ecd4f53e';

    const paneOneRollout = writeRollout(home, {
      sessionId: paneOneThread,
      cwd,
      modifiedAt: new Date(Date.now() - 60 * 1000),
    });
    const paneTwoRollout = writeRollout(home, {
      sessionId: paneTwoThread,
      cwd,
      fileOffsetMinutes: -1,
      modifiedAt: new Date(),
    });

    writeSnapshot(home, paneOneThread, '%70', 1775743639864947215n);
    writeSnapshot(home, paneTwoThread, '%72', 1775743876858615370n);

    process.env.CODEX_HUD_MAIN_PANE = '%70';
    const finderOne = new SessionFinder(cwd);
    const resultOne = finderOne.check();
    assert.ok(resultOne, 'expected pane one to resolve');
    assert.equal(resultOne.path, paneOneRollout, 'pane one should stay on its own thread');

    process.env.CODEX_HUD_MAIN_PANE = '%72';
    const finderTwo = new SessionFinder(cwd);
    const resultTwo = finderTwo.check();
    assert.ok(resultTwo, 'expected pane two to resolve');
    assert.equal(resultTwo.path, paneTwoRollout, 'pane two should stay on its own thread');
  }

  {
    const home = makeTempCodexHome();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-cwd-'));
    process.env.CODEX_HOME = home;
    delete process.env.CODEX_SESSIONS_PATH;
    process.env.CODEX_HUD_MAIN_PANE = '%70';

    const sessionId = '01a00bab-efc9-7743-8345-bd546f862e10';
    const rollout = writeRollout(home, {
      sessionId,
      cwd,
      modifiedAt: new Date(),
    });

    const finder = new SessionFinder(cwd, undefined, new Date());
    const resolved = finder.check();
    assert.ok(resolved, 'expected cwd fallback when snapshots have no TMUX_PANE');
    assert.equal(resolved.path, rollout, 'fallback should follow the newest cwd rollout after HUD start');
  }

  {
    const home = makeTempCodexHome();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-cwd-'));
    process.env.CODEX_HOME = home;
    delete process.env.CODEX_SESSIONS_PATH;
    delete process.env.CODEX_HUD_MAIN_PANE;

    const rootId = '01a00bd0-0000-4000-8000-000000000001';
    const childId = '01a00bd0-0000-4000-8000-000000000002';
    const rootRollout = writeRollout(home, {
      sessionId: rootId,
      cwd,
      modifiedAt: new Date(Date.now() - 5_000),
    });
    writeRollout(home, {
      sessionId: childId,
      cwd,
      parentThreadId: rootId,
      modifiedAt: new Date(),
    });

    const recent = findMostRecentRollout(1, cwd);
    assert.ok(recent, 'expected a root rollout');
    assert.equal(recent.path, rootRollout, 'fallback must ignore newer subagent rollouts');
  }

  {
    // Codex 0.159's app-server daemon writes every session's snapshot from its
    // own environment: the pane that started it, under a tmux server that may
    // since have restarted and handed that pane id to someone else.
    const home = makeTempCodexHome();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-cwd-'));
    process.env.CODEX_HOME = home;
    delete process.env.CODEX_SESSIONS_PATH;
    process.env.CODEX_HUD_MAIN_PANE = '%0';
    process.env.TMUX = '/tmp/tmux-1000/default,3441458,0';

    const ownThread = '01a0ede6-2db1-7b12-822e-e84172f5f720';
    const otherThread = '01a0ef3b-1e9c-70f1-b758-53dd30d67bbb';
    const ownRollout = writeRollout(home, { sessionId: ownThread, cwd, modifiedAt: new Date() });
    const otherCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-cwd-'));
    writeRollout(home, { sessionId: otherThread, cwd: otherCwd, modifiedAt: new Date() });
    writeSnapshot(home, otherThread, '%0', BigInt(Date.now()) * 1_000_000n, '/tmp/tmux-1000/default,3033953,0');

    const finder = new SessionFinder(cwd, undefined, new Date());
    const resolved = finder.check();
    assert.ok(resolved, 'expected the cwd fallback to resolve');
    assert.equal(resolved.path, ownRollout, 'a snapshot from an earlier tmux server must not bind this pane');

    writeSnapshot(home, otherThread, '%0', BigInt(Date.now() + 1) * 1_000_000n, '/tmp/tmux-1000/default,3441458,0');
    assert.equal(
      new SessionFinder(cwd, undefined, new Date()).check()?.sessionId,
      otherThread,
      'a snapshot from this tmux server still binds the pane'
    );
  }

  {
    // A HUD left running past the next midnight but one: its rollout is under
    // a day directory the shallow scan no longer covers.
    const home = makeTempCodexHome();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-cwd-'));
    process.env.CODEX_HOME = home;
    delete process.env.CODEX_SESSIONS_PATH;
    process.env.CODEX_HUD_MAIN_PANE = '%9';

    const sessionId = '01a0ef3b-1e9c-70f1-b758-53dd30d67bbc';
    const written = writeRollout(home, { sessionId, cwd, fileOffsetMinutes: -3 * 24 * 60 });
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const oldDir = path.join(
      home,
      'sessions',
      old.getFullYear().toString(),
      String(old.getMonth() + 1).padStart(2, '0'),
      String(old.getDate()).padStart(2, '0')
    );
    fs.mkdirSync(oldDir, { recursive: true });
    const rollout = path.join(oldDir, path.basename(written));
    fs.renameSync(written, rollout);

    const finder = new SessionFinder(cwd, undefined, new Date(old.getTime() - 5_000));
    assert.equal(finder.check()?.path, rollout, 'the deep scan finds the session');
    for (let i = 0; i < 3; i++) {
      finder.lastFallbackScanMs = 0;
      assert.equal(finder.check()?.path, rollout, 'the session stays bound between deep scans');
    }

    fs.rmSync(rollout);
    finder.lastFallbackScanMs = 0;
    finder.lastDeepScanMs = Date.now();
    assert.equal(finder.check(), null, 'a deleted rollout is let go');
  }
} finally {
  if (originalCodexHome === undefined) {
    delete process.env.CODEX_HOME;
  } else {
    process.env.CODEX_HOME = originalCodexHome;
  }

  if (originalMainPane === undefined) {
    delete process.env.CODEX_HUD_MAIN_PANE;
  } else {
    process.env.CODEX_HUD_MAIN_PANE = originalMainPane;
  }

  if (originalSessionsPath === undefined) {
    delete process.env.CODEX_SESSIONS_PATH;
  } else {
    process.env.CODEX_SESSIONS_PATH = originalSessionsPath;
  }

  if (originalTmux === undefined) {
    delete process.env.TMUX;
  } else {
    process.env.TMUX = originalTmux;
  }
}

console.log('test-session-finder-pane-binding: PASS');
