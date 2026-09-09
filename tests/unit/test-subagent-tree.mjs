import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildSubagentTree, resetSubagentLinkCache } from '../../dist/collectors/subagent-tree.js';
import { RolloutParser } from '../../dist/collectors/rollout.js';
import { visualLength } from '../../dist/render/colors.js';
import { stripAnsi } from '../../dist/render/colors.js';
import { renderHud } from '../../dist/render/header.js';
import { renderSubagentTreePage } from '../../dist/render/subagent-tree-view.js';
import { commFrame, renderSubagentChip } from '../../dist/render/subagent-chip.js';

function todayParts() {
  const now = new Date();
  return {
    year: String(now.getFullYear()),
    month: String(now.getMonth() + 1).padStart(2, '0'),
    day: String(now.getDate()).padStart(2, '0'),
    stamp: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}T00-00-00`,
  };
}

function writeRollout(home, { id, parentId, nickname, model, effort }) {
  const { year, month, day, stamp } = todayParts();
  const dir = path.join(home, 'sessions', year, month, day);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `rollout-${stamp}-${id}.jsonl`);
  const spawn = parentId
    ? {
        parent_thread_id: parentId,
        depth: 1,
        agent_nickname: nickname,
        model,
        effort,
      }
    : undefined;
  const source = spawn ? { subagent: { thread_spawn: spawn } } : 'cli';
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
  const childPath = writeRollout(home, { id: child, parentId: root, nickname: 'Gauss' });
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

  // Chips surface each agent's model and reasoning effort from session_meta.
  const modeled = '01a00bd0-0000-4000-8000-000000000005';
  writeRollout(home, { id: modeled, parentId: root, nickname: 'Oracle', model: 'gpt-5.3', effort: 'xhigh' });
  const withModel = buildSubagentTree(root, [], 3, Date.now());
  const oracleNode = withModel.nodes.find((node) => node.name === 'Oracle');
  assert.ok(oracleNode, 'newly spawned agent should appear in the tree');
  assert.equal(oracleNode.model, 'gpt-5.3', 'node should carry the spawned model');
  assert.equal(oracleNode.effort, 'xhigh', 'node should carry the spawned effort');

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

  assert.equal(lines.length, 3, 'header plus one row per active level');
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
  assert.doesNotMatch(lines[1], /Scout/, 'depth-2 agents move to their own row');
  const gaussAt = lines[1].indexOf('Gauss');
  const singerAt = lines[1].indexOf('Singer');
  assert.ok(singerAt > gaussAt, 'Singer should sit to the right of Gauss');
  assert.ok(
    singerAt - gaussAt < 40,
    `two lineages should sit compactly side by side, not stretch across the row (gap=${singerAt - gaussAt})`
  );
  assert.match(lines[2], /└─ .*Scout/, 'depth-2 row carries the tree connector');
  assert.ok(
    lines[2].indexOf('Scout') < singerAt,
    'the child region aligns under its own depth-1 ancestor'
  );

  const hudDataFor = (tree) => ({
    config: {},
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
    subagentTree: tree,
  });

  // A lone agent must not reserve phantom column slots; the row ends at its chip.
  const home2 = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-tree-lone-'));
  process.env.CODEX_HOME = home2;
  const loneRoot = '02a00bd0-0000-4000-8000-000000000001';
  const loneChild = '02a00bd0-0000-4000-8000-000000000002';
  writeRollout(home2, { id: loneRoot, parentId: null, nickname: null });
  writeRollout(home2, { id: loneChild, parentId: loneRoot, nickname: 'Solo' });
  const loneRow = renderHud(
    hudDataFor(buildSubagentTree(loneRoot, [], 3, Date.now())),
    { width: 160, showDetails: true }
  ).map(stripAnsi);
  process.env.CODEX_HOME = home;
  const soloLine = loneRow[1] ?? '';
  assert.match(soloLine, /Solo/);
  assert.ok(
    soloLine.length < 40,
    `lone agent row should end at its chip, got ${soloLine.length} chars`
  );

  // Model/effort chips: render a tree whose nodes carry model info.
  const modelRow = renderHud(hudDataFor(withModel), { width: 160, showDetails: true }).map(stripAnsi);
  assert.match(modelRow[1] ?? '', /gpt-5\.3·xhigh/, 'chip should show model and effort');

  // Fresh main<->agent traffic pulses the chip with the animated ⇄/⇆ marker.
  const commTree = buildSubagentTree(root, [
    { id: child, name: 'Gauss', status: 'running', lastActivityAt: new Date() },
  ], 3, Date.now());
  const commRow = renderHud(hudDataFor(commTree), { width: 160, showDetails: true }).map(stripAnsi);
  const commLine = commRow[1] ?? '';
  const marker = commLine.match(/[⇄⇆]/)?.[0];
  assert.ok(marker !== undefined, 'recent traffic should render the ⇄/⇆ marker');
  assert.ok(commLine.slice(commLine.indexOf(marker)).includes('Gauss'), 'the marker should sit on the active agent');

  // Only the traffic marker animates: the traffic glyph flips on a fixed
  // cadence, while a running chip is byte-identical at any point in time.
  assert.equal(commFrame(0), '⇄');
  assert.equal(commFrame(250), '⇆');
  assert.equal(commFrame(500), '⇄', 'traffic marker cycles every 2 frames');
  const runningNode = { id: child, name: 'Gauss', status: 'running', depth: 1, children: [] };
  assert.equal(
    renderSubagentChip(runningNode, { nowMs: 1000 }),
    renderSubagentChip(runningNode, { nowMs: 999_137_250 }),
    'running chips must be static (icon + color only, no animation)'
  );

  // Active-level rows: depth cap at 3, inactive branches hidden, completed
  // ancestors kept as lineage anchors, same depth always on the same row.
  const mk = (id, name, status, children = []) => ({ id, name, status, depth: 0, children });
  const synthetic = {
    rootId: 'root',
    nodes: [
      mk('a1', 'Gauss', 'running', [
        mk('d2', 'Scout', 'running', [mk('d3', 'Tracker', 'running', [mk('d4', 'Deep4', 'running')])]),
        mk('x2', 'Idle', 'completed'),
        mk('d2b', 'Digger', 'running'),
      ]),
      mk('a2', 'Singer', 'completed', [mk('c2', 'Echo', 'running')]),
      mk('a3', 'Hibern', 'completed', [mk('c3', 'AlsoIdle', 'completed')]),
    ],
    totalCount: 8,
    updatedAt: new Date(),
  };
  const capLines = renderHud(hudDataFor(synthetic), { width: 160, showDetails: true }).map(stripAnsi);
  assert.equal(capLines.length, 4, 'header plus three active levels');
  assert.match(capLines[1], /Gauss/);
  assert.match(capLines[1], /Singer/, 'completed root stays as lineage anchor for its active child');
  assert.doesNotMatch(capLines[1], /Hibern/, 'fully inactive roots are hidden');
  assert.doesNotMatch(capLines.join('\n'), /Deep4/, 'display depth is capped at 3 levels');
  assert.match(capLines[2], /Scout/);
  assert.match(capLines[2], /Digger/);
  assert.match(capLines[2], /Echo/, 'same-level agents share one row');
  assert.doesNotMatch(capLines[2], /Idle/, 'inactive children are hidden');
  assert.match(capLines[3], /Tracker/);
  assert.match(capLines[3], /│\s+└─ .*Tracker/, 'deeper rows keep tree connectors');
  const scoutAt = capLines[2].indexOf('Scout');
  const diggerAt = capLines[2].indexOf('Digger');
  const echoAt = capLines[2].indexOf('Echo');
  assert.ok(scoutAt < diggerAt && diggerAt < echoAt, 'entries order by lineage on the shared row');

  // Ownership ambiguity: A→[B→X, C, D] and A→[B, C→X, D] must not render
  // identically — the grandchild aligns inside its immediate parent's slice.
  const structA = {
    rootId: 'r',
    nodes: [mk('a1', 'A', 'running', [
      mk('b', 'B', 'running', [mk('x', 'X', 'running')]),
      mk('c', 'C', 'running'),
      mk('d', 'D', 'running'),
    ])],
    totalCount: 5,
    updatedAt: new Date(),
  };
  const structB = {
    rootId: 'r',
    nodes: [mk('a1', 'A', 'running', [
      mk('b', 'B', 'running'),
      mk('c', 'C', 'running', [mk('x', 'X', 'running')]),
      mk('d', 'D', 'running'),
    ])],
    totalCount: 5,
    updatedAt: new Date(),
  };
  const rowsA = renderHud(hudDataFor(structA), { width: 160, showDetails: true }).map(stripAnsi);
  const rowsB = renderHud(hudDataFor(structB), { width: 160, showDetails: true }).map(stripAnsi);
  assert.notDeepEqual(rowsA, rowsB, 'different parent structures must render differently');
  const xRowA = rowsA.find((line) => line.includes('X'));
  const xRowB = rowsB.find((line) => line.includes('X'));
  assert.ok(xRowA && xRowB, 'both structures show X');
  const parentBAt = rowsA[2].indexOf('B');
  const parentCAt = rowsB[2].indexOf('C');
  assert.ok(
    Math.abs(xRowA.indexOf('X') - parentBAt) <= 4,
    "X sits inside B's slice in structure A"
  );
  assert.ok(
    Math.abs(xRowB.indexOf('X') - parentCAt) <= 4,
    "X sits inside C's slice in structure B"
  );

  const pageLines = renderSubagentTreePage(withSiblings).map(stripAnsi);
  const page = pageLines.join('\n');
  assert.match(page, /Subagent tree/);
  assert.match(page, /● main/, 'popup should anchor the tree at the main session');
  assert.match(page, /· 01a00bd0/, 'popup should show the shortened session id on its own line');
  assert.match(page, /Gauss/);
  assert.match(page, /Singer/);
  assert.match(page, /Scout/);
  assert.match(page, /└─|├─/);
  assert.match(page, /⇄ traffic/, 'popup should explain the traffic marker');
  const scoutLine = pageLines.find((line) => line.includes('Scout'));
  assert.ok(scoutLine, 'grandchild line exists');
  assert.match(scoutLine, /│\s+└─ .*Scout/, 'nested agents are indented under their parent');
  const gaussHead = pageLines.find((line) => /[├└]─ .*Gauss/.test(line));
  assert.ok(gaussHead, 'Gauss sits on the tree connector line');
  assert.doesNotMatch(gaussHead, /running|completed|starting|error/, 'status is stacked under the name');
  assert.doesNotMatch(gaussHead, /gpt-/, 'model is stacked under the name');
  const gaussHeadAt = pageLines.indexOf(gaussHead);
  assert.match(pageLines[gaussHeadAt + 1] ?? '', /running|completed|starting|error/, 'status uses the next row');
  const oraclePage = renderSubagentTreePage(withModel).map(stripAnsi);
  const oracleHead = oraclePage.find((line) => /[├└]─ .*Oracle/.test(line));
  assert.ok(oracleHead, 'Oracle sits on the tree connector line');
  assert.doesNotMatch(oracleHead, /gpt-5\.3/, 'model does not share the name row');
  assert.ok(
    oraclePage.some((line) => line.includes('gpt-5.3·xhigh')),
    'model and effort still appear on a stacked detail row'
  );

  // Side-panel mode: every line clamps to the pane width, measured in
  // terminal columns so CJK nicknames cannot overflow.
  const narrowWidth = 24;
  const narrow = renderSubagentTreePage(withSiblings, narrowWidth).map(stripAnsi);
  assert.ok(narrow.length > 0, 'panel render produces lines');
  for (const line of narrow) {
    assert.ok(
      visualLength(line) <= narrowWidth,
      `panel line must fit the pane width (${visualLength(line)} > ${narrowWidth}): ${line}`
    );
  }
  const cjkTree = buildSubagentTree(root, [
    { id: child, name: '中文测试昵称', status: 'running' },
  ], 3, Date.now());
  const cjkPanel = renderSubagentTreePage(cjkTree, 20).map((line) => line).map(visualLength);
  for (const width of cjkPanel) {
    assert.ok(width <= 20, `CJK panel line must fit 20 columns, got ${width}`);
  }

  // Link cache: appending bytes must not invalidate the parsed first line,
  // while a shrink (truncation/rotation rewrite) must re-peek it.
  resetSubagentLinkCache();
  buildSubagentTree(root, [], 3, Date.now()); // warm the cache
  fs.appendFileSync(childPath, `${JSON.stringify({ type: 'event_msg' })}\n`);
  const afterAppend = buildSubagentTree(root, [], 3, Date.now());
  assert.equal(afterAppend.nodes[0].name, 'Gauss', 'append keeps the cached session_meta');
  const renamed = {
    timestamp: new Date().toISOString(),
    type: 'session_meta',
    payload: {
      id: child,
      parent_thread_id: root,
      agent_nickname: 'Renamed',
      timestamp: new Date().toISOString(),
      source: 'cli',
    },
  };
  fs.writeFileSync(childPath, `${JSON.stringify(renamed)}\n`);
  const afterTruncate = buildSubagentTree(root, [], 3, Date.now());
  assert.equal(
    afterTruncate.nodes[0].name,
    'Renamed',
    'a shrunk rollout file must be re-peeked'
  );
  resetSubagentLinkCache();

  // Negative cache: a first peek that fails (empty or incomplete first line)
  // must recover as soon as the file gains bytes; it may only survive while
  // the stat signature is untouched.
  const negId = '01a00bd0-0000-4000-8000-000000000010';
  const negPath = writeRollout(home, { id: negId, parentId: root, nickname: 'LateBorn' });
  fs.writeFileSync(negPath, '');
  buildSubagentTree(root, [], 3, Date.now()); // warm with a failed peek
  fs.writeFileSync(
    negPath,
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      type: 'session_meta',
      payload: {
        id: negId,
        parent_thread_id: root,
        agent_nickname: 'LateBorn',
        timestamp: new Date().toISOString(),
        source: 'cli',
      },
    })}\n`
  );
  const negTree = buildSubagentTree(root, [], 3, Date.now());
  assert.ok(
    negTree.nodes.some((node) => node.name === 'LateBorn'),
    'negative cache must recover when the file gains its first line'
  );
  resetSubagentLinkCache();

  // Shrink detection must compare against the latest observed size, not the
  // size at first cache time: grow, then truncate-and-rewrite.
  const shrinkId = '01a00bd0-0000-4000-8000-000000000011';
  const shrinkPath = writeRollout(home, { id: shrinkId, parentId: root, nickname: 'Grower' });
  buildSubagentTree(root, [], 3, Date.now());
  fs.appendFileSync(shrinkPath, 'x'.repeat(2000) + '\n');
  buildSubagentTree(root, [], 3, Date.now()); // baseline moves to the grown size
  writeRollout(home, { id: shrinkId, parentId: root, nickname: 'Reborn' }); // much smaller
  const shrinkTree = buildSubagentTree(root, [], 3, Date.now());
  assert.ok(
    shrinkTree.nodes.some((node) => node.name === 'Reborn'),
    'a shrink after appends must still re-peek'
  );
  resetSubagentLinkCache();

  // Same-size rewrite with a newer mtime must not be mistaken for a no-op.
  const sameSizeId = '01a00bd0-0000-4000-8000-000000000012';
  const samePath = writeRollout(home, { id: sameSizeId, parentId: root, nickname: 'Alpha' });
  buildSubagentTree(root, [], 3, Date.now());
  writeRollout(home, { id: sameSizeId, parentId: root, nickname: 'AlpHa' }); // equal byte length
  const laterTime = new Date(Date.now() + 5000);
  fs.utimesSync(samePath, laterTime, laterTime);
  const sameTree = buildSubagentTree(root, [], 3, Date.now());
  assert.ok(
    sameTree.nodes.some((node) => node.name === 'AlpHa'),
    'same-size rewrite with an advanced mtime must re-peek'
  );
  resetSubagentLinkCache();

  // Truly same-signature rewrites (size, mtime, inode all identical) are
  // invisible to stat; the scheduled revalidation must catch them once the
  // entry verification ages past the interval.
  const home3 = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-stealth-'));
  process.env.CODEX_HOME = home3;
  const stealthRoot = '03a00bd0-0000-4000-8000-000000000001';
  const stealthId = '03a00bd0-0000-4000-8000-000000000002';
  writeRollout(home3, { id: stealthRoot, parentId: null, nickname: null });
  const stealthPath = writeRollout(home3, { id: stealthId, parentId: stealthRoot, nickname: 'GhostA' });
  buildSubagentTree(stealthRoot, [], 3, Date.now()); // verifies content now
  const beforeStats = fs.statSync(stealthPath);
  writeRollout(home3, { id: stealthId, parentId: stealthRoot, nickname: 'GhostB' }); // equal byte length
  assert.equal(fs.statSync(stealthPath).size, beforeStats.size, 'stealth rewrite keeps the size');
  fs.utimesSync(stealthPath, beforeStats.atime, beforeStats.mtime); // restore the mtime too
  const immediate = buildSubagentTree(stealthRoot, [], 3, Date.now());
  assert.ok(
    immediate.nodes.some((node) => node.name === 'GhostA'),
    'an unchanged signature keeps the cached link before revalidation comes due'
  );
  const revalidated = buildSubagentTree(stealthRoot, [], 3, Date.now() + 31_000);
  process.env.CODEX_HOME = home;
  assert.ok(
    revalidated.nodes.some((node) => node.name === 'GhostB'),
    'scheduled revalidation catches same-signature rewrites'
  );
  resetSubagentLinkCache();

  // Metadata merged from an earlier incremental batch survives later batches
  // whose events do not carry model/effort again.
  const mergeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-merge-'));
  const mergePath = path.join(mergeDir, 'rollout-2026-09-05T00-00-00-merge.jsonl');
  const collabEvent = (tool, extra = {}) =>
    JSON.stringify({
      timestamp: new Date().toISOString(),
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        item: {
          type: 'CollabAgentToolCall',
          tool,
          receiver_agents: [{ thread_id: 'ag-1', agent_nickname: 'Gauss' }],
          ...extra,
        },
      },
    });
  fs.writeFileSync(mergePath, `${collabEvent('spawn_agent', { model: 'gpt-5.3', effort: 'xhigh' })}\n`);
  const parser = new RolloutParser(10);
  parser.setRolloutPath(mergePath);
  const firstBatch = await parser.parse();
  assert.equal(firstBatch?.subagents[0]?.model, 'gpt-5.3', 'spawn batch carries model');
  fs.appendFileSync(mergePath, `${collabEvent('wait')}\n`);
  const secondBatch = await parser.parse();
  assert.equal(
    secondBatch?.subagents[0]?.model,
    'gpt-5.3',
    'model must survive incremental batches'
  );
  assert.equal(
    secondBatch?.subagents[0]?.effort,
    'xhigh',
    'effort must survive incremental batches'
  );

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
