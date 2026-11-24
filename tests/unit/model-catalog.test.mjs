import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  SHIPPED_MODELS_CATALOG,
  lookupModelEntry,
  lookupModelPrice,
  resolveCliThinking,
  stripModelSnapshotDate,
} from '../../dist/models/catalog.js';
import { launchThinking, nearestThinking } from '../../dist/mcp/launch-thinking.js';
import { placeCatalog, roleRegistry } from '../../dist/roles/roster.js';
import { controlFacts } from '../../dist/roles/role-control.js';
import { PROVIDERS, providerMark, shortModel } from '../../dist/render/providers.js';
import { EFFORT_GLYPHS, MODEL_GLYPHS, MODEL_LABELS, classifyModelFamily } from '../../dist/render/model-glyphs.js';
import { shortModel as controlShortModel } from '../../dist/render/control-view.js';
import { renderBar } from '../../dist/render/layout/bar-fields.js';
import { stripAnsi } from '../../dist/render/colors.js';
import { setDisplayConfig } from '../../dist/render/hud-config.js';
import { getModelDisplayName } from '../../dist/collectors/codex-config.js';
import { OPENAI_DECISION_MODEL } from '../../dist/jev/providers/openai.js';
import { GeminiDecisionProvider } from '../../dist/jev/providers/gemini.js';
import { TypeSafeDecisionProvider } from '../../dist/jev/providers/typesafe.js';

const bundled = resolve('packages/hud-mcp');

function makeSandbox(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'model-catalog-'));
  const hud = join(root, 'hud');
  const cwd = join(root, 'cwd');
  const bin = join(root, 'bin');
  fs.mkdirSync(hud, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, hud, cwd, bin, env: { PATH: bin } };
}

test('packages/hud-mcp/catalog.json is gone and every shipped role/harness model exists in models-catalog.json', () => {
  assert.equal(fs.existsSync(join(bundled, 'catalog.json')), false);
  assert.equal(SHIPPED_MODELS_CATALOG.version, 1);

  const harnesses = JSON.parse(fs.readFileSync(join(bundled, 'harnesses.json'), 'utf8'));
  for (const [name, entry] of Object.entries(harnesses)) {
    if (typeof entry?.model === 'string') {
      assert.ok(lookupModelEntry(entry.model), `harnesses.json#${name} model ${entry.model} missing from catalog`);
    }
  }

  const rolesDir = join(bundled, 'roles');
  for (const file of fs.readdirSync(rolesDir).filter((n) => n.endsWith('.json'))) {
    const role = JSON.parse(fs.readFileSync(join(rolesDir, file), 'utf8'));
    const places = [
      ...(Array.isArray(role.run) ? role.run : []),
      ...(Array.isArray(role.presets) ? role.presets.flatMap((p) => p.run ?? []) : []),
    ];
    for (const place of places) {
      if (typeof place?.model === 'string') {
        assert.ok(lookupModelEntry(place.model), `roles/${file} model ${place.model} missing from catalog`);
      }
    }
  }
});

test('built-in catalog only: $HUD_HOME/models.json is ignored while harnesses.json#catalog still merges', (t) => {
  const s = makeSandbox(t);
  fs.writeFileSync(
    join(s.hud, 'models.json'),
    JSON.stringify({
      version: 1,
      harnesses: {
        pi: { offlineModels: ['override/should-not-load'] },
        cli: { models: { codex: ['override-codex'] } },
      },
      models: {
        'override-codex': { cliThinking: { codex: ['low', 'high'] } },
        'deepseek-v4-1-flash-1017': { pricingPerM: { input: 999, output: 999 } },
      },
    })
  );

  const catalog = placeCatalog(s.hud, bundled);
  assert.equal(catalog.pi.models.includes('override/should-not-load'), false);
  assert.equal(catalog.cli.models.codex.includes('override-codex'), false);
  assert.equal(launchThinking(s.hud, { harness: 'cli', agent: 'codex' }, 'override-codex'), undefined);
  assert.equal(lookupModelPrice('deepseek-v4-1-flash-1017')?.input, 0.3);
});

