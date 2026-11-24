import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  collectGitStatus,
  GIT_STATUS_CACHE_LIMIT,
  gitStatusCacheSize,
  resetGitStatusCache,
} from '../../dist/collectors/git.js';
import {
  AGENT_CONTEXT_CACHE_LIMIT,
  agentContextCacheSize,
  readAgentTokens,
  resetAgentContextCache,
} from '../../dist/collectors/agent-context.js';
import {
  TOKEN_RATE_MAX_OPEN_TOOLS,
  TokenRateTracker,
} from '../../dist/collectors/token-rate.js';
import {
  MAX_CREATED_JOBS,
  MAX_LAND_TASKS,
  MAX_MCP_TASKS,
  pruneCreatedJobs,
  pruneLandTasks,
  pruneTasks,
  rememberCreatedJob,
  rememberLandTask,
} from '../../dist/mcp/task-bounds.js';
import {
  recordWarning,
  rememberClosedTab,
  WATCH_CLOSED_TABS_LIMIT,
  WATCH_WARNINGS_LIMIT,
} from '../../dist/runtime/watch-runtime.js';
import { ProjectOverviews } from '../../dist/collectors/project-visits.js';
import {
  cacheGet,
  cachePut,
  SESSION_FINDER_CACHE_LIMIT,
} from '../../dist/collectors/session-finder.js';

const EMPTY_BOARD = { lanes: [], workers: [], updatedAt: 1_700_000_000_000 };

test('collectGitStatus bounds its per-cwd cache with LRU eviction', async (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'hud-git-cache-'));
  t.after(() => {
    resetGitStatusCache();
    fs.rmSync(root, { recursive: true, force: true });
  });
  resetGitStatusCache();

  const total = GIT_STATUS_CACHE_LIMIT + 15;
  const dirs = [];
  for (let i = 0; i < total; i++) {
    const d = join(root, `dir-${i}`);
    fs.mkdirSync(d);
    dirs.push(d);
    const status = await collectGitStatus(d);
    assert.equal(status.isGitRepo, false);
  }
  assert.equal(gitStatusCacheSize(), GIT_STATUS_CACHE_LIMIT);

  // Re-reading a retained directory promotes it without growing the cache.
  await collectGitStatus(dirs[total - 1]);
  assert.equal(gitStatusCacheSize(), GIT_STATUS_CACHE_LIMIT);
});

test('readAgentTokens bounds its per-rolloutPath cache with LRU eviction', async (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'hud-agent-ctx-cache-'));
  t.after(() => {
    resetAgentContextCache();
    fs.rmSync(root, { recursive: true, force: true });
  });
  resetAgentContextCache();

  const writeRollout = (name, tokens) => {
    const file = join(root, `${name}.jsonl`);
    const line = JSON.stringify({
      timestamp: '2026-01-01T00:00:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: { input_tokens: tokens, output_tokens: 10 },
          total_token_usage: { input_tokens: tokens, output_tokens: 10 },
          model_context_window: 200_000,
        },
      },
    });
    fs.writeFileSync(file, line + '\n');
    return file;
  };

  const hot = writeRollout('hot', 1234);
  const first = await readAgentTokens(hot);
  assert.equal(first.spent?.input, 1234);

  const extra = AGENT_CONTEXT_CACHE_LIMIT + 20;
  for (let i = 0; i < extra; i++) {
    const file = writeRollout(`agent-${i}`, 100 + i);
    await readAgentTokens(file);
    // Keep touching hot so LRU keeps it in cache while cold files churn past the cap.
    if (i % 32 === 0) await readAgentTokens(hot);
  }
  assert.equal(agentContextCacheSize(), AGENT_CONTEXT_CACHE_LIMIT);

  // Hot entry should still be cached and readable with its original values.
  const again = await readAgentTokens(hot);
  assert.equal(again.spent?.input, 1234);
  assert.equal(agentContextCacheSize(), AGENT_CONTEXT_CACHE_LIMIT);
});

