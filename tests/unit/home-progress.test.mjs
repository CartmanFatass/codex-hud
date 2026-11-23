import { withState, sliceState } from '../fixtures/state-helpers.mjs';
import { homeAnchor } from '../../dist/render/monitor-state.js';
import { projectPageOf } from '../../dist/render/project-view.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { homeFixture, homeFrames } from '../fixtures/home-progress.mjs';
import { NOW, TREE, plain } from '../fixtures/project-page.mjs';
import { ProjectCollector } from '../../dist/collectors/project-board.js';
import { targetKey } from '../../dist/collectors/workboard-types.js';
import { handleMonitorInput } from '../../dist/render/monitor.js';
import { visualLength, stripAnsi } from '../../dist/render/colors.js';
const expected = JSON.parse(fs.readFileSync(new URL('../fixtures/home-progress-frames.json', import.meta.url), 'utf8'));
async function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'home-progress-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, ...await homeFixture(root) };
}
const ctx = (frame) => ({ tree: TREE, frame, nowMs: NOW, standalone: true });
const press = (frame, key) => handleMonitorInput(frame.state, { type: 'key', key }, ctx(frame));
// The progress block only: Home's top line and its waiting/latest lists share the `home-progress:` prefix.
const compact = (frame) => frame.workboard.rows.filter((r) => /^home-progress:(progress|tickets:)/.test(r.item ?? ''));
// Rows above the spare ones: the top summary row and cards.
const rowsAbove = (f, width, lang, state, extras) => f.render(width, lang, 100, state, null, extras).workboard.rows.length;
test('Home frames at 52/80/120 EN/ZH: tickets shrink first, legend, bar, summary, then the block goes before any card', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(homeFrames(f), expected);
  assert.ok(f.board.workers.some((w) => w.homeNeedsHuman));
  assert.ok(f.board.workers.some((w) => w.nativeDepth === 1));
  assert.ok(f.board.decisions.length);
  for (const width of [52, 80, 120]) for (const lang of ['en', 'zh']) {
    const base = rowsAbove(f, width, lang), baseline = f.render(width, lang, base + 2);
    assert.equal(baseline.workboard.rows.length, base);
    const tall = f.render(width, lang, base + 24);
    const text = plain(tall).join('\n');
    assert.match(text, /Synthetic milestone closing/);
    assert.match(text, /M3b/);
    assert.match(text, lang === 'en' ? /native-tree.*2\/13 · 2 working/ : /native-tree.*2\/13 · 2 工作中/);
    assert.doesNotMatch(text, /02 Home lanes|Vocabulary|03 Inspector|Settings cleanup/, 'Home keeps only feature rollups');
    assert.match(text, lang === 'en' ? /◇ 1 (?:to )?try/ : /◇ 1 待试(?:用)?/, 'the legend counts pending tickets');
    assert.doesNotMatch(compact(tall).map((r) => stripAnsi(r.text)).join('\n'), /NATIVE-TREE|ORPHAN|now:|Next|retired-tools|07 Vocabulary resolved|08 Vocabulary wontfix/);
    let seenTickets = false, seenLegend = false;
    for (let spare = 30; spare >= -3; spare--) {
      const height = base + 2 + spare, frame = f.render(width, lang, height), rows = compact(frame);
      for (const line of frame.lines) assert.equal(visualLength(line), width, stripAnsi(line));
      assert.deepEqual(frame.workboard.rows.slice(0, base), baseline.workboard.rows, 'questions and job/native cards unchanged');
      assert.ok(frame.workboard.rows.length - base <= Math.max(0, spare), 'only whole spare rows, the separator included');
      const tickets = rows.some((r) => r.item.startsWith('home-progress:tickets:'));
      const legend = rows.some((r) => (lang === 'en' ? /◐ 2 (working|now)/ : /◐ 2 (工作中|现在)/).test(stripAnsi(r.text)));
      if (tickets) { seenTickets = true; assert.ok(legend); }
      if (legend) seenLegend = true;
      if (spare < 3) assert.equal(rows.length, 0);
      else assert.ok(rows.length <= spare);
      if (spare >= 0) assert.deepEqual(plain(frame).slice(1, base + 1), plain(baseline).slice(1, base + 1), 'no card row cut or displaced');
    }
    assert.ok(seenTickets && seenLegend);
    const notice = f.render(width, lang, base + 5);
    // Expanded cards consume their own rows first, with no compact block stealing them.
    const state = press(notice, 'end').state;
    const resized = f.render(width, lang, base + 4, state);
    assert.equal(compact(resized).length, 0);
    assert.equal(homeAnchor(resized.state.home), undefined, 'removed block cannot retain an invisible cursor');
  }
});
test('Home milestone bar, single-line slice legend and project meter precede feature rows', async (t) => {
  const f = await fixture(t);
  for (const width of [52, 80, 120]) for (const lang of ['en', 'zh']) {
    const base = rowsAbove(f, width, lang), at = (data, spare = 24) => plain(f.render(width, lang, base + 2 + spare, undefined, data));
    // The summary's wrapped rows (one to three), then the bar, then the legend rows, then the tickets.
    const shape = (lines) => {
      const head = lines.findIndex((l) => /^(Progress|进度) ─/.test(l)), bar = lines.findIndex((l, i) => i > head && /^  [█▒░]/.test(l));
      const legend = lines.slice(bar + 1, bar + 2);
      return { head, bar, legend, summary: lines.slice(head + 1, bar) };
    };
    const lines = at(f.data), { head, bar, legend, summary } = shape(lines);
    assert.equal(lines[head - 1].trim(), '', 'a blank row separates the block from the lists above');
    assert.match(lines[head], lang === 'en' ? /Milestone M3b$/ : /里程碑 M3b$/);
    assert.match(summary[0], /^  Synthetic milestone closing/);
    assert.ok(summary.length >= 1 && summary.length <= 3);
    assert.match(lines[bar], /^  █+▒+█+░+ 3\/14$/);
    assert.match(legend[0], /✓ 3.*◇ 1.*◐ 2.*◆ 2.*○ 6/);
    assert.match(lines[bar + 2], /^  (Tickets|工单) ━━─{6} 4\/15 +1\/2 /);
    assert.match(lines[bar + 4], /◐ native-tree ━─── +2\/13 · 2 /);
    assert.doesNotMatch(lines.join('\n'), /02 Home lanes|03 Inspector|05 Shortcuts/);
  }
});
test('Split counts pending slices and all tickets before folded plans, without a pending-work list', async (t) => {
  const f = await fixture(t), frames = homeFrames(f);
  for (const lang of ['en', 'zh']) {
    const text = frames[`rollup-40-${lang}`].join('\n');
    assert.match(text, lang === 'en' ? /0\.4\.0 · 4 (?:to )?try · 2 (live|working)/ : /0\.4\.0 · 4 待试用 · 2 工作中/);
    assert.match(text, /█+▒+█+░+ 14\/26/);
    assert.match(text, /✓ 14.*◇ 4.*◐ 2.*○ 6/);
    assert.match(text, /124\/138 +31\/34 /);
    assert.match(text, lang === 'en' ? /▸ 2 planned +2 ready · 2 queued/ : /▸ 已规划 2 个功能 +2 就绪 · 2 待前序/);
    assert.doesNotMatch(text, /plan-[ab]|Inspector|Settings cleanup/);
    const idle = { ...f.data, ledger: f.data.ledger.map(r => ({ ...r, state: 'accepted' })) };
    const state = withState(sliceState(), { prefs: { panelLayout: 'split' } });
    assert.match(plain(f.render(40, lang, 36, state, idle)).join('\n'), lang === 'en' ? /M3b · 15\/15 accepted/ : /M3b · 15\/15 已验收/);
  }
});
test('expanded questions/cards and notices claim space before progress; missing facts never get placeholders', async (t) => {
  const f = await fixture(t), expanded = new Set(f.board.workers.map((w) => targetKey({ kind: 'worker', laneId: w.laneId, workerId: w.id })));
  for (const width of [80, 120]) for (const lang of ['en', 'zh']) {
    const state = withState(sliceState(), { home: { expanded, toggled: expanded } });
    const extras = { error: 'Synthetic read fault', publicationNotice: 'Synthetic coverage notice' };
    const base = rowsAbove(f, width, lang, structuredClone(state), extras), baseline = f.render(width, lang, base + 2, structuredClone(state), f.data, extras);
    assert.equal(baseline.workboard.rows.length, base);
    assert.ok(baseline.workboard.rows.some((r) => stripAnsi(r.text).includes('Which synthetic option?')), 'the open question remains visible');
    const short = f.render(width, lang, base + 4, structuredClone(state), f.data, extras);
    assert.equal(compact(short).length, 0);
    assert.deepEqual(short.workboard.rows.slice(0, base), baseline.workboard.rows, 'only the waiting list may use the two spare rows');
    assert.deepEqual(plain(short).slice(1, base + 1), plain(baseline).slice(1, base + 1));
    const minimal = f.render(width, lang, base + 6, structuredClone(state), f.data, extras);
    assert.equal(compact(minimal).length, 3);
    assert.equal(compact(f.render(width, lang, 100, undefined, null)).length, 0);
    const missing = f.render(width, lang, 100, undefined, { ...f.data, ladder: { ids: [] } });
    assert.doesNotMatch(compact(missing).map((r) => stripAnsi(r.text)).join('\n'), /Milestone:|里程碑:/);
  }
});
test('real Home input: Up/Down/End select the block, Enter/click opens the Progress page, or a ticket row the Tickets page', async (t) => {
  const f = await fixture(t);
  for (const width of [80, 120]) {
    let frame = f.render(width, 'en', 80);
    frame = f.render(width, 'en', 80, press(frame, 'end').state);
    assert.equal(homeAnchor(frame.state.home), 'home-progress:tickets:native-tree');
    frame = f.render(width, 'en', 80, press(frame, 'up').state);
    assert.equal(homeAnchor(frame.state.home), 'home-progress:tickets:all');
    frame = f.render(width, 'en', 80, press(frame, 'up').state);
    assert.equal(homeAnchor(frame.state.home), 'home-progress:progress');
    assert.equal(press(frame, 'open-session').action, undefined, 'o on progress never opens a stale card file');
    frame.state.project.folded = new Set(['lane:done', 'agents']);
    let result = press(frame, 'enter');
    assert.equal(result.state.activeTab, 'project');
    assert.equal(projectPageOf(result.state), 'progress');
    let project = f.render(width, 'en', 80, result.state);
    assert.ok(plain(project).some((line) => line.startsWith('‹ Project › Progress')));
    frame = f.render(width, 'en', 80, press(frame, 'down').state);
    result = press(frame, 'enter');
    assert.equal(projectPageOf(result.state), 'tickets');
    assert.equal(result.state.project.nav.cursor, undefined, 'no cursor is forced: the page rests on its first row');
    assert.deepEqual([...result.state.project.folded].sort(), ['agents', 'lane:done'], 'the folds stay as they were');
    project = f.render(width, 'en', 80, result.state);
    assert.ok(plain(project).some((line) => line.startsWith('‹ Project › Tickets')));
    // Esc is the hub, Esc again is where Esc always went.
    assert.equal(projectPageOf(press(project, 'escape').state), undefined);
    for (const id of ['home-progress:progress', 'home-progress:tickets:native-tree']) {
      frame = f.render(width, 'en', 80);
      const index = frame.workboard.rows.findIndex((r) => r.item === id);
      result = handleMonitorInput(frame.state, { type: 'mouse', button: 'left', x: 8, y: index + 1 }, ctx(frame));
      assert.equal(result.state.activeTab, 'project');
      assert.equal(projectPageOf(result.state), id.endsWith('progress') ? 'progress' : 'tickets');
      assert.equal(result.action, undefined, 'navigation, not an editor or execution action');
    }
  }
});
test('Home joins cached STATE, spec, tickets, HEAD and jobs; no control or agents; only changed bodies refresh', async (t) => {
  const f = await fixture(t), opened = [], listed = [], spawned = [];
  const original = { openSync: fs.openSync, opendirSync: fs.opendirSync, execFile: childProcess.execFile };
  fs.openSync = (path, ...args) => { opened.push(String(path)); return original.openSync(path, ...args); };
  fs.opendirSync = (path, ...args) => { listed.push(String(path)); return original.opendirSync(path, ...args); };
  childProcess.execFile = (...args) => { spawned.push(args[0]); return original.execFile(...args); };
  syncBuiltinESMExports();
  t.after(() => { fs.openSync = original.openSync; fs.opendirSync = original.opendirSync; childProcess.execFile = original.execFile; syncBuiltinESMExports(); });
  const collector = new ProjectCollector(f.cwd, f.hud, f.env, f.home);
  let data = await collector.collect('home', f.board, NOW);
  assert.ok(opened.length > 0);
  assert.ok(opened.every((p) => /\/(STATE|spec)\.md$|\/\.git\/|\/jobs\/j[0-9a-f]+\/(job\.json|STATUS\.json|brief\.md)$|\/\.scratch\/[^/]+\/issues\/[^/]+\.md$/.test(p)), opened.join('\n'));
  assert.ok(listed.every((p) => /\/(\.scratch|jobs|worktrees)$|\/\.scratch\/[^/]+\/issues$/.test(p)));
  assert.deepEqual(spawned, ['git']);
  assert.equal(data.git, undefined);
  assert.deepEqual(data.control, []);
  assert.deepEqual(data.agents, []);
  assert.equal(data.tickets[0].tickets[0].state, 'working');
  opened.length = 0; listed.length = 0;
  await collector.collect('home', f.board, NOW + 60000);
  assert.deepEqual(opened, [], 'unchanged files cost no body reread');
  assert.deepEqual(listed, [], 'unchanged directory membership reused');
  f.issue('native-tree', '02', 'home-lanes', 'Home lanes', 'done');
  opened.length = 0;
  data = await collector.collect('home', f.board, NOW + 60001);
  assert.equal(data.tickets[0].tickets[0].state, 'done');
  assert.deepEqual(opened, [f.paths.working]);
  assert.deepEqual(spawned, ['git'], 'no git call without a HEAD change, even past the Project gate');
  assert.equal(await collector.collect(false, f.board, NOW + 60002), undefined);
});
test('live panel stays Home-only: only the HEAD-keyed subject scan invokes git', async (t) => {
  const f = await fixture(t), runner = join(f.root, 'home-only.mjs'), log = join(f.root, 'git-spawns');
  f.put(join(f.root, 'bin/git'), `#!${process.execPath}\nimport fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(log)}, 'git\\n'); process.exit(1);\n`);
  fs.chmodSync(join(f.root, 'bin/git'), 0o700);
  f.put(runner, `
import { ProjectCollector } from ${JSON.stringify(pathToFileURL(resolve('dist/collectors/project-board.js')).href)};
import { runLivePage } from ${JSON.stringify(pathToFileURL(resolve('dist/tree-page.js')).href)};
const collect = ProjectCollector.prototype.collect;
let calls = 0;
ProjectCollector.prototype.collect = async function(mode, ...args) {
  if (mode !== 'home') throw Error('unexpected collection mode: ' + mode);
  const result = await collect.call(this, mode, ...args);
  if (++calls === 2) { process.stdout.write('HOME_ONLY'); process.exit(0); }
  return result;
};
await runLivePage();
`);
  const settings = join(f.root, 'settings.json');
  f.put(settings, { modelEnabled: false, refreshMs: 100 });
  const child = childProcess.spawn(process.execPath, [runner], { env: { ...process.env, ...f.env,
    PATH: `${join(f.root, 'bin')}:${process.env.PATH}`, CODEX_HUD_CWD: f.cwd, HUD_SETTINGS_PATH: settings,
    CODEX_HUD_STANDALONE_PANEL: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', (b) => { stdout += b; });
  child.stderr.on('data', (b) => { stderr += b; });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 15000);
  t.after(() => { clearTimeout(timeout); if (child.exitCode === null) child.kill('SIGKILL'); });
  const code = await new Promise((done) => child.once('exit', done));
  clearTimeout(timeout);
  assert.equal(code, 0, stderr);
  assert.match(stdout, /HOME_ONLY/);
  assert.equal(fs.readFileSync(log, 'utf8'), 'git\n', 'one cold subject scan for two collections');
});
