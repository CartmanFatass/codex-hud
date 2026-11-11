import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

test('hud panel splits beside the caller and runs --here with the same selection', (t) => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'hud-panel-beside-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const hudHome = join(dir, 'hud');
  const bin = join(dir, 'bin');
  const cwd = join(dir, "workspace with 'quotes'");
  for (const path of [home, hudHome, bin, cwd]) fs.mkdirSync(path, { recursive: true });
  fs.writeFileSync(
    join(bin, 'herdr'),
    `#!${process.execPath}\nimport(${JSON.stringify(pathToFileURL(resolve('tests/fakes/panel-herdr.mjs')).href)});\n`,
    { mode: 0o700 }
  );
  const log = join(dir, 'herdr.jsonl');
  const result = spawnSync(process.execPath, [resolve('bin/hud'), 'panel', '--root', 'synthetic/session'], {
    cwd,
    env: {
      HOME: home,
      HUD_HOME: hudHome,
      CODEX_HOME: join(dir, 'codex'),
      CLAUDE_CONFIG_DIR: join(dir, 'claude'),
      PATH: `${bin}:${dirname(process.execPath)}`,
      HERDR_PANE_ID: 'main',
      PANEL_FAKE_LOG: log,
    },
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls[0], ['pane', 'split', 'main', '--direction', 'right', '--no-focus', '--cwd', cwd]);
  assert.equal(calls.length, 2, 'one split and one run, no topology/receipt probes');
  const pane = result.stdout.trim();
  assert.ok(pane);
  assert.deepEqual(calls[1].slice(0, 3), ['pane', 'run', pane]);
  assert.ok(calls[1][3].includes(`'${resolve('bin/hud')}' 'panel' '--here' '--root' 'synthetic/session'`));
});