test('TokenRateTracker bounds open tool call IDs within a turn', () => {
  const tracker = new TokenRateTracker();
  const base = 1_700_000_000_000;
  tracker.startTurn(new Date(base));

  const total = TOKEN_RATE_MAX_OPEN_TOOLS + 100;
  for (let i = 0; i < total; i++) {
    tracker.startTool(`call-${i}`, new Date(base + i + 1));
  }
  assert.equal(tracker.openToolCount, TOKEN_RATE_MAX_OPEN_TOOLS);

  // Oldest orphaned call was evicted, so endTool is a no-op; newest still closes.
  tracker.endTool('call-0', new Date(base + total + 10));
  assert.equal(tracker.openToolCount, TOKEN_RATE_MAX_OPEN_TOOLS);

  tracker.endTool(`call-${total - 1}`, new Date(base + total + 20));
  assert.equal(tracker.openToolCount, TOKEN_RATE_MAX_OPEN_TOOLS - 1);

  const cloned = tracker.clone();
  assert.equal(cloned.openToolCount, TOKEN_RATE_MAX_OPEN_TOOLS - 1);
});

test('hud-mcp task-bounds caps createdJobs, landTasks and tasks while dropping settled/archived first', () => {
  // 1. createdJobs drops archived/missing jobs first and caps at MAX_CREATED_JOBS.
  const created = new Set();
  const live = new Set();
  for (let i = 0; i < MAX_CREATED_JOBS + 80; i++) {
    const id = `j${String(i).padStart(16, '0')}`;
    if (i >= 50) live.add(id);
    rememberCreatedJob(created, id, (candidate) => live.has(candidate));
  }
  assert.ok(created.size <= MAX_CREATED_JOBS);
  assert.equal(created.has(`j${String(0).padStart(16, '0')}`), false);
  assert.equal(created.has(`j${String(MAX_CREATED_JOBS + 79).padStart(16, '0')}`), true);

  // Explicit prune removes jobs archived since last add.
  live.clear();
  pruneCreatedJobs(created, (candidate) => live.has(candidate));
  assert.equal(created.size, 0);

  // 2. landTasks drops settled/missing flows before active ones and caps at MAX_LAND_TASKS.
  const lands = new Set();
  const activeFlows = new Set(['f0000000000000001']);
  rememberLandTask(lands, 'f0000000000000001', (id) => activeFlows.has(id));
  for (let i = 2; i <= MAX_LAND_TASKS + 40; i++) {
    const flow = `f${String(i).padStart(16, '0')}`;
    rememberLandTask(lands, flow, (id) => activeFlows.has(id));
  }
  assert.equal(lands.size, MAX_LAND_TASKS);
  assert.equal(lands.has('f0000000000000001'), true, 'active land flow survives eviction of settled flows');
  pruneLandTasks(lands, () => false, 10);
  assert.equal(lands.size, 10);

  // 3. tasks evicts expired first, then settled before working, and caps at MAX_MCP_TASKS.
  const tasks = new Map();
  const evicted = [];
  const now = 1_700_000_000_000;
  // Seed one expired task, one active working task, and >MAX_MCP_TASKS settled tasks.
  tasks.set('expired-1', { id: 'expired-1', expiresAt: now - 1, view: { status: 'working' } });
  tasks.set('working-1', { id: 'working-1', expiresAt: now + 60_000, view: { status: 'working' } });
  for (let i = 0; i < MAX_MCP_TASKS + 25; i++) {
    tasks.set(`done-${i}`, { id: `done-${i}`, expiresAt: now + 60_000, view: { status: 'completed' } });
  }
  pruneTasks(tasks, now, (task) => evicted.push(task.id));
  assert.equal(tasks.size, MAX_MCP_TASKS);
  assert.equal(tasks.has('expired-1'), false);
  assert.equal(tasks.has('working-1'), true, 'working task is kept over settled tasks');
  assert.equal(evicted[0], 'expired-1');
  assert.equal(evicted.length, 27);
});

