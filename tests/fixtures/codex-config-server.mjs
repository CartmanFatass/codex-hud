// Synthetic peer for the pinned official config/read shape. No CLI, account or provider requests.
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const [mode = 'full', wireFile] = process.argv.slice(2);
const SECRET = 'SYNTHETIC_PRIVATE_SENTINEL';
const version = 'synthetic-v1';
const metadata = { name: { type: 'project', dotCodexFolder: '/synthetic/private/' + SECRET }, version };
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
let reads = 0;
let held;
let acknowledged = false;
if (mode === 'unreaped') setInterval(() => {}, 1000);
if (mode === 'ignore-term') process.on('SIGTERM', () => {});
function result(label = 'synthetic-model') {
  const provenance = { ...metadata, version: label === 'synthetic-model' ? version : label + '-v1' };
  const config = {
    model: label, model_provider: 'synthetic-provider', model_reasoning_effort: 'future-effort',
    sandbox_mode: 'workspace-write', zero: 0, false: false,
    env: { PRIVATE: SECRET }, api_key: SECRET, instructions: SECRET, developer_instructions: SECRET,
  };
  const origins = Object.fromEntries(
    ['model', 'model_provider', 'model_reasoning_effort', 'sandbox_mode'].map((name) => [name, provenance])
  );
  const layers = [{ ...provenance, config: { api_key: SECRET, env: { PRIVATE: SECRET }, instructions: SECRET }, disabledReason: null }];
  return { config, origins, layers };
}
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (wireFile) appendFileSync(wireFile, line + '\n', { mode: 0o600 });
  if (message.method === 'initialize') {
    send({ id: message.id, result: { userAgent: 'synthetic-config-peer', codexHome: SECRET } });
    return;
  }
  if (message.method === 'initialized') { acknowledged = true; return; }
  if (message.method !== 'config/read' || !acknowledged) process.exit(12);
  reads++;
  if (mode === 'silent') return;
  if (mode === 'exit') process.exit(0);
  if (mode === 'approval') {
    send({ id: 900, method: 'item/commandExecution/requestApproval', params: { command: SECRET } }); return;
  }
  if (mode === 'frame-limit') { process.stdout.write('x'.repeat(65537) + '\n'); return; }
  if (mode === 'connection-limit') {
    // Legal frames, paced until the real connection's cumulative 4 MiB budget is exhausted.
    const frame = JSON.stringify({ method: 'synthetic/padding', params: { padding: 'x'.repeat(60_000) } }) + '\n';
    let count = 0;
    const timer = setInterval(() => { process.stdout.write(frame); if (++count === 71) clearInterval(timer); }, 2);
    return;
  }
  if (mode === 'malformed-json') { process.stdout.write('{\n'); return; }
  if (mode === 'wrong-id') { send({ id: message.id + 100, result: result() }); return; }
  if (mode === 'error' || (mode === 'success-error' && reads === 2)) {
    send({ id: message.id, error: { code: -32000, message: SECRET, data: { env: SECRET } } }); return;
  }
  if (mode === 'reorder' || mode === 'reorder-error') {
    if (!held) { held = message; return; }
    if (mode === 'reorder-error') send({ id: message.id, error: { code: -32000, message: SECRET } });
    else send({ id: message.id, result: result('synthetic-second') });
    send({ id: held.id, result: result('synthetic-first') });
    return;
  }
  const response = result();
  if (mode === 'sparse') response.config = { model: 'synthetic-sparse', zero: 0, false: false };
  if (mode === 'nulls') for (const key of Object.keys(response.origins)) response.config[key] = null;
  if (mode === 'invalid-fields') Object.assign(response.config, {
    model: 0, model_provider: false, model_reasoning_effort: {}, sandbox_mode: 'future-sandbox',
  });
  if (mode === 'field-limit') response.config.model = 'x'.repeat(257);
  if (mode === 'unknown-source') {
    response.origins.model = { name: { type: 'future-secret-' + SECRET }, version };
    response.layers[0].name = { type: 'future-secret-' + SECRET };
  }
  if (mode === 'invalid-origin') response.origins.model = { name: { type: 'user', file: false, profile: null }, version };
  if (mode === 'disabled') response.layers[0].disabledReason = SECRET;
  if (mode === 'missing-origins') delete response.origins;
  if (mode === 'omitted-layers' || message.params.includeLayers === false) response.layers = null;
  if (mode === 'missing-layers') delete response.layers;
  if (mode === 'malformed-config') response.config = [];
  if (mode === 'malformed-origins') response.origins = [];
  if (mode === 'malformed-layers') response.layers = {};
  if (mode === 'malformed-layer') response.layers = [{ name: metadata.name, version, disabledReason: null }];
  if (mode === 'origins-limit') response.origins = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [String(i), metadata]));
  if (mode === 'layers-limit') response.layers = Array.from({ length: 33 }, () => response.layers[0]);
  if (mode === 'duplicate-id' && reads > 1) { send({ id: message.id - 1, result: response }); return; }
  send({ id: message.id, result: response });
});
