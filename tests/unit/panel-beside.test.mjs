import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

function checkPanel(t, width, columns, layoutWidth, ratio, savedWidth = 80, nativePi = false) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'hud-panel-beside-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const hudHome = join(dir, 'hud');
  const bin = join(dir, 'bin');
  const cwd = join(dir, "workspace with 'quotes'");
  for (const path of [home, hudHome, bin, cwd]) fs.mkdirSync(path, { recursive: true });
  fs.writeFileSync(
    join(bin, 'herdr'),
    `#!${process.execPath}
import fs from 'node:fs';
if (process.argv[3] === 'layout') {
  fs.appendFileSync(process.env.PANEL_FAKE_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
  console.log(JSON.stringify({result: {layout: {panes: [{pane_id: 'w4E:p9', rect: {width: 80}}, {pane_id: 'w4E:p1', rect: {width: Number(process.env.PANEL_LAYOUT_WIDTH)}}]}}}));
} else await import(${JSON.stringify(pathToFileURL(resolve('tests/fakes/panel-herdr.mjs')).href)});
`,
    { mode: 0o700 }
  );
  const log = join(dir, 'herdr.jsonl');
  const settingsFile = join(hudHome, 'custom-settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ treeWidth: savedWidth }));
  const result = spawnSync(
    process.execPath,
    nativePi ? ['--input-type=module', '-e', `
      import { openPiPanel } from ${JSON.stringify(pathToFileURL(resolve('dist/harness/pi/package-native.js')).href)};
      console.log(await openPiPanel({node: process.execPath, release: ${JSON.stringify(process.cwd())}},
        {cwd: process.cwd(), sessionManager: {getSessionId: () => 'synthetic', getSessionDir: () => process.cwd()}}, process.env));
    `] : [resolve('bin/hud'), 'panel', ...(width === undefined ? [] : ['--width', String(width)]), '--root', 'synthetic/session'],
    {
      cwd,
      env: {
        HOME: home,
        HUD_HOME: hudHome,
        HUD_SETTINGS_PATH: settingsFile,
        CODEX_HOME: join(dir, 'codex'),
        CLAUDE_CONFIG_DIR: join(dir, 'claude'),
        PI_CODING_AGENT_DIR: join(dir, 'pi'),
        COLUMNS: columns,
        PANEL_LAYOUT_WIDTH: layoutWidth,
        HERDR_SOCKET_PATH: join(dir, 'synthetic.sock'),
        PATH: `${bin}:${dirname(process.execPath)}`,
        HERDR_PANE_ID: 'w4E:p1',
        PANEL_FAKE_LOG: log,
      },
      encoding: 'utf8',
      timeout: 10000,
    }
  );
  assert.equal(result.status, 0, result.stderr);
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  if (!columns) assert.deepEqual(calls.shift(), ['pane', 'layout', '--pane', 'w4E:p1']);
  assert.equal(
    calls[0].join('|'),
    `pane|split|w4E:p1|--direction|right|--ratio|${ratio}|--no-focus|--cwd|${cwd}|--env|HUD_PANEL_CALLER_PANE=w4E:p1|--env|HUD_PANEL_WIDTH=${width ?? savedWidth}`
  );
  assert.equal(calls.length, 3, 'one split, rename and run after optional geometry lookup');
  const pane = result.stdout.trim();
  assert.ok(pane);
  assert.deepEqual(calls[1], ['pane', 'rename', pane, 'hud panel']);
  assert.deepEqual(calls[2].slice(0, 3), ['pane', 'run', pane]);
  assert.ok(calls[2][3].includes(`'${resolve('bin/hud')}' 'panel' '--here'`));
  assert.ok(calls[2][3].includes(nativePi ? "'--harness' 'pi'" : "'--root' 'synthetic/session'"));
}
for (const [label, width, columns, layoutWidth, ratio] of [
  ['COLUMNS', 40, '160', '', 0.75],
  ['caller pane layout without a TTY', 56, undefined, '200', 0.72],
  ['nominal width without geometry', 56, undefined, '', 1 - 56 / 120],
  ['saved Width', undefined, '160', '', 0.5],
  ['the 41-column agent minimum', 100, '120', '', 1 - 79 / 120],
])
  test(`hud panel sizes its split from ${label}`, (t) => checkPanel(t, width, columns, layoutWidth, ratio));
test('hud panel still opens with a saved legacy 32', (t) => checkPanel(t, undefined, '160', '', 0.8, 32));
test('pi native panel uses saved Width too', (t) => checkPanel(t, undefined, '160', '', 0.5, 80, true));
test('saved 0 opens at the common default 56', (t) => checkPanel(t, undefined, '160', '', 0.65, 0));
