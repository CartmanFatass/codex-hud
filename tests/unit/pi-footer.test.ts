import test from 'node:test';
import assert from 'node:assert/strict';
import fsMutable, { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parityFixture, parityHost } from '../fixtures/pi-footer.js';
import { PI_QUOTA_WIDTHS } from '../fixtures/bar-widths.js';
import { HUD_STATUS_KEY } from '../../dist/harness/pi/segment.js';
import { createP10kFooter } from '../../dist/harness/pi/p10k-footer.js';
import type { FooterComponent } from '../../dist/harness/pi/footer-host.js';
import { stripAnsi, visualWidth } from '../../dist/render/colors.js';
import { expProxyPath, readExpConfig, saveExpEdit } from '../../dist/collectors/exp-store.js';

function fixture(t: test.TestContext, settings?: unknown, env?: Record<string, string>) {
  const f = parityFixture({ name: 'ribbon', width: 160, settings, env });
  t.after(() => f.dispose());
  f.statuses.clear();
  return f;
}

test('editor top ribbon fits three widths, dropping whole segments from the right', (t) => {
  const f = fixture(t);
  const wide = stripAnsi(f.top(160));
  assert.match(wide, /Synthetic session title.*cache 73%.*tok 43K.*123\.4 t\/s.*TTFT 520ms.*\$0\.420.*4:02/);
  assert.ok(wide.endsWith('\ue0b0─'), 'one closing dash after the fading arrow');
  const medium = stripAnsi(f.top(80));
  assert.match(medium, /Synthetic session title.*cache 73%.*tok 43K.*123\.4 t\/s/);
  assert.doesNotMatch(medium, /\$|4:02/, 'rightmost cost and time drop first');
  assert.equal(stripAnsi(f.top(5)), '─────', 'no ribbon below its six-column minimum');
  for (const width of [0, 1, 5, 6, 7, 16, 40, 80, 160]) assert.equal(visualWidth(f.top(width)), width);
});

test('band config and commands toggle all seven fields, keeping context on the bottom', async (t) => {
  const f = fixture(t, { band: { session: false, tokens: false, cost: false } });
  assert.doesNotMatch(stripAnsi(f.top()), /Synthetic session title|tok |\$/);
  await f.controller.command('band off', f.ctx);
  assert.doesNotMatch(stripAnsi(f.top()), /\ue0b6|cache|t\/s|TTFT/);
  assert.match(stripAnsi(f.render()[0]!), /42%\/200K/);
  await f.controller.command('band on', f.ctx);
  assert.match(stripAnsi(f.top()), /Synthetic session title.*tok 43K.*\$0\.420/);
  const config = JSON.parse(readFileSync(join(f.ctx.sessionManager.getCwd(), '../../config.json'), 'utf8')).piFooter;
  assert.deepEqual(Object.keys(config.band).sort(), [
    'cache',
    'context',
    'cost',
    'session',
    'time',
    'tokens',
    'tps',
    'ttft',
  ]);
  assert.equal(config.band.context, true);
  for (const id of ['session', 'cache', 'tokens', 'tps', 'ttft', 'cost', 'time']) assert.equal(config.band[id], true);
  await f.controller.command('off context', f.ctx);
  assert.doesNotMatch(stripAnsi(f.render()[0]!), /42%/);
  await f.controller.command('on context', f.ctx);
  assert.match(stripAnsi(f.render()[0]!), /42%/);
  let listing = '';
  f.ctx.ui.notify = (text) => {
    listing = text;
  };
  await f.controller.command('list', f.ctx);
  assert.match(listing.split('\n')[0]!, /context/);
  assert.doesNotMatch(listing.split('\n')[1]!, /context/);
});

test('cost is in the ribbon only; bottom stays one shared bar with context', (t) => {
  const f = fixture(t);
  assert.match(stripAnsi(f.top()), /\$0\.420/);
  const bottom = f.render();
  assert.equal(bottom.length, 1);
  assert.match(stripAnsi(bottom[0]!), /synthetic-model.*42%\/200K.*example.*MCP 2.*skills 3/);
  assert.doesNotMatch(stripAnsi(bottom[0]!), /\$|cache |tok |t\/s|TTFT/);
});

const quotaNow = Date.parse('2026-11-19T10:30:00Z');
const quotaGolden = JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures/bar-widths.json'), 'utf8'));

