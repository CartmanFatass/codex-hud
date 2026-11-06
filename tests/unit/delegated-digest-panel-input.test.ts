import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { WorkbenchInputDecoder, type WorkbenchInput } from '../../src/utils/workbench-input.js';
import { PANEL_COMMANDS, commandSequence, needsOpenPanel, monitorKey } from '../../src/utils/panel-command.js';
import { DelegatedDigestPanel, DelegatedDigestPage, type DigestPageContext, type DigestPanelServices } from '../../src/collectors/delegated-digest-panel.js';
import { type DigestPlanLifetime } from '../../src/core/materials/delegated-digest-lifetime.js';
import { type DigestDocument } from '../../src/core/materials/delegated-digest.js';
import { digestPanelTarget } from '../../src/render/delegated-digest.js';
import { renderMonitor } from '../../src/render/monitor.js';
import { until, tick } from '../fixtures/delegated-digest.js';
import { buildVm, S, NOW } from '../fixtures/b10b-delegation.js';
import { monitorInput } from '../fixtures/b10b-s3.js';
import { digestModalInput, digestModalOwnsInput, renderDigestModal, type DigestPanelSnapshot } from '../../src/render/delegated-digest.js';

function confirmation(): DigestPanelSnapshot {
  const target = { key: 'synthetic', ledgerId: 'ledger-synthetic', linkId: 'link-synthetic', runId: 'run-synthetic',
    reportId: 'report-synthetic', ref: { harness: 'claude' as const, sourceId: 'a'.repeat(64), sessionId: 'synthetic-child', threadId: null } };
  return { phase: 'confirm', target, confirmation: { target, endpoint: 'https://synthetic.invalid/v1/chat/completions',
    account: 'synthetic-account', model: 'synthetic-model', language: 'en', ready: true, reason: 'unavailable',
    modelFile: `sources/${target.ref.sourceId}/model.json`, outboundFile: `sources/${target.ref.sourceId}/outbound.json` } };
}

test('D is only a focused monitor key; d diagnostics and unrelated workbench input remain unchanged', () => {
  assert.deepEqual(new WorkbenchInputDecoder('monitor').push(Buffer.from('Dd')), [
    { type: 'key', key: 'delegation-digest' }, { type: 'key', key: 'diagnostics' }]);
  assert.deepEqual(new WorkbenchInputDecoder('workbench', { forward: true }).push(Buffer.from('D')), [
    { type: 'key', key: '', raw: 'D' }]);
  const decoder = new WorkbenchInputDecoder('monitor');
  const command = commandSequence('delegation-digest');
  assert.deepEqual(decoder.push(Buffer.from(command.slice(0, 8))), []);
  assert.deepEqual(decoder.push(Buffer.from(command.slice(8))), [{ type: 'command', command: 'delegation-digest' }]);
  assert.equal(monitorKey('delegation-digest'), 'delegation-digest');
  assert.equal(needsOpenPanel('delegation-digest'), false);
});

test('prefix D is nonrepeating and command is a closed-panel no-op without installer edits', () => {
  const keys = fs.readFileSync('bin/codex-hud-keys', 'utf8');
  const command = fs.readFileSync('bin/codex-hud-command', 'utf8');
  assert.match(keys, /^bind_command 0 D delegation-digest$/m);
  assert.doesNotMatch(keys, /^bind_command 1 D/m);
  assert.match(command, /\|delegation-digest\) exit 0/);
});

test('modal owns planning/confirm/running/failure input and gives no action to paste, letters or repeated D', () => {
  const snapshot = confirmation();
  const frame = renderDigestModal(snapshot, 40, 20);
  const inert: WorkbenchInput[] = [{ type: 'paste', text: '\rD\x1b_codex-hud:delegation-digest\x1b\\' },
    { type: 'key', key: '', raw: 'secret synthetic text' }, { type: 'key', key: 'delegation-digest' },
    { type: 'command', command: 'delegation-digest' }];
  for (const phase of ['planning', 'confirm', 'running', 'failed'] as const)
    assert.equal(digestModalOwnsInput({ ...snapshot, phase }), true);
  for (const input of inert) assert.deepEqual(digestModalInput(input, frame), {});
  assert.equal(digestModalInput({ type: 'key', key: 'escape' }, frame).action, 'cancel');
  assert.equal(digestModalInput({ type: 'command', command: 'quit' }, frame).action, 'close');
  assert.equal(digestModalInput({ type: 'key', key: 'brief-toggle' }, frame).action, 'pause');
  for (const key of ['settings', 'help', 'main', 'activity-hub', 'find-agent', 'observability'])
    assert.equal(digestModalInput({ type: 'key', key }, frame).action, 'cancel');
});

