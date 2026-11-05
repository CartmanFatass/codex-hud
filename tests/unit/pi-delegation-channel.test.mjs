import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rename, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PiEvidenceChannel } from '../../dist-test/packages/hud-mcp/src/pi-channel.js';
import { SessionRefResolver } from '../../dist-test/packages/hud-mcp/src/resolvers.js';
import { Refusal } from '../../dist-test/packages/hud-mcp/src/errors.js';
import {
  createPiDelegationContextGuard,
  PI_EXTENSION_CONTEXT_PROFILE,
} from '../../dist/harness/pi/delegation-context.js';
import { PiDelegationChannel } from '../../dist/harness/pi/delegation-channel.js';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'hud-pi-channel-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'synthetic.jsonl');
  await writeFile(file, JSON.stringify({ type: 'session', version: 3, id: 'synthetic' }) + '\n');
  const guard = createPiDelegationContextGuard({
    profile: PI_EXTENSION_CONTEXT_PROFILE,
    canonicalSourceDir: root,
  }).start();
  const snapshot = await guard.capture(
    { sessionManager: { getSessionId: () => 'synthetic', getSessionDir: () => root, getSessionFile: () => file } },
    'call-synthetic',
    'delegate_whoami'
  );
  const input = new PassThrough();
  const channel = new PiEvidenceChannel(input);
  t.after(() => channel.close());
  const frame = (seq = 1, overrides = {}) => ({ seq, ticket: randomUUID(), snapshot, ...overrides });
  const meta = (frame) => ({ 'hud/pi': { seq: frame.seq, ticket: frame.ticket, callId: frame.snapshot.toolCallId } });
  const send = (frame) => input.write(JSON.stringify(frame) + '\n');
  return { root, file, input, channel, frame, meta, send };
}

test('stdin lookup may arrive first; exact private frame is bounded-waited then consumed once', async (t) => {
  const f = await fixture(t),
    frame = f.frame();
  const pending = f.channel.consume(f.meta(frame), 'delegate_whoami', f.root);
  setTimeout(() => f.send(frame), 10);
  assert.equal((await pending).snapshot.sessionId, 'synthetic');
  await assert.rejects(f.channel.consume(f.meta(frame), 'delegate_whoami', f.root), /identity_unverified/);
});

test('metadata, source/session fields and forged ticket cannot substitute for private evidence', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.channel.consume({ sessionId: 'synthetic', PI_SESSION_ID: 'synthetic' }, 'delegate_whoami', f.root),
    /identity_source_missing/
  );
  await assert.rejects(f.channel.consume(f.meta(f.frame()), 'delegate_whoami', f.root), /identity_source_missing/);
});

test('tool, call ID and sequence must exactly match the private admission', async (t) => {
  const f = await fixture(t),
    frame = f.frame();
  f.send(frame);
  await assert.rejects(f.channel.consume(f.meta(frame), 'delegate_spawn', f.root), /identity_unverified/);
  const wrongCall = f.meta(frame);
  wrongCall['hud/pi'].callId = 'different';
  await assert.rejects(f.channel.consume(wrongCall, 'delegate_whoami', f.root), /identity_unverified/);
  const wrongSeq = f.meta(frame);
  wrongSeq['hud/pi'].seq = 99;
  await assert.rejects(f.channel.consume(wrongSeq, 'delegate_whoami', f.root), /identity_unverified/);
});

test('EOF fences pending lookups and epoch/sequence replay closes the private channel', async (t) => {
  const f = await fixture(t),
    frame = f.frame();
  const waiting = f.channel.consume(f.meta(frame), 'delegate_whoami', f.root);
  f.input.end();
  await assert.rejects(waiting, /stale_context/);
  assert.equal(f.channel.signal.aborted, true);
  for (const reason of ['sequence', 'epoch']) {
    const g = await fixture(t);
    const first = g.frame();
    g.send(first);
    await g.channel.consume(g.meta(first), 'delegate_whoami', g.root);
    g.send(g.frame(reason === 'sequence' ? 1 : 2, { snapshot: { ...first.snapshot, epoch: randomUUID() } }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(g.channel.signal.aborted, true);
  }
});

test('server pins independently checked file inode/header and refuses replacement', async (t) => {
  const f = await fixture(t),
    first = f.frame();
  f.send(first);
  await f.channel.consume(f.meta(first), 'delegate_whoami', f.root);
  await rename(f.file, f.file + '.old');
  await writeFile(f.file, JSON.stringify({ type: 'session', version: 3, id: 'synthetic' }) + '\n');
  const second = f.frame(2);
  f.send(second);
  await assert.rejects(f.channel.consume(f.meta(second), 'delegate_whoami', f.root), /stale_context/);
  assert.equal(f.channel.signal.aborted, true);
});

test(
  'close bounds an uncooperative owned child and does not wait for descendant-held stdout',
  { timeout: 10000 },
  async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'hud-pi-close-')));
    t.after(() => rm(root, { recursive: true, force: true }));
    const entry = join(root, 'stubborn.mjs');
    await writeFile(
      entry,
      `import {spawn} from 'node:child_process';
    process.on('SIGTERM',()=>{});
    const child=spawn(process.execPath,['-e','setTimeout(()=>{},1800)'],{stdio:['ignore',process.stdout,'ignore']});
    process.stdin.once('data',chunk=>{const q=JSON.parse(chunk);process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result:{serverInfo:{name:'hud-mcp'}}})+'\\n')});
    setInterval(()=>{},1000);`
    );
    const channel = new PiDelegationChannel({ entry, env: {}, cwd: resolve('.'), sourceRoot: root });
    await channel.ready;
    const start = performance.now();
    await channel.close();
    assert.ok(performance.now() - start < 2500);
    assert.ok(channel.child.exitCode !== null || channel.child.signalCode !== null);
  }
);

