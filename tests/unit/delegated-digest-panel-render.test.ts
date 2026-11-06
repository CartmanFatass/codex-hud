import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { DelegatedDigestPanel, DelegatedDigestPage, type DigestPageContext } from '../../src/collectors/delegated-digest-panel.js';
import type { WorkbenchInput } from '../../src/utils/workbench-input.js';
import { tick } from '../fixtures/delegated-digest.js';
import { digestPanelTarget, digestActionCurrent, digestTargetStamp, digestFrameTarget, digestInspectorLines, renderDigestModal,
  type DigestPanelSnapshot, type DigestPanelTarget } from '../../src/render/delegated-digest.js';
import { setLanguage } from '../../src/render/i18n.js';
import { stripAnsi, visualLength } from '../../src/render/colors.js';
import { renderMonitor } from '../../src/render/monitor.js';
import { buildVm, S, NOW } from '../fixtures/b10b-delegation.js';
import { draw, press, click, monitorInput } from '../fixtures/b10b-s3.js';

function selected() {
  const built = buildVm([{ id: 'main', root: true, status: S.working() },
    { id: 'one', parent: 'main', status: S.working(), report: { status: 'completed', summary: 'Original report fact.', at: NOW } }]);
  built.vm.tree.ledger.state = 'available';
  const node = built.vm.tree.nodes.find((item) => item.key === built.keys.one)!;
  node.links = [node.currentRun!.linkId];
  return { ...built, node };
}
function snapshot(target: DigestPanelTarget): DigestPanelSnapshot {
  return { phase: 'confirm', target, confirmation: { target, endpoint: 'https://synthetic.invalid/v1/chat/completions',
    account: 'Synthetic account', model: 'synthetic-model', language: 'en', ready: true, reason: 'unavailable',
    modelFile: `sources/${target.ref.sourceId}/model.json`, outboundFile: `sources/${target.ref.sourceId}/outbound.json` } };
}

test('real monitor Digest key/click parity for both languages and widths 32/40/48/56/80; hidden means inactive', () => {
  const previous = setLanguage('en');
  try {
    for (const language of ['en', 'zh'] as const) for (const width of [32, 40, 48, 56, 80]) {
      setLanguage(language);
      const built = selected();
      const frame = draw(built.vm, { selected: built.keys.one, width, height: 30 });
      const control = frame.controls.find((item) => item.kind === 'delegation-digest');
      const key = press(frame, 'delegation-digest');
      assert.equal(key.action?.type === 'delegation-digest', Boolean(control), `${language}/${width}`);
      if (control) {
        assert.deepEqual(click(frame, control.x, control.y).action, key.action);
        assert.match(frame.lines.map(stripAnsi).join('\n'), language === 'zh' ? /总结/ : /Digest/);
      }
      for (const line of frame.lines) assert.equal(visualLength(line), width);
    }
    for (const height of [0, 1]) {
      const built = selected();
      const frame = draw(built.vm, { selected: built.keys.one, width: 1, height });
      assert.equal(press(frame, 'delegation-digest').action, undefined);
    }
  } finally { setLanguage(previous); }
});

test('legacy/root/native/intent/job/unloaded/conflict/ambiguous/foreign-run/noncompleted targets cannot plan', () => {
  assert.equal(press(draw(undefined), 'delegation-digest').action, undefined);
  for (const kind of ['root', 'native', 'intent', 'job', 'unloaded', 'conflict', 'duplicate', 'foreign-run', 'failed', 'degraded', 'missing-report']) {
    const built = selected();
    const report = built.vm.details[built.node.key].latestReportForRun!;
    if (kind === 'root') built.node.parentKey = null;
    if (kind === 'native') built.node.edge = 'native';
    if (kind === 'intent') built.node.identity = { kind: 'delegationIntent', linkId: 'synthetic-link' };
    if (kind === 'job') built.node.identity = { kind: 'job', ref: { kind: 'jev', provider: 'synthetic', key: 'synthetic-job' } };
    if (kind === 'unloaded') built.node.loaded = false;
    if (kind === 'conflict') built.node.conflict = { count: 1, since: NOW, recordIds: ['synthetic-conflict'] };
    if (kind === 'duplicate') built.vm.tree.nodes.push({ ...built.node });
    if (kind === 'foreign-run') report.runId = 'other-run';
    if (kind === 'failed') report.status = 'failed';
    if (kind === 'degraded') built.vm.tree.ledger.state = 'degraded';
    if (kind === 'missing-report') built.vm.details[built.node.key].latestReportForRun = null;
    assert.equal(digestPanelTarget(built.vm, built.node.key), null, kind);
  }
});

