/**
 * The panel's rollout list stats new, growing and priority files, plus two
 * quiet ones. The sync list still stats every file and does not touch that
 * cache. An explicit empty list tells the tree build not to scan.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { findRolloutsInDays, findRolloutsInDaysYielding, resetRolloutStatCache } from '../../src/collectors/session-finder.js';
import { NO_GIT, sameGit } from '../../src/collectors/hud-status.js';
import { buildSubagentTree, resetSubagentLinkCache } from '../../src/collectors/subagent-tree.js';

const pad = (n: number) => String(n).padStart(2, '0');

function dayDir(root: string): string {
  const now = new Date();
  const dir = path.join(root, String(now.getFullYear()), pad(now.getMonth() + 1), pad(now.getDate()));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function rollout(dir: string, id: string, body: string): string {
  const file = path.join(dir, `rollout-2026-10-14T00-00-00-${id}.jsonl`);
  fs.writeFileSync(file, body);
  return file;
}

function withSessions<T>(run: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-rollout-budget-'));
  const previous = process.env.CODEX_SESSIONS_PATH;
  process.env.CODEX_SESSIONS_PATH = dir;
  resetRolloutStatCache();
  resetSubagentLinkCache();
  return Promise.resolve()
    .then(() => run(dir))
    .finally(() => {
      if (previous === undefined) delete process.env.CODEX_SESSIONS_PATH;
      else process.env.CODEX_SESSIONS_PATH = previous;
      resetRolloutStatCache();
      resetSubagentLinkCache();
      fs.rmSync(dir, { recursive: true, force: true });
    });
}

test('sameGit treats the placeholder and a missing repo as their own values', () => {
  assert.equal(sameGit(NO_GIT, { ...NO_GIT }), true);
  assert.equal(sameGit(NO_GIT, { ...NO_GIT, branch: 'main', isGitRepo: true }), false);
  assert.equal(sameGit({ ...NO_GIT, repo: '' }, { ...NO_GIT }), true);
  assert.equal(sameGit({ ...NO_GIT, repo: 'demo' }, NO_GIT), false);
});


test('the yielding finder restats two quiet files, the sync finder ignores that cache, and an empty list does not scan', async () => {
  await withSessions(async (root) => {
    const dir = dayDir(root);
    const body = '{"type":"session_meta"}\n';
    const extra = 'x'.repeat(40);
    const ids = ['aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee2',
      'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee3', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee4',
      'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee5'];
    const files = ids.map(id => rollout(dir, id, body));
    const first = await findRolloutsInDaysYielding(0);
    assert.equal(first.length, 5);
    assert.ok(first.every(file => file.size === Buffer.byteLength(body)));
    for (const file of files) fs.appendFileSync(file, extra);
    const fresh = findRolloutsInDays(0);
    assert.ok(fresh.every(file => file.size === Buffer.byteLength(body + extra)), 'the sync list stats every file');
    const second = await findRolloutsInDaysYielding(0);
    const grown = second.filter(file => file.size === Buffer.byteLength(body + extra));
    assert.equal(grown.length, 2);
    const stale = second.find(file => file.size === Buffer.byteLength(body));
    assert.ok(stale);
    const priority = await findRolloutsInDaysYielding(0, new Set([stale.path]));
    assert.equal(priority.find(file => file.path === stale.path)?.size, Buffer.byteLength(body + extra));
    const created = rollout(dir, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee6', body);
    const third = await findRolloutsInDaysYielding(0);
    assert.ok(third.some(file => file.path === created));

    const now = new Date();
    const child = path.join(dir, 'rollout-2026-10-14T00-00-01-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee10.jsonl');
    fs.writeFileSync(child, `${JSON.stringify({ type: 'session_meta', payload: { id: 'child', parent_thread_id: 'root', timestamp: now.toISOString() } })}\n`);
    resetSubagentLinkCache();
    assert.equal(buildSubagentTree('root', [], 3, now.getTime(), []).nodes.length, 0);
    resetSubagentLinkCache();
    assert.equal(buildSubagentTree('root', [], 3, now.getTime()).nodes.length, 1);
  });
});
