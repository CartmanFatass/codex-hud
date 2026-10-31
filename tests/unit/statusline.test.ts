import test from 'node:test';
import assert from 'node:assert/strict';
import { buildContextUsage, percentOfContextWindowRemaining } from '../../src/collectors/context-usage.js';
import { buildBarModules } from '../../src/render/layout/bar-modules.js';
import { setDisplayConfig } from '../../src/render/hud-config.js';
import { colors, stripAnsi, getContextColor, visualWidth } from '../../src/render/colors.js';
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

test('the bar reads the context as Codex reports it, against the model\'s whole window', () => {
  const previous = setDisplayConfig({ theme: 'terminal' });
  try {
    const data = makeHudData({ contextUsage: buildContextUsage({ model_context_window: 380000,
      last_token_usage: { total_tokens: 149124 } }, 0, null), activity: { state: 'working', updatedAt: new Date() } });
    const context = buildBarModules(data).find(m => m.id === 'context')!;
    assert.match(stripAnsi(context.variants.full!), /^━━━━─+ 149\.1K\/380K$/);
    assert.equal(stripAnsi(context.variants.short!), '149.1K/380K');
    const full = makeHudData({ contextUsage: buildContextUsage({ model_context_window: 200000,
      last_token_usage: { total_tokens: 190600 } }, 0, null) });
    const tight = buildBarModules(full).find(m => m.id === 'context')!.variants.short!;
    assert.ok(tight.includes(getContextColor(95)('190.6K')), 'past the danger line the numbers turn');
  } finally { setDisplayConfig(previous); }
});

test('a new turn keeps the last rate, dim, until it has a sample of its own', () => {
  const data = makeHudData({ activity: { state: 'working', updatedAt: new Date(2000), turnStartedAt: new Date(2000) },
    tokenUsageAt: new Date(1000), outputRate: { tokensPerSecond: 20.4, sampleMs: 1000, sampledAt: new Date(1000) } });
  const speed = () => buildBarModules(data, { nowMs: 3000 }).find(m => m.id === 'speed')!;
  assert.equal(speed().variants.full, colors.dim(' 20 tok/s'));
  data.outputRate = { tokensPerSecond: 57.3, sampleMs: 1000, sampledAt: new Date(2500) };
  assert.equal(stripAnsi(speed().variants.full!), ' 57 tok/s');
  assert.notEqual(speed().variants.full, colors.dim(' 57 tok/s'));
  data.activity = { state: 'idle', updatedAt: new Date(2600) };
  assert.equal(speed().variants.full, colors.dim(' 57 tok/s'), 'idle, the last rate stays, dim');
  assert.doesNotMatch(stripAnsi(buildBarModules(data).find(m => m.id === 'context')!.variants.full!), /~/);
  data.stale = true;
  const staleActivity = buildBarModules(data).find(m => m.id === 'activity')!;
  assert.match(stripAnsi(staleActivity.variants.full!), /Session read failed; showing last data/);
});

test('split bracketed paste never runs monitor shortcuts', () => {
  const decoder = new WorkbenchInputDecoder('monitor');
  assert.deepEqual(decoder.push(Buffer.from('\x1b[20')), []);
  assert.deepEqual(decoder.push(Buffer.from('0~qxo123s\x1b[20')), []);
  assert.deepEqual(decoder.push(Buffer.from('1~j')), [{ type: 'key', key: 'down' }]);
});

test('the bar has no prompt-cache reminder: Codex keeps the cache', () => {
  const now = Date.UTC(2026, 8, 21, 12);
  const data = makeHudData({ tokenUsageAt: new Date(now - 45 * 60_000) });
  for (const density of ['focus', 'balanced', 'full'] as const) {
    const modules = buildBarModules(data, { nowMs: now, density });
    assert.ok(!modules.some(m => m.id === 'cache'));
    assert.doesNotMatch(stripAnsi(fitModules(modules, { width: 200, separator: ' | ' }).line), /◷|Cache/);
  }
});

test('a narrow bar keeps the context and the state', () => {
  const now = Date.UTC(2026, 8, 21, 12);
  const data = makeHudData({ activity: { state: 'working', updatedAt: new Date(now) } });
  const result = fitModules(buildBarModules(data, { nowMs: now }), { width: 40, separator: ' | ' });
  assert.ok(result.kept.includes('context'));
  assert.ok(result.kept.includes('activity'));
  assert.ok(visualWidth(result.line) <= 40);
});
