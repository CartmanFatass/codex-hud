// Explicit opt-in only: node tests/fixtures/claude-hud-parity/generate.mjs --installed ABS/dist/index.js
// Requires build:test. Never discovers plugins, never uses the invoking user's HOME.
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  NOW,
  OWNER_CONFIG,
  SCENARIOS,
  parityFixture,
} from '../../../dist-test/tests/fixtures/claude-hud-parity/fixture.js';
if (process.argv.length !== 4 || process.argv[2] !== '--installed' || !process.argv[3].startsWith('/'))
  throw new Error('explicit --installed ABS required');
for (const scenario of SCENARIOS) {
  const home = fs.mkdtempSync(join(tmpdir(), 'claude-hud-golden-'));
  try {
    const f = parityFixture(home, scenario);
    const dir = join(f.claude, 'plugins', 'claude-hud');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, 'config.json'), JSON.stringify(OWNER_CONFIG));
    const clock = join(home, 'clock.mjs');
    fs.writeFileSync(
      clock,
      `const Original=Date;globalThis.Date=class extends Original{constructor(...a){super(...(a.length?a:[${NOW}]))}static now(){return ${NOW}}};`
    );
    const r = spawnSync(process.execPath, ['--import', clock, process.argv[3]], {
      cwd: f.cwd,
      env: { ...f.env, COLUMNS: String(f.width) },
      input: JSON.stringify(f.input),
      encoding: 'utf8',
      timeout: 5000,
    });
    if (r.status !== 0 || r.error || r.stdout.includes('[claude-hud] Error:'))
      throw new Error(scenario + ': ' + r.stderr + r.stdout);
    fs.writeFileSync(
      resolve('tests/fixtures/claude-hud-parity', scenario + '.txt'),
      r.stdout.replace(/\x1b\[[0-9;]*m/g, '')
    );
    console.log(scenario + ': captured installed 0.8.0 stdout');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}