function quotaFixture(t: test.TestContext) {
  t.mock.timers.enable({ apis: ['Date'], now: quotaNow });
  const f = fixture(t, undefined, { NO_COLOR: '1' });
  const home = join(f.ctx.sessionManager.getCwd(), '../..');
  writeFileSync(join(home, 'hud-settings.json'), JSON.stringify({ experiments: true }), { mode: 0o600 });
  f.ctx.model!.id = 'gpt-6.2-sol';
  f.ctx.getContextUsage = () => ({ percent: 72, contextWindow: 200_000 });
  f.bus.get('pi-lens/analysis-complete')?.({ filePath: 'synthetic.ts', diagnostics: [] });
  const expectQuota = (scene: string) => {
    for (const width of PI_QUOTA_WIDTHS)
      assert.deepEqual(f.render(width), quotaGolden[width][scene], `${scene} at ${width}`);
  };
  return { f, home, expectQuota };
}

test('the actual subscription footer matches S1 at 144, 120, 80 and 36 with pi’s short model name', async (t) => {
  const { f, home, expectQuota } = quotaFixture(t);
  // Dotfiles managers commonly keep the preferences in a separate directory.
  const settings = join(home, 'hud-settings.json'), target = join(home, 'dotfiles', 'settings');
  mkdirSync(join(home, 'dotfiles'));
  fsMutable.renameSync(settings, target);
  writeFileSync(target, '{"experiments":false}');
  fsMutable.symlinkSync(target, settings);
  const profile = join(home, '.codex');
  const min = 60_000;
  mkdirSync(profile);
  writeFileSync(join(profile, 'config.toml'), '# synthetic profile\n');
  saveExpEdit(home, { field: 'binding', value: profile }, quotaNow, { HOME: home, CODEX_HOME: profile });
  saveExpEdit(home, { field: 'proxy-enabled', value: true }, quotaNow);
  writeFileSync(
    expProxyPath(home),
    JSON.stringify({
      profile,
      bindingVersion: readExpConfig(home).proxy.bindingVersion,
      secondary: { usedPercent: 43, windowDurationMins: 10_080, resetsAt: (quotaNow + 52 * 60 * min) / 1000 },
      observedAtMs: quotaNow,
      // Retain the last snapshot but do not start a subprocess in this rendering fixture.
      error: 'not_logged_in',
      failures: 1,
      nextAttemptMs: null,
    }),
    { mode: 0o600 }
  );
  f.ctx.modelRegistry = { isUsingOAuth: () => true };
  f.controller.update();
  assert.doesNotMatch(f.render(120)[0]!, /≈43%/);
  await sleep(20); // Allow the initial off observation to finish.
  writeFileSync(target, '{"experiments":true}');
  for (let attempt = 0; attempt < 100 && !f.render(120)[0]?.includes('≈43%'); attempt++) await sleep(5);
  assert.match(f.render(120)[0]!, /^◎ 6\.2-sol high .*≈43%/);
  const direct = (percent: number, resetInMinutes: number) => {
    f.controller.requestStarted(f.ctx);
    f.controller.requestWindows(
      f.ctx,
      {
        headers: {
          'x-codex-primary-used-percent': String(percent),
          'x-codex-primary-window-minutes': '300',
          'x-codex-primary-reset-at': String((Date.now() + resetInMinutes * min) / 1000),
        },
      },
      false
    );
  };
  direct(11, 192);
  expectQuota('pi-quota');
  direct(92, 41);
  expectQuota('pi-quota-high');
  direct(92, 0);
  expectQuota('pi-quota-pending');
  direct(11, 192);
  t.mock.timers.tick(31 * min);
  expectQuota('pi-quota-stale');
});

test('the API footer keeps uncalibrated text, then meters the grant and redraws days to renewal', async (t) => {
  const { f, home, expectQuota } = quotaFixture(t);
  const now = quotaNow;
  f.ctx.model!.provider = 'oapi';
  const account = 'openai-api';
  saveExpEdit(home, { account, field: 'zone', value: 'UTC' }, now);
  saveExpEdit(home, { account, field: 'grant', value: 49_360_000 }, now);
  saveExpEdit(home, { account, field: 'grant-enabled', value: true }, now);
  f.controller.update();
  assert.match(f.render()[0]!, /API uncalibrated/);
  assert.doesNotMatch(f.render()[0]!, /API [█░]|\x1b/);
  await saveExpEdit(home, { account, field: 'calibration', value: 12_340_000 }, now);
  // A scheduled change to the configured grant is for the next cycle, not this meter.
  saveExpEdit(home, { account, field: 'grant', value: 100_000_000 }, now);
  f.controller.update();
  expectQuota('pi-api');
  t.mock.timers.setTime(now + 86_400_000);
  assert.match(f.render(120)[0]!, /API ████████░░ ≈\$12\.34 \(11d\)/);
  assert.match(f.render(36)[0]!, /API ≈\$12\.34$/);
  t.mock.timers.setTime(now + 9 * 86_400_000);
  await saveExpEdit(home, { account, field: 'calibration', value: 2_050_000 }, Date.now());
  f.controller.update();
  expectQuota('pi-api-high');
});

