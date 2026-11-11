import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { REPO_ROOT } from '../fixtures/paths.js';
import { JOB, fixture } from '../fixtures/role-wait-perf.js';

test('file-only waiter cold RSS remains narrow and observation writes nothing', (t) => {
  const f = fixture(t, true);
  const file = join(f.directory, 'STATUS.json');
  const before = fs.statSync(file).mtimeMs;
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { waitForJob } from ${JSON.stringify(pathToFileURL(join(REPO_ROOT, 'dist/roles/job-wait.js')).href)};
    await waitForJob(process.env.HUD_HOME, process.env, ${JSON.stringify(JOB)}, 0);
    console.log(process.memoryUsage().rss);
  `,
    ],
    { env: f.env, encoding: 'utf8', timeout: 10000 }
  );
  assert.equal(child.status, 0, child.stderr);
  const rss = Number(child.stdout.trim());
  assert.ok(rss > 0 && rss < 80 * 1024 * 1024, `file-only RSS=${rss}`);
  assert.equal(fs.statSync(file).mtimeMs, before);
  t.diagnostic(`cold file-only waiter RSS=${rss} bytes; STATUS writes=0`);
});
