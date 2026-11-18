import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectFixture, plain, onPage, NOW, TREE } from '../fixtures/project-page.mjs';
import { renderHtmlBoard } from '../../dist/render/html-board.js';
import { language } from '../../dist/render/i18n.js';
import { handleMonitorInput, initialMonitorState } from '../../dist/render/monitor.js';
import { WorkbenchInputDecoder } from '../../dist/utils/workbench-input.js';
import { main } from '../../dist/cli/hud.js';

const XSS = '<script>alert(1)</script>"><img src=x onerror=alert(1)>\'&';
const diffOf = (x) => ({
  totalFiles: 7, totalAdded: 150, totalDeleted: 30,
  files: [
    { path: `src/${x}.ts`, absPath: '/x/a', added: 100, deleted: 25 },
    { path: 'src/b.ts', absPath: '/x/b', added: 50, deleted: 5 },
    { path: 'logo.png', absPath: '/x/c', added: null, deleted: null, binary: true },
  ],
});
const ticket = (number, title, state, items = []) => ({ number, title, path: `/x/${number}`, at: NOW, status: 'open', state, blockers: [],
  checked: items.filter((i) => i.done).length, total: items.length, items });
function inputs(x = XSS) {
  const row = (id, extra = {}) => ({ id, state: 'try', milestone: 'M5', text: `${id} landed (a1b2c3d4)`, commit: 'a1b2c3d4', at: NOW - 3 * 3600e3, ...extra });
  const project = {
    tickets: [{ slug: 'panel-v2', at: NOW, tickets: [ticket('06', 'Other ticket', 'ready'), ticket('07', `Board ${x}`, 'working', [{ done: true, text: 'Generator' }, { done: false, text: x }])] }],
    waiting: [{ label: '', value: `Try ${x}`, text: `Try ${x}\n  second line` }], docs: [{ label: 'review', value: '2026-11-12-review.md' }],
    control: [], roles: [], harnesses: [], models: { pi: [], include: {}, cli: {}, bro: {} }, agents: [], keys: [], browser: false, roleCount: 0, editing: [],
    ladder: { ids: [], current: 'M5' }, next: [], summary: `Closing ${x}`,
    slices: [{ label: 'PAGE-ONE', value: `working ${x}`, ledgerState: 'working', role: 'imp', at: NOW - 40 * 60e3 }],
    active: [], counts: { working: 1, blocked: 0, try: 2, todo: 3, accepted: 4, dropped: 1 },
    git: { branch: `wt/${x}`, changed: 3, staged: 1, unstaged: 1, untracked: 1, conflicts: 0, ahead: 2, behind: 0 },
    ledger: [
      row('BRIEFED', { diff: diffOf(x), text: 'BRIEFED (a1b2c3d4) see .scratch/panel-v2/issues/07-board.md', brief: { brief: `Adds the board ${x}`, steps: ['Run it', `Open ${x}`] } }),
      row('PLAIN', { at: NOW - 5 * 3600e3, text: `PLAIN ${x}` }),
      { id: 'DONE', state: 'accepted', milestone: 'M4', text: 'accepted one' },
    ],
  };
  const requestInfo = { id: 'q1', question: `Which ${x}?`, suggested: 'a', options: ['a) keep', `b) ${x}`] };
  const worker = { id: 'thin-job:j0000000000000001', laneId: 'l', role: 'imp', harness: 'pi', task: `Build ${x}`, model: 'synthetic/model', effort: 'high',
    state: 'working', startedAt: NOW - 20 * 60e3, settledAt: null, homeNeedsHuman: true, work: { requestInfo, reason: `now ${x}` } };
  const settled = { ...worker, id: 'thin-job:j0000000000000002', task: 'Finished one', state: 'done', settledAt: NOW - 1, homeNeedsHuman: false, work: {} };
  const workboard = { revision: 'x', lanes: [], workers: [worker, settled], decisions: [], coverage: { incomplete: false, diagnostics: [], workspace: null } };
  return { projectName: `proj ${x}`, root: `/home/user/${x}`, project, workboard, reviewText: `# Review ${x}\n- minor ${x}\n`, generatedAt: NOW, lang: 'en' };
}