test('Enter/click only confirm when visible and ready; cancellation and scroll never confirm', () => {
  const snapshot = confirmation();
  for (const width of [32, 40, 48, 56, 80]) {
    const frame = renderDigestModal(snapshot, width, 16);
    const button = frame.controls.find((control) => control.kind === 'confirm')!;
    assert.ok(button);
    assert.equal(digestModalInput({ type: 'key', key: 'enter' }, frame).action, 'confirm');
    assert.equal(digestModalInput({ type: 'mouse', button: 'left', x: button.x, y: button.y }, frame).action, 'confirm');
    const cancel = frame.controls.find((control) => control.kind === 'cancel')!;
    assert.equal(digestModalInput({ type: 'mouse', button: 'left', x: cancel.x, y: cancel.y }, frame).action, 'cancel');
    assert.equal(digestModalInput({ type: 'key', key: 'down' }, frame).offset, 1);
  }
  for (const phase of ['planning', 'running', 'failed'] as const) {
    const frame = renderDigestModal({ ...snapshot, phase }, 80, 20);
    assert.equal(digestModalInput({ type: 'key', key: 'enter' }, frame).action, undefined);
  }
  for (const width of [0, 1, 8]) {
    const frame = renderDigestModal(snapshot, width, 20);
    assert.equal(frame.controls.length, 0);
    assert.equal(digestModalInput({ type: 'key', key: 'enter' }, frame).action, undefined);
  }
  const denied = { ...snapshot, confirmation: { ...snapshot.confirmation!, ready: false } };
  assert.equal(digestModalInput({ type: 'key', key: 'enter' }, renderDigestModal(denied, 80, 20)).action, undefined);
});


/** Only ports are synthetic. Routing, modal ownership, frame action and success effects are production code. */
function pageHarness(overrides: Partial<DigestPanelServices> = {}) {
  const built = buildVm([{ id: 'main', root: true, status: S.working() },
    { id: 'one', parent: 'main', status: S.working(), report: { status: 'completed', at: NOW } }]);
  built.vm.tree.ledger.state = 'available';
  const node = built.vm.tree.nodes.find((item) => item.key === built.keys.one)!;
  node.links = [node.currentRun!.linkId];
  const data = monitorInput(built.vm, { selected: node.key, width: 120, height: 40 });
  const target = digestPanelTarget(built.vm, node.key)!;
  const counts = { plans: 0, runs: 0, paints: 0, panelFocus: 0, mainFocus: 0, pauses: 0, validations: 0 };
  const forwarded: string[] = [];
  const doc = (): DigestDocument => ({ format: 'hud-delegated-digest', schemaVersion: 1, ...target,
    origin: 'delegated', purpose: 'digest', material: 'completed_report_summary', recipientId: 'synthetic-recipient',
    model: 'synthetic-model', language: 'en', generatedAt: 100, cached: false, digest: { conclusion: 'Synthetic result.' } });
  const panel = new DelegatedDigestPanel({
    prepare: async () => { counts.plans++; return { lifetime: Object.freeze({}) as DigestPlanLifetime, plan: {
      format: 'hud-delegated-digest-plan', schemaVersion: 1, ...target, origin: 'delegated', purpose: 'digest', field: 'result',
      material: { kind: 'completed_report_summary', status: 'completed', bytes: 12, acceptedSeq: 1, acceptedAt: 100,
        coverage: 'one_report_summary' }, configuration: { model: 'sources/synthetic/model.json', outbound: 'sources/synthetic/outbound.json' },
      recipientId: 'synthetic-recipient', endpoint: 'https://synthetic.invalid/v1/chat/completions', account: 'synthetic-account',
      model: 'synthetic-model', language: 'en', readiness: { ready: true, reason: 'ready' },
    } }; },
    revalidate: () => { counts.validations++; return true; }, dispose: () => {},
    run: async () => { counts.runs++; return doc(); }, ...overrides,
  });
  const context: DigestPageContext = { state: data.state, monitor: { tree: data.tree, frame: renderMonitor(data) },
    surfaces: { settingsPage: null, settingsLeave: null, activityHub: null, observability: null, logsOpen: false },
    mainPane: true, mouse: true, closed: false, home: '/synthetic/unused', env: {}, target, scope: 'root/selection',
    frameRoot: 'root', currentRoot: 'root', frameEpoch: 1, currentEpoch: 1 };
  let modal = renderDigestModal(panel.snapshot, 80, 20);
  const paint = () => {
    counts.paints++;
    context.monitor.frame = renderMonitor({ ...data, state: context.state, delegatedDigest: panel.snapshot });
    modal = renderDigestModal(panel.snapshot, 80, 20, page.offset);
  };
  const page = new DelegatedDigestPage(panel, {
    context: () => context, sync: () => page.synchronize(), modalFrame: () => modal,
    setState: (next) => { context.state = next; }, paint,
    focusPanel: () => { counts.panelFocus++; }, focusMain: () => { counts.mainFocus++; },
    pauseModels: () => { counts.pauses++; }, close: () => { context.closed = true; },
    forward: (text) => forwarded.push(text), timeAsync: async (_name, work) => { await work(); },
  });
  const read = (events: WorkbenchInput[]) => [...page.inputs(events)];
  page.synchronize();
  return { page, panel, context, counts, forwarded, read, paint, doc, modal: () => modal };
}
const prefix: WorkbenchInput = { type: 'command', command: 'delegation-digest' };
const typed: WorkbenchInput = { type: 'key', key: 'delegation-digest', raw: 'D' };
const enter: WorkbenchInput = { type: 'key', key: 'enter', raw: '\r' };

