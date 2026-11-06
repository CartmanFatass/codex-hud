import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { digestCommand, parseDigestArguments, DIGEST_HELP } from '../../src/cli/digest.js';
import { main } from '../../src/cli/hud.js';
import { digestFixture, deferredTransport, response, until, tick } from '../fixtures/delegated-digest.js';

const plan = ['plan', '--run', 'synthetic-run', '--report', 'synthetic-report', '--json'];
async function invoke(args: string[], env: NodeJS.ProcessEnv, fetcher?: typeof fetch, brokenOutput = false) {
  let stdout = ''; let stderr = '';
  const code = await digestCommand(args, { env, stdout: (text) => {
    if (brokenOutput) throw new Error('PRIVATE_PROVIDER_MESSAGE'); stdout += text;
  }, stderr: (text) => { stderr += text; } }, { fetch: fetcher ?? (async () => { throw new Error('unexpected synthetic transport'); }) as typeof fetch });
  return { code, stdout, stderr };
}
test('strict CLI parse refuses all malformed/unknown/duplicate selections before even reading env', async () => {
  const env = new Proxy({}, { get() { throw new Error('must not read environment'); } });
  assert.deepEqual(await invoke(['--help'], env), { code: 0, stdout: DIGEST_HELP, stderr: '' });
  for (const args of [[], ['latest'], ['run'], ['plan', '--help'], [...plan, '--json'], [...plan, '--unknown'],
    [...plan, '--expected-ledger', 'abc'], plan.slice(0, -1), ['plan', '--run', '../bad', '--report', 'r', '--json'],
    ['run', '--run', 'r', '--report', 'p', '--expected-ledger', 'a', '--expected-recipient', 'not-a-recipient', '--json'],
    ['plan', '--run', 'x'.repeat(129), '--report', 'p', '--json']]) {
    assert.throws(() => parseDigestArguments(args));
    assert.deepEqual(await invoke(args, env), { code: 2, stdout: '', stderr: 'invalid_arguments\n' });
  }
});
test('root route discovers digest and help bypasses missing/unsafe homes', async () => {
  let out = '';
  assert.equal(await main(['--help'], { env: { HUD_HOME: '/nonexistent-synthetic' },
    stdout: (t) => { out += t; }, stderr: () => {} }), 0);
  assert.match(out, /hud digest --help/);
  assert.equal((await invoke(plan, { HUD_HOME: 'relative' })).code, 3);
  assert.equal((await invoke(plan, { HUD_HOME: '/nonexistent-synthetic' })).code, 3);
});
test('real command produces one complete JSON document; expected IDs, schema, material and model errors are fixed codes', async () => {
  const f = await digestFixture();
  const run = ['run', ...plan.slice(1), '--expected-ledger', f.input.expectedLedger,
    '--expected-recipient', f.input.expectedRecipient];
  try {
    const preview = await invoke(plan, f.env);
    assert.equal(preview.code, 0); assert.equal(JSON.parse(preview.stdout).readiness.ready, true);
    const result = await invoke(run, f.env, (async () => response()) as typeof fetch);
    assert.equal(result.code, 0); assert.equal(result.stderr, '');
    assert.equal(JSON.parse(result.stdout).format, 'hud-delegated-digest');
    assert.equal(result.stdout.split('\n').length, 2);
    assert.equal((await invoke(run, f.env, undefined, true)).code, 1);
    const wrong = [...run]; wrong[wrong.indexOf('--expected-ledger') + 1] = 'wrong';
    assert.deepEqual(await invoke(wrong, f.env), { code: 4, stdout: '', stderr: 'expected_ledger_mismatch\n' });
    f.db.exec('PRAGMA user_version=2');
    assert.deepEqual(await invoke(plan, f.env), { code: 5, stdout: '', stderr: 'unsupported_ledger_schema\n' });
    f.db.exec('PRAGMA user_version=1');
    f.db.prepare('UPDATE reports SET summary=?').run('x'.repeat(8001));
    assert.deepEqual(await invoke(run, f.env), { code: 6, stdout: '', stderr: 'material_invalid\n' });
    f.db.prepare('UPDATE reports SET summary=?').run('Changed synthetic summary.');
    assert.deepEqual(await invoke(run, f.env, (async () => { throw new Error('PRIVATE_PROVIDER_MESSAGE'); }) as typeof fetch),
      { code: 6, stdout: '', stderr: 'model_failed\n' });
    fs.unlinkSync(join(f.dir, 'model.json'));
    const denied = await invoke(run, f.env);
    assert.equal(denied.code, 4); assert.equal(denied.stdout, ''); assert.equal(denied.stderr, 'source_configuration_invalid\n');
  } finally { f.cleanup(); }
});


test('installed hud entry generates a digest with preload-injected fake transport only', async () => {
  const f = await digestFixture();
  try {
    const preload = join(f.home, 'fake-transport.mjs');
    fs.writeFileSync(preload, `
      globalThis.fetch = async (url, init) => {
        if (url !== 'https://synthetic.invalid/v1/chat/completions') throw new Error('unexpected target');
        const body = JSON.parse(init.body);
        if (body.model !== 'synthetic-model') throw new Error('unexpected model');
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ conclusion: 'Synthetic installed success.' }) } }] }));
      };
    `, { mode: 0o600 });
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, resolve('bin/hud'),
      'digest', 'run', '--run', f.input.runId, '--report', f.input.reportId, '--expected-ledger', f.input.expectedLedger,
      '--expected-recipient', f.input.expectedRecipient, '--json'], { env: { ...f.env, PATH: process.env.PATH },
      encoding: 'utf8', timeout: 10000 });
    assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.digest.conclusion, 'Synthetic installed success.');
    assert.deepEqual(output.ref, f.ref); assert.equal(output.cached, false);
  } finally { f.cleanup(); }
});


for (const change of ['scope', 'outbound', 'target', 'abort'] as const) {
  test(`CLI ${change} maps authorization loss separately from explicit cancellation`, async () => {
    const f = await digestFixture();
    const transport = deferredTransport();
    const controller = new AbortController();
    let stdout = ''; let stderr = '';
    const args = ['run', ...plan.slice(1), '--expected-ledger', f.input.expectedLedger,
      '--expected-recipient', f.input.expectedRecipient];
    const pending = digestCommand(args, { env: f.env,
      stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; } },
      { fetch: transport.fetcher, signal: controller.signal });
    try {
      await until(() => transport.calls.length === 1);
      if (change === 'scope') f.write('model.json', { ...f.config, revision: 2, materials: [] });
      if (change === 'outbound') f.write('outbound.json', { ...f.policy, revision: 2, grants: [] });
      if (change === 'target') f.db.exec("UPDATE links SET current_owner=0,state='handed_over'");
      if (change === 'abort') controller.abort();
      else transport.calls[0].resolve(response());
      assert.equal(await pending, change === 'abort' ? 6 : 4);
      assert.equal(stderr, change === 'abort' ? 'cancelled\n' : 'authorization_changed\n');
      assert.equal(stdout, '');
      // A cancelled fetch may still return later; it cannot deliver or create a reusable sidecar.
      if (change === 'abort') transport.calls[0].resolve(response());
      await tick(); await tick();
      const materials = join(f.dir, 'model-runtime-v1', 'materials-v1');
      assert.equal(fs.existsSync(materials) && fs.readdirSync(materials).some((name) => name.endsWith('.json')), false);
      assert.equal(transport.calls.length, 1);
      assert.equal(stdout, '');
    } finally {
      controller.abort();
      for (const call of transport.calls) call.resolve(response());
      await pending;
      f.cleanup();
    }
  });
}