test('other extension statuses survive at 100 columns alongside lens, MCP and skills', async (t) => {
  const f = fixture(t);
  f.ctx.model!.id = 'gemini-x';
  f.controller.update();
  f.bus.get('pi-lens/analysis-complete')?.({ filePath: 'synthetic.ts', diagnostics: [] });
  f.statuses.set('antigravity-model', 'ag gemini-x');
  f.statuses.set('antigravity-retry', 'antigravity: retry 2/5 · waiting');
  for (const key of ['mcp', 'lens', 'pi-lens', 'pi-lens-lsp', HUD_STATUS_KEY]) f.statuses.set(key, 'DUPLICATE');
  const top = stripAnsi(f.top(100));
  const bottom = stripAnsi(f.render(100)[0]!);
  assert.match(top, /ag gemini-x.*antigravity: retry 2\/5 · waiting/);
  assert.match(bottom, /lens ✓.*MCP 2.*skills 3/);
  assert.doesNotMatch(top + bottom, /DUPLICATE/);
  assert.equal(visualWidth(top), 100);
  assert.ok(visualWidth(bottom) <= 100);
  assert.match(stripAnsi(f.top(20)), /ag gemini-x/, 'statuses get the space before the ribbon');
  await f.controller.command('band off', f.ctx);
  assert.match(stripAnsi(f.top(100)), /ag gemini-x/);
  await f.controller.command('off statuses', f.ctx);
  assert.doesNotMatch(stripAnsi(f.top(100)), /ag gemini-x/);
});

test('native working indicator and scroll hint keep their places; resizing does not scan history', (t) => {
  const f = fixture(t);
  const editor = f.editor() as unknown as {
    setWorkingStatusIndicator(value: { renderInBorder(width: number): string }): void;
  };
  editor.setWorkingStatusIndicator({ renderInBorder: () => '⠋ Working…' });
  const before = f.counts();
  const top = stripAnsi(f.top(160, 8));
  assert.ok(top.startsWith('── ⠋ Working… '));
  assert.match(top, /↑ 8 more.*\ue0b6/);
  for (const width of [20, 80, 120, 160]) {
    assert.equal(visualWidth(f.top(width)), width);
    f.render(width);
  }
  assert.deepEqual(f.counts(), before);
});

test('rates come from the active branch, preserve last valid measurements, and have placeholders', (t) => {
  const f = fixture(t);
  f.ctx.sessionManager.getLeafId = () => 'new-leaf';
  f.ctx.sessionManager.getBranch = () => [
    { type: 'custom', customType: 'tps', data: { tps: 50, timing: { ttftMs: 1500 } } },
    { type: 'custom', customType: 'tps', data: { tps: null, timing: { ttftMs: null } } },
  ];
  f.controller.update();
  assert.match(stripAnsi(f.top()), /50\.0 t\/s.*TTFT 1\.5s/);
  f.ctx.sessionManager.getLeafId = () => 'empty-branch';
  f.ctx.sessionManager.getBranch = () => [];
  f.controller.update();
  assert.match(stripAnsi(f.top()), /- t\/s.*TTFT -/);
});

test('ribbon uses terminal palette transitions and respects NO_COLOR', (t) => {
  const f = fixture(t);
  const top = f.top();
  if (!process.env.NO_COLOR) {
    assert.ok(top.includes('\x1b[48;5;183m\x1b[38;5;235m Synthetic session title '));
    assert.ok(top.includes('\x1b[48;5;152m\x1b[38;5;183m\ue0b0'), 'previous foreground on next background');
    assert.ok(top.includes('\x1b[0m\x1b[38;5;187m\ue0b0\x1b[0m'), 'last arrow on terminal background');
  }
  const plain = fixture(t, undefined, { NO_COLOR: '1' });
  assert.doesNotMatch(plain.top(), /\x1b/);
  assert.match(plain.top(), /cache 73%.*123\.4 t\/s/);
});

