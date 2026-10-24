// Usage: node tests/performance/correctness.mjs /baseline/build /optimized/build
// Differential behavior checks, no performance thresholds.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [baseline, optimized] = process.argv.slice(2);
const load = (build, file) => import(pathToFileURL(path.join(build, file)));
const base = await load(baseline, 'collectors/subagent-tree.js');
const next = await load(optimized, 'collectors/subagent-tree.js');
assert.equal(typeof next.buildSubagentTreeYielding, 'function');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-perf-correctness-'));
const now = Date.parse('2026-10-24T12:00:00Z');
const meta = (id, parent) =>
  JSON.stringify({
    type: 'session_meta',
    timestamp: new Date(now).toISOString(),
    payload: { id, cwd: home, ...(parent ? { parent_thread_id: parent, agent_path: `/root/${id}` } : {}) },
  }) + '\n';
const event = (payload) =>
  JSON.stringify({ type: 'event_msg', timestamp: new Date(now).toISOString(), payload }) + '\n';
const message = (text) =>
  JSON.stringify({
    type: 'response_item',
    timestamp: new Date(now).toISOString(),
    payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text }] },
  }) + '\n';
let files = [];
function write(id, parent, extra = '') {
  const file = path.join(home, id + '.jsonl');
  fs.writeFileSync(file, meta(id, parent) + extra);
  files.push(file);
  return file;
}
function listed() {
  return files.map((file) => {
    const s = fs.statSync(file);
    return {
      path: file,
      sessionId: path.basename(file, '.jsonl'),
      timestamp: new Date(now),
      size: s.size,
      modifiedAt: s.mtime,
      ino: s.ino,
    };
  });
}
async function compare(label) {
  const listing = listed();
  const expected = base.buildSubagentTree('root', [], 3, now, listing);
  const actual = await next.buildSubagentTreeYielding('root', [], 3, now, listing);
  assert.deepEqual(actual, expected, label);
}
try {
  write('root');
  const parent = write('parent', 'root', event({ type: 'task_started', turn_id: 'one' }));
  const child = write(
    'child',
    'parent',
    event({ type: 'task_started', turn_id: 'two' }) +
      message('Synthetic result') +
      event({ type: 'task_complete', last_agent_message: 'Synthetic result' })
  );
  write('other');
  write('unrelated', 'other', event({ type: 'task_started', turn_id: 'other' }));
  write('cycle-a', 'cycle-b');
  write('cycle-b', 'cycle-a');
  write('review', 'root', event({ type: 'task_started', turn_id: 'review' }));
  await compare('initial scan, nesting, disconnected cycle and other root');
  fs.appendFileSync(parent, message('Parent synthetic result') + event({ type: 'task_complete' }));
  await compare('append completion');
  fs.appendFileSync(child, '{"type":"event_msg","payload":');
  await compare('partial trailing line');
  fs.appendFileSync(child, '{"type":"task_started","turn_id":"next"}}\n');
  await compare('completed trailing line');
  fs.writeFileSync(child, meta('replacement', 'root') + event({ type: 'task_started', turn_id: 'replacement' }));
  await compare('rewrite and parent relink');
  fs.writeFileSync(parent + '.new', meta('parent', 'root') + event({ type: 'task_started', turn_id: 'rotated' }));
  fs.renameSync(parent + '.new', parent);
  await compare('inode rotation');
  files = files.filter((f) => f !== child);
  fs.unlinkSync(child);
  await compare('removed rollout');
  assert.deepEqual(
    await next.buildSubagentTreeYielding('root', [], 3, now, []),
    base.buildSubagentTree('root', [], 3, now, []),
    'explicit empty list'
  );
} finally {
  base.resetSubagentLinkCache();
  next.resetSubagentLinkCache();
  fs.rmSync(home, { recursive: true, force: true });
}

const monitors = await Promise.all(
  [baseline, optimized].map(async (build) => ({
    monitor: await load(build, 'render/monitor.js'),
    config: await load(build, 'render/hud-config.js'),
    language: await load(build, 'render/i18n.js'),
  }))
);
function clean(frame) {
  return {
    lines: frame.lines,
    controls: frame.controls,
    state: frame.state,
    panes: frame.panes.map((p) => ({ ...p, rows: p.rows.map(({ counts, ...r }) => r) })),
  };
}
let cases = 0;
for (const size of [4, 256])
  for (const width of [16, 32, 100])
    for (const height of [8, 40])
      for (const lang of ['en', 'zh'])
        for (const theme of ['none', 'mocha']) {
          const nodes = Array.from({ length: size }, (_, i) => ({
            id: `agent-${i}`,
            name: `agent_${i}`,
            agentPath: `/root/agent_${i}`,
            status: i % 3 === 0 ? 'completed' : 'running',
            depth: 1,
            children: [],
            startedAt: new Date(now - 600_000 + i * 1000),
            turnStartedAt: new Date(now - 120_000),
            statusAt: new Date(now - 60_000),
            lastEventAt: new Date(now - 10_000),
            model: 'gpt-6.1-sol',
            effort: 'high',
          }));
          const tree = { rootId: 'root', nodes, totalCount: size, updatedAt: new Date(now) };
          const states = monitors.map(({ monitor, config, language }) => {
            config.setDisplayConfig({ ...config.displayConfig(), theme });
            language.setLanguage(lang);
            return { ...monitor.initialMonitorState(), style: 'rich' };
          });
          for (let pass = 0; pass < 4; pass++) {
            if (pass === 2) {
              nodes[0].name = 'renamed';
              nodes[1].status = 'error';
              nodes[1].peers = { '/root/agent_0': 4 };
            }
            const frames = monitors.map(({ monitor }, i) =>
              monitor.renderMonitor({
                tree,
                state: states[i],
                width,
                height,
                nowMs: now + pass * 1000,
                linkNames: pass !== 3,
              })
            );
            assert.deepEqual(
              clean(frames[1]),
              clean(frames[0]),
              `${size}/${width}/${height}/${lang}/${theme}/pass${pass}`
            );
            frames.forEach((f, i) => {
              states[i] = f.state;
              states[i].tree.selectedId = nodes[Math.min(pass + 1, size - 1)].id;
              states[i].scroll.agents += 3;
            });
            cases++;
          }
        }
console.log(
  `collector differential cases passed; ${cases} render frames matched, including controls, scroll state and pane rows`
);