test('capacity and pre-admission abort do not create private sequence gaps', { timeout: 10000 }, async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'hud-pi-capacity-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entry = join(root, 'synthetic-server.mjs');
  const frames = join(root, 'frames.json');
  await writeFile(
    entry,
    `import {Socket} from 'node:net';
    import {createInterface} from 'node:readline';
    import {writeFileSync} from 'node:fs';
    const seq=[];
    createInterface({input:new Socket({fd:3,readable:true,writable:false})}).on('line',line=>{
      const f=JSON.parse(line); if(f.kind!=='host'){seq.push(f.seq);writeFileSync(${JSON.stringify(frames)},JSON.stringify(seq));}
    });
    createInterface({input:process.stdin}).on('line',line=>{
      const q=JSON.parse(line); if(q.id===undefined)return;
      const result=q.method==='initialize'?{serverInfo:{name:'hud-mcp'}}:{content:[],structuredContent:{ok:true}};
      setTimeout(()=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n'),q.method==='initialize'?0:120);
    });`
  );
  const channel = new PiDelegationChannel({ entry, env: {}, cwd: root, sourceRoot: root });
  t.after(() => channel.close());
  await channel.ready;
  const snapshot = { toolName: 'delegate_list', toolCallId: 'synthetic' };
  const pending = Array.from({ length: 32 }, () => channel.call(snapshot, {}));
  await assert.rejects(channel.call(snapshot, {}), /pi_channel_busy/);
  await Promise.all(pending);
  await assert.rejects(channel.call(snapshot, {}, AbortSignal.abort()), /pi_channel_unavailable/);
  await channel.call(snapshot, {});
  assert.deepEqual(
    JSON.parse(await readFile(frames, 'utf8')),
    Array.from({ length: 33 }, (_, i) => i + 1)
  );
  assert.equal(channel.isClosed(), false);
});

test('oversized bootstrap rejects ready and reaps its owned child', { timeout: 10000 }, async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'hud-pi-bootstrap-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entry = join(root, 'synthetic-idle.mjs');
  await writeFile(entry, 'setTimeout(() => {}, 3000);');
  let channel;
  process.argv.push('x'.repeat(262144));
  try {
    channel = new PiDelegationChannel({ entry, env: {}, cwd: root, sourceRoot: root });
  } finally {
    process.argv.pop();
  }
  await assert.rejects(channel.ready, /pi_request_too_large/);
  await channel.close();
  assert.ok(channel.child.exitCode !== null || channel.child.signalCode !== null);
});

// Synthetic fault injection tests only the resolver's refusal boundary, not host authority.
test('Pi resolver preserves typed evidence refusals without exposing generic errors', async () => {
  const host = { pid: 10, ppid: 1, procStart: '100', argv: ['pi'], env: {}, pidNamespace: 'pid:[synthetic]' };
  const caller = {
    pid: 11,
    ppid: host.pid,
    procStart: '110',
    parentProcStart: host.procStart,
    pidNamespace: host.pidNamespace,
  };
  const reader = {
    get: (pid) => (pid === caller.pid ? caller : host),
    domain: () => ({ pidDomain: 'synthetic-domain' }),
  };
  const registration = {
    caller,
    source: { harness: 'pi', sourceId: 'a'.repeat(64), rootPath: '/synthetic/sessions' },
    harnessPid: host.pid,
    harnessProcStart: host.procStart,
  };
  const profile = { callSource: { kind: 'pi_extension_v1' } };
  const cases = [
    ...['identity_source_missing', 'identity_unverified', 'unsupported', 'stale_context'].map((code) => [
      new Refusal(code),
      code,
    ]),
    [new Refusal('configuration_invalid'), 'identity_source_missing'],
    [new Error('synthetic private path or diagnostic'), 'identity_source_missing'],
    [new Error('identity_unverified'), 'identity_source_missing'],
    [{ code: 'identity_unverified', message: 'synthetic private diagnostic' }, 'identity_source_missing'],
  ];
  for (const stage of ['verifyHost', 'consume', 'assertLive']) {
    for (const [error, code] of cases) {
      let reached = false;
      const fail = () => {
        reached = true;
        throw error;
      };
      const channel = {
        verifyHost() {},
        async consume() {},
        assertLive() {},
        [stage]: stage === 'consume' ? async () => fail() : fail,
      };
      const resolver = new SessionRefResolver(registration, reader, profile, undefined, undefined, undefined, channel);
      assert.deepEqual(await resolver.resolve({}, 'delegate_list'), { ok: false, code }, `${stage}: ${code}`);
      assert.equal(reached, true, `must exercise ${stage}`);
    }
  }
});
