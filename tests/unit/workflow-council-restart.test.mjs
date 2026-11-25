import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { enableOptionalRoles, fixture, until } from '../helpers/thin-mcp-harness.mjs';
import { writeFixtureFile as put } from '../helpers/thin-mcp-files.mjs';

test('the detached council closes with a main hand-off after its MCP exits mid-fan-out', { timeout: 30_000 }, async t => {
  const f = await fixture(t), home = f.env.HUD_HOME;
  enableOptionalRoles(f, 'council');
  put(join(f.env.HOME, 'defer-pi-report'), '');
  execFileSync(process.execPath, ['bin/hud', 'council', 'allow'], { env: f.env });
  const { job } = await f.call('hud_create', { role: 'council', task: 'Compare two synthetic plans.', members: ['astra', 'astra'] });
  const dir = id => join(home, 'jobs', id);
  const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
  const parent = () => json(join(dir(job), 'job.json'));
  const flow = () => json(join(home, 'flows', `${job}.json`));
  await until(() => parent().council_members.every(m => m.job), t.signal);
  await f.stopMcp(); // Do not reconnect or call another tool to drive synthesis.
  assert.equal(json(join(dir(job), 'STATUS.json')).state, 'working');
  const reports = ['First independent idea.', 'Second independent idea.'];
  for (const [i, m] of parent().council_members.entries()) {
    assert.equal(json(join(dir(m.job), 'STATUS.json')).state, 'working');
    put(join(dir(m.job), 'report.md'), reports[i]);
    put(join(dir(m.job), 'STATUS.json'), JSON.stringify({ state: 'closed', output_written: true }));
  }
  await until(() => flow().state === 'completed', t.signal);
  assert.equal(flow().steps.council.state, 'done');
  assert.equal(json(join(dir(job), 'STATUS.json')).state, 'closed');
  assert.deepEqual(parent().council_members.map(m => m.digest), reports);
  assert.equal(parent().synthesis_job, undefined);
  const packet = fs.readFileSync(join(dir(job), 'report.md'), 'utf8');
  assert.match(packet, /table of disagreements/);
  for (const m of parent().council_members) assert.ok(packet.includes(m.job));
});
