import test from 'node:test';
import assert from 'node:assert/strict';
import { statSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { r5Fixture, FIXED_R5_NOW } from '../fixtures/r5-jobs.js';

test('R5 fixture stamps every producer file with its injected clock, including atomic replacements', (t) => {
  const f = r5Fixture(t);
  const check = (file: string) => assert.equal(statSync(file).mtimeMs, f.now(), file);
  const produce = () => {
    const a = f.association(1);
    // No invented producer timestamp: physical evidence dates are pinned instead.
    assert.equal(a.created_at, undefined);
    check(join(f.home, 'assoc', `${a.job}.json`));
    f.dispatch(a);
    check(join(f.home, 'jobs', a.job, 'receipt.json'));
    check(join(f.home, 'jobs', a.job, 'STATUS.json'));
    f.status(a, 'working', {}, 'review-1');
    check(join(f.home, 'jobs', a.job, '.dispatch', 'review-1', 'STATUS.json'));
    f.put(join(f.home, 'jobs', a.job, 'report.md'), 'Synthetic report');
    check(join(f.home, 'jobs', a.job, 'report.md'));
    for (const name of ['q1.md', 'q1.answer.md']) {
      const file = join(f.home, 'workspace', 'tmp', 'tasks', 'SYN', 'qa', name);
      f.put(file, 'Synthetic QA');
      check(file);
    }
    const web = f.association(2, {
      role: 'jev',
      backend: {
        id: 'synthetic-web',
        executor: 'jev',
        harness: null,
        model: 'synthetic-model',
        effort: null,
        env_profile: null,
        recipe: null,
      },
    });
    f.jev(web);
    check(join(f.home, 'jev-runtime', 'jobs', `runtime-${web.job}.json`));
    check(join(f.home, 'jev-runtime', 'runtime.json'));
  };
  assert.equal(f.now(), FIXED_R5_NOW);
  produce();
  f.advance(120_000);
  produce();
});

for (const days of [2, 400])
  test(`R5 panel evidence and restored summaries ignore wall time at fixture +${days} days`, async () => {
    const home = mkdtempSync(join(tmpdir(), 'hud-r5-clock-'));
    const env: NodeJS.ProcessEnv & { HOME: string; CODEX_HOME: string } = {
      ...process.env,
      HOME: join(home, 'home'),
      CODEX_HOME: join(home, 'codex'),
    };
    for (const key of [
      'NO_COLOR',
      'FORCE_COLOR',
      'HUD_HOME',
      'HUD_SETTINGS_PATH',
      'CODEX_HUD_SETTINGS_PATH',
      'NODE_TEST_CONTEXT',
    ])
      delete env[key];
    mkdirSync(env.HOME);
    mkdirSync(env.CODEX_HOME);
    // Preload before any tested module. Only wall time moves: real timers and
    // monotonic budgets still run, and filesystem mtimes are NOT mocked.
    const preload = `
      const NativeDate = Date, epoch = ${FIXED_R5_NOW + days * 86_400_000}, start = performance.now();
      const now = () => Math.trunc(epoch + performance.now() - start);
      globalThis.Date = new Proxy(NativeDate, {
        construct(target, args) { return Reflect.construct(target, args.length ? args : [now()]); },
        apply() { return new NativeDate(now()).toString(); },
        get(target, key, receiver) { return key === 'now' ? now : Reflect.get(target, key, receiver); }
      });
      if (Math.abs(Date.now() - epoch) > 10_000 || Math.abs(new Date().getTime() - epoch) > 10_000)
        throw new Error('wall clock preload did not apply');
    `;
    // Inherit the same clock in CLI children, but never an ambient preload.
    env.NODE_OPTIONS = `--import=data:text/javascript,${encodeURIComponent(preload)}`;
    const files = ['workboard-fix4', 'workboard-visual-facts', 'r5-job-observation', 'r5-production-summary'].map(
      (name) => fileURLToPath(new URL(`./${name}.test.js`, import.meta.url))
    );
    try {
      const { stdout } = await promisify(execFile)(process.execPath, ['--test', '--test-reporter=tap', ...files], {
        env,
        timeout: 120_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      assert.match(stdout, /# fail 0\b/);
      assert.match(stdout, /ok \d+ - fix4: clicking the painted Home activation hint/);
      assert.match(stdout, /ok \d+ - orchestrator visual 1:/);
      assert.match(stdout, /ok \d+ - R5 real SmallModel\/ModelRuntimeStore restore/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
