import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DiffStatCollector, parseNumstat } from '../../dist/collectors/diff-stat.js';
import { ProjectCollector } from '../../dist/collectors/project-board.js';
import { diffStatRows } from '../../dist/render/diff-stat-rows.js';
import { setLanguage } from '../../dist/render/i18n.js';
import { setDisplayConfig } from '../../dist/render/hud-config.js';
import { stripAnsi, visualLength } from '../../dist/render/colors.js';
import { handleMonitorInput, renderMonitor } from '../../dist/render/monitor.js';
import { PanelJobPipeline } from '../../dist/tree-page.js';
import { WorkbenchInputDecoder } from '../../dist/utils/workbench-input.js';
import { NOW, TREE, onPage } from '../fixtures/project-page.mjs';

const name = 'src/a-very-long-subdirectory/围栏\t实测\nname.txt';
const baseline = 'alpha\nold\nkeep\n';
const scope = { pane: 'w4E:p1', project: null };
const emptyBoard = { workers: [], lanes: [], decisions: [] };
const emptyDiff = { files: [], totalAdded: 0, totalDeleted: 0, totalFiles: 0 };
function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'hud-numstat-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, 'repo'), home = join(root, 'hud');
  const put = (path, data) => {
    fs.mkdirSync(dirname(path), { recursive: true });
    fs.writeFileSync(path, data);
  };
  fs.mkdirSync(cwd);
  const git = (...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=Synthetic', '-c', 'user.email=test@invalid', ...args], { encoding: 'utf8' }).trim();
  const commit = (subject) => {
    git('add', '--all');
    git('commit', '-qm', subject);
    return git('rev-parse', 'HEAD');
  };
  git('init', '-qb', 'synthetic');
  put(join(cwd, name), baseline);
  put(join(cwd, '.gitattributes'), '*.txt filter=synthetic diff=synthetic\n');
  const base = commit('base');
  return { root, cwd, home, put, git, commit, base };
}

const action = (frame, input) => handleMonitorInput(frame.state, input, { tree: TREE, frame, nowMs: NOW, standalone: true });
const enter = (frame) => action(frame, { type: 'key', key: 'enter' });
function assertOpens(frame, path) {
  const expected = { type: 'open-files', files: [path] };
  assert.deepEqual(enter(frame).action, expected);
  const [open] = new WorkbenchInputDecoder('workboard').push(Buffer.from('o'));
  assert.deepEqual(action(frame, open).action, expected);
}

function display(t) {
  const before = setDisplayConfig({ theme: 'none', icons: 'unicode' }), lang = setLanguage('en');
  t.after(() => { setDisplayConfig(before); setLanguage(lang); });
}

test('bounded safe numstat for working tree and newest 12 tries, with native paths and aggregated totals', async (t) => {
  display(t);
  const f = fixture(t), file = join(f.cwd, name);
  f.put(file, 'alpha\nnew\nextra\nkeep\n');
  for (let i = 0; i < 13; i++) f.put(join(f.cwd, `small-${i}`), 'one\n');
  const a = f.commit('first');
  f.put(file, 'alpha\nnew\nextra\nchanged\n');
  f.put(join(f.cwd, 'asset.bin'), Buffer.from([0, 1]));
  const b = f.commit('second');
  // Repo-local filters and diff drivers must not run even for a same-size working edit.
  const marker = join(f.root, 'ran'), script = join(f.root, 'marker.sh');
  f.put(script, `#!/bin/sh\ntouch '${marker}'\n`);
  fs.chmodSync(script, 0o700);
  for (const key of ['filter.synthetic.process', 'filter.synthetic.clean', 'diff.synthetic.command', 'diff.synthetic.textconv', 'diff.external', 'core.fsmonitor'])
    f.git('config', key, script);
  f.git('config', 'filter.synthetic.required', 'true');
  f.put(file, 'alpha\nneo\nextra\nchanged\nx\n');
  f.put(join(f.cwd, 'asset.bin'), Buffer.from([0, 2]));
  fs.utimesSync(join(f.cwd, 'asset.bin'), 0, 0);
  for (let i = 1; i <= 14; i++) f.put(join(f.cwd, `.scratch/try/issues/${i}-landed.md`),
    `# ${i}: Synthetic slice\n**Status:** ${i === 14 ? 'done' : 'try'}\n**Blocked by:** none\n\n## Comments\n- Landed ${b}\n`);
  const diffs = new DiffStatCollector();
  const read = diffs.commits(f.cwd, `(${a}, ${b}, ${a})`, NOW);
  assert.strictEqual(diffs.commits(f.cwd, `(${b}, ${a})`, NOW + 6000), read, 'same hash set shares even an in-flight probe');
  const aggregate = await read;
  assert.strictEqual(diffs.commits(f.cwd, `(${a}, ${b})`, NOW + 6000), read, 'successful commit results are immutable');
  assert.equal(await diffs.commits(f.cwd, '(1111111)', NOW), undefined, 'unknown commit is not an empty diff');
  assert.equal(aggregate.files.length, 12);
  assert.deepEqual(aggregate.files[0], { path: name, absPath: file, added: 3, deleted: 2 });
  assert.deepEqual([aggregate.totalFiles, aggregate.totalAdded, aggregate.totalDeleted], [15, 16, 2]);
  assert.throws(() => parseNumstat('1\t2\tx', f.cwd), /Incomplete/);
  assert.throws(() => parseNumstat('1\t2\t../x\0', f.cwd), /Invalid numstat path/);

  const collector = new ProjectCollector(f.cwd, f.home);
  const light = await collector.collect('home', emptyBoard, NOW);
  assert.equal(light.gitDiff, undefined);
  assert.ok(light.ledger.every((row) => row.diff === undefined));
  const project = await collector.collect(true, emptyBoard, NOW);
  assert.equal(project.ledger.filter((row) => row.diff).length, 12);
  assert.equal(project.ledger[0].diff, undefined, 'older than the 12 newest tries');
  assert.equal(project.ledger.at(-1).diff, undefined, 'accepted slice');
  assert.deepEqual(project.ledger.at(-2).diff, await diffs.commits(f.cwd, b, NOW));
  assert.deepEqual(project.gitDiff.files, [
    { path: name, absPath: file, added: 2, deleted: 1 },
    { path: 'asset.bin', absPath: join(f.cwd, 'asset.bin'), added: null, deleted: null, binary: true },
  ]);
  assert.ok(!fs.existsSync(marker), 'repo-local filters, diff drivers and fsmonitor were not invoked');
  f.put(file, baseline);
  assert.strictEqual((await collector.collect(true, emptyBoard, NOW + 4999)).gitDiff, project.gitDiff);
  assert.notDeepEqual((await collector.collect(true, emptyBoard, NOW + 5000)).gitDiff, project.gitDiff);

  const unicode = diffStatRows(aggregate, 40).map((r) => stripAnsi(r.text));
  assert.match(unicode[0], /….*name\.txt\s+\+3 -2  ███░░$/);
  assert.match(unicode.at(-1), /\+3 more files/);
  assert.match(diffStatRows(project.gitDiff, 40)[1].text, /bin$/);
  setDisplayConfig({ icons: 'text' });
  assert.match(diffStatRows(aggregate, 40)[0].text, /\+3 -2  \+\+\+--$/);
  setLanguage('zh');
  assert.match(diffStatRows(aggregate, 40).at(-1).text, /另有 3 个文件/);
  assert.match(diffStatRows(project.gitDiff, 40)[1].text, /二进制$/);
  for (const width of [40, 56, 80]) for (const r of diffStatRows(aggregate, width)) assert.equal(visualLength(r.text), width);
  assert.deepEqual(diffStatRows(undefined, 40), []);
  assert.deepEqual(diffStatRows(emptyDiff, 40), []);
  setLanguage('en');

  const item = 'diff:' + file;
  const state = onPage('tree', { project: { nav: { cursor: item } } });
  const frame = renderMonitor({ tree: TREE, project, state, width: 40, height: 48, nowMs: NOW });
  const rows = frame.workboard.rows, shown = rows.findIndex((row) => row.item === item);
  assert.ok(shown > 0, 'Working tree shows the diff');
  assert.ok(rows.slice(0, shown).some((row) => row.text.includes('changed')));
  assert.equal(frame.state.project.nav.cursor, item);
  assertOpens(frame, file);
});

