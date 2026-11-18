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

function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'panel-try-'));
  const cwd = join(root, 'SampleHUD'), hud = join(root, 'hud'), file = join(hud, 'tries.jsonl');
  const state = join(cwd, 'docs/handoff/STATE.md');
  fs.mkdirSync(join(cwd, 'docs/handoff'), { recursive: true });
  fs.mkdirSync(join(hud, 'jobs'), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, HUD_HOME: hud };
  const body = `# Synthetic STATE
Milestone: 0.1.4

## Slices
- try · 0.1.3 · OLDER · older work
- try · 0.1.4 · ONE · first slice
- try · 0.1.4 · TWO · second slice
- accepted · 0.1.4 · DONE · already accepted
`;
  fs.writeFileSync(state, body);
  const record = (action, ...slices) => appendTry(hud, cwd, action, { milestone: '0.1.4', slices });
  const records = () => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse) : [];
  return { cwd, hud, file, state, body, env, record, records };
}
const until = async (condition, diagnostic) => {
  for (let i = 0; i < 200; i++, await sleep(20)) if (condition()) return;
  assert.fail(diagnostic());
};

test('the live panel records y/n on milestone and slice rows and paints the latest marks until the ledger agrees', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(join(f.hud, 'hud-settings.json'), JSON.stringify({ modelEnabled: false, refreshMs: 100, language: 'en', theme: 'none', icons: 'unicode' }));
  const runner = `process.stdout.columns = 80; process.stdout.rows = 24;
    const { runLivePage } = await import(${JSON.stringify(new URL('../../dist/tree-page.js', import.meta.url).href)});
    await runLivePage(); process.exit(0);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', runner], {
    cwd: f.cwd, env: { ...f.env, CODEX_HUD_STANDALONE_PANEL: '1', CODEX_HUD_PANEL_ALL_DELEGATIONS: '1', CODEX_HUD_CWD: f.cwd },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
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

  key('2');
  await painted(/^Progress +0\.1\.4/m);
  key('\r');
  await painted(/Progress.*updated/);
  key('ynt'); // Neither result key acts in the full feed.
  await painted(/^Only to try ─+ 3$/m);
  assert.match(frame(), /y accept  n flag/);
  key('yn'); // The filter's header is not a milestone.
  assert.deepEqual(f.records(), []);
  key('jy');
  await recorded(1);
  await painted(/▾ 0\.1\.4 +✓ 2 accepted/);
  await painted(/✓ ONE/);
  await painted(/✓ TWO/);
  key('n');
  await recorded(2);
  await painted(/▾ 0\.1\.4 +⚑ 2 flagged/);
  key('jy'); // TWO is the later ledger entry and therefore first in this group.
  await recorded(3);
  await painted(/▾ 0\.1\.4 +✓ 1 accepted  ⚑ 1 flagged/);
  await painted(/✓ TWO/);
  key('n');
  await recorded(4);
  await painted(/⚑ TWO/);
  key('y');
  await recorded(5);
  assert.deepEqual(f.records().map(({ root, action, milestone, slices }) => ({ root, action, milestone, slices })), [
    { root: f.cwd, action: 'accept', milestone: '0.1.4', slices: ['TWO', 'ONE'] },
    { root: f.cwd, action: 'flag', milestone: '0.1.4', slices: ['TWO', 'ONE'] },
    { root: f.cwd, action: 'accept', milestone: '0.1.4', slices: ['TWO'] },
    { root: f.cwd, action: 'flag', milestone: '0.1.4', slices: ['TWO'] },
    { root: f.cwd, action: 'accept', milestone: '0.1.4', slices: ['TWO'] },
  ]);
  assert.ok(f.records().every(({ at }) => Number.isFinite(Date.parse(at))));
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(f.state, 'utf8'), f.body);

  fs.writeFileSync(f.state, f.body.replace('try · 0.1.4 · TWO', 'accepted · 0.1.4 · TWO'));
  await painted(/^Only to try ─+ 2$/m);
  assert.doesNotMatch(frame(), /TWO/);
  assert.match(frame(), /⚑ ONE/, 'another ledger line changing does not clear a flag');
  fs.writeFileSync(f.state, fs.readFileSync(f.state, 'utf8').replace('first slice', 'updated first slice'));
  await painted(/◇ ONE/);
  await painted(/▾ 0\.1\.4 +◇ 1 to try/);
  key('q');
  child.stdin.end();
  assert.deepEqual(await exited, [0, null]);
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
  const child = spawn(process.execPath, [resolve('packages/hud-mcp/bin/hud-mcp.mjs')], { env: f.env, cwd: f.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  t.after(async () => { child.stdin.end(); await exited; });
  const rpc = createInterface({ input: child.stdout });
  let id = 0;
  const roster = async () => {
    const next = once(rpc, 'line');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', id: ++id, params: { name: 'hud_roster', arguments: {} } }) + '\n');
    const [line] = await next;
    return JSON.parse(JSON.parse(line).result.content[0].text);
  };
  assert.deepEqual((await roster()).changes, ['try flagged SampleHUD TWO']);
  assert.equal((await roster()).changes, undefined);
  f.record('accept', { id: 'ONE' });
  assert.deepEqual((await roster()).changes, ['try accepted SampleHUD 0.1.4: ONE']);
});
