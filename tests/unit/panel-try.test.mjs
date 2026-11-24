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
  fs.writeFileSync(join(hud, 'projects.json'), JSON.stringify({ version: 1, projects: [{ root: cwd }] }));
  const env = { ...process.env, HUD_HOME: hud };
  const body = `# Synthetic STATE
Milestone: 0.1.4

## Waiting for the owner
- Choose the sample filename.
- 确认示例的显示语言。

## Slices
- try · 0.1.3 · OLDER · older work
- try · 0.1.4 · ONE · first slice
- try · 0.1.4 · TWO · second slice
- accepted · 0.1.4 · DONE · already accepted
- working · 0.1.4 · LIVE · ongoing work
`;
  writeFixtureFile(state, body);
  const record = (action, ...slices) => appendTry(hud, cwd, action, { milestone: '0.1.4', slices });
  const records = () => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').slice(0, -1).filter(Boolean).map(JSON.parse) : [];
  return { cwd, hud, file, state, body, env, record, records, stops };
}
const until = async (condition, diagnostic) => {
  for (let i = 0; i < 200; i++, await sleep(20)) if (condition()) return;
  assert.fail(diagnostic());
};

function panel(f, layout) {
  const modelLog = join(f.hud, 'model-features');
  fs.writeFileSync(join(f.hud, 'hud-settings.json'), JSON.stringify({ panelLayout: layout, acceptance: 'slice', modelEnabled: true,
    briefingApiBase: 'https://api.mistral.ai/v1', model: 'synthetic', refreshMs: 100, language: 'en', theme: 'none', icons: 'unicode' }));
  const runner = `import fs from 'node:fs';
    globalThis.fetch = async (url) => {
      fs.appendFileSync(${JSON.stringify(modelLog)}, String(url) + '\\n');
      throw new Error('Unexpected outbound panel request');
    };
    process.stdout.columns = 56; process.stdout.rows = 35;
    const { runLivePage } = await import(${JSON.stringify(new URL('../../dist/tree-page.js', import.meta.url).href)});
    await runLivePage(); process.exit(0);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', runner], {
    cwd: f.cwd, env: { ...f.env, MISTRAL_API_KEY: 'synthetic-key', OPENAI_API_KEY: 'synthetic-key', CODEX_HUD_STANDALONE_PANEL: '1', CODEX_HUD_PANEL_ALL_DELEGATIONS: '1', CODEX_HUD_CWD: f.cwd },
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
  const close = async () => { key('q'); child.stdin.end(); assert.deepEqual(await exited, [0, null]); };
  return { key, frame, painted, close, modelLog };
}

for (const layout of ['classic', 'split']) test(`${layout} Accept all records every pending ticket once, leaves STATE alone and keeps its waiting item`, async (t) => {
  const f = fixture(t), issues = join(f.cwd, '.scratch/demo/issues');
  fs.mkdirSync(issues, { recursive: true });
  for (const n of ['01', '02', '03']) writeFixtureFile(join(issues, `${n}-pending.md`),
    `# ${n}: Pending change\n**Status:** ready-for-human\n**Blocked by:** none\n\n## Comments\n- Landed abc1234\n`);
  const { key, frame, painted, close, modelLog } = panel(f, layout);
  await painted(/Choose the sample filename/);
  key('\x1b[C');
  await painted(/Tickets +1 feature/m);
  assert.doesNotMatch(frame(), /Accept all|3 to try/);
  key('Gkk\r'); // Docs → Working tree → Tickets, then open its diagnostics.
  await painted(/^Accept all +3 to try/m);
  key('G');
  await painted(/⏎ accept all/);
  key('yntm ');
  assert.deepEqual(f.records(), []);
  key('\r\r');
  await until(() => f.records().length > 0 && !/Accept all/.test(frame()), frame);
  key('\x1b');
  await painted(/Choose the sample filename/);
  await close();
  assert.doesNotMatch(frame(), /Only to try|How to try|Space mark|m request land/);
  assert.match(frame(), /Choose the sample filename/);
  assert.equal(fs.existsSync(join(f.hud, 'panel-actions.jsonl')), false);
  assert.equal(f.records().length, 1);
  const [{ at, ...record }] = f.records();
  assert.ok(Number.isFinite(Date.parse(at)));
  assert.deepEqual(record, { root: f.cwd, action: 'accept', milestone: 'demo', slices: ['DEMO-01', 'DEMO-02', 'DEMO-03'] });
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(f.state, 'utf8'), f.body);
  assert.equal(fs.existsSync(modelLog), false, 'legacy display settings never request translations');
  assert.match(frame(), /确认示例的显示语言/);
  const abort = new AbortController(), lines = [];
  t.after(() => abort.abort());
  const watching = watchCommand(['--all'], { env: f.env, stdout: (s) => lines.push(s.trim()), stderr: () => {} }, { signal: abort.signal });
  await until(() => lines.length > 0, () => JSON.stringify(f.records()));
  abort.abort();
  assert.equal(await watching, 0);
  assert.deepEqual(lines, ['try accepted SampleHUD demo: DEMO-01, DEMO-02, DEMO-03']);
});

test('hud watch skips reflected legacy tries on catch-up and emits each live record once', async (t) => {
  const f = fixture(t);
  f.record('accept', { id: 'DONE' });
  f.record('flag', { id: 'ONE', text: 'outdated first slice' });
  f.record('accept', { id: 'TWO' });
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
