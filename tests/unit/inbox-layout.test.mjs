import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inboxFixture, inboxFrames, harbor, plain, NOW } from '../fixtures/inbox.mjs';
import { initialMonitorState, handleMonitorInput, monitorSettings } from '../../dist/render/monitor.js';
import { SETTING_ROWS, resetSettingsGroup, valueText } from '../../dist/render/settings-page.js';
import { defaultSettings, loadSettings, saveSettings } from '../../dist/settings.js';
import { setLanguage } from '../../dist/render/i18n.js';
import { visualLength, stripAnsi } from '../../dist/render/colors.js';
import { WorkbenchInputDecoder } from '../../dist/utils/workbench-input.js';
const expected = JSON.parse(fs.readFileSync(new URL('../fixtures/inbox-frames.json', import.meta.url), 'utf8'));
function scene(t, options) {
  const root = fs.mkdtempSync(join(tmpdir(), 'inbox-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return inboxFixture(root, options);
}
const TREE = { rootId: '', nodes: [], totalCount: 0, updatedAt: new Date(NOW) };
const ctx = (frame) => ({ tree: TREE, frame, nowMs: NOW, standalone: true });
const decoder = new WorkbenchInputDecoder('workboard');
const press = (frame, raw) => handleMonitorInput(frame.state, decoder.push(Buffer.from(raw))[0], ctx(frame));
const at = (lines, pattern) => lines.findIndex((l) => pattern.test(l));

test('Inbox frames at 40 columns (busy, 24 rows, idle, hub, Progress; EN and ZH) match the snapshot and fill every row exactly', (t) => {
  const busy = scene(t), idle = scene(t, { idle: true });
  assert.deepEqual(inboxFrames(busy, idle), expected);
  for (const frame of [busy.render(40, {}), busy.render(40, { height: 24 }), busy.render(40, { tab: 'project', height: 30 }), busy.render(40, { tab: 'project', page: 'progress' })])
    for (const line of frame.lines) assert.equal(visualLength(line), 40, stripAnsi(line));
});

test('Home busy: the question first, the waiting count, then jobs by need; the package leads each title', (t) => {
  const lines = plain(scene(t).render(40, {}));
  const order = [/^\? imp · SYNC-QUEUE +asking/, /^\? 3 waiting for you · 2 to try +▸$/, /^Jobs .* 3 running · 1 failed$/, /^✗ sonic +EXPORT-CSV slow run/, /SYNC-QUEUE retry on 429/,
    /DOCS-SWEEP › Tidy the chang/, /AUTH-REFRESH rotation/, /SYNC-QUEUE tests +done/, /^this session /, /^Decided for you .* 3 · 1 worth a look$/, /^ +▸ 2 as proposed$/, /^Progress .* Milestone M3$/].map((p) => at(lines, p));
  assert.ok(order.every((i) => i >= 0), JSON.stringify(order));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'ranked by need, not by package');
  const text = lines.join('\n');
  assert.doesNotMatch(text, /Nothing needs you|waiting for you · \d+ running|┃ …|qa\/q|2 options|Waiting for you ─|Tickets/, 'no top line, lane header, path row, placeholder, summary, waiting list or tickets');
  assert.match(text, /● a +keep it for one more release\n┃ +b +drop it with this change/, 'the options listed, the default marked');
  // A job is a title row and one sentence row only while it runs or when it went wrong; a finished one is its title row.
  assert.match(text, /SYNC-QUEUE retry on 429 +47m\n┃ fixing the retry cap finding/);
  assert.match(text, /failed 9m\n┃ HTTP 429 on the second request; no\n┃ report was written\./);
  assert.doesNotMatch(text, /SYNC-QUEUE tests +done 2m\n┃/);
});

test('Home idle lists every waiting item and Latest, and keeps the settled jobs as rows', (t) => {
  const text = plain(scene(t, { idle: true }).render(40, {})).join('\n');
  assert.match(text, /^Waiting for you ─+ 3 · 2 to try\n\? Try AUDIT-LOG: read one audit row\n\? Try EXPORT-CSV: header and quoting\n\? Choose the browser profile$/m);
  assert.match(text, /Jobs ─+ 1 failed/);
  assert.match(text, /^Latest ─+ newest first\n +◇ AUDIT-LOG +to try 3h/m);
});

test('Home at 24 rows gives way in order and never loses the question, the waiting count, the failure or a running job', (t) => {
  const busy = scene(t), lines = plain(busy.render(40, { height: 24 }));
  assert.equal(lines.length, 24);
  for (const must of [/^\? imp · SYNC-QUEUE/, /Keep the v1 shim/, /^\? 3 waiting for you/, /✗ sonic +EXPORT-CSV/, /SYNC-QUEUE retry on 429/, /DOCS-SWEEP/, /AUTH-REFRESH/, /retryPolicy callers/, /scan tests/])
    assert.ok(at(lines, must) >= 0, String(must));
  const text = lines.join('\n');
  assert.doesNotMatch(text, /^Jobs /m, 'headers go first');
  assert.doesNotMatch(text, /comparing the rotation window/, 'one sentence is kept for a running job, the longest');
  assert.match(text, /fixing the retry cap finding/);
  assert.doesNotMatch(text, /report was written/, 'the failure keeps one reason row');
  assert.match(text, /◆ 3 decided for you · 1 worth a look +▸/);
  // More rows keep more: every extra row brings something back until the full frame.
  let last = 0;
  for (const height of [24, 26, 28, 30, 34, 40, 48]) {
    const shown = plain(busy.render(40, { height })).filter((l) => l.trim()).length;
    assert.ok(shown >= last, `${height}: ${shown} < ${last}`);
    last = shown;
  }
});

test('Classic is untouched: no setting and Classic draw the same frames; Inbox and Split differ', (t) => {
  const busy = scene(t), idle = scene(t, { idle: true });
  for (const f of [busy, idle]) for (const opts of [{}, { height: 24 }, { tab: 'project', height: 30 }, { tab: 'project', page: 'progress' }]) {
    const bare = plain(f.render(40, { ...opts, state: { ...initialMonitorState(), mainTab: opts.tab ?? 'home', projectPage: opts.page, projectFolded: new Set(['agents', 'healthy', 'files']) }, height: opts.height ?? 48 }));
    assert.deepEqual(plain(f.render(40, { ...opts, layout: 'classic' })), bare);
    assert.notDeepEqual(plain(f.render(40, { ...opts, layout: 'split' })), bare);
    assert.notDeepEqual(plain(f.render(40, { ...opts, layout: 'inbox' })), bare);
  }
});

test('hub: what the owner owes is listed once, y accepts and n flags in place, t does nothing', (t) => {
  const busy = scene(t);
  let frame = busy.render(40, { tab: 'project', height: 30 });
  const lines = plain(frame);
  assert.equal(lines.filter((l) => /AUDIT-LOG/.test(l)).length, 1, 'the STATE item and the ledger slice are one row');
  assert.match(lines.join('\n'), /^Waiting for you ─+ 3 · 2 to try\n◇ AUDIT-LOG +read one audit row +3h\n◇ EXPORT-CSV +header and quoting +1d\n\? Choose the browser profile$/m);
  assert.match(lines.join('\n'), /Latest accepted[\s\S]*✓ RATE-LIMIT[\s\S]*Pages ─+\n◐ Progress +[█▒░]+ 3\/9\n\? Tickets +1\/3 done · 1 asks you\n○ Working tree/);
  assert.equal(frame.state.projectCursor, 'project:try:AUDIT-LOG', 'the cursor starts on what the owner owes');
  assert.match(lines.at(-1), /y accept  n flag  ⏎ open/);
  assert.deepEqual(press(frame, 'y').action, { type: 'record-try', action: 'accept', target: { milestone: 'M3', slices: [harbor().ledger.find((r) => r.id === 'AUDIT-LOG')] } });
  frame = busy.render(40, { tab: 'project', height: 30, state: press(frame, '\x1b[B').state });
  assert.equal(frame.state.projectCursor, 'project:try:EXPORT-CSV');
  const flag = press(frame, 'n').action;
  assert.equal(flag.type === 'record-try' && flag.action, 'flag');
  assert.deepEqual(flag.target.slices.map((s) => s.id), ['EXPORT-CSV']);
  // The item that is a STATE line is not a slice: no record.
  frame = busy.render(40, { tab: 'project', height: 30, state: { ...frame.state, projectCursor: 'project:wait:2' } });
  assert.equal(press(frame, 'y').action, undefined);
  // `t` filters nothing and leaves the state as it was.
  const before = JSON.stringify({ ...frame.state, tree: undefined });
  const after = press(frame, 't');
  assert.equal(after.action, undefined);
  assert.equal(JSON.stringify({ ...after.state, tree: undefined }), before);
});

test('hub: a recorded y or n shows at once (and leaves the to-try count); a short panel loses Latest first, never the owed rows', (t) => {
  const busy = scene(t);
  const marks = new Map([['AUDIT-LOG', 'accept'], ['EXPORT-CSV', 'flag']]);
  const text = plain(busy.render(40, { tab: 'project', height: 30, marks })).join('\n');
  assert.match(text, /^Waiting for you ─+ 3\n✓ AUDIT-LOG +accepted 3h\n⚑ EXPORT-CSV +flagged 1d\n\? Choose the browser profile$/m);
  for (const height of [24, 20, 16]) {
    const lines = plain(busy.render(40, { tab: 'project', height }));
    assert.ok(lines.some((l) => /AUDIT-LOG/.test(l)) && lines.some((l) => /Control plane/.test(l)) && lines.some((l) => /SYNC-QUEUE/.test(l)), `${height}\n${lines.join('\n')}`);
    if (height <= 20) assert.doesNotMatch(lines.join('\n'), /Latest accepted/);
  }
});

test('Enter on the waiting count lists them on the hub, where the cursor lands on the Waiting header', (t) => {
  const busy = scene(t);
  let frame = busy.render(40, {});
  const row = frame.workboard.rows.find((r) => r.item === 'home-progress:waiting');
  assert.ok(row);
  frame = busy.render(40, { state: { ...frame.state, boardAnchor: 'home-progress:waiting' } });
  const next = press(frame, '\r').state;
  assert.equal(next.mainTab, 'project');
  assert.equal(next.projectCursor, 'project:fold:waiting');
});

test('Progress: To try above Now, y and n on its rows, History holds accepted slices only, t does nothing', (t) => {
  const busy = scene(t);
  let frame = busy.render(40, { tab: 'project', page: 'progress', height: 50 });
  const lines = plain(frame);
  const idx = [/^To try ─+ 2$/, /^Now ─+ 3$/, /^Next ─+ 3$/, /^History ─+ newest first$/].map((p) => at(lines, p));
  assert.deepEqual(idx, [...idx].sort((a, b) => a - b));
  assert.ok(idx.every((i) => i >= 0), JSON.stringify(idx));
  const history = lines.slice(idx[3]).join('\n');
  assert.doesNotMatch(history, /AUDIT-LOG|EXPORT-CSV|to try/);
  assert.match(history, /✓ RATE-LIMIT[\s\S]*▸ M2 ✓ 9 accepted +11–19d\n▸ M1 ✓ 7 accepted +24–30d/);
  assert.equal(frame.state.projectCursor, 'project:try:AUDIT-LOG');
  assert.deepEqual(press(frame, 'y').action?.action, 'accept');
  assert.equal(press(frame, 'n').action?.action, 'flag');
  assert.equal(press(frame, 't').action, undefined);
  assert.equal(press(frame, 't').state.projectTry, undefined);
  assert.match(lines.at(-1), /y accept  n flag  ⏎ open  esc back/);
  // Esc goes back to the hub, as ever.
  assert.equal(handleMonitorInput(frame.state, { type: 'key', key: 'escape' }, ctx(frame)).state.projectPage, undefined);
});

test('the Layout setting: Classic by default, saved with the others, carried into the panel state and reset with its group', () => {
  assert.equal(defaultSettings().panelLayout, 'classic');
  const row = SETTING_ROWS.find((r) => r.key === 'panelLayout');
  assert.deepEqual([row.group, row.label, row.values], ['Panel', 'Layout', ['classic', 'inbox', 'split']]);
  assert.deepEqual(['classic', 'inbox', 'split'].map((v) => valueText(row, v)), ['Classic', 'Inbox', 'Split']);
  setLanguage('zh');
  try { assert.deepEqual(['classic', 'inbox', 'split'].map((v) => valueText(row, v)), ['经典', '收件箱', '分栏']); } finally { setLanguage('en'); }
  assert.equal(monitorSettings(defaultSettings()).panelLayout, 'classic');
  assert.equal(monitorSettings({ ...defaultSettings(), panelLayout: 'inbox' }).panelLayout, 'inbox');
  assert.equal(resetSettingsGroup({ ...defaultSettings(), panelLayout: 'inbox' }, 'Panel').panelLayout, 'classic');
  const home = fs.mkdtempSync(join(tmpdir(), 'inbox-settings-')), path = join(home, 'hud-settings.json'), env = { ...process.env, HUD_SETTINGS_PATH: path };
  const before = process.env.HUD_SETTINGS_PATH;
  process.env.HUD_SETTINGS_PATH = path;
  try {
    saveSettings({ panelLayout: 'inbox' });
    assert.equal(loadSettings(env).panelLayout, 'inbox');
    fs.writeFileSync(path, JSON.stringify({ panelLayout: 'timeline' }));
    assert.equal(loadSettings(env).panelLayout, 'classic', 'an unknown layout is the default');
  } finally {
    if (before === undefined) delete process.env.HUD_SETTINGS_PATH; else process.env.HUD_SETTINGS_PATH = before;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