test('watch closedTabs and warnings stay bounded under churn', () => {
  const tabs = new Set();
  for (let i = 0; i < WATCH_CLOSED_TABS_LIMIT + 100; i++) {
    rememberClosedTab(tabs, `tab-${i}`);
  }
  assert.equal(tabs.size, WATCH_CLOSED_TABS_LIMIT);
  assert.equal(tabs.has('tab-0'), false);
  assert.equal(tabs.has(`tab-${WATCH_CLOSED_TABS_LIMIT + 99}`), true);

  // Re-adding an existing tab promotes it so it survives the next eviction.
  const survivor = `tab-100`;
  rememberClosedTab(tabs, survivor);
  rememberClosedTab(tabs, 'tab-extra');
  assert.equal(tabs.size, WATCH_CLOSED_TABS_LIMIT);
  assert.equal(tabs.has(survivor), true);
  assert.equal(tabs.has('tab-101'), false);

  // warnings: throttles duplicates within 60s, caps at WATCH_WARNINGS_LIMIT, sweeps expired.
  const warns = new Map();
  const base = 1_700_000_000_000;
  assert.equal(recordWarning(warns, 'kind-0', base), true);
  assert.equal(recordWarning(warns, 'kind-0', base + 10_000), false);
  for (let i = 1; i < WATCH_WARNINGS_LIMIT + 80; i++) {
    assert.equal(recordWarning(warns, `kind-${i}`, base + i), true);
  }
  assert.equal(warns.size, WATCH_WARNINGS_LIMIT);
  assert.equal(warns.has('kind-0'), false);

  // Once 60s pass, expired entries are swept on the next warning beyond limit or can re-fire.
  const later = base + 120_000;
  assert.equal(recordWarning(warns, 'kind-fresh', later), true);
  assert.equal(warns.size, 1);
  assert.equal(warns.has('kind-fresh'), true);
});

test('ProjectOverviews.pool releases a project collector when its root leaves the list', async () => {
  const created = [];
  const overviews = new ProjectOverviews((root) => {
    created.push(root);
    return {
      liveCwds: () => [],
      collect: async () => ({
        tickets: [],
        waiting: [],
        docs: [],
        control: [],
        roles: [],
        harnesses: [],
        models: { pi: [], cli: {}, bro: {} },
        agents: [],
        keys: [],
        browser: false,
        roleCount: 0,
        editing: [],
        ladder: { ids: [] },
        slices: [],
        ledger: [],
        active: [],
        next: [],
        summary: '',
        counts: { working: 0, blocked: 0, try: 0, todo: 0, accepted: 0, dropped: 0 },
      }),
    };
  }, '/synthetic/lookup');

  await overviews.read(['/synthetic/a', '/synthetic/b'], EMPTY_BOARD, 1000);
  await overviews.read(['/synthetic/a', '/synthetic/b'], EMPTY_BOARD, 2000);
  assert.deepEqual(created, ['/synthetic/lookup', '/synthetic/a', '/synthetic/b']);

  // Drop /synthetic/b from the list, then re-add it: a new collector must be constructed.
  await overviews.read(['/synthetic/a'], EMPTY_BOARD, 3000);
  await overviews.read(['/synthetic/a', '/synthetic/b'], EMPTY_BOARD, 4000);
  assert.deepEqual(created, ['/synthetic/lookup', '/synthetic/a', '/synthetic/b', '/synthetic/b']);
});

test('session-finder cachePut/cacheGet uses LRU eviction instead of FIFO', () => {
  const map = new Map();
  cachePut(map, 'a', 1, 3);
  cachePut(map, 'b', 2, 3);
  cachePut(map, 'c', 3, 3);

  // Access 'a' so it becomes most-recently-used; 'b' is now least-recently-used.
  assert.equal(cacheGet(map, 'a'), 1);
  cachePut(map, 'd', 4, 3);
  assert.equal(map.size, 3);
  assert.equal(map.has('a'), true, 'hot key survives LRU eviction');
  assert.equal(map.has('b'), false, 'least-recently-used key is evicted');

  // Updating an existing key at capacity refreshes it without evicting another key.
  cachePut(map, 'c', 30, 3);
  assert.equal(map.size, 3);
  assert.deepEqual([...map.entries()], [['a', 1], ['d', 4], ['c', 30]]);

  // Churn past SESSION_FINDER_CACHE_LIMIT while keeping a hot key alive.
  const big = new Map();
  cachePut(big, 'hot', 'keep');
  for (let i = 0; i < SESSION_FINDER_CACHE_LIMIT + 50; i++) {
    cachePut(big, `cold-${i}`, i);
    if (i % 500 === 0) assert.equal(cacheGet(big, 'hot'), 'keep');
  }
  assert.equal(big.size, SESSION_FINDER_CACHE_LIMIT);
  assert.equal(big.has('hot'), true);
});
