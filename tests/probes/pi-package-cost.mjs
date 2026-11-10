/** Three-run passive tick and clean-artifact extension/bridge startup cost. No provider. */
import fs from 'node:fs';
import { tmpdir, hostname, cpus, release } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';
import { probeRelease } from '../fakes/pi-package-release.mjs';
import { createPiSegment } from '../../dist/harness/pi/segment.js';
import { roleSummaryPath } from '../../dist/roles/role-summary.js';
import { readProcess } from '../../dist/core/run/process.js';
import { saveJson } from '../../dist/integrations/panel/receipt.js';
const dir = fs.mkdtempSync(join(tmpdir(), 'hud-a5-cost-'));
try {
  const env = { ...process.env, HUD_HOME: join(dir, 'tick-hud') };
  fs.mkdirSync(env.HUD_HOME, { mode: 0o700 });
  const root = 'synthetic-source/main',
    now = Date.now();
  saveJson(roleSummaryPath(env, root), {
    schema: 1,
    root,
    producer: { generation: 'synthetic-cost', process: readProcess(process.pid).stamp },
    observedAt: now,
    coverage: 'complete',
    counts: { 'needs-you': 2, 'in-progress': 3, 'awaiting-acceptance': 1, stalled: 0, done: 9 },
    sources: [],
  });
  let callback,
    publications = 0;
  const ctx = {
    mode: 'tui',
    hasUI: true,
    ui: {
      setStatus() {
        publications++;
      },
    },
  };
  const segment = createPiSegment({
    env,
    now: () => now,
    schedule: (cb) => {
      callback = cb;
      return () => {
        callback = undefined;
      };
    },
  });
  segment.start(ctx, root, () => true);
  const stats = (a) => {
    a.sort((x, y) => x - y);
    return {
      n: a.length,
      p50: a[Math.ceil(a.length * 0.5) - 1],
      p95: a[Math.ceil(a.length * 0.95) - 1],
      p99: a[Math.ceil(a.length * 0.99) - 1],
      max: a.at(-1),
    };
  };
  const runs = [];
  for (let run = 0; run < 3; run++) {
    for (let i = 0; i < 50; i++) callback();
    const values = [];
    for (let i = 0; i < 250; i++) {
      const at = performance.now();
      callback();
      values.push(performance.now() - at);
    }
    runs.push(stats(values));
  }
  assert.equal(publications, 1);
  segment.stop();
  const artifact = probeRelease(dir),
    startup = [];
  for (let run = 0; run < 3; run++) {
    const base = join(dir, 'start-' + run),
      pkg = join(base, 'node_modules/@earendil-works/pi-coding-agent');
    fs.mkdirSync(join(pkg, 'dist/bundle'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      join(pkg, 'package.json'),
      JSON.stringify({
        name: '@earendil-works/pi-coding-agent',
        version: '1.5.1',
        type: 'module',
        bin: { pi: 'dist/bundle/cli.js' },
      })
    );
    fs.copyFileSync('tests/fixtures/pi-package-host.mjs', join(pkg, 'dist/bundle/cli.js'));
    for (const n of ['home', 'codex', 'agent', 'sessions']) fs.mkdirSync(join(base, n), { mode: 0o700 });
    fs.writeFileSync(
      join(base, 'sessions/synthetic-a.jsonl'),
      JSON.stringify({ type: 'session', version: 3, id: 'synthetic-a' }) + '\n'
    );
    const child = spawn(process.execPath, [join(pkg, 'dist/bundle/cli.js')], {
      env: {
        PATH: process.env.PATH,
        HOME: join(base, 'home'),
        HUD_HOME: artifact.hudHome,
        CODEX_HOME: join(base, 'codex'),
        PI_CODING_AGENT_DIR: join(base, 'agent'),
        HUD_TEST_REPO: resolve('.'),
        HUD_TEST_SESSIONS: join(base, 'sessions'),
        HUD_TEST_PACKAGE: artifact.piPackage,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (b) => (stderr += b));
    const ended = new Promise((r) => child.once('close', r));
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    const rows = [];
    const done = new Promise((resolve, reject) => {
      createInterface({ input: child.stdout }).on('line', (line) => {
        try {
          const v = JSON.parse(line);
          rows.push(v);
          if (v.ready)
            child.stdin.write(
              JSON.stringify({
                id: 1,
                kind: 'call',
                tool: 'hud_roster',
                callId: 'cost',
                args: { action: 'show' },
                measure: true,
              }) + '\n'
            );
          else {
            if (v.error) reject(Error(v.error));
            else resolve(v.result);
            child.stdin.end();
          }
        } catch (e) {
          reject(e);
        }
      });
      child.once('close', () => {
        if (rows.length < 2) reject(Error(stderr || 'cost_host_exited'));
      });
    });
    try {
      const result = await done;
      assert.equal(result.result.details.ok, true);
      startup.push({
        extensionLoadMs: rows[0].loadMs,
        bridgeInitializeAndFirstRosterMs: result.startupMs,
        bridgeRssKiB: result.rssKiB,
      });
    } finally {
      child.stdin.end();
      await ended;
      clearTimeout(timer);
    }
  }
  console.log(
    JSON.stringify(
      {
        host: { hostname: hostname(), kernel: release(), cpu: cpus()[0]?.model, node: process.version },
        tick: {
          unit: 'ms',
          method:
            'performance.now; sync exact cache read + pure render + changed-text check + timer rearm; 50 warmups/run, nearest-rank percentiles; application-warm, not OS-cache eviction',
          runs,
          publications,
          bytes: fs.statSync(roleSummaryPath(env, root)).size,
        },
        startup: {
          method:
            '3 fresh synthetic installed-pi host processes load actual materialized entry and clean-built release; extension import/factory separate from lazy bridge initialize + first read-only roster; RSS /proc child VmRSS after call; not full pi startup RSS',
          samples: startup,
        },
      },
      null,
      2
    )
  );
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
