import test from 'node:test';
import assert from 'node:assert/strict';
import { buildContextUsage, percentOfContextWindowRemaining } from '../../src/collectors/context-usage.js';
import { buildBarModules } from '../../src/render/layout/bar-modules.js';
import { setDisplayConfig } from '../../src/render/hud-config.js';
import { stripAnsi, getContextColor, theme, visualWidth } from '../../src/render/colors.js';
import { fitModules } from '../../src/render/layout/engine.js';
import { WorkbenchInputDecoder } from '../../src/utils/workbench-input.js';
import { makeHudData } from '../fixtures/hud-data.js';

test('context percentage agrees with Codex baseline normalization', () => {
  // Reference: openai/codex rust-v0.154.0 protocol.rs TokenUsage.
  for (const [used, size, remaining] of [[12000,200000,100], [50000,200000,80],
    [106000,200000,50], [200000,200000,0], [300000,200000,0]]) {
    assert.equal(percentOfContextWindowRemaining(used, size), remaining);
  }
  const context = buildContextUsage({ model_context_window: 200000, last_token_usage: { total_tokens: 50000 },
    total_token_usage: { total_tokens: 900000 } }, 0, null);
  assert.equal(context?.percent, 20, 'cumulative session tokens do not measure context');
  assert.equal(context?.used, 38000);
  assert.equal(context?.total, 188000);
  assert.equal(buildContextUsage({ model_context_window: 200000, last_token_usage: {} }, 0, null), undefined);
  assert.equal(buildContextUsage({ model_context_window: NaN, last_token_usage: { total_tokens: 10 } }, 0, null), undefined);
});

test('remaining display keeps capacity warning colors and glyph status', () => {
  const previous = setDisplayConfig({ context: 'remaining', theme: 'terminal' });
  try {
    const data = makeHudData({ contextUsage: buildContextUsage({ model_context_window: 200000,
      last_token_usage: { total_tokens: 190600 } }, 0, null), activity: { state: 'working', updatedAt: new Date() } });
    const modules = buildBarModules(data, { glyphs: 'glyph' });
    const context = modules.find(m => m.id === 'context')!.variants.min!;
    assert.match(stripAnsi(context), /5% left/);
    assert.ok(context.includes(getContextColor(95)('5% left')));
    assert.equal(stripAnsi(modules.find(m => m.id === 'activity')!.variants.full!), '▸');
  } finally { setDisplayConfig(previous); }
});

test('old usage is visibly marked while a new turn is waiting for telemetry', () => {
  const data = makeHudData({ activity: { state: 'working', updatedAt: new Date(2000), turnStartedAt: new Date(2000) },
    tokenUsageAt: new Date(1000), outputRate: { tokensPerSecond: 20, sampleMs: 1000, sampledAt: new Date(1000) } });
  let modules = buildBarModules(data);
  assert.match(stripAnsi(modules.find(m => m.id === 'context')!.variants.min!), /Ctx~/);
  assert.deepEqual(modules.find(m => m.id === 'speed')!.variants, {});
  data.tokenUsageAt = new Date(3000);
  modules = buildBarModules(data);
  assert.doesNotMatch(stripAnsi(modules.find(m => m.id === 'context')!.variants.min!), /Ctx~/);
  data.stale = true;
  assert.equal(stripAnsi(buildBarModules(data).find(m => m.id === 'activity')!.variants.full!), '?');
});

test('split bracketed paste never runs monitor shortcuts', () => {
  const decoder = new WorkbenchInputDecoder('monitor');
  assert.deepEqual(decoder.push(Buffer.from('\x1b[20')), []);
  assert.deepEqual(decoder.push(Buffer.from('0~qxo123s\x1b[20')), []);
  assert.deepEqual(decoder.push(Buffer.from('1~j')), [{ type: 'key', key: 'down' }]);
});

test('cache reminder changes by minutes, warns at 25 and reaches its limit at 30', () => {
  const previous = setDisplayConfig({ theme: 'terminal' });
  const start = Date.UTC(2026, 8, 21, 12);
  const data = makeHudData({ tokenUsageAt: new Date(start) });
  const cache = (elapsedMs: number) => buildBarModules(data, { nowMs: start + elapsedMs, glyphs: 'glyph' })
    .find(m => m.id === 'cache')!;
  try {
    assert.equal(stripAnsi(cache(0).variants.full!), '◷~00m');
    assert.equal(cache(0).variants.full, cache(59_999).variants.full);
    assert.equal(stripAnsi(cache(60_000).variants.full!), '◷~01m');
    assert.equal(cache(25 * 60_000 - 1).pinned, false);
    assert.equal(cache(25 * 60_000).variants.full, theme.warning('◷~25m'));
    assert.equal(cache(25 * 60_000).pinned, true);
    assert.equal(cache(30 * 60_000 - 1).variants.full, theme.warning('◷~29m'));
    assert.equal(cache(30 * 60_000).variants.full, theme.error('◷~30m+'));
    assert.equal(cache(48 * 60 * 60_000).variants.full, theme.error('◷~30m+'));
    // A new model usage record renews the reminder, including after restart/resume.
    data.tokenUsageAt = new Date(start + 30 * 60_000);
    assert.equal(stripAnsi(cache(30 * 60_000).variants.full!), '◷~00m');
    assert.equal(stripAnsi(cache(0).variants.full!), '◷~00m', 'clock rollback must not show negative age');
    data.stale = true;
    assert.equal(stripAnsi(cache(30 * 60_000).variants.full!), '◷?00m');
    data.tokenUsageAt = undefined;
    assert.deepEqual(cache(0).variants, {});
    data.tokenUsageAt = new Date(NaN);
    assert.deepEqual(cache(0).variants, {});
  } finally { setDisplayConfig(previous); }
});

test('cache warning stays in the existing single line across densities and narrow widths', () => {
  const now = Date.UTC(2026, 8, 21, 12);
  const data = makeHudData({ tokenUsageAt: new Date(now - 25 * 60_000) });
  for (const density of ['focus', 'balanced', 'full'] as const) {
    const modules = buildBarModules(data, { nowMs: now, density, glyphs: 'glyph' });
    for (const width of [20, 40, 80, 120, 200]) {
      const result = fitModules(modules, { width, separator: ' | ' });
      assert.ok(result.kept.includes('cache'));
      assert.match(stripAnsi(result.line), /◷~25m/);
      assert.ok(!result.line.includes('\n'));
      assert.ok(visualWidth(result.line) <= width);
    }
  }
  const words = buildBarModules(data, { nowMs: now, glyphs: 'text' });
  assert.equal(stripAnsi(words.find(m => m.id === 'cache')!.variants.full!), 'Cache ~25m');
});

test('a narrow bar retains context before project and agent details during cache alerts',()=>{
  const now=Date.UTC(2026,8,21,12);
  const data=makeHudData({tokenUsageAt:new Date(now-25*60_000),activity:{state:'working',updatedAt:new Date(now)}});
  const result=fitModules(buildBarModules(data,{nowMs:now,glyphs:'glyph'}),{width:40,separator:' | '});
  assert.ok(result.kept.includes('context'));
  assert.ok(result.kept.includes('cache'));
  assert.ok(visualWidth(result.line)<=40);
});
