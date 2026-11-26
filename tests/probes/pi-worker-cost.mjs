// Run with the repo's temporary-HOME wrapper on a machine with pi installed.
// A final, test-only hook captures what pi will actually send and exits before the provider request.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { piWorkerArgv } from '../../dist/mcp/dispatch/pi-worker-argv.js';
import { piRoleDefaults } from '../../dist/roles/pi-defaults.js';

const root = fs.mkdtempSync(join(tmpdir(), 'hud-pi-worker-probe-'));
try {
  const agent = join(root, 'agent'), home = join(root, 'hud'), job = 'j1111111111111111', dir = join(home, 'jobs', job);
  fs.mkdirSync(agent); fs.mkdirSync(dir, { recursive: true });
  const model = piRoleDefaults.sonic.model, thinking = 'high';
  const receipt = { job, role: 'sonic', headless: true, model, thinking, cwd: root };
  fs.writeFileSync(join(dir, 'job.json'), JSON.stringify(receipt));
  fs.writeFileSync(join(home, 'credentials.env'), 'DEEPSEEK_SEARCH_API_KEY=synthetic\n', { mode: 0o600 });
  const env = { HOME: root, PATH: process.env.PATH, HUD_JOB_DIR: dir, HUD_HOME: home, PI_CODING_AGENT_DIR: agent,
    PI_OFFLINE: '1' };
  fs.writeFileSync(join(agent, 'models.json'), JSON.stringify({ providers: { mistral: { api: 'openai-completions',
    baseUrl: 'http://127.0.0.1:1', apiKey: 'synthetic', models: [{ id: model.split('/')[1], reasoning: true }] } } }));
  fs.writeFileSync(join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'mistral', defaultModel: model.split('/')[1] }));
  const tap = join(root, 'capture.mjs');
  // Exercise the same core-installed symlink as a deployed worker.
  fs.mkdirSync(join(home, 'pi-worker'));
  fs.symlinkSync(resolve('integrations/pi/worker/hud-worker.mjs'), join(home, 'pi-worker/hud-worker.mjs'));
  fs.writeFileSync(tap, `import {writeFileSync} from 'node:fs'; export default pi => pi.on('before_agent_start', (e,ctx) => {
    writeFileSync(process.env.CAPTURE, JSON.stringify({role:e.systemPromptOptions.sections.role,tools:pi.getActiveTools().sort(),
      model:ctx.model.provider+'/'+ctx.model.id,thinking:pi.getThinkingLevel()})); process.exit(0); });`);
  const instructions = resolve('packages/hud-mcp/instructions/sonic.md');
  const samples = [];
  let dump;
  for (let i = 0; i < 7; i++) {
    const capture = join(root, `capture-${i}.json`), start = performance.now();
    const args = piWorkerArgv(home, dir, receipt, { instructions: 'sonic' }, 'sonic', [], 'Synthetic probe');
    execFileSync('pi', ['--offline', ...args.slice(0, -2), '-e', tap, ...args.slice(-2)],
      { cwd: root, env: { ...env, CAPTURE: capture }, encoding: 'utf8', timeout: 10000 });
    samples.push(Math.round(performance.now() - start));
    dump = JSON.parse(fs.readFileSync(capture));
    assert.equal(dump.role, fs.readFileSync(instructions, 'utf8').trim());
  }
  console.log(JSON.stringify({ worker: dump, timingsMs: { samples, median: [...samples].sort((a, b) => a - b)[3] } }, null, 2));
} finally { fs.rmSync(root, { recursive: true, force: true }); }
