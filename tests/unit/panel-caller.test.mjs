import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

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
console.log(JSON.stringify({result: {pane: {pane_id: 'caller'}}}));
`, { mode: 0o700 });
    if (initiallyMissing) fs.writeFileSync(missing, '');
    const child = spawn(process.execPath, [resolve('dist/tree-page.js')], {
      cwd: dir, stdio: ['pipe', 'ignore', 'pipe'],
      env: {
        HOME: join(dir, 'home'), HUD_HOME: join(dir, 'hud'), CODEX_HOME: join(dir, 'codex'),
        CLAUDE_CONFIG_DIR: join(dir, 'claude'), PI_CODING_AGENT_DIR: join(dir, 'pi'),
        HERDR_SOCKET_PATH: join(dir, 'synthetic.sock'), PATH: `${bin}:${dirname(process.execPath)}`,
        HUD_PANEL_CALLER_PANE: 'caller', HERDR_PANE_ID: 'panel', CODEX_HUD_STANDALONE_PANEL: '1',
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
      fs.writeFileSync(missing, '');
    }
    const result = await exited;
    assert.deepEqual(result, { code: 0, signal: null }, stderr);
    assert.deepEqual(calls().filter((a) => ['get', 'close'].includes(a[1])).at(-1), ['pane', 'close', 'panel']);
    assert.ok(calls().filter((a) => a[0] === 'pane').every((a) =>
      (a[1] === 'get' && a[2] === 'caller') || (a[1] === 'close' && a[2] === 'panel')));
  });
