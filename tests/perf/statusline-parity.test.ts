import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir, hostname, loadavg } from 'node:os';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import { resolve, isAbsolute } from 'node:path';
import { collectAndRenderParity } from '../../src/statusline-parity/collect.js';
import { collectTranscript, TRANSCRIPT_CHUNK } from '../../src/statusline-parity/transcript.js';
import { loadParitySettings } from '../../src/statusline-parity/settings.js';
import { NOW, OWNER_CONFIG, parityFixture } from '../fixtures/claude-hud-parity/fixture.js';

test('statusline parity: warm 20 MiB transcript / 3000 tracked files p95 <= 30 ms', () => {
  const home = fs.mkdtempSync(join(tmpdir(), 'hud-parity-perf-'));
  try {
    const f = parityFixture(home, 'dirty-git');
    f.input.session_id = 'synthetic-session';
    const line =
      JSON.stringify({
        type: 'user',
        timestamp: '2026-01-02T11:58:00Z',
        message: { content: 'Synthetic '.repeat(40) },
      }) + '\n';
    const fd = fs.openSync(f.file, 'a');
    try {
      for (let n = 0; n < Math.ceil((20 * 1024 * 1024) / Buffer.byteLength(line)); n++) fs.writeSync(fd, line);
    } finally {
      fs.closeSync(fd);
    }
    fs.mkdirSync(join(f.cwd, 'files'));
    for (let i = 0; i < 3000; i++) fs.writeFileSync(join(f.cwd, 'files', String(i)), String(i));
    f.git(['-c', 'core.fsmonitor=false', 'add', 'files']);
    f.git(['commit', '-m', 'synthetic files']);
    let tick = NOW;
    const render = () => collectAndRenderParity(f.input, 120, loadParitySettings(f.env)!, f.env, tick);
    const cold = performance.now();
    render();
    const coldMs = performance.now() - cold;
    let state = collectTranscript(f.file, f.env),
      catchup = 1;
    assert.ok(state.bytesRead <= TRANSCRIPT_CHUNK);
    while (state.pendingHistory && catchup < 40) {
      state = collectTranscript(f.file, f.env);
      catchup++;
    }
    assert.equal(state.pendingHistory, false);
    assert.equal(collectTranscript(f.file, f.env).bytesRead, 0);
    const result: object[] = [];
    for (let run = 0; run < 3; run++) {
      for (let i = 0; i < 10; i++) render();
      const times: number[] = [];
      for (let i = 0; i < 100; i++) {
        // Every sample is a real 5-second refresh, including the dirty-worktree TTL probe.
        tick += 5000;
        const start = performance.now();
        const output = render();
        times.push(performance.now() - start);
        assert.match(output, /git:/);
      }
      times.sort((a, b) => a - b);
      const percentile = (p: number) => times[Math.ceil(times.length * p) - 1];
      const row = {
        run: run + 1,
        n: times.length,
        p50: percentile(0.5),
        p95: percentile(0.95),
        p99: percentile(0.99),
        max: times.at(-1),
      };
      result.push(row);
      console.log(
        'statusline-parity perf ' +
          JSON.stringify({
            host: hostname(),
            node: process.version,
            load: loadavg(),
            coldMs,
            catchup,
            bytes: fs.statSync(f.file).size,
            files: 3000,
            ...row,
          })
      );
      assert.ok(row.p95 <= 30, `warm p95 ${row.p95.toFixed(3)} > 30 ms`);
    }
    assert.equal(result.length, 3);
    const reference = process.env.CLAUDE_HUD_PARITY_REFERENCE;
    if (reference) {
      assert.ok(isAbsolute(reference), 'reference is an explicit absolute installed-build path, never discovery');
      const dir = join(f.claude, 'plugins/claude-hud');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(join(dir, 'config.json'), JSON.stringify(OWNER_CONFIG));
      const input = JSON.stringify(f.input);
      const sample = (entry: string) => {
        const start = performance.now();
        const r = spawnSync(process.execPath, [entry], {
          cwd: f.cwd,
          env: { ...f.env, COLUMNS: '124' },
          input,
          encoding: 'utf8',
          timeout: 5000,
        });
        const ms = performance.now() - start;
        assert.ifError(r.error);
        assert.equal(r.status, 0, r.stderr);
        assert.ok(r.stdout.includes('Opus 4.5'));
        return ms;
      };
      const hud = resolve('bin/hud-statusline');
      for (let i = 0; i < 5; i++) {
        sample(hud);
        sample(reference);
      }
      for (let run = 0; run < 3; run++) {
        const ours: number[] = [],
          upstream: number[] = [];
        for (let i = 0; i < 30; i++) {
          // Alternate order to avoid giving either process the consistently hotter filesystem.
          if (i % 2) {
            upstream.push(sample(reference));
            ours.push(sample(hud));
          } else {
            ours.push(sample(hud));
            upstream.push(sample(reference));
          }
        }
        const stats = (v: number[]) => {
          v.sort((a, b) => a - b);
          return { p50: v[14], p95: v[28], p99: v[29], max: v[29] };
        };
        const h = stats(ours),
          c = stats(upstream);
        console.log(
          'statusline-parity process ' +
            JSON.stringify({
              host: hostname(),
              node: process.version,
              run: run + 1,
              n: 30,
              hud: h,
              claudeHud080: c,
              metric: 'spawn-to-exit; no forward argv; warm persistent caches',
            })
        );
        assert.ok(h.p95 <= c.p95, `HUD process p95 ${h.p95} exceeds claude-hud 0.8.0 ${c.p95}`);
      }
    } else
      console.log(
        'SKIP side-by-side process reference: set CLAUDE_HUD_PARITY_REFERENCE to an explicit installed 0.8.0 dist/index.js'
      );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
