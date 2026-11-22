import { withState } from '../fixtures/state-helpers.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { initialMonitorState } from '../../dist/render/monitor.js';
import { acceptsRawText, blocksReload, hasUnsavedDraft } from '../../dist/render/monitor-state.js';

test('overlay policy distinguishes a reload blocker from a draft and a raw-text consumer', () => {
  const role = { role: 'synthetic' }, picker = { text: '', place: {} };
  const places = { kind: 'places' }, form = { kind: 'sheet', index: 0, field: 'target' };
  const chain = (mode, draft) => ({ kind: 'control-chain', role, at: 0, mode, draft });
  const preset = (mode, text = '') => ({ kind: 'control-preset', sheet: { role, mode, ...(mode === 'delete' ? {} : { text }), ...(mode === 'list' ? { at: 0 } : {}) } });
  const cases = [
    // Overlay, unsaved draft, blocks reload, accepts text.
    [undefined, false, false, false],
    [{ kind: 'confirm-stop', role: role.role, jobId: 'j0000000000000000', dir: 'synthetic' }, false, true, true],
    [{ kind: 'control-quick-model', role, index: 0, picker }, true, true, true],
    [{ kind: 'control-harness-add', text: '' }, true, true, true],
    [{ kind: 'exp-edit', entryId: 'alias', draft: { text: '', pick: 0 } }, true, true, true],
    [preset('list'), false, true, true],
    [preset('list', 'x'), true, true, true],
    [preset('copy'), true, true, true],
    [preset('empty'), true, true, true],
    [preset('rename'), true, true, true],
    [preset('delete'), true, true, false],
    [chain(places), false, false, false],
    [chain(places, { run: [] }), true, true, false],
    [chain({ kind: 'confirm-leave', leave: { type: 'key', key: 'escape' }, resume: places }, { run: [] }), true, true, false],
    [chain(form), true, true, false],
    [chain({ ...form, input: { kind: 'choice', text: '', at: 0 } }), true, true, true],
    [chain({ ...form, field: 'model', input: { kind: 'pi-model-picker', picker } }), true, true, true],
    [chain({ kind: 'quick-model', index: 0, picker }), true, true, true],
  ];
  const initial = initialMonitorState();
  for (const [overlay, draft, blocked, raw] of cases) {
    const state = { ...initial, overlay };
    assert.deepEqual([hasUnsavedDraft(state), blocksReload(state), acceptsRawText(state)], [draft, blocked, raw], JSON.stringify(overlay));
  }
  const help = { ...initial, overlay: chain(places, { run: [] }), help: {} };
  assert.deepEqual([blocksReload(help), acceptsRawText(help)], [true, false]);
  const kept = withState(initial, { home: { filter: { query: 'sonic', editing: false } } }), typing = withState(kept, { home: { filter: { editing: true } } });
  assert.deepEqual([blocksReload(kept), acceptsRawText(kept)], [false, false]);
  assert.deepEqual([blocksReload(typing), acceptsRawText(typing)], [true, true]);
});
