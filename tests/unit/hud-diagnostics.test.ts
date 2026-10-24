import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BridgeHealthReader } from '../../src/collectors/bridge-health.js';
import { diagnosticLines, hudProblems, tokenRateDetails } from '../../src/render/hud-diagnostics.js';
import { makeHudData } from '../fixtures/hud-data.js';
import { setLanguage } from '../../src/render/i18n.js';
import { visualLength } from '../../src/render/colors.js';
import { initialMonitorState, renderMonitor, handleMonitorInput } from '../../src/render/monitor.js';
import { buildSnapshot } from '../../src/snapshot.js';

test('normal state stays quiet; binding, collection, bridge and model failures have distinct reasons', () => {
  const now = 10_000;
  const data = makeHudData({ stale: false });
  assert.deepEqual(hudProblems(data, now), []);
  assert.deepEqual(hudProblems({ ...data, health: { sessionBound: false } }, now), ['No Codex session bound']);
  assert.match(hudProblems({ ...data, stale: true }, now).join(), /Session read failed/);
  assert.match(hudProblems({ ...data, bridgeHealth: { state: 'disconnected' } }, now).join(), /Herdr bridge disconnected/);
  const legacy = { ...data, bridgeHealth: { state: 'unavailable' as const } };
  assert.deepEqual(hudProblems(legacy, now), [], 'missing legacy telemetry must not masquerade as a bridge fault');
  assert.match(diagnosticLines(legacy, 100, now).join(' '), /completion notifications are unverified/);
  const failure = { queued: 0, lastFailure: { classification: 'auth', at: 2000, feature: 'recap' } };
  assert.match(hudProblems({ ...data, modelHealth: failure }, now).join(), /authentication/);
  assert.deepEqual(hudProblems({ ...data, modelHealth: { ...failure, lastSuccessAt: 3000 } }, now), []);
  assert.match(hudProblems({ ...data, modelHealth: { queued: 2 } }, now).join(), /queue: 2/);
});

test('rate details distinguish no evidence, current, stale and previous-turn measurements', () => {
  const before = setLanguage('en');
  try {
    const now = Date.parse('2026-01-01T00:00:20Z');
    const rate = { tokensPerSecond: 20, sampleMs: 4500, sampledAt: new Date(now - 1000) };
    assert.match(tokenRateDetails(undefined, undefined, true, now).join(), /no sample/);
    const current = tokenRateDetails(rate, new Date(now - 5000), true, now).join('\n');
    assert.match(current, /current turn, recent/); assert.match(current, /4.50s/);
    assert.match(current, /2026-01-01T00:00:19.000Z/); assert.match(current, /Not exact request/);
    assert.match(tokenRateDetails(rate, new Date(now), true, now).join(), /previous turn/);
    assert.match(tokenRateDetails(rate, new Date(now - 5000), true, now + 20_000).join(), /last measurement/);
  } finally { setLanguage(before); }
});

test('native transport success does not hide a Codex state mismatch', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-native-health-'));
  const dir = path.join(home, 'hud', 'herdr', 'session'); fs.mkdirSync(dir, { recursive: true });
  const previousLanguage = setLanguage('en');
  try {
    const record = { schemaVersion: 1, session: 'session', lifecycle: 'running', mainPaneId: '%1',
      updatedAtMs: 10_000, mode: 'native', nativeState: 'working', stateMatches: false,
      transport: { status: 'connected', lastSuccessAtMs: 10_000 }, probe: { status: 'mismatch' } };
    fs.writeFileSync(path.join(dir, '1.json'), JSON.stringify(record));
    const reader = new BridgeHealthReader(home, { CODEX_HUD_TMUX_SESSION: 'session', CODEX_HUD_MAIN_PANE: '%1' });
    const health = reader.read(10_100)!;
    assert.equal(health.state, 'connected'); assert.equal(health.stateMismatch, true);
    assert.equal(health.probeFailed, false); assert.equal(health.nativeState, 'working');
    const data = makeHudData({ bridgeHealth: health });
    assert.match(hudProblems(data, 10_100).join(), /state differs/);
    const lines = diagnosticLines(data, 120, 10_100).join(' ');
    assert.match(lines, /native detection; last observed state: working/);
    assert.match(lines, /last readback/); assert.doesNotMatch(lines, /acknowledge/);
    fs.writeFileSync(path.join(dir, '1.json'), JSON.stringify({ ...record, updatedAtMs: 12_000,
      nativeState: 'done', stateMatches: true, probe: { status: 'ok' } }));
    assert.equal(reader.read(12_100)?.stateMismatch, false);
    assert.equal(reader.read(12_100)?.nativeState, 'done');
    const recovered = makeHudData({ bridgeHealth: { ...reader.read(12_100)!, notificationGap: true } });
    assert.deepEqual(hudProblems(recovered, 12_100), [], 'a recovered read-only observer does not imply notification failure');
    assert.match(diagnosticLines(recovered, 120, 12_100).join(' '), /notifications run independently/);
  } finally { setLanguage(previousLanguage); fs.rmSync(home, { recursive: true, force: true }); }
});

