import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { stripAnsi } from '../../dist/render/colors.js';
import { SETTING_ROWS } from '../../dist/render/settings-page.js';

const until = async (condition, diagnostic) => {
  for (let i = 0; i < 250; i++, await sleep(20)) if (condition()) return;
  assert.fail(diagnostic());
};

test('the live panel switches to Inbox from Settings without a restart, and y on a hub row records a try and paints its mark', async (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'inbox-live-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, 'SampleHUD'), hud = join(root, 'hud');
  fs.mkdirSync(join(cwd, 'docs/handoff'), { recursive: true });
  fs.mkdirSync(join(hud, 'jobs'), { recursive: true });
  fs.writeFileSync(join(cwd, 'docs/handoff/STATE.md'), '# Synthetic STATE\nMilestone: 0.1.4\n\n## Waiting for the owner\n- Choose the synthetic profile\n\n## Slices\n- try · 0.1.4 · ONE · first slice\n- try · 0.1.4 · TWO · second slice\n- accepted · 0.1.4 · DONE · already accepted\n');
  fs.writeFileSync(join(hud, 'hud-settings.json'), JSON.stringify({ modelEnabled: false, refreshMs: 100, language: 'en', theme: 'none', icons: 'unicode' }));
  const runner = `process.stdout.columns = 60; process.stdout.rows = 30;
    const { runLivePage } = await import(${JSON.stringify(new URL('../../dist/tree-page.js', import.meta.url).href)});
    await runLivePage(); process.exit(0);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', runner], {
    cwd, env: { ...process.env, HUD_HOME: hud, CODEX_HUD_STANDALONE_PANEL: '1', CODEX_HUD_PANEL_ALL_DELEGATIONS: '1', CODEX_HUD_CWD: cwd }, stdio: ['pipe', 'pipe', 'pipe'],
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
  const file = join(hud, 'tries.jsonl'), records = () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse) : []);

  key('2');
  await painted(/^Waiting for you ─+ 1$/m);
  assert.doesNotMatch(frame(), /Pages ─|Latest accepted/, "Classic hub");
  key('y');
  await sleep(150);
  assert.deepEqual(records(), [], 'Classic hub: y does nothing outside the to-try view');
  const row = SETTING_ROWS.findIndex((r) => r.key === 'panelLayout');
  key(',');
  await painted(/Layout +Classic/);
  key('\x1b[B'.repeat(row));
  key('\x1b[C'); // Classic → Inbox
  await painted(/Layout .*Inbox/);
  key('s');
  await painted(/Saved/);
  assert.equal(JSON.parse(fs.readFileSync(join(hud, 'hud-settings.json'), 'utf8')).panelLayout, 'inbox');
  key('\x1b');
  await painted(/^Waiting for you ─+ 3 · 2 to try$/m);
  await painted(/^Pages ─+$/m);
  assert.match(frame(), /^◇ TWO +second slice/m);
  key('y');
  await until(() => records().length === 1, () => `${JSON.stringify(records())}\n${frame()}\n${err}`);
  assert.deepEqual([records()[0].action, records()[0].slices, records()[0].milestone], ['accept', ['TWO'], '0.1.4']);
  await painted(/^✓ TWO .*accepted$/m);
  await painted(/^Waiting for you ─+ 3 · 1 to try$/m);
  key('jn');
  await until(() => records().length === 2, () => frame());
  assert.equal(records()[1].action, 'flag');
  await painted(/^⚑ ONE .*flagged$/m);
  key('q');
  child.stdin.end();
  assert.deepEqual(await exited, [0, null]);
});
