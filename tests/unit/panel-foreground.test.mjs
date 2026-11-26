import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { fixture, launch, until } from '../helpers/panel-reload-fixture.mjs';
import { listenDock } from '../fakes/herdr-dock.mjs';

const execSupported = typeof process.execve === 'function' && !['win32', 'os400'].includes(process.platform);
for (const [here, fallback] of [[true, false], [true, true], [false, false]]) {
  test(`hud panel${here ? ' --here' : ' outside herdr'} ${fallback ? 'spawns and forwards termination without execve' : 'replaces the launcher PID'}`,
    { skip: !fallback && !execSupported, timeout: 15000 }, async (t) => {
      const f = fixture(t);
      const dock = await listenDock(t, f.env.HERDR_SOCKET_PATH);
      if (!here) { delete f.env.HERDR_SOCKET_PATH; delete f.env.HERDR_PANE_ID; }
      const preload = encodeURIComponent(`import {basename} from 'node:path';
${fallback ? 'process.execve = undefined;' : ''}
if (basename(process.argv[1] ?? '') === 'hud-dist.mjs') console.log('panel-pid:' + process.pid + ':' + process.ppid);`);
      const run = launch(f, resolve('bin/hud'), here ? ['panel', '--here'] : ['panel'], { NODE_OPTIONS: `--import=data:text/javascript,${preload}` });
      const closed = once(run.child, 'close');
      await until(() => run.output().includes('\x1b[?1049h'), 'panel did not enter alternate screen');
      const [, panelPid, parentPid] = run.output().match(/panel-pid:(\d+):(\d+)/) ?? [];
      assert.ok(panelPid);
      if (fallback) {
        assert.notEqual(Number(panelPid), run.child.pid);
        assert.equal(Number(parentPid), run.child.pid);
      } else assert.equal(Number(panelPid), run.child.pid);
      if (process.platform === 'win32') run.child.stdin.end();
      else run.child.kill('SIGTERM');
      assert.deepEqual(await run.exited, { code: 0, signal: null }, run.stderr());
      await closed;
      assert.match(run.output(), /\x1b\[\?25h\x1b\[\?1049l/, 'panel restores the cursor and screen on exit');
      assert.deepEqual(dock.operations(), [], 'foreground launch leaves the dock alone');
    }
  );
}