test('production read routes visible key/prefix/click, preserves main forwarding and never runs on first activation', async () => {
  for (const mode of ['main', 'keys', 'standalone', 'prefix', 'click'] as const) {
    const h = pageHarness();
    h.context.state.keys = mode === 'keys'; h.context.mainPane = mode !== 'standalone';
    const button = h.context.monitor.frame!.controls.find((item) => item.kind === 'delegation-digest')!;
    assert.ok(button);
    const event: WorkbenchInput = mode === 'prefix' ? prefix : mode === 'click'
      ? { type: 'mouse', button: 'left', x: button.x, y: button.y } : typed;
    assert.deepEqual(h.read([event]), []);
    if (mode === 'main') {
      assert.deepEqual(h.forwarded, ['D']); assert.equal(h.counts.plans, 0);
    } else {
      await until(() => h.panel.snapshot.phase === 'confirm');
      assert.equal(h.counts.plans, 1); assert.equal(h.counts.runs, 0); assert.deepEqual(h.forwarded, []);
      assert.deepEqual(h.read([enter, enter, typed, { type: 'paste', text: 'D\r' }]), []);
      await until(() => h.panel.snapshot.phase === 'result'); await tick();
      assert.equal(h.counts.runs, 1); assert.equal(h.context.state.keys, true);
      assert.equal(h.context.state.focus, 'details'); assert.equal(h.context.state.scroll.details, 0);
    }
    h.page.shutdown();
  }
});

test('each real obscuring state rejects named Digest before ordinary dismissal/queue; literal search D survives', () => {
  for (const surface of ['settingsPage', 'settingsLeave', 'dirtySettings', 'help', 'activity', 'find', 'observability', 'logs'] as const) {
    const h = pageHarness();
    if (surface === 'help') h.context.state.help = true;
    else if (surface === 'logs') h.context.surfaces.logsOpen = true;
    else if (surface === 'activity' || surface === 'find') h.context.surfaces.activityHub = { tab: surface === 'find' ? 'find' : 'inbox', query: '' };
    else if (surface === 'observability') h.context.surfaces.observability = { tab: 'evidence' };
    else if (surface === 'dirtySettings') {
      h.context.surfaces.settingsPage = { draft: { briefingPaused: true }, original: { briefingPaused: false } };
      h.context.surfaces.settingsLeave = { choice: 'cancel', destination: 'help' };
    } else h.context.surfaces[surface] = surface === 'settingsLeave' ? { choice: 'cancel' } : { draft: {}, original: {} };
    const before = JSON.stringify(h.context.surfaces);
    let dismissals = 0; const queued: WorkbenchInput[] = [];
    for (const input of h.page.inputs([prefix])) { dismissals++; queued.push(input); }
    assert.equal(dismissals, 0, surface); assert.deepEqual(queued, []); assert.equal(h.counts.plans, 0);
    assert.equal(JSON.stringify(h.context.surfaces), before, 'the original dirty destination is unchanged');
    assert.deepEqual(h.read([typed]), [typed], 'literal D is delivered intact to the existing surface text handler');
    h.context.state.help = false;
    h.context.surfaces = { settingsPage: null, settingsLeave: null, activityHub: null, observability: null, logsOpen: false };
    assert.deepEqual(h.read([]), []); assert.equal(h.counts.plans, 0, 'dismissal later does not queue Digest');
    h.page.shutdown();
  }
});