test('complete identities distinguish matching short IDs and the frame is the input authority for candidates', () => {
  const built = selected();
  const frame = draw(built.vm, { selected: built.node.key, width: 120 });
  const target = digestFrameTarget(frame.delegation, built.node.key)!;
  assert.ok(target);
  for (const other of [{ ...target, ledgerId: 'other' }, { ...target, linkId: 'other' },
    { ...target, ref: { ...target.ref, threadId: 'other' } },
    { ...target, ref: { ...target.ref, sourceId: target.ref.sourceId.slice(0, 12) + 'b'.repeat(52) } }])
    assert.notEqual(digestTargetStamp(other), digestTargetStamp(target));
  const stale = structuredClone(built.vm);
  stale.details[target.key].latestReportForRun!.reportId = 'new-report';
  assert.notEqual(digestTargetStamp(digestPanelTarget(stale, target.key)), digestTargetStamp(target));
  assert.deepEqual(press(frame, 'delegation-digest').action, { type: 'delegation-digest', target });
});

test('confirmation is wrapped, bilingual, scrollable, exact and contains no report body or local path', () => {
  const previous = setLanguage('en');
  try {
    const built = selected();
    const target = digestPanelTarget(built.vm, built.node.key)!;
    for (const language of ['en', 'zh'] as const) for (const width of [32, 40, 48, 56, 80]) {
      setLanguage(language);
      const shown = snapshot(target);
      const first = renderDigestModal(shown, width, 12);
      const last = renderDigestModal(shown, width, 12, 1000);
      assert.ok(first.maxOffset > 0);
      assert.equal(last.offset, last.maxOffset);
      assert.ok(first.controls.some((control) => control.kind === 'confirm'));
      for (const line of [...first.lines, ...last.lines]) assert.equal(visualLength(line), width);
      const all = renderDigestModal(shown, 120, 80).lines.join('\n');
      assert.match(all, new RegExp(target.ref.sourceId));
      assert.match(all, new RegExp(target.reportId));
      assert.match(all, /synthetic\.invalid\/v1\/chat\/completions/);
      assert.doesNotMatch(all, /Original report fact|PRIVATE|\/home\//);
      assert.match(all, language === 'zh' ? /来源专用摘要配置/ : /Per-source digest configuration/);
    }
  } finally { setLanguage(previous); }
});

test('parsed summary is distinct from report/status, bounded and escaped; other selection never sees it', () => {
  const built = selected();
  const target = digestPanelTarget(built.vm, built.node.key)!;
  const result: DigestPanelSnapshot = { phase: 'result', target, result: { generatedAt: 100, model: 'synthetic-model', cached: true,
    conclusion: 'MODEL_ONLY\u001b[31m\u202econtrol\ntext', basis: 'Synthetic basis.', caveats: 'Synthetic caveat.' } };
  for (const width of [32, 40, 48, 56, 80]) {
    const lines = digestInspectorLines(result, target, width);
    assert.ok(lines.every((line) => visualLength(line) <= width));
    assert.doesNotMatch(lines.join(''), /[\x00-\x1f\u202a-\u202e]/);
    assert.match(lines.join(''), /\\x1b/);
    assert.match(lines.join(''), /1970-01-01T00:00:00.100Z/);
  }
  assert.deepEqual(digestInspectorLines(result, { ...target, reportId: 'other' }, 80), []);
  const data = monitorInput(built.vm, { selected: target.key, width: 120, height: 60 });
  data.state.focus = 'details'; data.state.preview = 'agent'; data.state.modes.details = 'open'; data.state.zoom = true;
  const frame = renderMonitor({ ...data, delegatedDigest: result });
  const details = frame.panes.find((pane) => pane.id === 'details')!.rows.map((row) => stripAnsi(row.text)).join('\n');
  assert.match(details, /Original report fact/);
  assert.match(details, /Model summary · one completed report/);
  assert.match(details, /MODEL_ONLY/);
  assert.equal(built.vm.details[target.key].latestReportForRun!.summary, 'Original report fact.');
  assert.equal(built.node.execution.isRunTerminal, false);
  assert.ok(frame.panes.filter((pane) => pane.id !== 'details').every((pane) => pane.rows.every((row) => !row.text.includes('MODEL_ONLY'))));
});

test('pure renderMonitor cost (not full paint/collection): three runs of unchanged and changed summary inputs, no historical workload', (context) => {
  const built = selected();
  const target = digestPanelTarget(built.vm, built.node.key)!;
  const data = monitorInput(built.vm, { selected: target.key, width: 80, height: 30 });
  data.state.focus = 'details'; data.state.modes.details = 'open';
  for (const changing of [false, true]) for (let run = 0; run < 3; run++) {
    const samples: number[] = [];
    for (let i = 0; i < 220; i++) {
      const start = performance.now();
      renderMonitor({ ...data, delegatedDigest: { phase: 'result', target,
        result: { generatedAt: 100, model: 'synthetic-model', cached: true, conclusion: `Synthetic ${changing ? i : 0}` } } });
      if (i >= 20) samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    context.diagnostic(JSON.stringify({ mode: changing ? 'changed' : 'unchanged', run, n: samples.length, warmup: 20,
      p50: samples[99], p95: samples[189], p99: samples[197], max: samples[199],
      host: `${process.platform}/${process.arch}/${process.version}`, scope: 'synthetic two-node panel only; not WSL qualification' }));
    assert.ok(samples[197] < 50, 'pure render component p99 < 50 ms');
    assert.ok(samples[199] < 200, 'pure render component max < 200 ms');
    if (!changing) assert.ok(samples[197] <= 2, 'unchanged pure render component p99 <= 2 ms');
  }
});

test('disabled/absent controls, missing target and non-agent focus have no invisible Digest action', () => {
  const built = selected();
  const frame = draw(built.vm, { selected: built.node.key, width: 120 });
  const button = frame.controls.find((control) => control.kind === 'delegation-digest')!;
  assert.ok(button);
  const disabled = { ...frame, controls: frame.controls.map((control) => control === button ? { ...control, disabled: true } : control) };
  assert.equal(press(disabled, 'delegation-digest').action, undefined);
  assert.equal(click(disabled, button.x, button.y).action, undefined);
  assert.equal(press({ ...frame, digestTarget: null }, 'delegation-digest').action, undefined);
  assert.equal(press({ ...frame, controls: [] }, 'delegation-digest').action, undefined);
  const state = { ...frame.state, focus: 'changes' as const, modes: { ...frame.state.modes, changes: 'open' as const } };
  const changes = draw(built.vm, { state, width: 120 });
  assert.equal(changes.controls.some((control) => control.kind === 'delegation-digest'), false);
  assert.equal(press(changes, 'delegation-digest').action, undefined);
});


test('pure full-identity dispatch predicate rejects stale root, collection, selection and full report identity', () => {
  const built = selected();
  const target = digestPanelTarget(built.vm, built.node.key)!;
  const current = { frameRoot: 'root', currentRoot: 'root', frameEpoch: 3, currentEpoch: 3, currentTarget: target };
  assert.equal(digestActionCurrent(target, current), true);
  assert.equal(digestActionCurrent(target, { ...current, currentRoot: 'new-root' }), false);
  assert.equal(digestActionCurrent(target, { ...current, currentEpoch: 4 }), false);
  for (const currentTarget of [null, { ...target, key: 'other-selection' }, { ...target, reportId: 'other-report' },
    { ...target, ledgerId: 'other-ledger' }, { ...target, ref: { ...target.ref, threadId: 'other-thread' } }])
    assert.equal(digestActionCurrent(target, { ...current, currentTarget }), false);
});


test('production page consumes real rendered key/prefix/click visibility and frame identity in EN/ZH at all requested widths', async () => {
  const previous = setLanguage('en');
  try {
    for (const language of ['en', 'zh'] as const) for (const width of [32, 40, 48, 56, 80]) {
      setLanguage(language);
      for (const mode of ['key', 'prefix', 'click', 'disabled', 'stale-root', 'stale-epoch', 'stale-target'] as const) {
        const built = selected();
        const data = monitorInput(built.vm, { selected: built.node.key, width, height: 30 });
        const frame = renderMonitor(data);
        const button = frame.controls.find((control) => control.kind === 'delegation-digest');
        const target = digestPanelTarget(built.vm, built.node.key)!;
        let plans = 0; let runs = 0;
        const panel = new DelegatedDigestPanel({ prepare: async () => { plans++; throw new Error('synthetic metadata refusal'); },
          run: async () => { runs++; throw new Error('never run'); }, revalidate: () => true, dispose: () => {} });
        const context: DigestPageContext = { state: data.state, monitor: { tree: data.tree, frame },
          surfaces: { settingsPage: null, settingsLeave: null, activityHub: null, observability: null, logsOpen: false },
          mainPane: false, mouse: true, closed: false, home: '/synthetic/unused', env: {}, target, scope: 'root',
          frameRoot: 'root', currentRoot: 'root', frameEpoch: 1, currentEpoch: 1 };
        if (mode === 'disabled') context.monitor.frame = { ...frame,
          controls: frame.controls.map((control) => control === button ? { ...control, disabled: true } : control) };
        if (mode === 'stale-root') context.currentRoot = 'new-root';
        if (mode === 'stale-epoch') context.currentEpoch++;
        if (mode === 'stale-target') context.target = { ...target, reportId: 'new-report' };
        const page = new DelegatedDigestPage(panel, { context: () => context, sync: () => page.synchronize(),
          modalFrame: () => undefined, setState: (next) => { context.state = next; }, paint: () => {},
          focusPanel: () => {}, focusMain: () => {}, close: () => { context.closed = true; }, pauseModels: () => {},
          forward: () => { throw new Error('standalone must not forward'); }, timeAsync: async (_name, work) => { await work(); } });
        const input: WorkbenchInput = mode === 'prefix' ? { type: 'command', command: 'delegation-digest' }
          : mode === 'click' ? { type: 'mouse', button: 'left', x: button?.x ?? 0, y: button?.y ?? 0 }
            : { type: 'key', key: 'delegation-digest', raw: 'D' };
        [...page.inputs([input])]; await tick();
        const allowed = Boolean(button && ['key', 'prefix', 'click'].includes(mode));
        assert.equal(plans, allowed ? 1 : 0, `${language}/${width}/${mode}`);
        assert.equal(runs, 0); page.shutdown();
      }
    }
  } finally { setLanguage(previous); }
});
