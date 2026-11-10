// Synthetic application-cold (distinct root/file) vs warm exact-file reads; no OS cache eviction.
import * as fs from 'node:fs';
import { tmpdir, hostname, platform, release, cpus } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
const startup = performance.now();
const { readRoleSummary, roleSummaryPath } = await import('../dist/roles/role-summary.js');
const { renderRoleSummary } = await import('../dist/render/role-summary.js');
const { readProcess } = await import('../dist/core/run/process.js');
const { saveJson } = await import('../dist/integrations/panel/receipt.js');
const importsMs = performance.now() - startup;
const n = 250;
function quantiles(values) {
  values.sort((a, b) => a - b);
  const q = (p) => values[Math.ceil(values.length * p) - 1];
  return { p50: q(0.5), p95: q(0.95), p99: q(0.99), max: values.at(-1) };
}
const dir = fs.mkdtempSync(join(tmpdir(), 'hud-role-cost-'));
try {
  const env = { ...process.env, HUD_HOME: join(dir, 'hud') };
  const beforeDomain = performance.now();
  const stamp = readProcess(process.pid).stamp;
  const domainStartupMs = performance.now() - beforeDomain;
  const doc = (root) => ({
    schema: 1,
    root,
    producer: { generation: 'cost-fixture', process: stamp },
    observedAt: Date.now(),
    coverage: 'partial',
    counts: { 'needs-you': 2, stalled: 1, 'awaiting-acceptance': 1, 'in-progress': 4, done: 9 },
    sources: [{ id: 'board', revision: 'fixture', at: null }],
  });
  const outputs = [];
  for (let run = 1; run <= 3; run++) {
    const coldRoots = Array.from({ length: n }, (_, i) => `cost-source/run-${run}-root-${i}`);
    for (const root of coldRoots) saveJson(roleSummaryPath(env, root), doc(root));
    const warmRoot = `cost-source/run-${run}-warm`;
    saveJson(roleSummaryPath(env, warmRoot), doc(warmRoot));
    const firstStarted = performance.now();
    const available = readRoleSummary(env, warmRoot);
    const firstReadMs = performance.now() - firstStarted;
    if (available.state !== 'available') throw Error('cost fixture unavailable');
    for (let i = 0; i < 50; i++) {
      readRoleSummary(env, warmRoot);
      renderRoleSummary(available, 80);
    }
    const heapBefore = process.memoryUsage().heapUsed;
    const cold = [],
      warm = [],
      render = [];
    let coldUnavailable = 0,
      warmUnavailable = 0;
    for (const root of coldRoots) {
      let start = performance.now();
      const coldResult = readRoleSummary(env, root);
      cold.push(performance.now() - start);
      if (coldResult.state !== 'available') coldUnavailable++;
      start = performance.now();
      const warmResult = readRoleSummary(env, warmRoot);
      warm.push(performance.now() - start);
      if (warmResult.state !== 'available') warmUnavailable++;
      start = performance.now();
      renderRoleSummary(available, 80);
      render.push(performance.now() - start);
    }
    outputs.push({
      run,
      n,
      firstReadMs,
      coldUnavailable,
      warmUnavailable,
      bytes: fs.statSync(roleSummaryPath(env, warmRoot)).size,
      heapDeltaBytes: process.memoryUsage().heapUsed - heapBefore,
      coldMs: quantiles(cold),
      warmMs: quantiles(warm),
      renderMs: quantiles(render),
    });
  }
  console.log(
    JSON.stringify(
      {
        host: hostname(),
        os: `${platform()} ${release()}`,
        cpu: cpus()[0].model,
        node: process.version,
        n,
        importsMs,
        domainStartupMs,
        startupNote:
          'module import and process-domain init separate; parent Node startup not included; cold = distinct exact-root file, not dropped kernel pages; heap delta includes GC, not allocation count',
        runs: outputs,
      },
      null,
      2
    )
  );
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