test('whole production read remains owned after Esc, Cancel, Pause, another modal or shutdown', async () => {
  for (const kind of ['escape', 'cancel-click', 'brief-toggle', 'settings', 'help', 'main', 'activity-hub', 'find-agent', 'observability', 'quit'] as const) {
    const h = pageHarness();
    assert.deepEqual(h.read([prefix, enter, prefix]), []);
    await until(() => h.panel.snapshot.phase === 'confirm');
    assert.equal(h.counts.runs, 0, 'same-read trailing Enter cannot bypass asynchronous planning');
    const cancel = h.modal().controls.find((control) => control.kind === 'cancel')!;
    const event: WorkbenchInput = kind === 'cancel-click' ? { type: 'mouse', button: 'left', x: cancel.x, y: cancel.y }
      : kind === 'quit' ? { type: 'command', command: 'quit' } : { type: 'key', key: kind };
    const rest: WorkbenchInput[] = [typed, enter, prefix, { type: 'paste', text: 'private synthetic bytes' },
      { type: 'key', key: '', raw: 'remaining bytes' }];
    assert.deepEqual(h.read([event, ...rest]), [], kind);
    assert.deepEqual(h.forwarded, []); assert.equal(h.counts.runs, 0); assert.equal(h.counts.plans, 1);
    assert.equal(h.panel.snapshot.phase, 'idle');
    assert.equal(h.counts.pauses, kind === 'brief-toggle' ? 1 : 0);
    if (kind !== 'quit') { h.read([typed]); assert.deepEqual(h.forwarded, ['D'], 'the next read resumes ordinary ownership'); }
    h.page.shutdown();
  }
});

test('production synchronization cancels on root, selection, every full target component, overlay and shutdown', async () => {
  for (const change of ['root', 'selection', 'ledger', 'link', 'run', 'report', 'source', 'harness', 'session', 'thread', 'overlay', 'shutdown'] as const) {
    const h = pageHarness(); h.read([prefix]); await until(() => h.panel.snapshot.phase === 'confirm');
    if (change === 'root' || change === 'selection') h.context.scope += change;
    else if (change === 'overlay') h.context.surfaces.settingsLeave = { choice: 'cancel' };
    else if (change === 'shutdown') h.context.closed = true;
    else {
      const target = h.context.target!;
      const fields: Record<string, 'ledgerId' | 'linkId' | 'runId' | 'reportId'> = { ledger: 'ledgerId', link: 'linkId', run: 'runId', report: 'reportId' };
      const key = fields[change];
      if (key) h.context.target = { ...target, [key]: `changed-${change}` };
      else {
        const ref = { ...target.ref };
        if (change === 'source') ref.sourceId = 'b'.repeat(64);
        if (change === 'harness') ref.harness = ref.harness === 'claude' ? 'codex' : 'claude';
        if (change === 'session') ref.sessionId = 'changed-session';
        if (change === 'thread') ref.threadId = 'changed-thread';
        h.context.target = { ...target, ref };
      }
    }
    h.page.synchronize(); assert.equal(h.panel.snapshot.phase, 'idle', change);
    h.read([enter]); assert.equal(h.counts.runs, 0); h.page.shutdown();
  }
});

test('production success receipt fences A cancel / same-target B success / B UI change / A late cleanup', async () => {
  let completeA!: (value: DigestDocument) => void;
  let calls = 0;
  let successful!: DigestDocument;
  const h = pageHarness({ run: async () => {
    calls++;
    return calls === 1 ? new Promise<DigestDocument>((resolve) => { completeA = resolve; }) : successful;
  } });
  successful = h.doc();
  h.read([prefix]); await until(() => h.panel.snapshot.phase === 'confirm');
  const a = h.page.confirm();
  await h.page.confirm(); // no-op/double confirmation must not produce a receipt
  assert.equal(calls, 1);
  h.read([{ type: 'key', key: 'escape' }]);
  h.read([prefix]); await until(() => h.panel.snapshot.phase === 'confirm');
  await h.page.confirm(); assert.equal(calls, 2);
  const b = h.panel.snapshot;
  h.context.state = { ...h.context.state, keys: false, focus: 'changes', preview: 'file',
    scroll: { ...h.context.state.scroll, details: 17 } };
  const state = h.context.state; const paints = h.counts.paints; const focused = h.counts.panelFocus;
  completeA(h.doc()); await a; await h.page.confirm();
  assert.equal(h.context.state, state); assert.equal(h.panel.snapshot, b);
  assert.equal(h.counts.paints, paints, 'late/no-op continuations do not even repaint');
  assert.equal(h.counts.panelFocus, focused);
  h.page.shutdown();
});