test('stopping the footer restores both native components', (t) => {
  const f = fixture(t);
  assert.ok(f.editor());
  assert.equal(f.render().length, 1);
  f.controller.stop();
  assert.equal(f.editor(), undefined);
  assert.deepEqual(f.render(), []);
  f.controller.start(f.ctx);
  assert.match(stripAnsi(f.top()), /cache/);
});

test('pi footer prices provider-prefixed gateway model ids from the built-in catalog', (t) => {
  const f = fixture(t);
  // 1M input ($0.30) + 1M output ($1.20) + 1M cacheRead ($0.007) = $1.507 -> ≈$1.51
  const entries = [
    {
      type: 'message' as const,
      message: {
        role: 'assistant',
        model: 'mistral/deepseek-v4-1-flash-1017',
        usage: { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0, cost: { total: 0 } },
      },
    },
  ];
  f.ctx.model!.id = 'mistral/deepseek-v4-1-flash-1017';
  f.ctx.model!.provider = 'mistral';
  f.ctx.sessionManager.getLeafId = () => 'prefixed-leaf';
  f.ctx.sessionManager.getEntries = () => entries;
  f.ctx.sessionManager.getBranch = () => entries;
  f.controller.update();
  assert.match(stripAnsi(f.top(160)), /~\$1\.51\b/);
});

test('pi footer counts the HUD workers by role, `!2` for the two asking; the zone is the same at every width', (t) => {
  const f = parityFixture({ name: 'workers', width: 120, delegation: 'complete' });
  t.after(() => f.dispose());
  assert.match(stripAnsi(f.render(120)[0]!), /│ \uF0AD5 +!2 +MCP 2 +skills 3$/);
  assert.doesNotMatch(stripAnsi(f.render(120)[0]!), /imp|Question|Continue/);
  // Narrower, the loaded counts go; the zone does not change.
  assert.match(stripAnsi(f.render(60)[0]!), /│ \uF0AD5 +!2 *$/);
  assert.match(stripAnsi(f.render(40)[0]!), /│ \uF0AD5 +!2 *$/);
  // The jobs are gone: so is the group.
  f.publish('unavailable');
  assert.doesNotMatch(stripAnsi(f.render(120)[0]!), /\uF0AD/);
});

test('120 paced paints with EXP off read settings once, and turning EXP on or updating proxy is picked up without restart', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: quotaNow });
  const f = fixture(t, undefined, { NO_COLOR: '1' });
  const home = join(f.ctx.sessionManager.getCwd(), '../..');
  const settingsFile = join(home, 'hud-settings.json');
  writeFileSync(settingsFile, JSON.stringify({ experiments: false }), { mode: 0o600 });

  const open = t.mock.method(fsMutable.promises, 'open');
  const openSync = t.mock.method(fsMutable, 'openSync');
  const settingsReads = () =>
    open.mock.calls.filter((c) => c.arguments[0] === settingsFile).length +
    openSync.mock.calls.filter((c) => c.arguments[0] === settingsFile).length;

  f.render(120);
  for (let attempt = 0; attempt < 50 && settingsReads() < 1; attempt++) await sleep(2);
  await sleep(10);
  assert.equal(settingsReads(), 1);
  for (let i = 1; i < 120; i++) {
    f.render(120);
    await sleep(2);
  }
  assert.equal(settingsReads(), 1, '120 paced paints with EXP off read settings only once');

  const profile = join(home, '.codex');
  mkdirSync(profile);
  writeFileSync(join(profile, 'config.toml'), '# synthetic profile\n');
  saveExpEdit(home, { field: 'binding', value: profile }, quotaNow, { HOME: home, CODEX_HOME: profile });
  saveExpEdit(home, { field: 'proxy-enabled', value: true }, quotaNow);
  const proxyPayload = (usedPercent: number) =>
    JSON.stringify({
      profile,
      bindingVersion: readExpConfig(home).proxy.bindingVersion,
      secondary: { usedPercent, windowDurationMins: 10_080, resetsAt: (quotaNow + 52 * 3_600_000) / 1000 },
      observedAtMs: quotaNow,
      error: 'not_logged_in',
      failures: 1,
      nextAttemptMs: null,
    });
  writeFileSync(expProxyPath(home), proxyPayload(43), { mode: 0o600 });
  f.ctx.model!.id = 'gpt-6.2-sol';
  f.ctx.modelRegistry = { isUsingOAuth: () => true };

  writeFileSync(settingsFile, JSON.stringify({ experiments: true }), { mode: 0o600 });
  for (let attempt = 0; attempt < 100 && !f.render(120)[0]?.includes('≈43%'); attempt++) await sleep(5);
  assert.match(f.render(120)[0]!, /≈43%/);

  await sleep(10);
  const readsAfterEnable = settingsReads();
  for (let i = 0; i < 20; i++) {
    f.render(120);
    await sleep(2);
  }
  assert.equal(settingsReads(), readsAfterEnable, 'cached enabled state does not reread settings on paint');

  writeFileSync(expProxyPath(home), proxyPayload(77), { mode: 0o600 });
  for (let attempt = 0; attempt < 100 && !f.render(120)[0]?.includes('≈77%'); attempt++) await sleep(5);
  assert.match(f.render(120)[0]!, /≈77%/);
});