test('launchThinking and nearestThinking read the built-in catalog and keep codex ultra per model only', (t) => {
  const s = makeSandbox(t);

  // Q2 A: cli.thinking does not include ultra globally; only specific codex models allow ultra.
  assert.deepEqual(SHIPPED_MODELS_CATALOG.harnesses.cli.thinking, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(
    launchThinking(s.hud, { harness: 'cli', agent: 'codex' }, 'gpt-6.1-sol'),
    ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
  );
  assert.deepEqual(
    launchThinking(s.hud, { harness: 'cli', agent: 'codex' }, 'gpt-6-luna'),
    ['low', 'medium', 'high', 'xhigh', 'max']
  );
  assert.deepEqual(
    launchThinking(s.hud, { harness: 'cli', agent: 'codex' }, 'gpt-5.5'),
    ['low', 'medium', 'high', 'xhigh']
  );

  // Claude aliases and full ids, agy models, unmapped grok, and wrong-agent lookups.
  for (const model of ['fable', 'claude-fable-5-2', 'opus', 'claude-opus-5-5', 'sonnet', 'claude-sonnet-5-5', 'haiku']) {
    assert.deepEqual(
      launchThinking(s.hud, { harness: 'cli', agent: 'claude' }, model),
      ['low', 'medium', 'high', 'xhigh', 'max']
    );
  }
  for (const model of ['gemini-4-argon-high', 'gemini-4-hydrogen-high', 'gemini-3.8-flash-high']) {
    assert.deepEqual(
      launchThinking(s.hud, { harness: 'cli', agent: 'agy' }, model),
      ['low', 'medium', 'high', 'xhigh', 'max']
    );
  }
  assert.equal(launchThinking(s.hud, { harness: 'cli', agent: 'grok' }, 'grok-4.7'), undefined);
  assert.equal(resolveCliThinking(SHIPPED_MODELS_CATALOG, 'claude', 'gpt-6.1-sol'), undefined);

  assert.equal(nearestThinking('ultra', ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']), 'ultra');
  assert.equal(nearestThinking('ultra', ['low', 'medium', 'high', 'xhigh', 'max']), 'max');
  assert.equal(nearestThinking('ultra', ['low', 'medium', 'high', 'xhigh']), 'xhigh');
  assert.equal(nearestThinking('off', ['low', 'medium', 'high']), 'low');
  assert.equal(nearestThinking('unknown', ['medium', 'high']), 'medium');
});

test('visible fix: fable shows the Anthropic mark in providerMark and the bar while other marks stay unchanged', (t) => {
  assert.deepEqual(providerMark({ id: 'fable' }), { glyph: '✻', ascii: 'Ant', color: 173 });
  assert.deepEqual(providerMark({ id: 'fable' }, true), { glyph: 'Ant', ascii: 'Ant', color: 173 });
  assert.deepEqual(providerMark({ id: 'claude-fable-5-2' }), { glyph: '✻', ascii: 'Ant', color: 173 });

  const previous = setDisplayConfig({ theme: 'terminal', barFields: ['model'], icons: 'unicode' });
  t.after(() => setDisplayConfig(previous));
  const unicodeLine = stripAnsi(renderBar({ model: { id: 'fable', name: 'fable' } }, 60, 0, 'line').line);
  assert.match(unicodeLine, /✻ fable/);
  setDisplayConfig({ theme: 'terminal', barFields: ['model'], icons: 'text' });
  const asciiLine = stripAnsi(renderBar({ model: { id: 'fable', name: 'fable' } }, 60, 0, 'line').line);
  assert.match(asciiLine, /Ant fable/);

  // Other vendor marks unchanged.
  assert.equal(providerMark({ id: 'gpt-6.1-sol', provider: 'arena' })?.glyph, PROVIDERS.openai.glyph);
  assert.equal(providerMark({ id: 'o3-mini' })?.glyph, PROVIDERS.openai.glyph);
  assert.equal(providerMark({ id: 'claude-opus-5-5' })?.glyph, PROVIDERS.anthropic.glyph);
  assert.equal(providerMark({ id: 'deepseek-v4-1-flash-1017', provider: 'mistral' })?.glyph, PROVIDERS.deepseek.glyph);
  assert.equal(providerMark({ id: 'zai-glm-5-3-flash', provider: 'mistral' })?.glyph, PROVIDERS.zai.glyph);
  assert.equal(providerMark({ id: 'gemini-4-argon-high' })?.glyph, PROVIDERS.gemini.glyph);
  assert.equal(providerMark({ id: 'grok-4.7' })?.glyph, PROVIDERS.xai.glyph);
  assert.equal(providerMark({ id: 'mistral-large-4', provider: 'mistral' })?.glyph, PROVIDERS.mistral.glyph);
  assert.equal(providerMark({ id: 'local-model', baseUrl: 'http://127.0.0.1:4000' })?.glyph, PROVIDERS.litellm.glyph);
});

test('visible fix: lookupModelPrice prices provider-prefixed ids and preserves normalization and prefix rules', () => {
  const bare = lookupModelPrice('deepseek-v4-1-flash-1017');
  const prefixed = lookupModelPrice('mistral/deepseek-v4-1-flash-1017');
  const dotted = lookupModelPrice('mistral/deepseek-v4.1-flash-1017');
  assert.deepEqual(prefixed, bare);
  assert.deepEqual(dotted, bare);
  assert.equal(bare?.input, 0.3);
  assert.equal(bare?.cacheRead, 0.007);
  assert.equal(bare?.output, 1.2);

  assert.equal(lookupModelPrice('mistral/zai-glm-5-3-flash')?.output, 0.5);
  assert.equal(lookupModelPrice('mistral/zai-glm-5-3-20261101')?.output, 4.4);
  assert.equal(lookupModelPrice('mistral/codestral-2501')?.output, 0.9);
  assert.equal(lookupModelPrice('mistral/codestral-embed-2505')?.input, 0.15);
  assert.equal(lookupModelPrice('mistral/mistral-large-4-latest')?.output, 2.1);
  assert.equal(lookupModelPrice('unknown/synthetic-model'), null);
  assert.equal(lookupModelPrice('mistral/'), null);
  assert.equal(lookupModelPrice(undefined), null);
});

test('Control picker facts stay price-free and read browser thinking from the catalog', (t) => {
  const s = makeSandbox(t);
  const now = Date.parse('2026-11-22T12:00:00Z');
  const reg = roleRegistry(s.hud, s.cwd, s.env, undefined, undefined, bundled);
  const facts = controlFacts(reg, s.hud, now);
  const catalog = placeCatalog(s.hud, bundled);

  assert.deepEqual(facts.models.editor?.broThinking, ['Low', 'High']);
  assert.doesNotMatch(JSON.stringify(facts), /pricingPerM/);
  assert.doesNotMatch(JSON.stringify(catalog), /pricingPerM/);
});

test('defaults, glyphs, abbreviations and codex display helper match the catalog', () => {
  assert.equal(OPENAI_DECISION_MODEL, SHIPPED_MODELS_CATALOG.defaults.decisions.openai);
  assert.equal(new GeminiDecisionProvider({ apiKey: 'synthetic' }).model, SHIPPED_MODELS_CATALOG.defaults.decisions.gemini);
  assert.equal(
    new TypeSafeDecisionProvider({ apiKey: 'synthetic' }).model,
    SHIPPED_MODELS_CATALOG.defaults.decisions.typesafe
  );

  assert.deepEqual(MODEL_GLYPHS, { astra: '☀', sol: '★', terra: '≡', luna: '☽', spark: '*' });
  assert.deepEqual(MODEL_LABELS, { astra: 'Astra', sol: 'Sol', terra: 'Terra', luna: 'Luna', spark: 'Spark' });
  assert.deepEqual(EFFORT_GLYPHS, { low: '○', medium: '◐', high: '◕', xhigh: '●', max: '◆', ultra: '✦' });
  assert.equal(classifyModelFamily('gpt-6.1-sol'), 'sol');
  assert.equal(classifyModelFamily('openai/gpt-6.2-astra'), 'astra');
  assert.equal(classifyModelFamily('gpt-6-luna'), 'luna');
  assert.equal(classifyModelFamily('gpt-6.1-terra'), 'terra');
  assert.equal(classifyModelFamily('gpt-5.6-spark'), 'spark');

  assert.equal(shortModel('claude-fable-5-2'), 'fable-5.2');
  assert.equal(shortModel('mistral/deepseek-v4-1-flash-1017'), 'v4.1-flash');
  assert.equal(stripModelSnapshotDate('mistral/deepseek-v4-1-flash-1017'), 'mistral/deepseek-v4-1-flash');
  assert.equal(controlShortModel('openai/gpt-6-2026-11-01'), 'openai/gpt-6');
  assert.equal(getModelDisplayName({ model: 'gpt-6.1-sol' }), 'gpt-6.1-sol');
  assert.equal(getModelDisplayName({}), 'default');
});
