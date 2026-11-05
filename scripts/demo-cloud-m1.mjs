/** Synthetic demonstration only: no installed pi, provider, MCP or user settings. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const root = mkdtempSync(join(tmpdir(), 'hud-m1-simulation-'));
const home = join(root, 'home');
const source = join(root, 'sessions');
mkdirSync(home);
mkdirSync(source);
// Deliberately do not inherit credentials, NODE_OPTIONS or a real configuration root.
const env = { HOME: home, HUD_HOME: join(home, '.hud'), PATH: process.env.PATH ?? '', COLUMNS: '80' };
function run(entry, args, input) {
  const result = spawnSync(process.execPath, [join(repo, entry), ...args], {
    cwd: root,
    env,
    input,
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${entry} failed: ${result.stderr}`);
  return result.stdout;
}
try {
  console.log('M1 CLOUD SIMULATION: real HUD entrypoints, synthetic inputs and child; no model/account calls.');
  const timestamp = '2026-01-01T00:00:00.000Z';
  const file = join(source, 'demo.jsonl');
  const rows = [
    { type: 'session', version: 3, id: 'synthetic-m1-session', timestamp, cwd: '/synthetic/project' },
    {
      type: 'message',
      id: 'msg-1',
      parentId: null,
      timestamp,
      message: {
        role: 'assistant',
        model: 'synthetic-model',
        provider: 'synthetic',
        api: 'openai-completions',
        content: [{ type: 'text', text: 'SYNTHETIC_BODY_NOT_EXPORTED' }],
        usage: {
          input: 20,
          output: 5,
          cacheRead: 10,
          cacheWrite: 2,
          totalTokens: 37,
          cost: { input: 0.08, output: 0.025, cacheRead: 0.01, cacheWrite: 0.01, total: 0.125 },
        },
        stopReason: 'stop',
        timestamp: Date.parse(timestamp),
      },
    },
  ];
  const original = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
  writeFileSync(file, original);
  const inspection = run('bin/hud', [
    'pi',
    'inspect',
    '--source',
    source,
    '--session',
    file,
    '--context-window',
    '1000',
  ]);
  const observed = JSON.parse(inspection);
  assert.equal(observed.format, 'hud.pi.inspect');
  assert.equal(observed.ref.sessionId, 'synthetic-m1-session');
  assert.equal(observed.coverage.state, 'complete');
  assert.equal(observed.context.value.used, 32);
  assert.equal(observed.spent.costUsd.value, 0.125);
  assert.ok(!inspection.includes('SYNTHETIC_BODY_NOT_EXPORTED'));
  assert.equal(readFileSync(file, 'utf8'), original);
  console.log('\n1. Actual hud pi inspect, synthetic documented JSONL:');
  console.log(inspection.trim());

  const fake = join(root, 'synthetic-pi.mjs');
  writeFileSync(
    fake,
    `console.log(JSON.stringify({ simulated: true, argv: process.argv.slice(2), cwd: process.cwd(), hasClaim: Boolean(process.env.HUD_CLAIM) }));\n`
  );
  const launch = run('bin/hud', [
    'pi',
    'launch',
    '--executable',
    process.execPath,
    '--',
    fake,
    '--print',
    'Synthetic demo only',
  ]);
  assert.deepEqual(JSON.parse(launch), {
    simulated: true,
    argv: ['--print', 'Synthetic demo only'],
    cwd: root,
    hasClaim: false,
  });
  console.log('\n2. Actual hud pi launch, synthetic executable (Node, NOT pi):');
  console.log(launch.trim());

  const line = run(
    'bin/hud-statusline-preview',
    ['--width', '80'],
    JSON.stringify({
      model: { display_name: 'Claude (simulated)' },
      context_window: { used_percentage: 42 },
      cost: { total_cost_usd: 0.12 },
    })
  );
  assert.equal(line.trim(), 'Claude (simulated) · ctx 42% · $0.12');
  console.log('\n3. Actual stdin statusline preview, synthetic Claude payload:');
  console.log(line.trim());
  assert.deepEqual(readdirSync(home), []);
  console.log('\nPASS: observation, argv/cwd forwarding, and preview assertions. No user settings written.');
  console.log(
    'Not verified: real pi/Claude execution, managed delegation, MCP identity, panel wiring or default statusline installation.'
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
