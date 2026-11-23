import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { watchCommand } from '../../dist/cli/watch.js';
import { appendTry } from '../../dist/collectors/try-records.js';
import { stripAnsi } from '../../dist/render/colors.js';
import { writeFixtureFile } from '../helpers/thin-mcp-files.mjs';
import { cleanupFixture, stopChild } from '../helpers/process-cleanup.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'panel-try-'));
  const cwd = join(root, 'SampleHUD'), hud = join(root, 'hud'), file = join(hud, 'tries.jsonl');
  const stops = [];
  cleanupFixture(t, { root, hudHome: hud }, () => Promise.all(stops.map((stop) => stop())));
  const state = join(cwd, 'docs/handoff/STATE.md');
  fs.mkdirSync(join(cwd, 'docs/handoff'), { recursive: true });
  fs.mkdirSync(join(hud, 'jobs'), { recursive: true });
  const env = { ...process.env, HUD_HOME: hud };
  const body = `# Synthetic STATE
Milestone: 0.1.4

## Slices
- try · 0.1.3 · OLDER · older work
- try · 0.1.4 · ONE · first slice
- try · 0.1.4 · TWO · second slice
- accepted · 0.1.4 · DONE · already accepted
`;
  writeFixtureFile(state, body);
  const record = (action, ...slices) => appendTry(hud, cwd, action, { milestone: '0.1.4', slices });
  // The real ledger is append-only; an empty file or a partial tail is not a record yet.
  const records = () => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').slice(0, -1).filter(Boolean).map(JSON.parse) : [];
  return { cwd, hud, file, state, body, env, record, records, stops };
}
const until = async (condition, diagnostic) => {
  for (let i = 0; i < 200; i++, await sleep(20)) if (condition()) return;
  assert.fail(diagnostic());
};

