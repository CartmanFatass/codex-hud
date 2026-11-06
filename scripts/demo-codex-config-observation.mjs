// Run after npm run build. This uses the real product subprocess transport and a synthetic peer only.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexAppServerTransport } from '../dist/harness/codex/app-server-transport.js';

const home = mkdtempSync(join(tmpdir(), 'hud-config-demo-'));
const record = join(home, 'wire.jsonl');
const client = new CodexAppServerTransport({
  executable: process.execPath,
  args: [fileURLToPath(new URL('../tests/fixtures/codex-config-server.mjs', import.meta.url)), 'full', record],
  cwd: home,
  env: { HOME: home, HUD_HOME: join(home, '.hud'), CODEX_HOME: join(home, '.codex') },
  requestTimeoutMs: 3000,
  lifetimeMs: 10000,
});
let reaped = false;
try {
  await client.initialize();
  const configuration = await client.configRead({ cwd: home });
  const methods = readFileSync(record, 'utf8').trim().split('\n').map((line) => JSON.parse(line).method);
  assert.deepEqual(methods, ['initialize', 'initialized', 'config/read']);
  assert.equal(configuration.fields.model.value, 'synthetic-model');
  assert.equal(configuration.qualification, 'not_qualified');
  assert.equal(client.snapshot().observation.threadId, null);
  const output = JSON.stringify({
    evidence: 'synthetic_peer_actual_product_transport',
    methods,
    configuration,
    realCodexObservation: 'NOT_RUN',
    managedConfigurationBinding: 'NOT_IMPLEMENTED',
    productionCapability: 'UNVERIFIED',
  }, null, 2);
  assert.ok(!output.includes('SYNTHETIC_PRIVATE_SENTINEL'));
  assert.ok(!output.includes(home));
  reaped = (await client.shutdown()).reaped;
  assert.equal(reaped, true);
  process.stdout.write(output + '\n');
} catch {
  // Never print response/error bodies, caller paths or the complete wire log.
  process.stderr.write('synthetic_config_observation_demo_failed\n');
  process.exitCode = 1;
} finally {
  reaped = (await client.shutdown()).reaped;
  if (reaped) rmSync(home, { recursive: true, force: true });
  else {
    process.stderr.write('synthetic_config_observation_cleanup_unconfirmed\n');
    process.exitCode = 1;
  }
}
