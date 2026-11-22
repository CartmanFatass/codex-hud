import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { watchPanelCaller } from '../../dist/cli/panel-pane.js';
import { writeFixtureFile } from '../helpers/thin-mcp-files.mjs';

// The modules deleted by PRUNE-OBS-01 through PRUNE-OBS-03. Keep the live rollout/recovery types out of this list.
const retiredModules = [
  'collectors/job-display-types',
  'collectors/job-live-observation',
  'collectors/job-observations',
  'collectors/job-tree',
  'collectors/native-calls',
  'collectors/task-observations',
  'core/capacity',
  'core/execution',
  'core/interfaces/registry-provider',
  'core/interfaces/session-binding',
  'core/ledger-read',
  'core/link-ledger-read',
  'core/link/job-display',
  'core/link/limits',
  'core/link/types',
  'core/link/view-model',
  'core/types/close',
  'core/types/execution',
  'core/types/lifecycle',
  'core/wake/projection',
  'jev/runtime/types',
  'ledger/notify-events',
  'managed/host-ipc',
  'managed/host',
  'managed/jev-host',
  'managed/relations',
  'managed/types',
  'render/job-details',
  'roles/association',
  'roles/external-association',
  'roles/pi-dispatch-status',
  'roles/pi-dispatch',
];

test('removed observer modules stay out of source and the panel build', () => {
  const files = retiredModules.flatMap((name) => [`src/${name}.ts`, `dist/${name}.js`]);
  assert.deepEqual(files.filter((file) => fs.existsSync(new URL(`../../${file}`, import.meta.url))), []);
});

test('panel caller uses a 3000ms interval without a timing override', (t) => {
  const interval = t.mock.method(globalThis, 'setInterval');
  const stop = watchPanelCaller({ HUD_PANEL_CALLER_PANE: 'w4E:p1', HERDR_PANE_ID: 'w4E:p2' }, () => {});
  stop();
  assert.equal(interval.mock.callCount(), 1);
  assert.equal(interval.mock.calls[0].arguments[1], 3000);
});

for (const initiallyMissing of [true, false])
  test(`panel caller ${initiallyMissing ? 'missing' : 'present, then closed'}`, { timeout: 20000 }, async (t) => {
    const dir = fs.mkdtempSync(join(tmpdir(), 'panel-caller-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const bin = join(dir, 'bin'), log = join(dir, 'calls'), missing = join(dir, 'missing');
    fs.mkdirSync(bin);
    fs.writeFileSync(join(bin, 'herdr'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[1] === 'get' && fs.existsSync(${JSON.stringify(missing)})) {
  console.error(JSON.stringify({error: {code: 'not_found', message: 'pane not found: caller'}}));
  process.exit(1);
}
console.log(JSON.stringify({result: {pane: {pane_id: 'w4E:p1'}}}));
`, { mode: 0o700 });
    if (initiallyMissing) writeFixtureFile(missing, '');
    const child = spawn(process.execPath, [resolve('dist/tree-page.js')], {
      cwd: dir, stdio: ['pipe', 'ignore', 'pipe'],
      env: {
        HOME: join(dir, 'home'), HUD_HOME: join(dir, 'hud'), CODEX_HOME: join(dir, 'codex'),
        CLAUDE_CONFIG_DIR: join(dir, 'claude'), PI_CODING_AGENT_DIR: join(dir, 'pi'),
        HERDR_SOCKET_PATH: join(dir, 'synthetic.sock'), PATH: `${bin}:${dirname(process.execPath)}`,
        HUD_PANEL_CALLER_PANE: 'w4E:p1', HERDR_PANE_ID: 'w4E:p2', CODEX_HUD_STANDALONE_PANEL: '1',
        HUD_PANEL_CALLER_POLL_MS: '150',
      },
    });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    let stderr = '';
    child.stderr.on('data', (data) => { stderr += data; });
    const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
    const calls = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [];
    if (!initiallyMissing) {
      for (let i = 0; i < 100 && !calls().some((a) => a[1] === 'get'); i++) await delay(100);
      assert.ok(calls().some((a) => a[1] === 'get'), stderr);
      await delay(200);
      assert.equal(child.exitCode, null, stderr);
      assert.ok(!calls().some((a) => a[1] === 'close'));
      writeFixtureFile(missing, '');
    }
    const result = await exited;
    assert.deepEqual(result, { code: 0, signal: null }, stderr);
    const recorded = calls();
    assert.deepEqual(recorded.filter(([verb, subcommand]) => verb === 'agent' && subcommand === 'list'), []);
    assert.deepEqual(recorded.filter((a) => ['get', 'close'].includes(a[1])).at(-1), ['pane', 'close', 'w4E:p2']);
    assert.ok(recorded.filter((a) => a[0] === 'pane').every((a) =>
      (a[1] === 'get' && a[2] === 'w4E:p1') || (a[1] === 'close' && a[2] === 'w4E:p2') ||
      (a[1] === 'layout' && a[2] === '--pane' && a[3] === 'w4E:p2')));
  });