function panel(f, { layout = 'classic', columns = 80, prelude = '', acceptance = 'slice' } = {}) {
  fs.writeFileSync(join(f.hud, 'hud-settings.json'), JSON.stringify({ panelLayout: layout, acceptance, modelEnabled: false, refreshMs: 100, language: 'en', theme: 'none', icons: 'unicode' }));
  const runner = `process.stdout.columns = ${columns}; process.stdout.rows = 24;
    ${prelude}
    const { runLivePage } = await import(${JSON.stringify(new URL('../../dist/tree-page.js', import.meta.url).href)});
    await runLivePage(); process.exit(0);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', runner], {
    cwd: f.cwd, env: { ...f.env, CODEX_HUD_STANDALONE_PANEL: '1', CODEX_HUD_PANEL_ALL_DELEGATIONS: '1', CODEX_HUD_CWD: f.cwd },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  f.stops.push(() => stopChild(child, exited));
  const screen = [];
  let err = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    const parts = chunk.split(/\x1b\[(\d+);1H\x1b\[0m\x1b\[K/);
    for (let i = 1; i + 1 < parts.length; i += 2) screen[Number(parts[i]) - 1] = stripAnsi(parts[i + 1]).trimEnd();
  });
  child.stderr.on('data', (data) => { err += data; });
  const frame = () => screen.join('\n');
  const painted = (pattern) => until(() => pattern.test(frame()), () => `${pattern}\n${frame()}\n${err}`);
  const key = (input) => child.stdin.write(input);
  const recorded = (n) => until(() => f.records().length === n, () => `${JSON.stringify(f.records())}\n${frame()}\n${err}`);
  const close = async () => { key('q'); child.stdin.end(); assert.deepEqual(await exited, [0, null]); };
  return { key, frame, painted, recorded, close };
}

test('the live panel flags a milestone, accepts one slice and immediately removes it from Only to try', async (t) => {
  const f = fixture(t);
  const { key, frame, painted, recorded, close } = panel(f);

  key('\x1b[C');
  await painted(/^Progress +0\.1\.4 · 3 to try/m);
  key('Gkk\r'); // Docs → Working tree → Progress.
  await painted(/Progress.*updated/);
  key('ynt'); // The bar row is not a try target.
  await painted(/^Only to try ─+ 3$/m);
  assert.match(frame(), /y accept  n flag/);
  key('yn'); // The filter's header is not a milestone.
  assert.deepEqual(f.records(), []);
  key('jn');
  await recorded(1);
  await painted(/▾ 0\.1\.4 +⚑ 2 flagged/);
  key('jm'); // TWO is the later ledger entry and therefore first in this group.
  const intents = join(f.hud, 'panel-actions.jsonl');
  await painted(/Land requested/);
  const { at, ...intent } = JSON.parse(fs.readFileSync(intents, 'utf8'));
  assert.deepEqual(intent, { type: 'land', root: f.cwd, slices: ['TWO'] });
  assert.equal(f.records().length, 1, 'a request to land neither marks nor removes the slice');
  key('y');
  await recorded(2);
  await painted(/^Only to try ─+ 2$/m);
  assert.doesNotMatch(frame(), /TWO/);
  assert.deepEqual(f.records().map(({ root, action, milestone, slices }) => ({ root, action, milestone, slices })), [
    { root: f.cwd, action: 'flag', milestone: '0.1.4', slices: ['TWO', 'ONE'] },
    { root: f.cwd, action: 'accept', milestone: '0.1.4', slices: ['TWO'] },
  ]);
  assert.ok(f.records().every(({ at }) => Number.isFinite(Date.parse(at))));
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(f.state, 'utf8'), f.body);

  writeFixtureFile(f.state, f.body.replace('try · 0.1.4 · TWO', 'accepted · 0.1.4 · TWO'));
  await painted(/^Only to try ─+ 2$/m);
  assert.doesNotMatch(frame(), /TWO/);
  assert.match(frame(), /⚑ ONE/, 'another ledger line changing does not clear a flag');
  writeFixtureFile(f.state, fs.readFileSync(f.state, 'utf8').replace('first slice', 'updated first slice'));
  await painted(/◇ ONE/);
  await painted(/▾ 0\.1\.4 +◇ 1$/m);
  await close();
});

test('task acceptance writes each pending slice of the milestone in one record', async (t) => {
  const f = fixture(t), { key, painted, recorded, close } = panel(f, { acceptance: 'task' });
  key('\x1b[C');
  await painted(/^Progress +2 to try/m);
  key('Gkk\rtj');
  await painted(/^Only to try ─+ 2$/m);
  await painted(/◇ 0\.1\.4 +2 slices/);
  key(' ');
  await painted(/▣ ◇ 0\.1\.4/);
  key('n');
  await recorded(1);
  await painted(/⚑ 0\.1\.4 +2 slices/);
  key('y');
  await recorded(2);
  await painted(/^Only to try ─+ 1$/m);
  assert.deepEqual(f.records().map(({ action, milestone, slices }) => ({ action, milestone, slices })), [
    { action: 'flag', milestone: '0.1.4', slices: ['TWO', 'ONE'] },
    { action: 'accept', milestone: '0.1.4', slices: ['TWO', 'ONE'] },
  ]);
  assert.equal(fs.readFileSync(f.state, 'utf8'), f.body);
  await close();
});

test('Space marks two rows, then y writes one try record and one watch line in Classic and both Split views', async (t) => {
  for (const view of ['classic', 'split-hub', 'split-progress']) {
    const f = fixture(t);
    const { key, frame, painted, recorded, close } = panel(f, { layout: view === 'classic' ? 'classic' : 'split', columns: 40 });
    key('\x1b[C');
    await painted(/^Needs you ─+ 3 to try/m);
    let slices = ['TWO', 'ONE'];
    if (view === 'classic') {
      key('Gkk\rt');
      await painted(/^Only to try /m);
      key('jj ');
      await painted(/▣ ◇ TWO/);
      key('t'); // Leaving and re-entering clears the selection.
      await painted(/t to try/);
      key('t');
      await painted(/^Only to try /m);
      assert.doesNotMatch(frame(), /▣/);
      key('jj ');
      await painted(/▣ ◇ TWO/);
      key(' ');
      await painted(/^ {4}◇ TWO/m); // Toggle the same row off.
    } else if (view === 'split-progress') {
      key('Gkk\r');
      await painted(/^‹ .*Progress/m);
    } else {
      slices = ['TWO', 'OLDER']; // One record across milestones from the Inbox list.
    }
    assert.match(frame(), /Space mark/);
    key(' ');
    await painted(new RegExp(`▣ ◇ ${slices[0]}`));
    key(view === 'split-hub' ? 'jj ' : 'j ');
    await painted(new RegExp(`▣ ◇ ${slices[1]}`));
    assert.match(frame(), new RegExp(`▣ ◇ ${slices[0]}`));
    assert.deepEqual(f.records(), []);
    key('y');
    await recorded(1);
    await until(() => !slices.some(s => frame().includes(`◇ ${s}`)) && !frame().includes('▣'), frame);
    assert.doesNotMatch(frame(), /▣/);
    assert.equal(f.records()[0].action, 'accept');
    assert.deepEqual(f.records()[0].slices, slices);
    const abort = new AbortController(), lines = [];
    t.after(() => abort.abort());
    const watching = watchCommand(['--all'], { env: f.env, stdout: (s) => lines.push(s.trim()), stderr: () => {} }, { signal: abort.signal });
    await until(() => lines.length > 0, () => `${view}: ${JSON.stringify(f.records())}`);
    abort.abort();
    assert.equal(await watching, 0);
    const title = view === 'split-hub' ? 'SampleHUD' : 'SampleHUD 0.1.4';
    assert.deepEqual(lines, [`try accepted ${title}: ${slices.join(', ')}`]);
    await close();
  }
});

test('at 40 columns the Projects list pauses brief scheduling, and a switched project only schedules its own inputs', async (t) => {
  const f = fixture(t), other = join(f.cwd, 'other-project'), hold = join(f.hud, 'hold'), log = join(f.hud, 'brief-schedule.jsonl');
  fs.mkdirSync(other);
  fs.writeFileSync(join(other, 'STATE.md'), 'Milestone: M4\n\n## Slices\n- try · M4 · OTHER · synthetic other work\n');
  fs.writeFileSync(join(f.hud, 'projects.json'), JSON.stringify({ version: 1, projects: [{ root: other }] }));
  fs.writeFileSync(log, '');
  const prelude = `
    import fs from 'node:fs';
    import { setTimeout as sleep } from 'node:timers/promises';
    import { ProjectCollector } from ${JSON.stringify(new URL('../../dist/collectors/project-board.js', import.meta.url).href)};
    import { TryBriefs } from ${JSON.stringify(new URL('../../dist/collectors/try-brief.js', import.meta.url).href)};
    const log = (event) => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(event) + '\\n');
    const held = () => fs.existsSync(${JSON.stringify(hold)});
    const collect = ProjectCollector.prototype.collect;
    ProjectCollector.prototype.collect = async function (mode, ...args) {
      if (mode === true && held()) { log({ held: true }); while (held()) await sleep(10); }
      if (mode === false) log({ overview: true });
      return collect.call(this, mode, ...args);
    };
    TryBriefs.prototype.update = (root, ledger) => log({ root, ids: ledger.map((r) => r.id) });`;
  const { key, painted, close } = panel(f, { columns: 40, prelude });
  const events = () => fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const waitFor = (condition) => until(() => condition(events()), () => JSON.stringify(events()));
  await waitFor(xs => xs.some(x => x.root === f.cwd && x.ids.includes('ONE'))); // Home alone starts the briefs.
  key('\x1b[C');
  await painted(/project 1\/2/);
  await waitFor((xs) => xs.some((x) => x.root === f.cwd && x.ids.includes('ONE')));
  fs.writeFileSync(hold, '');
  key('\x1b[H'); // Home selects the project name and hold the next full collection.
  await waitFor((xs) => xs.some((x) => x.held));
  key('\r');
  await painted(/^‹ Projects/m);
  fs.unlinkSync(hold);
  await waitFor((xs) => xs.some((x) => x.overview));
  key('j');
  await waitFor((xs) => xs.filter((x) => x.overview).length >= 2);
  const paused = events().slice(events().findIndex((e) => e.held));
  assert.ok(!paused.some((e) => e.root), 'the previous snapshot did not schedule requests in the list');

  fs.writeFileSync(hold, '');
  key('\x1b');
  await waitFor((xs) => xs.filter((x) => x.held).length >= 2);
  key(']');
  await painted(/project 2\/2/);
  fs.unlinkSync(hold);
  await waitFor((xs) => xs.some((x) => x.root === other && x.ids.includes('OTHER')));
  await close();
  const switched = events().slice(events().findLastIndex((e) => e.held)).filter((e) => e.root);
  assert.ok(switched.length && switched.every((e) => e.root === other && e.ids.join() === 'OTHER'));
});

test('hud watch skips reflected tries on catch-up and emits each live record once without waiting for a rescan', async (t) => {
  const f = fixture(t);
  f.record('accept', { id: 'DONE' });
  f.record('flag', { id: 'ONE', text: 'outdated first slice' });
  f.record('accept', { id: 'TWO' }); // Superseded before catch-up.
  f.record('flag', { id: 'TWO', text: 'second slice' });
  const abort = new AbortController();
  t.after(() => abort.abort());
  const lines = [];
  const run = watchCommand(['--all'], { env: f.env, stdout: (s) => lines.push(s.trim()), stderr: () => {} }, { signal: abort.signal });
  await until(() => lines.length > 0, () => JSON.stringify(lines));
  assert.deepEqual(lines, ['try flagged SampleHUD TWO']);
  f.record('accept', { id: 'ONE' }, { id: 'TWO' });
  await until(() => lines.length >= 2, () => JSON.stringify(lines));
  f.record('flag', { id: 'ONE', text: 'first slice' });
  f.record('flag', { id: 'TWO', text: 'second slice' });
  await until(() => lines.length >= 4, () => JSON.stringify(lines));
  await sleep(100); // One append may produce multiple fs.watch events.
  assert.deepEqual(lines, ['try flagged SampleHUD TWO', 'try accepted SampleHUD 0.1.4: ONE, TWO', 'try flagged SampleHUD ONE', 'try flagged SampleHUD TWO']);
  abort.abort();
  assert.equal(await run, 0);
});

test('MCP changes carry unreflected try lines once, only for the session cwd', async (t) => {
  const f = fixture(t);
  f.record('accept', { id: 'DONE' });
  const other = join(f.cwd, 'other');
  fs.mkdirSync(other);
  fs.writeFileSync(join(other, 'STATE.md'), f.body);
  appendTry(f.hud, other, 'accept', { milestone: '0.1.4', slices: [{ id: 'ONE' }] });
  f.record('flag', { id: 'TWO', text: 'second slice' });
  const child = spawn(process.execPath, [resolve('packages/hud-mcp/bin/hud-mcp.mjs')], {
    env: { ...f.env, HUD_MCP_JSON: '0' }, cwd: f.cwd, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  f.stops.push(() => stopChild(child, exited, { closeStdin: true }));
  const rpc = createInterface({ input: child.stdout });
  let id = 0;
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  // A child that exits (no dist/mcp: run `npm run build`) fails the test instead of leaving it waiting for a line.
  const died = exited.then(([code]) => { throw new Error(`hud-mcp exited (${code}) before answering: ${stderr.trim() || 'no stderr'}`); });
  const call = async (name) => {
    const next = Promise.race([once(rpc, 'line'), died]);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', id: ++id, params: { name, arguments: {} } }) + '\n');
    const [line] = await next;
    return JSON.parse(line).result.content.map(({ text }) => text);
  };
  assert.match((await call('hud_roster'))[0], /\nchanges:\n- try flagged SampleHUD TWO$/);
  assert.doesNotMatch((await call('hud_roster'))[0], /\nchanges:/);
  f.record('accept', { id: 'ONE' }, { id: 'TWO' });
  const [guide, changes] = await call('hud_tickets');
  assert.match(guide, /^# Ticket method/);
  assert.equal(changes, 'changes:\n- try accepted SampleHUD 0.1.4: ONE, TWO');
});
