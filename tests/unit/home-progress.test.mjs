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
import { initialMonitorState, handleMonitorInput } from '../../dist/render/monitor.js';
import { visualLength, stripAnsi } from '../../dist/render/colors.js';
const expected = JSON.parse(fs.readFileSync(new URL('../fixtures/home-progress-frames.json', import.meta.url), 'utf8'));
async function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'home-progress-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, ...await homeFixture(root) };
}
const ctx = (frame) => ({ tree: TREE, frame, nowMs: NOW, standalone: true });
const press = (frame, key) => handleMonitorInput(frame.state, { type: 'key', key }, ctx(frame));
const compact = (frame) => frame.workboard.rows.filter((r) => r.item?.startsWith('home-progress:'));
test('Home frames at 52/80/120 EN/ZH: tickets shrink first, legend, bar, summary, then the block goes before any card', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(homeFrames(f), expected);
  assert.ok(f.board.workers.some((w) => w.homeNeedsHuman));
  assert.ok(f.board.workers.some((w) => w.nativeDepth === 1));
  assert.ok(f.board.decisions.length);
  for (const width of [52, 80, 120]) for (const lang of ['en', 'zh']) {
    const baseline = f.render(width, lang, 100, initialMonitorState(), { ...f.data, summary: '', ladder: { ids: [] }, tickets: [] });
    const base = baseline.workboard.rows.length;
    const tall = f.render(width, lang, base + 24);
    const text = plain(tall).join('\n');
    assert.match(text, /Synthetic milestone closing/);
    assert.match(text, /M3b/);
    assert.match(text, /native-tree.*1\/12/);
    assert.match(text, /09 Vocabulary claimed[\s\S]*02 Home lanes/, 'working before ready');
    assert.match(text, lang === 'en' ? /\+5 more/ : /另 5 个/, 'a short list: five tickets and the rest counted');
    assert.doesNotMatch(text, /Settings cleanup|Vocabulary ready-for-agent/);
    assert.match(text, lang === 'en' ? /blocked/ : /受阻/);
    assert.doesNotMatch(compact(tall).map((r) => stripAnsi(r.text)).join('\n'), /NATIVE-TREE|ORPHAN|now:|Next|retired-tools|07 Vocabulary resolved|08 Vocabulary wontfix/);
    let seenTickets = false, seenLegend = false;
    for (let spare = 30; spare >= -3; spare--) {
      const height = base + 2 + spare, frame = f.render(width, lang, height), rows = compact(frame);
      for (const line of frame.lines) assert.equal(visualLength(line), width, stripAnsi(line));
      assert.deepEqual(frame.workboard.rows.slice(0, base), baseline.workboard.rows, 'questions, job/native cards, decisions unchanged');
      assert.ok(frame.workboard.rows.length - base <= Math.max(0, spare), 'only whole spare rows, the separator included');
      const tickets = rows.some((r) => r.item.startsWith('home-progress:tickets:'));
      const legend = rows.some((r) => stripAnsi(r.text).includes(lang === 'en' ? 'accepted 1' : '已验收 1'));
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
    assert.equal(resized.state.boardAnchor, undefined, 'removed block cannot retain an invisible cursor');
  }
});
test('Home progress layout: separator row, milestone on the rule, bar as wide as the aligned legend, zero states hidden, short list', async (t) => {
  const f = await fixture(t), glyphs = (line) => [...line.matchAll(/●/g)].map((m) => visualLength(line.slice(0, m.index)));
  for (const width of [52, 80, 120]) for (const lang of ['en', 'zh']) {
    const base = f.render(width, lang, 100, undefined, null).workboard.rows.length, at = (data, spare = 14) => plain(f.render(width, lang, base + 2 + spare, undefined, data));
    const lines = at(f.data), head = lines.findIndex((l) => /^(Progress|进度) ─/.test(l));
    assert.equal(lines[head - 1].trim(), '', 'a blank row separates the block from the decisions above');
    assert.match(lines[head], lang === 'en' ? /Milestone M3b$/ : /里程碑 M3b$/);
    assert.match(lines[head + 1], /^  Synthetic milestone closing/);
    const [bar, ...legend] = lines.slice(head + 2, head + 5).map((l) => l.trimEnd());
    assert.equal(legend.length, 2);
    assert.equal(visualLength(bar), Math.max(...legend.map(visualLength)), 'the bar is as wide as the legend grid');
    assert.ok(visualLength(bar) <= 60 && visualLength(bar) <= width - 2, 'not the full width');
    assert.deepEqual(glyphs(legend[0]), glyphs(legend[1]), 'legend columns align');
    assert.match(lines[head + 5], /^(Tickets|工单) · native-tree ─/);
    assert.match(lines[head + 5], lang === 'en' ? /1\/12 done$/ : /1\/12 完成$/);
    const sparse = at({ ...f.data, counts: { ...f.data.counts, todo: 0, dropped: 0 } }).join('\n');
    assert.doesNotMatch(sparse, lang === 'en' ? /todo|dropped/ : /待办|已放弃/, 'zero counts add no legend entry');
    const few = at({ ...f.data, tickets: [{ ...f.data.tickets[0], tickets: f.data.tickets[0].tickets.slice(0, 7) }] }).join('\n');
    assert.match(few, /02 Home lanes[\s\S]*03 Inspector[\s\S]*06 Polish[\s\S]*04 Settings cleanup[\s\S]*05 Shortcuts/, 'ready before blocked');
    assert.doesNotMatch(few, /more|另 \d+ 个/, 'five open tickets fit the short list');
  }
});
test('expanded questions/cards/decisions and notices claim space before progress; missing facts never get placeholders', async (t) => {
  const f = await fixture(t), expanded = new Set(f.board.workers.map((w) => targetKey({ kind: 'worker', laneId: w.laneId, workerId: w.id })));
  for (const d of f.board.decisions) expanded.add(targetKey({ kind: 'decision', laneId: d.laneId, decisionId: d.id }));
  const blank = { ...f.data, summary: '', ladder: { ids: [] }, tickets: [] };
  for (const width of [80, 120]) for (const lang of ['en', 'zh']) {
    const state = { ...initialMonitorState(), boardExpanded: expanded, boardToggled: expanded };
    const extras = { error: 'Synthetic read fault', publicationNotice: 'Synthetic coverage notice' };
    const baseline = f.render(width, lang, 100, structuredClone(state), blank, extras), base = baseline.workboard.rows.length;
    assert.ok(base > f.render(width, lang, 100, undefined, blank).workboard.rows.length);
    const short = f.render(width, lang, base + 4, structuredClone(state), f.data, extras);
    assert.equal(compact(short).length, 0);
    assert.deepEqual(short.workboard.rows, baseline.workboard.rows);
    assert.deepEqual(plain(short).slice(1, base + 1), plain(baseline).slice(1, base + 1));
    const minimal = f.render(width, lang, base + 5, structuredClone(state), f.data, extras);
    assert.equal(compact(minimal).length, 3);
    assert.equal(compact(f.render(width, lang, 100, undefined, null)).length, 0);
    const missing = f.render(width, lang, 100, undefined, { ...f.data, ladder: { ids: [] } });
    assert.doesNotMatch(compact(missing).map((r) => stripAnsi(r.text)).join('\n'), /Milestone:|里程碑:/);
  }
});
test('real Home input: Up/Down/End select the block, Enter/click opens Project progress or feature and unfolds it', async (t) => {
  const f = await fixture(t);
  for (const width of [80, 120]) {
    let frame = f.render(width, 'en', 80);
    frame = f.render(width, 'en', 80, press(frame, 'end').state);
    assert.equal(frame.state.boardAnchor, 'home-progress:tickets:native-tree');
    frame = f.render(width, 'en', 80, press(frame, 'up').state);
    assert.equal(frame.state.boardAnchor, 'home-progress:progress');
    frame.state.projectFolded = new Set(['progress', 'tickets', 'tickets:native-tree', 'control']);
    let result = press(frame, 'enter');
    assert.equal(result.state.mainTab, 'project');
    assert.equal(result.state.projectCursor, 'project:fold:progress');
    assert.equal(result.state.projectFolded.has('progress'), false);
    let project = f.render(width, 'en', 80, result.state);
    assert.ok(plain(project).some((line) => line.includes('Progress')));
    frame = f.render(width, 'en', 80, press(frame, 'down').state);
    result = press(frame, 'enter');
    assert.equal(result.state.projectCursor, 'project:fold:tickets:native-tree');
    assert.equal(result.state.projectFolded.has('tickets'), false);
    assert.equal(result.state.projectFolded.has('tickets:native-tree'), false);
    for (const id of ['home-progress:progress', 'home-progress:tickets:native-tree']) {
      frame = f.render(width, 'en', 80);
      const index = frame.workboard.rows.findIndex((r) => r.item === id);
      result = handleMonitorInput(frame.state, { type: 'mouse', button: 'left', x: 8, y: index + 1 }, ctx(frame));
      assert.equal(result.state.mainTab, 'project');
      assert.equal(result.state.projectCursor, `project:fold:${id.slice('home-progress:'.length)}`);
      assert.equal(result.action, undefined, 'navigation, not an editor or execution action');
    }
  }
});
test('Home-only collection: only STATE/issues cached reads; no git, control-plane, agents or job scans; changed file refreshes', async (t) => {
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
  assert.ok(opened.every((p) => p.endsWith('/STATE.md') || /\/\.scratch\/[^/]+\/issues\/[^/]+\.md$/.test(p)), opened.join('\n'));
  assert.ok(listed.every((p) => p.endsWith('/.scratch') || /\/\.scratch\/[^/]+\/issues$/.test(p)));
  assert.deepEqual(spawned, []);
  assert.equal(data.git, undefined);
  assert.deepEqual(data.control, []);
  assert.deepEqual(data.agents, []);
  assert.ok(data.tickets.every((feature) => feature.tickets.every((ticket) => !ticket.job)));
  opened.length = 0; listed.length = 0;
  await collector.collect('home', f.board, NOW + 60000);
  assert.deepEqual(opened, [], 'unchanged files cost no body reread');
  assert.deepEqual(listed, [], 'unchanged directory membership reused');
  f.issue('native-tree', '02', 'home-lanes', 'Home lanes', 'done');
  opened.length = 0;
  data = await collector.collect('home', f.board, NOW + 60001);
  assert.equal(data.tickets[0].tickets[0].state, 'done');
  assert.deepEqual(opened, [f.paths.working]);
  assert.deepEqual(spawned, [], 'Home never calls git, even past the five-second Project gate');
  assert.equal(await collector.collect(false, f.board, NOW + 60002), undefined);
});
test('live panel stays Home-only: actual collection gate never spawns git', async (t) => {
  const f = await fixture(t), runner = join(f.root, 'home-only.mjs'), log = join(f.root, 'git-spawns');
  f.put(join(f.root, 'bin/git'), `#!${process.execPath}\nimport fs from 'node:fs'; fs.appendFileSync(process.env.GIT_TEST_LOG, 'git\\n'); process.exit(1);\n`);
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
    GIT_TEST_LOG: log, CODEX_HUD_STANDALONE_PANEL: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', (b) => { stdout += b; });
  child.stderr.on('data', (b) => { stderr += b; });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 15000);
  t.after(() => { clearTimeout(timeout); if (child.exitCode === null) child.kill('SIGKILL'); });
  const code = await new Promise((done) => child.once('exit', done));
  clearTimeout(timeout);
  assert.equal(code, 0, stderr);
  assert.match(stdout, /HOME_ONLY/);
  assert.equal(fs.existsSync(log), false, 'no git executable invoked while Home alone is shown');
});
