import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildSubagentTree } from '../../dist/collectors/subagent-tree.js';
import { stripAnsi } from '../../dist/render/colors.js';
import { renderHud } from '../../dist/render/header.js';
import { renderSubagentTreePage } from '../../dist/render/subagent-tree-view.js';

function todayParts() {
  const now = new Date();
  return {
    year: String(now.getFullYear()),
    month: String(now.getMonth() + 1).padStart(2, '0'),
    day: String(now.getDate()).padStart(2, '0'),
    stamp: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}T00-00-00`,
  };
}

function writeRollout(home, { id, parentId, nickname }) {
  const { year, month, day, stamp } = todayParts();
  const dir = path.join(home, 'sessions', year, month, day);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `rollout-${stamp}-${id}.jsonl`);
  const source = parentId
    ? {
        subagent: {
          thread_spawn: {
            parent_thread_id: parentId,
            depth: parentId ? 1 : 0,
            agent_nickname: nickname,
          },
        },
      }
    : 'cli';
  fs.writeFileSync(
    filePath,
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      type: 'session_meta',
      payload: {
        id,
        parent_thread_id: parentId,
        agent_nickname: nickname,
        timestamp: new Date().toISOString(),
        cwd: '/tmp',
        originator: 'codex-tui',
        cli_version: '0.147.0',
        source,
        thread_source: parentId ? 'subagent' : 'user',
      },
    })}\n`
  );
  return filePath;
}

const originalHome = process.env.CODEX_HOME;
const originalSessions = process.env.CODEX_SESSIONS_PATH;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-tree-'));

try {
  process.env.CODEX_HOME = home;
  delete process.env.CODEX_SESSIONS_PATH;

  const root = '01a00bd0-0000-4000-8000-000000000001';
  const child = '01a00bd0-0000-4000-8000-000000000002';
  const grand = '01a00bd0-0000-4000-8000-000000000003';
  writeRollout(home, { id: root, parentId: null, nickname: null });
  writeRollout(home, { id: child, parentId: root, nickname: 'Gauss' });
  writeRollout(home, { id: grand, parentId: child, nickname: 'Scout' });

  const tree = buildSubagentTree(root, [], 3, Date.now());
  assert.equal(tree.totalCount, 2, 'tree should include child and grandchild');
  assert.equal(tree.nodes.length, 1, 'root should have one first-level child');
  assert.equal(tree.nodes[0].name, 'Gauss');
  assert.equal(tree.nodes[0].children.length, 1);
  assert.equal(tree.nodes[0].children[0].name, 'Scout');

  const sibling = '01a00bd0-0000-4000-8000-000000000004';
  writeRollout(home, { id: sibling, parentId: root, nickname: 'Singer' });
  const withSiblings = buildSubagentTree(root, [], 3, Date.now());
  assert.equal(withSiblings.nodes.length, 2, 'two first-level children should share depth 1');

  const lines = renderHud(
    {
      config: {
        approval_policy: 'on-request',
        sandbox_mode: 'workspace-write',
      },
      git: {
        branch: null,
        isDirty: false,
        isGitRepo: false,
        ahead: 0,
        behind: 0,
        modified: 0,
        added: 0,
        deleted: 0,
        untracked: 0,
      },
      project: {
        cwd: '/tmp',
        projectName: 'tmp',
        agentsMdCount: 0,
        hasCodexDir: false,
        instructionsMdCount: 0,
        rulesCount: 0,
        mcpCount: 0,
        configsCount: 0,
        extensionsCount: 0,
        workMode: 'development',
      },
      sessionStart: new Date(),
      displayMode: 'single',
      contextUsage: {
        used: 50200,
        total: 128000,
        percent: 39,
        inputTokens: 35000,
        outputTokens: 15200,
        cachedTokens: 5000,
        compactCount: 2,
      },
      subagentTree: withSiblings,
    },
    { width: 160, showDetails: true }
  ).map(stripAnsi);

  assert.equal(lines.length, 2, 'collapsed mode shows header plus first-level row only');
  assert.match(lines[0], /Ctx/);
  assert.match(lines[0], /\(50\.2K\/128\.0K\)/);
  assert.match(lines[0], /↻2/);
  assert.match(lines[0], /Plan/);
  assert.doesNotMatch(lines[0], /\[.*\]/, 'header should not show model or effort');
  assert.match(lines[0], /mode:/);
  assert.match(lines[0], /Approval:/);
  assert.match(lines[0], /Sandbox:/);
  assert.doesNotMatch(lines[0], /\/tmp(?:\/|$)/);
  assert.doesNotMatch(lines[0], /~/);
  assert.match(lines[1], /Gauss/);
  assert.match(lines[1], /Singer/);
  assert.match(lines[1], /▾/, 'collapsed first-level parents hint that a tree exists');
  assert.doesNotMatch(lines.join('\n'), /Scout/, 'collapsed mode hides nested subagents');
  const gaussAt = lines[1].indexOf('Gauss');
  const singerAt = lines[1].indexOf('Singer');
  assert.ok(singerAt > gaussAt, 'Singer should sit to the right of Gauss');
  assert.ok(
    singerAt - gaussAt < 40,
    `two trees should use 6-slot columns, not stretch across the row (gap=${singerAt - gaussAt})`
  );

  const page = renderSubagentTreePage(withSiblings).map(stripAnsi).join('\n');
  assert.match(page, /Subagent tree/);
  assert.match(page, /Gauss/);
  assert.match(page, /Singer/);
  assert.match(page, /Scout/);
  assert.match(page, /└─|├─/);

  const headerOnly = renderHud(
    {
      config: { model: 'gpt-5.3-codex-spark' },
      git: {
        branch: null,
        isDirty: false,
        isGitRepo: false,
        ahead: 0,
        behind: 0,
        modified: 0,
        added: 0,
        deleted: 0,
        untracked: 0,
      },
      project: {
        cwd: '/tmp',
        projectName: 'tmp',
        agentsMdCount: 0,
        hasCodexDir: false,
        instructionsMdCount: 0,
        rulesCount: 0,
        mcpCount: 0,
        configsCount: 0,
        extensionsCount: 0,
        workMode: 'development',
      },
      sessionStart: new Date(),
      displayMode: 'single',
      subagentTree: { rootId: root, nodes: [], totalCount: 0, updatedAt: new Date() },
    },
    { width: 120, showDetails: true }
  ).map(stripAnsi);
  assert.equal(headerOnly.length, 1, 'no subagents should keep a single header row');
  assert.match(headerOnly[0], /Ctx/);
  assert.doesNotMatch(headerOnly[0], /gpt-5\.3-codex-spark/);
  assert.doesNotMatch(headerOnly[0], /\b(xhigh|high|medium|low)\b/);
  assert.match(headerOnly[0], /Plan/);
} finally {
  if (originalHome === undefined) {
    delete process.env.CODEX_HOME;
  } else {
    process.env.CODEX_HOME = originalHome;
  }
  if (originalSessions === undefined) {
    delete process.env.CODEX_SESSIONS_PATH;
  } else {
    process.env.CODEX_SESSIONS_PATH = originalSessions;
  }
}

console.log('test-subagent-tree: PASS');
