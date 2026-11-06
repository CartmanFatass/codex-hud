import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { digestCommand, parseDigestArguments, DIGEST_HELP } from '../../src/cli/digest.js';
import { digestFixture, response, SUMMARY, PRIVATE } from '../fixtures/delegated-digest.js';

function args(f: Awaited<ReturnType<typeof digestFixture>>, mode = 'run') {
  return [mode, '--run', f.input.runId, '--report', f.input.reportId,
    '--expected-ledger', f.input.expectedLedger, '--expected-recipient', f.input.expectedRecipient, '--json'];
}
async function invoke(argv: string[], env: NodeJS.ProcessEnv, broken = false) {
  let stdout = ''; let stderr = ''; let sends = 0;
  const code = await digestCommand(argv, { env,
    stdout(text) { if (broken) throw new Error(PRIVATE); stdout += text; },
    stderr(text) { stderr += text; } }, { fetch: (async () => { sends++; return response(); }) as typeof fetch });
  return { code, stdout, stderr, sends };
}

test('new strict show/save parser rejects malformed and duplicate flags before home/model I/O; help stays read-free', async () => {
  const env = new Proxy({}, { get() { throw new Error('must not read environment'); } });
  const base = ['--run', 'r', '--report', 'p', '--expected-ledger', 'ledger', '--expected-recipient', 'a'.repeat(64), '--json'];
  assert.deepEqual(parseDigestArguments(['run', ...base]), {
    mode: 'run', runId: 'r', reportId: 'p', expectedLedger: 'ledger', expectedRecipient: 'a'.repeat(64),
  });
  assert.equal(parseDigestArguments(['show', ...base]).mode, 'show');
  assert.deepEqual(await invoke(['--help'], env), { code: 0, stdout: DIGEST_HELP, stderr: '', sends: 0 });
  for (const argv of [['show', ...base, '--save'], ['run', ...base, '--save', '--save'],
    ['run', ...base, '--save', 'true'], ['show', ...base, '--json'], ['show', '--help'],
    ['plan', '--run', 'r', '--report', 'p', '--json', '--save'], ['show', '--run', 'r', '--report', 'p', '--json'],
    ['show', ...base, '--path', '../private'], ['show', ...base, '--latest']]) {
    assert.throws(() => parseDigestArguments(argv));
    assert.deepEqual(await invoke(argv, env), { code: 2, stdout: '', stderr: 'invalid_arguments\n', sends: 0 });
  }
});

test('CLI no-save JSON remains ordinary; explicit save has a closed wrapper and show never calls fake transport', async () => {
  const f = await digestFixture();
  try {
    const ordinary = await invoke(args(f), f.env);
    assert.equal(ordinary.code, 0); assert.equal(JSON.parse(ordinary.stdout).format, 'hud-delegated-digest');
    assert.equal(Object.hasOwn(JSON.parse(ordinary.stdout), 'retention'), false);
    const saved = await invoke([...args(f), '--save'], f.env);
    assert.equal(saved.code, 0); const value = JSON.parse(saved.stdout);
    assert.deepEqual(Object.keys(value).sort(), ['document', 'format', 'retention', 'schemaVersion']);
    assert.equal(value.retention.state, 'saved');
    const shown = await invoke(args(f, 'show'), f.env);
    assert.equal(shown.code, 0); assert.equal(shown.sends, 0);
    assert.deepEqual(JSON.parse(shown.stdout).document, value.document);
    for (const text of [ordinary.stdout, saved.stdout, shown.stdout, ordinary.stderr, saved.stderr, shown.stderr]) {
      assert.equal(text.includes(PRIVATE), false); assert.equal(text.includes(SUMMARY), false);
      assert.equal(text.includes('synthetic-key'), false); assert.equal(text.includes(f.home), false);
    }
    f.write('outbound.json', { ...f.policy, revision: 2, grants: [] });
    assert.deepEqual(await invoke(args(f, 'show'), f.env), { code: 4, stdout: '', stderr: 'outbound_denied\n', sends: 0 });
  } finally { f.cleanup(); }
});

test('retention busy emits generated document with not_saved, while output loss after save instructs exact show and never reruns', async () => {
  const f = await digestFixture();
  try {
    const broken = await invoke([...args(f), '--save'], f.env, true);
    assert.deepEqual(broken, { code: 1, stdout: '', stderr: 'digest_note_delivery_uncertain_use_show\n', sends: 1 });
    const show = await invoke(args(f, 'show'), f.env);
    assert.equal(show.code, 0); assert.equal(show.sends, 0);
    const dir = join(f.dir, 'digest-notes-v1');
    fs.writeFileSync(join(dir, '.write-lock'), '', { mode: 0o600 });
    const busy = await invoke([...args(f), '--save'], f.env);
    assert.equal(busy.code, 0); assert.equal(busy.sends, 0);
    assert.deepEqual(JSON.parse(busy.stdout).retention, { state: 'not_saved', reason: 'digest_note_busy' });
    assert.equal(JSON.parse(busy.stdout).document.format, 'hud-delegated-digest');
  } finally { f.cleanup(); }
});

