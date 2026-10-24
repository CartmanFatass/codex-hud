// Usage: node tests/performance/collect.mjs /absolute/build [agents=256] [KB=256]
// Synthetic, temporary CODEX_HOME only. No wall-time assertions.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';

const [build, rawAgents = '256', rawKb = '256'] = process.argv.slice(2);
if (!build) throw new Error('pass an absolute build directory');
const agents = Number(rawAgents),
  kb = Number(rawKb);
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-perf-collect-'));
process.env.CODEX_HOME = home;
delete process.env.CODEX_SESSIONS_PATH;
const { findRolloutsInDaysYielding } = await import(pathToFileURL(path.join(build, 'collectors/session-finder.js')));
const treeModule = await import(pathToFileURL(path.join(build, 'collectors/subagent-tree.js')));
const buildTree = treeModule.buildSubagentTreeYielding ?? treeModule.buildSubagentTree;
const date = new Date(),
  pad = (n) => String(n).padStart(2, '0');
const day = path.join(home, 'sessions', String(date.getFullYear()), pad(date.getMonth() + 1), pad(date.getDate()));
fs.mkdirSync(day, { recursive: true });
const label = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T00-00-00`;
const id = (n) => `019d0000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const row = (payload) => JSON.stringify({ type: 'event_msg', timestamp: date.toISOString(), payload }) + '\n';
const paths = [];
for (let i = 0; i <= agents; i++) {
  const file = path.join(day, `rollout-${label}-${id(i)}.jsonl`);
  const meta = { id: id(i), cwd: home, ...(i ? { parent_thread_id: id(0), agent_path: `/root/agent_${i}` } : {}) };
  const filler = row({ type: 'benchmark_padding', text: 'x'.repeat(1000) });
  fs.writeFileSync(
    file,
    JSON.stringify({ type: 'session_meta', payload: meta }) +
      '\n' +
      filler.repeat(kb) +
      row({ type: 'task_started', turn_id: `t${i}` })
  );
  paths.push(file);
}
const summarize = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    avg: values.reduce((a, b) => a + b, 0) / values.length,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    max: sorted.at(-1),
  };
};
const loop = monitorEventLoopDelay({ resolution: 1 });
loop.enable();
const lags = [];
let expected = performance.now() + 5;
const timer = setInterval(() => {
  const now = performance.now();
  lags.push(Math.max(0, now - expected));
  expected = now + 5;
}, 5);
const priority = new Set(paths);
const list = [],
  tree = [];
const cpuStart = process.cpuUsage(),
  wallStart = performance.now();
try {
  await new Promise((r) => setTimeout(r, 10));
  let at = performance.now();
  let files = await findRolloutsInDaysYielding(3, priority);
  const coldList = performance.now() - at;
  at = performance.now();
  const result = await buildTree(id(0), [], 3, Date.now(), files);
  const coldTree = performance.now() - at;
  if (result.totalCount !== agents) throw new Error(`expected ${agents} agents, got ${result.totalCount}`);
  for (let pass = 0; pass < 30; pass++) {
    // A realistic small append in every active agent, plus a final newline.
    for (const file of paths)
      fs.appendFileSync(file, row({ type: 'agent_message', message: `Synthetic update ${pass}` }));
    at = performance.now();
    files = await findRolloutsInDaysYielding(3, priority);
    list.push(performance.now() - at);
    at = performance.now();
    await buildTree(id(0), [], 3, Date.now(), files);
    tree.push(performance.now() - at);
    await new Promise((r) => setTimeout(r, 5));
  }
  await new Promise((r) => setTimeout(r, 10));
  const cpu = process.cpuUsage(cpuStart),
    wall = performance.now() - wallStart;
  console.log(
    JSON.stringify(
      {
        agents,
        kb,
        cold: { list: coldList, tree: coldTree },
        list: summarize(list),
        tree: summarize(tree),
        timerLagMs: summarize(lags),
        eventLoopMs: { p95: loop.percentile(95) / 1e6, max: loop.max / 1e6 },
        cpuMs: (cpu.user + cpu.system) / 1000,
        wallMs: wall,
        cpuPercent: ((cpu.user + cpu.system) / 1000 / wall) * 100,
      },
      null,
      2
    )
  );
} finally {
  clearInterval(timer);
  loop.disable();
  fs.rmSync(home, { recursive: true, force: true });
}
