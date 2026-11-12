import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { projectFixture, projectFrames, plain, NOW, TREE } from '../fixtures/project-page.mjs';
import { projectShown } from '../../dist/collectors/project-board.js';
import { initialMonitorState, handleMonitorInput } from '../../dist/render/monitor.js';
import { visualLength, stripAnsi } from '../../dist/render/colors.js';
import { WorkbenchInputDecoder } from '../../dist/utils/workbench-input.js';
import { openEditorPane } from '../../dist/cli/panel-pane.js';
const expected = JSON.parse(fs.readFileSync(new URL('../fixtures/project-frames.json', import.meta.url), 'utf8'));
async function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'project-page-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, ...await projectFixture(root) };
}
const ctx = (frame) => ({ tree: TREE, frame, nowMs: NOW, standalone: true });
const press = (frame, key) => handleMonitorInput(frame.state, { type: 'key', key }, ctx(frame));
test('Project frames: real synthetic project, roles, agents, credentials, STATE and reviews at 80/120 EN/ZH', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(projectFrames(f), expected);
  assert.equal(f.data.git.branch, 'synthetic-project');
  assert.match(f.data.last.text, /Synthetic Project baseline/);
  assert.equal(f.data.waiting.length, 2);
  assert.match(f.data.waiting[1].value, /after trying the synthetic setup/);
  assert.equal(f.data.editing.length, 1);
  assert.equal(f.data.docs[0].value, 'M4 · Project');
  assert.match(f.data.docs[1].path, /2026-11-12-review.md$/);
  assert.ok(f.data.control.some((r) => r.label === 'imp' && r.value === 'pi  synthetic/model  high'));
  assert.equal(f.data.agents.length, 3);
  assert.equal(f.data.browser, true);
  for (const width of [32, 40, 56, 80, 120]) for (const lang of ['en', 'zh']) {
    const frame = f.render(width, lang);
    for (const line of frame.lines) assert.equal(visualLength(line), width, stripAnsi(line));
    const text = plain(frame).join('\n');
    assert.doesNotMatch(text, /NEVER_RENDER|unrelated bullet|Tickets|工单/);
    if (lang === 'zh') {
      assert.match(text, /^ 首页  项目 2/m);
      assert.doesNotMatch(text, /\bProject 2\b|3 agent\b/);
      assert.ok(frame.workboard.rows.some((r) => stripAnsi(r.text).startsWith('▸ 代理')));
    }
  }
  assert.doesNotMatch(JSON.stringify(f.data), /NEVER_RENDER/);
  assert.deepEqual(f.data.keys, [['MISTRAL_API_KEY', true], ['OPENAI_API_KEY', false], ['TYPESAFE_API_KEY', true], ['SYNTHETIC_KEY', true]]);
  assert.ok([...f.collector.cache.get(join(f.hud, 'credentials.env')).value.values()].every((v) => typeof v === 'boolean'));
});
test('Control plane and native agents start folded and Enter unfolds/folds through real input', async (t) => {
  const f = await fixture(t);
  let frame = f.render(80, 'en', { ...initialMonitorState(), mainTab: 'project' });
  assert.match(plain(frame).join('\n'), /▸ Control plane/);
  assert.doesNotMatch(plain(frame).join('\n'), /synthetic\/model/);
  frame.state.projectCursor = 'project:fold:control';
  frame = f.render(80, 'en', press(frame, 'enter').state);
  assert.match(plain(frame).join('\n'), /synthetic\/model/);
  assert.doesNotMatch(plain(frame).join('\n'), /project-agent\.md/);
  frame.state.projectCursor = 'project:fold:agents';
  frame = f.render(80, 'en', press(frame, 'enter').state);
  for (const name of ['user-agent.md', 'project-agent.md', 'codex-agent.toml']) assert.match(plain(frame).join('\n'), new RegExp(name));
  frame.state.projectCursor = 'project:fold:control';
  frame = f.render(80, 'en', press(frame, 'enter').state);
  assert.doesNotMatch(plain(frame).join('\n'), /synthetic\/model/);
});
test('2 and arrows/Tab switch Home ⇄ Project with independent cursor/scroll; 3 stays Changes', async (t) => {
  const f = await fixture(t), decoder = new WorkbenchInputDecoder('workboard');
  const send = (frame, raw) => handleMonitorInput(frame.state, decoder.push(Buffer.from(raw))[0], ctx(frame));
  let frame = f.render(80, 'en', { ...initialMonitorState(), homeScroll: 3 });
  assert.equal(projectShown(frame.state), false);
  frame = f.render(80, 'en', send(frame, '2').state);
  assert.equal(frame.state.mainTab, 'project');
  assert.equal(projectShown(frame.state), true);
  frame.state.projectCursor = 'project:fold:docs';
  for (const raw of ['\x1b[D', '\x1b[C', '\t', '\x1b[Z']) {
    frame = f.render(80, 'en', send(frame, raw).state);
    assert.equal(frame.state.mainTab, 'home');
    frame = f.render(80, 'en', send(frame, raw).state);
    assert.equal(frame.state.mainTab, 'project');
    assert.equal(frame.state.projectCursor, 'project:fold:docs');
  }
  const homeControl = frame.controls.find((c) => c.kind === 'board-home');
  frame = f.render(80, 'en', handleMonitorInput(frame.state, { type: 'mouse', button: 'left', x: homeControl.x, y: 0 }, ctx(frame)).state);
  assert.equal(frame.state.mainTab, 'home');
  const control = frame.controls.find((c) => c.kind === 'board-project');
  frame = f.render(80, 'en', handleMonitorInput(frame.state, { type: 'mouse', button: 'left', x: control.x, y: 0 }, ctx(frame)).state);
  assert.equal(frame.state.mainTab, 'project');
  frame = f.render(80, 'en', send(frame, '3').state);
  assert.equal(frame.state.focus, 'changes');
  assert.equal(projectShown(frame.state), false);
});
test('Enter and o open the exact Project file through fake herdr; default editor is vim', async (t) => {
  const f = await fixture(t), log = join(f.root, 'editor.jsonl'), bin = join(f.root, 'bin');
  fs.writeFileSync(join(bin, 'herdr'), `#!${process.execPath}\nimport fs from 'node:fs';\nconst args = process.argv.slice(2);\nfs.appendFileSync(process.env.EDITOR_LOG, JSON.stringify(args) + '\\n');\nconsole.log(JSON.stringify({result: {pane: {pane_id: 'synthetic-editor'}}}));\n`, { mode: 0o700 });
  const env = { ...f.env, PATH: `${bin}:${dirname(process.execPath)}`, HERDR_PANE_ID: 'synthetic-panel', EDITOR_LOG: log };
  let frame = f.render(80);
  const rows = frame.workboard.rows.filter((r) => r.files);
  for (const row of rows) {
    frame.state.projectCursor = row.item;
    for (const key of ['enter', 'open-session']) assert.deepEqual(press(frame, key).action, { type: 'open-files', files: row.files });
  }
  const file = rows.find((r) => r.files[0].endsWith('STATE.md'));
  frame.state.projectCursor = file.item;
  await openEditorPane(press(frame, 'enter').action.files, env);
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls[0].slice(0, 6), ['pane', 'split', 'synthetic-panel', '--direction', 'right', '--focus']);
  assert.deepEqual(calls[1], ['pane', 'run', 'synthetic-editor', `vim '${file.files[0]}'`]);
  await openEditorPane([join(f.root, "a file's name.md")], { ...env, EDITOR: 'synthetic-editor --wait' });
  const custom = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse).at(-1);
  assert.ok(custom[3].startsWith('synthetic-editor --wait '));
  assert.ok(custom[3].includes("'\\''"));
});
test('Home and overlays collect nothing; warm Project uses signatures and git waits five seconds', async (t) => {
  const f = await fixture(t), originals = Object.fromEntries(['readSync', 'lstatSync', 'opendirSync'].map((k) => [k, fs[k]]));
  const calls = { readSync: 0, lstatSync: 0, opendirSync: 0 };
  for (const key of Object.keys(calls)) fs[key] = (...args) => { calls[key]++; return originals[key](...args); };
  syncBuiltinESMExports();
  t.after(() => { Object.assign(fs, originals); syncBuiltinESMExports(); });
  for (const state of [initialMonitorState(), { mainTab: 'project', focus: 'details', help: false }, { mainTab: 'project', focus: 'agents', help: true }]) {
    assert.equal(await f.collector.collect(projectShown(state), f.board, NOW + 1), undefined);
  }
  assert.equal(projectShown({ mainTab: 'project', focus: 'agents', help: false }, true), false);
  assert.deepEqual(calls, { readSync: 0, lstatSync: 0, opendirSync: 0 });
  fs.renameSync(join(f.cwd, '.git'), join(f.cwd, '.git-hidden'));
  const warm = await f.collector.collect(true, f.board, NOW + 4999);
  assert.equal(warm.git.branch, 'synthetic-project', 'no git probe before five seconds, even when repository disappears');
  assert.equal(calls.readSync, 0);
  assert.equal(calls.opendirSync, 0);
  assert.ok(calls.lstatSync > 0);
  const expired = await f.collector.collect(true, f.board, NOW + 5000);
  assert.equal(expired.git, undefined, 'a failed git refresh is unknown, not stale success');
});
test('changed/oversized sources, missing milestone and source fallback never invent facts', async (t) => {
  const f = await fixture(t);
  f.put(join(f.cwd, 'docs/handoff/STATE.md'), '# No milestone\n\n## Waiting for the owner\n- New owner item\n\n## Other\n- Not waiting\n');
  f.put(join(f.hud, 'credentials.env'), 'MISTRAL_API_KEY=\nOPENAI_API_KEY=   \nTYPESAFE_API_KEY=\'\'\nOTHER_NAME=synthetic\n');
  let data = await f.collector.collect(true, f.board, NOW + 1);
  assert.deepEqual(data.waiting.map((i) => i.value), ['New owner item']);
  assert.equal(data.docs.some((i) => i.label === 'spec'), false);
  assert.deepEqual(data.keys, [['MISTRAL_API_KEY', false], ['OPENAI_API_KEY', false], ['TYPESAFE_API_KEY', false], ['OTHER_NAME', true]]);
  f.put(join(f.cwd, 'docs/handoff/STATE.md'), 'Milestone:\n\n## Waiting for the owner\n- Still waiting\n');
  data = await f.collector.collect(true, f.board, NOW + 1);
  assert.equal(data.docs.some((i) => i.label === 'spec'), false, 'an empty milestone must not consume the next heading');
  fs.unlinkSync(join(f.hud, 'jev-runtime/runtime.json'));
  fs.unlinkSync(join(f.cwd, 'hud-convention.md'));
  f.put(join(f.hud, 'hud-convention.md'), '# User convention');
  f.put(join(f.cwd, 'docs/handoff/STATE.md'), 'x'.repeat(65536) + '\nMilestone: NEVER_READ_TAIL\n');
  data = await f.collector.collect(true, f.board, NOW + 2);
  assert.equal(data.docs.some((i) => i.label === 'spec'), false);
  assert.equal(data.control.find((i) => i.label === 'convention').value, 'yours');
  assert.equal(data.browser, false);
  assert.doesNotMatch(JSON.stringify(data), /NEVER_READ_TAIL/);
  f.put(join(f.hud, 'roles/imp.json'), { role: 'imp', harness: 'pi', pi_role: 'implementer', split: true, can_continue: true, model: 'override/model', thinking: 'low' });
  data = await f.collector.collect(true, f.board, NOW + 3);
  assert.equal(data.control.find((i) => i.label === 'imp').value, 'pi  override/model  low');
});