test('thin-job Inspector uses a linked worktree BASE, gates active probes, and freezes a settlement', async (t) => {
  display(t);
  const f = fixture(t), worktree = join(f.root, 'worktree'), file = join(worktree, name);
  f.git('worktree', 'add', '-q', '--detach', worktree, f.base);
  const job = 'j0000000000000001', dir = join(f.home, 'jobs', job), id = `thin-job:${job}`;
  f.put(join(dir, 'job.json'), JSON.stringify({ job, created_at: new Date(NOW).toISOString(), herdr_pane: scope.pane,
    role: 'imp', cwd: f.cwd, worktree: { root: worktree } }));
  f.put(join(dir, 'SESSION.txt'), `TAB=w4E:t2\nBASE=${f.base}`);
  f.put(join(dir, 'brief.md'), '# Synthetic changes');
  f.put(join(dir, 'STATUS.json'), '{"state":"working"}');
  const diffs = new DiffStatCollector();
  assert.deepEqual(await diffs.job(dir, null, NOW), emptyDiff);
  f.put(file, baseline + 'one\n');
  assert.deepEqual(await diffs.job(dir, null, NOW + 4999), emptyDiff);
  const dirty = await diffs.job(dir, null, NOW + 5000);
  assert.deepEqual(dirty.files, [{ path: name, absPath: file, added: 1, deleted: 0 }]);
  f.git('-C', worktree, 'commit', '-qam', 'linked work');
  const committed = await diffs.job(dir, null, NOW + 10000);
  assert.deepEqual(committed, dirty, 'also shows commits with a clean worktree');
  f.put(file, baseline + 'one\ntwo\n');
  const final = await diffs.job(dir, NOW + 10500, NOW + 10500);
  assert.equal(final.files[0].added, 2, 'the final sample includes committed and dirty edits');
  f.put(file, baseline + 'one\ntwo\nthree\n');
  assert.strictEqual(await diffs.job(dir, NOW + 10500, NOW + 50000), final);
  assert.equal((await diffs.job(dir, null, NOW + 50000)).files[0].added, 3, 'resumed work samples again');

  const panel = new PanelJobPipeline(f.home, scope, 0);
  t.after(() => panel.dispose());
  await panel.refresh();
  assert.equal(panel.workboard(TREE).workers[0].diffStat, undefined, 'no Git read in the ordinary jobs pass');
  await panel.refresh(id);
  const workboard = panel.workboard(TREE), worker = workboard.workers[0];
  assert.equal(worker.diffStat.files[0].absPath, file);
  const frame = renderMonitor({ tree: TREE, workboard, width: 40, height: 40, nowMs: NOW, state: onPage(undefined, { activeTab: 'home', subpage: { kind: 'inspector', scroll: 0, target: { kind: 'worker', laneId: worker.laneId, workerId: id }, cursor: 'diff:' + file } }) });
  const rows = frame.workboard.rows.map((r) => stripAnsi(r.text));
  assert.ok(rows.findIndex((line) => /^Changes ─/.test(line)) < rows.findIndex((line) => /^Files ─/.test(line)));
  assertOpens(frame, file);
});