test('installed CLI save/show across separate processes uses only a fake transport and preserves runtime bytes on show', async () => {
  const f = await digestFixture();
  try {
    const preload = join(f.home, 'synthetic-fetch.mjs');
    const countFile = join(f.home, 'fake-sends');
    fs.writeFileSync(preload, `
      import fs from 'node:fs';
      globalThis.fetch = async (url) => {
        if (url !== 'https://synthetic.invalid/v1/chat/completions') throw new Error('unexpected transport');
        fs.appendFileSync(${JSON.stringify(countFile)}, 'send\\n', { mode: 0o600 });
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ conclusion: 'Synthetic saved result.' }) } }] }));
      };
    `, { mode: 0o600 });
    const command = (argv: string[]) => spawnSync(process.execPath,
      ['--import', pathToFileURL(preload).href, resolve('bin/hud'), 'digest', ...argv],
      { env: { ...f.env, PATH: process.env.PATH }, encoding: 'utf8', timeout: 10000 });
    const saved = command([...args(f), '--save']);
    assert.ifError(saved.error); assert.equal(saved.status, 0, saved.stderr);
    const shown = command(args(f, 'show'));
    assert.ifError(shown.error); assert.equal(shown.status, 0, shown.stderr);
    assert.deepEqual(JSON.parse(shown.stdout).document, JSON.parse(saved.stdout).document);
    assert.equal(fs.readFileSync(countFile, 'utf8'), 'send\n');
    f.write('outbound.json', { ...f.policy, grants: [], revision: 2 });
    const revoked = command(args(f, 'show'));
    assert.equal(revoked.status, 4); assert.equal(revoked.stdout, ''); assert.equal(revoked.stderr, 'outbound_denied\n');
    assert.equal(fs.readFileSync(countFile, 'utf8'), 'send\n');
  } finally { f.cleanup(); }
});

test('successful rename plus revoked authority and failed cleanup withholds text but preserves explicit publication uncertainty', async () => {
  const f = await digestFixture(); const oldRename = fs.renameSync; const oldUnlink = fs.unlinkSync;
  const dir = join(f.dir, 'digest-notes-v1'); let published = false; let cleanupDenied = false;
  try {
    fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
      oldRename(from, to);
      if (String(from).startsWith(join(dir, '.pending-'))) {
        published = true;
        f.write('outbound.json', { ...f.policy, revision: 2, grants: [] });
      }
    }) as typeof fs.renameSync;
    fs.unlinkSync = ((path: fs.PathLike) => {
      if (String(path).startsWith(dir + '/') && String(path).endsWith('.json')) {
        cleanupDenied = true;
        throw Object.assign(new Error(PRIVATE), { code: 'EACCES' });
      }
      oldUnlink(path);
    }) as typeof fs.unlinkSync;
    syncBuiltinESMExports();
    const result = await invoke([...args(f), '--save'], f.env);
    assert.deepEqual(result, { code: 6, stdout: '', stderr: 'digest_note_publish_uncertain_use_show\n', sends: 1 });
    assert.equal(published, true); assert.equal(cleanupDenied, true);
    assert.equal(fs.readdirSync(dir).filter((name) => name.endsWith('.json')).length, 1);
    assert.equal(result.stderr.includes(PRIVATE), false);
    f.write('outbound.json', f.policy);
    const reopened = await invoke(args(f, 'show'), f.env);
    assert.equal(reopened.code, 0); assert.equal(reopened.sends, 0);
    assert.equal(JSON.parse(reopened.stdout).document.digest.conclusion, 'Input validation is implemented.');
  } finally { fs.renameSync = oldRename; fs.unlinkSync = oldUnlink; syncBuiltinESMExports(); f.cleanup(); }
});

test('CLI cleanup takes one bounded lock attempt and preserves a completed peer replacement while that writer lock is held', async () => {
  const f = await digestFixture(); const controller = new AbortController(); const oldOpen = fs.openSync;
  let entered = false; let deliver!: () => void; let stderr = ''; let peerFd: number | undefined; let attempts = 0;
  const pending = digestCommand([...args(f), '--save'], { env: f.env,
    stdout() { entered = true; return new Promise<void>((resolve) => { deliver = resolve; }); },
    stderr(text) { stderr += text; } }, { signal: controller.signal, fetch: (async () => response()) as typeof fetch });
  try {
    const until = Date.now() + 4000;
    while (!entered) { assert.ok(Date.now() < until); await new Promise<void>((resolve) => setImmediate(resolve)); }
    const peer = await invoke([...args(f), '--save'], f.env);
    assert.equal(peer.code, 0); assert.equal(JSON.parse(peer.stdout).retention.state, 'saved');
    const dir = join(f.dir, 'digest-notes-v1');
    const file = join(dir, fs.readdirSync(dir).find((name) => name.endsWith('.json'))!);
    const bytes = fs.readFileSync(file); const inode = fs.statSync(file).ino;
    const lock = join(dir, '.write-lock');
    peerFd = oldOpen(lock, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.openSync = ((...params: Parameters<typeof fs.openSync>) => { if (String(params[0]) === lock) attempts++; return oldOpen(...params); }) as typeof fs.openSync;
    syncBuiltinESMExports();
    controller.abort(); assert.equal(await pending, 6);
    assert.equal(stderr, 'digest_note_publish_uncertain_use_show\n'); assert.equal(attempts, 1);
    assert.equal(fs.statSync(file).ino, inode); assert.deepEqual(fs.readFileSync(file), bytes);
    const shown = await invoke(args(f, 'show'), f.env);
    assert.equal(shown.code, 0); assert.equal(shown.sends, 0);
    assert.deepEqual(JSON.parse(shown.stdout).document, JSON.parse(peer.stdout).document);
  } finally {
    fs.openSync = oldOpen; syncBuiltinESMExports();
    if (peerFd !== undefined) { fs.closeSync(peerFd); fs.unlinkSync(join(f.dir, 'digest-notes-v1', '.write-lock')); }
    controller.abort(); deliver?.(); await pending; f.cleanup();
  }
});