test('diagnostics command opens scrollable main details and exports sampled evidence', () => {
  const data = makeHudData({ health: { sessionBound: false }, outputRate: { tokensPerSecond: 21, sampleMs: 1000, sampledAt: new Date('2026-01-01') } });
  const tree = { rootId: 'synthetic-root', nodes: [], totalCount: 0, updatedAt: new Date() };
  const result = handleMonitorInput(initialMonitorState(), { type: 'key', key: 'diagnostics' }, { tree });
  assert.equal(result.state.preview, 'diagnostics'); assert.equal(result.state.modes.details, 'open');
  for (const lang of ['en', 'zh'] as const) {
    const old = setLanguage(lang);
    try { for (const width of [24, 32, 40, 56]) {
      assert.ok(diagnosticLines(data, width, Date.now()).every(line => visualLength(line) <= width));
      const frame = renderMonitor({ tree, state: result.state, hud: data, width, height: 30 });
      assert.ok(frame.lines.every(line => visualLength(line) <= width));
      assert.ok(frame.panes.find(pane => pane.id === 'details')!.contentLength > 0);
    } } finally { setLanguage(old); }
  }
  const snapshot = buildSnapshot(data, { width: 0, segments: [] });
  assert.equal(snapshot.health?.sessionBound, false);
  assert.deepEqual(snapshot.outputRate, { estimated: true, tokensPerSecond: 21, sampleMs: 1000, sampledAt: '2026-01-01T00:00:00.000Z' });
});

test('bridge health follows reattach to a new Herdr pane and aggregates live writers; ignores stopped records', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-health-'));
  const dir = path.join(home, 'hud', 'herdr', 'session'); fs.mkdirSync(dir, { recursive: true });
  const report = { schemaVersion: 1, session: 'session', lifecycle: 'running', herdrPaneId: 'outer:one',
    updatedAtMs: 10_000, transport: { status: 'connected', lastSuccessAtMs: 10_000 }, probe: { status: 'ok' }, notificationGap: true };
  try {
    fs.writeFileSync(path.join(dir, '1.json'), JSON.stringify(report));
    fs.writeFileSync(path.join(dir, '2.json'), JSON.stringify({ ...report, herdrPaneId: 'outer:two', updatedAtMs: 10_100, transport: { status: 'connected' } }));
    fs.writeFileSync(path.join(dir, '3.json'), '{bad');
    for (let i = 0; i < 65; i++) fs.writeFileSync(path.join(dir, `${100000 + i}.json`), JSON.stringify({ ...report, lifecycle: 'stopped' }));
    const reader = new BridgeHealthReader(home, { CODEX_HUD_TMUX_SESSION: 'session', HERDR_PANE_ID: 'outer:one' });
    assert.equal(reader.read(10_200)?.state, 'connected'); assert.equal(reader.read(10_200)?.notificationGap, true);
    fs.writeFileSync(path.join(dir, '1.json'), JSON.stringify({ ...report, lifecycle: 'stopped' }));
    assert.equal(reader.read(12_000)?.state, 'connected', 'new outer pane stays healthy despite inherited old pane id');
    fs.writeFileSync(path.join(dir, '1.json'), JSON.stringify({ ...report, updatedAtMs: 12_000, transport: { status: 'disconnected' } }));
    assert.equal(reader.read(13_000)?.state, 'disconnected', 'another active attachment failure remains visible');
    assert.equal(reader.read(40_000)?.state, 'unresponsive');
    fs.writeFileSync(path.join(dir, '1.json'), JSON.stringify({ ...report, lifecycle: 'stopped' }));
    fs.writeFileSync(path.join(dir, '2.json'), JSON.stringify({ ...report, lifecycle: 'stopped' }));
    assert.equal(reader.read(42_000), undefined);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
