import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { readContract } from '../../dist/harness/pi/worker/contract.js';
import { executable } from '../../dist/roles/roster.js';
import { cliState, fixture, until } from '../helpers/thin-mcp-harness.mjs';

test('a core install without pi-roles runs Sonic, an imp tab and a headless reviewer', async t => {
  const f = await fixture(t, { path: '/usr/bin:/bin' });
  for (const name of ['pi-role', 'pi-role-reap', 'pi-dispatch']) assert.equal(executable(name, f.env), null);
  execFileSync('./install', ['--with', 'herdr', '--skip-build'], { env: f.env });
  // Explicit headless mode is available only for continuable roles. Keep the reviewer profile and guard.
  const roles = join(f.env.HUD_HOME, 'roles');
  fs.mkdirSync(roles);
  fs.writeFileSync(join(roles, 'reviewer.json'), JSON.stringify({ role: 'reviewer', instructions: 'reviewer',
    can_continue: true, run: [{ harness: 'pi', pi_role: 'reviewer' }] }));
  const worker = join(f.env.HUD_HOME, 'pi-worker', 'hud-worker.mjs');
  const ui = join(f.env.HUD_HOME, 'pi-worker', 'hud-worker-ui.mjs');

  for (const [role, mode, instructions] of [
    ['sonic', 'headless', 'sonic'], ['imp', 'tab', 'implementer'], ['reviewer', 'headless', 'reviewer'],
  ]) {
    const job = await f.call('hud_create', { role, ...(role === 'sonic' ? {} : { mode }), task: `Synthetic ${role} task.` });
    assert.ok(job.task_dir, JSON.stringify(job));
    const contract = readContract(job.task_dir);
    assert.equal(contract.instructions, instructions);
    if (mode === 'headless') {
      await until(() => cliState(job.task_dir)?.state === 'closed', t.signal);
      assert.equal(fs.readFileSync(join(job.task_dir, 'report.md'), 'utf8'), 'Synthetic implementation report.');
      const launch = f.commands().find(c => c.command === 'pi' && c.dir === job.task_dir);
      assert.ok(launch?.args.includes(worker));
      assert.ok(!launch.args.includes(ui));
      if (role === 'reviewer') assert.equal(contract.guard, 'strict');
    } else {
      assert.match(fs.readFileSync(join(job.task_dir, 'SESSION.txt'), 'utf8'), /^TAB=w4E:t\d+$/m);
      const calls = f.commands().filter(c => c.command === 'herdr' && c.args[2] === `${job.job}-primary`);
      const start = calls.find(c => c.args[1] === 'start');
      assert.ok(start?.args.includes(worker));
      assert.ok(start.args.includes(ui));
      assert.ok(calls.some(c => c.args[1] === 'prompt' && c.args[3].includes('Synthetic imp task.')));
    }
  }
});