test('the board is one static page: CSP, no script, nothing external, both themes', () => {
  const html = renderHtmlBoard(inputs('plain'));
  assert.match(html, /^<!doctype html>\n<html lang="en">/);
  assert.ok(html.includes(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">`));
  assert.ok(html.includes('name="viewport"'));
  assert.doesNotMatch(html, /<script|<link|<iframe|<img|<form|<base|@import|url\(|\bsrc=|https?:\/\//i);
  assert.doesNotMatch(html, /\son[a-z]+=/i);
  // The only hrefs are in-page anchors.
  assert.deepEqual([...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]).filter((h) => !h.startsWith('#')), []);
  // Light by default; dark by the system setting or by the pure-CSS switch.
  assert.match(html, /@media \(prefers-color-scheme:dark\)\{#t-auto:checked~\.page\{--bg:#0e131b/);
  assert.match(html, /#t-dark:checked~\.page\{--bg:#0e131b/);
  assert.match(html, /\.page\{--bg:#eff1f5/);
  for (const id of ['t-auto', 't-dark', 't-light']) assert.match(html, new RegExp(`<input class="sw" type="radio" name="theme" id="${id}"`));
  assert.match(html, /@media \(max-width:520px\)/);
});

test('every dynamic string is escaped: only the page\'s own tags exist', () => {
  const html = renderHtmlBoard(inputs());
  const allowed = new Set(['html', 'head', 'meta', 'title', 'style', 'body', 'input', 'div', 'header', 'span', 'label', 'h1', 'p', 'ul', 'ol', 'li', 'nav', 'a',
    'section', 'h2', 'h3', 'article', 'details', 'summary', 'b', 'code', 'i', 'footer']);
  const tags = new Set([...html.matchAll(/<([a-z][a-z0-9]*)/gi)].map((m) => m[1].toLowerCase()));
  assert.deepEqual([...tags].filter((tag) => !allowed.has(tag)), []);
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;&quot;&gt;&lt;img src=x onerror=alert(1)&gt;&#39;&amp;'));
  assert.equal(html.split('<script').length, 1);
  // Each field that carries the payload shows it as text.
  for (const where of ['<h1>proj ', 'class="root">/home/user/', 'class="chip plain">branch wt/', 'class="lede">Closing ', 'class="card ask"><header><span class="chip try">STATE</span></header><p class="pre">Try ',
    '<p>Adds the board ', '<li>Open ', '<span class="p mono">src/', '<p>PLAIN ', 'Board ', '<p class="q">Which ', '<li>b) ', '<li class="">', '<b># Review ', '<p>working ']) {
    const at = html.indexOf(where);
    assert.ok(at >= 0, where);
    assert.ok(html.slice(at, at + where.length + 80).includes('&lt;'), `${where} is escaped`);
  }
});

test('a to-try card carries its brief, numbered steps, linked tickets and diff bars', () => {
  const html = renderHtmlBoard(inputs());
  const card = html.slice(html.indexOf('<article class="card try"><header><span class="id">BRIEFED'), html.indexOf('<article class="card try"><header><span class="id">PLAIN'));
  assert.match(card, /<span class="chip try">M5<\/span>/);
  assert.match(card, /<code>a1b2c3d4<\/code> · 3h ago/);
  assert.match(card, /<ol><li>Run it<\/li><li>Open /);
  assert.match(card, /<details><summary>Ledger line<\/summary>BRIEFED \(a1b2c3d4\) see \.scratch\/panel-v2\/issues\/07-board\.md<\/details>/);
  assert.match(card, /\+150 -30 · 7 files/);
  // The biggest file fills the bar: its added part 100/125 of it, the deleted 25/125.
  assert.match(card, /<span class="nums"><b class="add">\+100<\/b> <b class="del">-25<\/b><\/span><span class="dbar"><i class="a" style="width:80\.0%"><\/i><i class="d" style="width:20\.0%"><\/i>/);
  assert.match(card, /<b class="add">\+50<\/b> <b class="del">-5<\/b><\/span><span class="dbar"><i class="a" style="width:40\.0%"><\/i><i class="d" style="width:4\.0%"><\/i>/);
  assert.match(card, /<span class="nums plain">bin<\/span>/);
  assert.match(card, /<li class="plain"><span>\+4 more files<\/span>/);
  // Only the ticket the slice names: 07 with its checklist; 06 is not linked.
  assert.match(card, /<b>panel-v2<\/b>/);
  assert.match(card, /<span class="num">07<\/span>Board /);
  assert.match(card, /<li class="d">Generator<\/li><li class="">/);
  assert.doesNotMatch(card, /Other ticket/);
  // A slice with no brief shows the whole ledger line.
  assert.match(html, /<article class="card try"><header><span class="id">PLAIN<\/span>[^]*?<p>PLAIN &lt;script/);
  assert.doesNotMatch(html, /<span class="id">DONE</);
  // Newest first.
  assert.ok(html.indexOf('>PLAIN<') > html.indexOf('>BRIEFED<'));
});

test('Needs you, In flight, tickets and the review appear when there is something in them', () => {
  const html = renderHtmlBoard(inputs());
  assert.match(html, /<section id="needs"><h2>Needs you <span class="n">2<\/span>/);
  assert.match(html, /<h3>Options<\/h3><ul class="opts"><li>a\) keep<\/li>/);
  assert.match(html, /Default if unanswered:<\/span> a<\/p>/);
  assert.match(html, /<section id="flight">/);
  assert.match(html, /<span class="id">PAGE-ONE<\/span><span class="chip working">working<\/span><span class="chip plain">imp<\/span>/);
  assert.match(html, /imp · pi<\/span>[^]*?synthetic\/model · high · 20m/);
  assert.doesNotMatch(html, /Finished one/);
  assert.match(html, /<section id="tickets">[^]*?<b>panel-v2<\/b><span class="plain">0\/2<\/span>/);
  assert.match(html, /<section id="review">[^]*?class="root">2026-11-12-review\.md<\/p><div class="review"><b># Review /);
  assert.match(html, /<i title="1 working" style="flex:1;background:var\(--working\)">/);
  assert.match(html, /<li><i style="background:var\(--trying\)"><\/i><b>2<\/b> to try<\/li>/);
  assert.match(html, /branch wt\/[^]*?3 changed[^]*?2 ahead[^]*?Milestone M5/);

  const input = inputs();
  const quiet = renderHtmlBoard({ ...input, workboard: undefined, reviewText: undefined,
    project: { ...input.project, waiting: [], tickets: [], ledger: [], slices: [], counts: { working: 0, blocked: 0, try: 0, todo: 0, accepted: 0, dropped: 0 } } });
  for (const id of ['needs', 'try', 'flight', 'tickets', 'review']) assert.doesNotMatch(quiet, new RegExp(`<section id="${id}"`));
});

test('Chinese keeps the language it found', () => {
  const before = language();
  const html = renderHtmlBoard({ ...inputs(), lang: 'zh' });
  assert.match(html, /<html lang="zh">/);
  assert.match(html, /审阅看板/);
  assert.match(html, /需要你处理/);
  assert.equal(language(), before);
});

test('w is the panel key for the board, on Home and Project only', () => {
  assert.deepEqual(new WorkbenchInputDecoder('workboard').push(Buffer.from('w')), [{ type: 'key', key: 'export-board', text: 'w' }]);
  const press = (state, extra = {}) => handleMonitorInput({ ...state, ...extra }, { type: 'key', key: 'export-board', text: 'w' }, { tree: TREE, nowMs: NOW, standalone: true }).action;
  assert.deepEqual(press(initialMonitorState()), { type: 'export-board' });
  assert.deepEqual(press(onPage()), { type: 'export-board' });
  assert.deepEqual(press(onPage('control')), { type: 'export-board' });
  assert.equal(press(initialMonitorState(), { focus: 'changes' }), undefined);
  assert.equal(press(initialMonitorState(), { focus: 'details' }), undefined);
  assert.equal(press(initialMonitorState(), { help: true }), undefined);
  // The model picker types the letter.
  assert.equal(press(onPage('control'), { projectInput: { role: 'imp', index: 0, text: '' } }), undefined);
});

test('the Help page lists w and the saved board shows at the top in both languages', async (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'html-board-help-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = await projectFixture(root);
  assert.match(plain(f.render(120, 'en', { ...initialMonitorState(), help: true }, 80)).join('\n'), /\bw\s+export a review board \(HTML\) and open it/);
  assert.match(plain(f.render(120, 'zh', { ...initialMonitorState(), help: true }, 80)).join('\n'), /导出审阅看板/);
  const frame = f.render(80, 'en', undefined, 24, f.data, true, 'unicode', 'none', { publicationNotice: 'Board saved: board-project.html' });
  assert.match(plain(frame).join('\n'), /^Board saved: board-project\.html$/m);
});

function cli(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'html-board-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return projectFixture(root).then((f) => {
    const opener = join(root, 'opener'), marker = join(root, 'opened.txt');
    fs.mkdirSync(opener);
    const run = async (args, env = {}) => {
      let out = '', err = '';
      const code = await main(args, { env: { ...f.env, PATH: join(root, 'nobin'), HERDR_PANE_ID: 'w4E:p1', ...env }, stdout: (s) => { out += s; }, stderr: (s) => { err += s; } });
      return { code, out, err };
    };
    return { ...f, root, opener, marker, run };
  });
}

test('hud board writes the page atomically and prints its path', async (t) => {
  const f = await cli(t);
  const out = await f.run(['board', '--cwd', f.cwd]);
  const file = join(f.hud, 'display', 'board-project.html');
  assert.deepEqual([out.code, out.out, out.err], [0, `${file}\n`, '']);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(join(f.hud, 'display')).filter((n) => n.endsWith('.tmp')), []);
  const html = fs.readFileSync(file, 'utf8');
  assert.match(html, /^<!doctype html>/);
  assert.ok(html.includes(`content="default-src 'none'; style-src 'unsafe-inline'"`));
  assert.doesNotMatch(html, /<script/);
  assert.match(html, /<h1>project<\/h1>/);
  // Synthetic project: its STATE waiting items, its ledger slice to try, its job asking a question, its newest review.
  assert.match(html, /Try the Project tab/);
  assert.match(html, /<span class="id">LANDING<\/span>/);
  assert.match(html, /Which synthetic option\?/);
  assert.match(html, /class="root">2026-11-12-review\.md<\/p><div class="review">Verdict: accept/);
  assert.match(html, /branch synthetic-project/);
  // The caller's pane is the HERDR_PANE_ID: without one there are no jobs.
  const alone = await f.run(['board', '--cwd', f.cwd, '--out', join(f.root, 'alone.html')], { HERDR_PANE_ID: '' });
  assert.equal(alone.code, 0);
  assert.doesNotMatch(fs.readFileSync(join(f.root, 'alone.html'), 'utf8'), /Which synthetic option\?/);
});

test('hud board --out never follows a link and replaces it', async (t) => {
  const f = await cli(t);
  const victim = join(f.root, 'victim.txt'), link = join(f.root, 'board.html');
  fs.writeFileSync(victim, 'keep me');
  fs.symlinkSync(victim, link);
  const out = await f.run(['board', '--html', '--cwd', f.cwd, '--out', link]);
  assert.deepEqual([out.code, out.out], [0, `${link}\n`]);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'keep me');
  assert.ok(fs.lstatSync(link).isFile());
  assert.match(fs.readFileSync(link, 'utf8'), /^<!doctype html>/);
  assert.equal(fs.statSync(link).mode & 0o777, 0o600);
});

test('hud board --open runs the opener detached, and only mentions a missing one', async (t) => {
  const f = await cli(t);
  const none = await f.run(['board', '--cwd', f.cwd, '--out', join(f.root, 'a.html'), '--open']);
  assert.equal(none.code, 0);
  assert.equal(none.out, `${join(f.root, 'a.html')}\n`);
  assert.match(none.err, /no opener found \(wslview or xdg-open\)/);
  const quiet = await f.run(['board', '--cwd', f.cwd, '--out', join(f.root, 'b.html')]);
  assert.equal(quiet.err, '');
  fs.writeFileSync(join(f.opener, 'xdg-open'), `#!/bin/sh\nprintf '%s' "$1" > "${f.marker}"\n`, { mode: 0o700 });
  const opened = await f.run(['board', '--cwd', f.cwd, '--out', join(f.root, 'c.html'), '--open'], { PATH: f.opener });
  assert.deepEqual([opened.code, opened.err], [0, '']);
  for (let i = 0; i < 100 && !fs.existsSync(f.marker); i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(fs.readFileSync(f.marker, 'utf8'), join(f.root, 'c.html'));
});

test('hud board checks its arguments', async (t) => {
  const f = await cli(t);
  const help = await f.run(['board', '--help']);
  assert.deepEqual([help.code, help.err], [0, '']);
  assert.match(help.out, /^Usage: hud board \[--html\] \[--cwd DIR\] \[--out FILE\] \[--open\]/);
  for (const args of [['--nope'], ['--out'], ['--cwd', '--open'], ['--open', '--open']]) {
    const bad = await f.run(['board', ...args]);
    assert.deepEqual([bad.code, bad.out], [2, ''], args.join(' '));
    assert.match(bad.err, /^Usage: hud board/);
  }
  const missing = await f.run(['board', '--cwd', join(f.root, 'absent')]);
  assert.deepEqual([missing.code, missing.err.startsWith('not a directory')], [2, true]);
  const refused = await f.run(['board', '--cwd', f.cwd, '--out', f.root]);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /^board_failed/);
});