test('missing settings directory retries on draw until the watch attaches, then caches', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: quotaNow });
  const root = mkdtempSync(join(tmpdir(), 'hud-missing-watch-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const hudHome = join(root, 'hud');
  const settingsFile = join(hudHome, 'hud-settings.json');
  const open = t.mock.method(fsMutable.promises, 'open');
  const reads = () => open.mock.calls.filter((c) => c.arguments[0] === settingsFile).length;

  let footer: FooterComponent | undefined;
  const ctx = {
    mode: 'tui',
    hasUI: true,
    model: { id: 'gpt-6.2-sol', name: 'Sol', provider: 'openai', reasoning: true, contextWindow: 200_000 },
    modelRegistry: { isUsingOAuth: () => true },
    getContextUsage: () => ({ contextWindow: 200_000, percent: 42 }),
    sessionManager: {
      getSessionId: () => 's1',
      getLeafId: () => 'leaf',
      getEntries: () => [],
      getBranch: () => [],
      getCwd: () => root,
    },
    ui: {
      theme: { fg: (_token: string, text: string) => text },
      notify() {},
      setEditorComponent() {},
      setFooter(factory: Parameters<typeof createP10kFooter>[0] extends never ? never : any) {
        footer?.dispose?.();
        footer = factory?.({ requestRender() {} }, ctx.ui.theme, { getExtensionStatuses: () => new Map() });
      },
    },
  };
  const controller = createP10kFooter(
    {},
    parityHost,
    { HOME: root, HUD_HOME: hudHome, NO_COLOR: '1' },
    { gitStatus: (_cwd, done) => done(null, '') }
  );
  t.after(() => controller.dispose());
  controller.start(ctx as never);

  footer!.render(120);
  await sleep(10);
  assert.equal(reads(), 1);

  mkdirSync(hudHome, { recursive: true });
  const profile = join(root, '.codex');
  mkdirSync(profile);
  writeFileSync(join(profile, 'config.toml'), '# synthetic profile\n');
  saveExpEdit(hudHome, { field: 'binding', value: profile }, quotaNow, { HOME: root, CODEX_HOME: profile });
  saveExpEdit(hudHome, { field: 'proxy-enabled', value: true }, quotaNow);
  writeFileSync(
    expProxyPath(hudHome),
    JSON.stringify({
      profile,
      bindingVersion: readExpConfig(hudHome).proxy.bindingVersion,
      secondary: { usedPercent: 55, windowDurationMins: 10_080, resetsAt: (quotaNow + 52 * 3_600_000) / 1000 },
      observedAtMs: quotaNow,
      error: 'not_logged_in',
      failures: 1,
      nextAttemptMs: null,
    }),
    { mode: 0o600 }
  );
  writeFileSync(settingsFile, JSON.stringify({ experiments: true }), { mode: 0o600 });

  for (let attempt = 0; attempt < 100 && !footer!.render(120)[0]?.includes('≈55%'); attempt++) await sleep(5);
  assert.match(footer!.render(120)[0]!, /≈55%/);
  await sleep(10);
  const settledReads = reads();
  for (let i = 0; i < 10; i++) {
    footer!.render(120);
    await sleep(2);
  }
  assert.equal(reads(), settledReads);
});
