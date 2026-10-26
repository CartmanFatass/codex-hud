import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDiagnosticExportPreview, saveDiagnosticExport } from '../../src/diagnostics/diagnostic-export.js';
import { diagnosticEvidence } from '../../src/diagnostics/provenance.js';
import { SmallModel } from '../../src/collectors/small-model.js';
import type { SubagentTree, SubagentTreeNode } from '../../src/types.js';
import { diagnosticLines } from '../../src/render/hud-diagnostics.js';
import { makeHudData } from '../fixtures/hud-data.js';
import { visualLength } from '../../src/render/colors.js';
import { setLanguage } from '../../src/render/i18n.js';

const SECRET = 'SYNTHETIC_PRIVATE_SENTINEL';
const nowMs = Date.parse('2026-10-25T12:00:00Z');
const node: SubagentTreeNode = { id: SECRET, name: SECRET, task: SECRET, charge: SECRET, rolloutPath: `/private/${SECRET}`,
  status: 'unknown', statusAt: new Date(nowMs - 2000), lastEventAt: new Date(nowMs - 1000), children: [], depth: 1,
  outputRate: { tokensPerSecond: 12, sampleMs: 500, sampledAt: new Date(nowMs - 1000) } };
const tree: SubagentTree = { rootId: 'synthetic-root', nodes: [node], totalCount: 1, updatedAt: new Date(nowMs) };
function data() {
  const hud = makeHudData({ subagentTree: tree, health: { sessionBound: true, lastReadAt: new Date(nowMs - 100),
    lastError: { source: SECRET, message: `${SECRET} https://private.invalid/?token=${SECRET} /private/${SECRET}`, at: new Date(nowMs - 200) } },
    modelHealth: { queued: 1, running: { feature: SECRET, startedAt: nowMs - 200 },
      lastFailure: { classification: SECRET, at: nowMs - 1000, feature: SECRET } } });
  return Object.assign(hud, { nested: { credential: SECRET, endpoint: `https://private.invalid/${SECRET}` } });
}

test('allowlisted preview excludes synthetic nested secrets and save emits its exact bytes privately', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-export-'));
  const model = new SmallModel({ env: {} });
  const telemetry = Object.assign(model.telemetry(nowMs), { nested: { secret: SECRET } });
  const input = { data: data(), tree, selectedId: SECRET, telemetry, nowMs };
  try {
    const before = fs.readdirSync(home);
    const preview = createDiagnosticExportPreview(input);
    assert.deepEqual(fs.readdirSync(home), before, 'preview does no filesystem I/O');
    assert.equal(preview.json, createDiagnosticExportPreview(input).json, 'preview is deterministic');
    assert.ok(Object.isFrozen(preview)); assert.ok(!preview.json.includes(SECRET));
    assert.ok(!preview.json.includes('private.invalid')); assert.ok(!preview.json.includes('/private/'));
    const parsed = JSON.parse(preview.json);
    assert.equal(parsed.evidence.selected.found, true); assert.equal(parsed.evidence.selected.state, 'unknown');
    assert.equal(parsed.evidence.model.running.feature, 'other');
    assert.equal(parsed.evidence.collection.lastError.classification, 'collection-failed');
    assert.equal(parsed.modelTelemetry.features.length, 0);
    const saved = saveDiagnosticExport(preview, home);
    assert.ok(saved.ok);
    assert.equal(fs.readFileSync(saved.path, 'utf8'), preview.json);
    assert.equal(fs.statSync(saved.path).size, preview.bytes);
    assert.equal(fs.statSync(saved.path).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(saved.path)).mode & 0o777, 0o700);
    assert.deepEqual(saveDiagnosticExport({ json: SECRET, bytes: SECRET.length }, home), { ok: false, reason: 'invalid-preview' });
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('preview rebuilds telemetry instead of serializing nested metadata or injected billing values', () => {
  const model = new SmallModel({ env: {} });
  const summary = model.telemetry(nowMs);
  summary.features.push({ feature: 'recap', requests: 1, pending: 0, successes: 1, failures: 0, cacheHits: 0,
    cancelled: 0, limited: 0, refused: 0, durationSamples: 1, meanDurationMs: 10, tokens: null, cost: null });
  Object.assign(summary.features[0], { prompt: SECRET, tokens: SECRET, cost: SECRET, metadata: { input: SECRET } });
  Object.assign(summary, { persistence: SECRET });
  const preview = createDiagnosticExportPreview({ data: data(), tree, telemetry: summary, nowMs });
  assert.ok(!preview.json.includes(SECRET));
  assert.equal(JSON.parse(preview.json).modelTelemetry.features[0].tokens, null);
  assert.equal(JSON.parse(preview.json).modelTelemetry.persistence, 'unavailable');
});

test('missing, unknown, future and conflicting evidence stay explicit without exact throughput claims', () => {
  assert.equal(diagnosticEvidence({ nowMs }).main.state, 'unknown');
  const hud = data();
  hud.bridgeHealth = { state: 'connected', mode: 'native', stateMismatch: true, nativeState: 'working' };
  for (const lang of ['en', 'zh'] as const) {
    const old = setLanguage(lang);
    try { for (const width of [24, 32, 56]) {
      const lines = diagnosticLines(hud, width, nowMs, { tree, selectedId: SECRET });
      assert.ok(lines.every(line => visualLength(line) <= width));
      assert.ok(!lines.join().includes(SECRET), 'render omits arbitrary raw collector errors and agent source text');
    } } finally { setLanguage(old); }
  }
  const lines = diagnosticLines(hud, 160, nowMs, { tree, selectedId: SECRET }).join(' ');
  assert.match(lines, /Unknown agent state/); assert.match(lines, /Conflicting evidence/);
  assert.match(lines, /not verification of its work/); assert.match(lines, /Not exact request throughput/);
  assert.match(diagnosticLines(hud, 160, nowMs, { tree, selectedId: 'missing' }).join(' '), /unavailable in the current tree/);
  const future = diagnosticEvidence({ nowMs, data: { ...hud, outputRate: { tokensPerSecond: 1, sampleMs: 1000, sampledAt: new Date(nowMs + 10_000) } } });
  assert.equal(future.main.rate?.relation, 'future');
});

test('save failure returns a safe category without exposing the destination path', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-export-failure-'));
  try {
    fs.writeFileSync(path.join(home, 'hud'), 'synthetic obstacle');
    const result = saveDiagnosticExport(createDiagnosticExportPreview({ nowMs }), home);
    assert.deepEqual(result, { ok: false, reason: 'write-failed' });
    assert.ok(!JSON.stringify(result).includes(home));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