test('production shutdown/cancel during asynchronous cleanup prevents all delayed completion effects', async () => {
  for (const shutdown of [false, true]) {
    let settle!: (value: DigestDocument) => void;
    const h = pageHarness({ run: () => new Promise<DigestDocument>((resolve) => { settle = resolve; }) });
    h.read([prefix]); await until(() => h.panel.snapshot.phase === 'confirm');
    const request = h.page.confirm();
    if (shutdown) { h.context.closed = true; h.page.shutdown(); }
    else h.read([{ type: 'key', key: 'escape' }]);
    const state = h.context.state; const paints = h.counts.paints;
    settle(h.doc()); await request;
    assert.equal(h.context.state, state); assert.equal(h.counts.paints, paints); assert.equal(h.panel.snapshot.phase, 'idle');
  }
});

test('default/workbench D, monitor raw order, left arrow and paste retain exact decoder meanings', () => {
  for (const forward of [false, true]) {
    for (const profile of [undefined, 'workbench'] as const)
      assert.deepEqual(new WorkbenchInputDecoder(profile, { forward }).push(Buffer.from('D')),
        forward ? [{ type: 'key', key: '', raw: 'D' }] : []);
    assert.deepEqual(new WorkbenchInputDecoder('monitor', { forward }).push(Buffer.from('dD')),
      forward ? [{ type: 'key', key: 'diagnostics', raw: 'd' }, { type: 'key', key: 'delegation-digest', raw: 'D' }]
        : [{ type: 'key', key: 'diagnostics' }, { type: 'key', key: 'delegation-digest' }]);
  }
  const decoder = new WorkbenchInputDecoder('monitor', { forward: true });
  assert.deepEqual(decoder.push(Buffer.from('\x1b[D')), [{ type: 'key', key: 'left', raw: '\x1b[D' }]);
  assert.deepEqual(decoder.push(Buffer.from('\x1b[200~D\x1b[201~')), [{ type: 'paste', text: 'D' }]);
  const split = new WorkbenchInputDecoder('monitor', { forward: true });
  const inputs: WorkbenchInput[] = [];
  for (const byte of Buffer.from(commandSequence('delegation-digest'))) inputs.push(...split.push(Buffer.from([byte])));
  assert.deepEqual(inputs, [{ type: 'command', command: 'delegation-digest' }]);
  assert.equal(PANEL_COMMANDS.filter((command) => command === 'delegation-digest').length, 1);
});


test('actual dead-panel command with fake tmux never toggles Digest; legacy help still opens', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'f4-panel-input-synthetic-'));
  try {
    const bin = join(root, 'bin'); fs.mkdirSync(bin);
    fs.copyFileSync(resolve('bin/codex-hud-command'), join(bin, 'codex-hud-command'));
    fs.writeFileSync(join(bin, 'codex-hud-toggle'), '#!/bin/bash\nprintf "toggle %s\\n" "$*" >> "$TRACE"\n', { mode: 0o700 });
    fs.writeFileSync(join(bin, 'tmux'), '#!/bin/bash\nprintf "%s\\n" "$*" >> "$TRACE"\ncase "$1" in\n display-message) printf "%s\\n" "%777";;\n send-keys) exit 1;;\n show-option) printf "%s\\n" "%42";;\nesac\n', { mode: 0o700 });
    const trace = join(root, 'trace');
    const options = { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root, HUD_HOME: join(root, 'hud'), TRACE: trace } };
    execFileSync('/bin/bash', [join(bin, 'codex-hud-command'), '$synthetic', 'delegation-digest'], options);
    const digest = fs.readFileSync(trace, 'utf8');
    assert.match(digest, /send-keys -t %777 -H/);
    assert.doesNotMatch(digest, /toggle|main_pane/);
    execFileSync('/bin/bash', [join(bin, 'codex-hud-command'), '$synthetic', 'help'], options);
    assert.match(fs.readFileSync(trace, 'utf8'), /^toggle \$synthetic --command help$/m);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
