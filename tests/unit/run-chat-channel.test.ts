import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { RunChatChannel, connectRunChat, resolveRunChatTarget } from '../../src/core/run/chat-channel.js';
import { RunArtifacts } from '../../src/core/run/artifacts.js';
import { readProcess } from '../../src/core/run/process.js';
import { PiChatProtocol } from '../../src/harness/pi/chat-protocol.js';
import { MemoryRunFactPort } from '../../src/core/run/fake-port.js';
import { seedRun } from '../run/fixtures.js';
import type { RunMeta } from '../../src/core/types/supervision.js';

async function setup(t: test.TestContext, reply = true) {
  const home = mkdtempSync(join(tmpdir(), 'hud-chat-'));
  const child = spawn(
    process.execPath,
    [
      '-e',
      `let b='';process.stdin.on('data',x=>{b+=x;let i;while((i=b.indexOf('\\n'))>=0){let r=JSON.parse(b.slice(0,i));b=b.slice(i+1);${reply ? "process.stdout.write(JSON.stringify({type:'response',command:'prompt',id:r.id,success:true})+'\\n');process.stdout.write(JSON.stringify({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'same-child:'+r.message}})+'\\n');" : ''}}});`,
    ],
    { stdio: ['pipe', 'pipe', 'ignore'] }
  );
  await once(child, 'spawn');
  t.after(async () => {
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await once(child, 'exit');
    }
    rmSync(home, { recursive: true, force: true });
  });
  const { seed } = seedRun(home, []);
  const s = seed.snapshot,
    r = s.run;
  const supervisor = readProcess(process.pid)!.stamp,
    harness = readProcess(child.pid!)!.stamp;
  r.state = 'running';
  r.supervisor = supervisor;
  const ref = { harness: r.harness, sourceId: r.sourceId, sessionId: 'bound-native-session', threadId: null };
  s.status.link.childRef = ref;
  s.status.link.currentOwner = true;
  s.status.link.state = 'bound';
  s.status.runHandshake = { state: 'bound', reason: null };
  s.currentChildBinding = {
    bindingId: 'binding',
    runId: r.runId,
    sessionRef: ref,
    bindingGeneration: r.expectedGeneration,
    callerId: 'child',
    callerContextId: 'context',
    contextGeneration: 1,
    boundBy: 'trusted_session',
    capabilities: 'mcp',
    evidenceId: 'synthetic',
    isCurrent: true,
    createdAt: 1,
    revokedAt: null,
  };
  s.retirement = {
    assignment: 'synthetic',
    authorityValid: true,
    currentRunId: r.runId,
    reportSeq: null,
    intentSeq: 1,
    intentAt: 1,
  };
  s.meta = {
    schema_version: 1,
    run_id: r.runId,
    link_id: r.linkId,
    source_id: r.sourceId,
    binding_generation: r.expectedGeneration,
    mode: 'headless',
    supervision_strategy: 'headless',
    supervisor,
    command_leader: harness,
    harness,
    scope: null,
    launch_digest: r.launchDigest,
    profile_digest: 'a'.repeat(64),
    launch_call_id: 'call',
    launch_correlation_id: 'correlation',
    created_at: 1,
    stdin_mode: 'closed',
    capture: 'file',
    launch_cwd: home,
    project_origin: null,
  } as RunMeta;
  RunArtifacts.create(home, r.runId);
  const port = new MemoryRunFactPort(seed),
    selected = { linkId: r.linkId, runId: r.runId, sourceId: r.sourceId };
  const target = await resolveRunChatTarget(port, selected);
  const channel = new RunChatChannel(new PiChatProtocol(), port, home, target, supervisor);
  child.stdout.on('data', (b) => channel.consume(b));
  await channel.listen(
    (bytes) => new Promise<void>((resolve, reject) => child.stdin.write(bytes, (e) => (e ? reject(e) : resolve())))
  );
  t.after(() => channel.close());
  return { home, child, seed, port, target, selected, channel };
}
test('exact live selected child sends and streams, detach leaves child running, no replay', async (t) => {
  const f = await setup(t),
    session = await connectRunChat(f.home, f.target, f.port);
  let text = '';
  session.subscribe((e) => {
    if (e.type === 'text') text += e.text;
  });
  await session.send('hello');
  for (let i = 0; i < 50 && !text; i++) await delay(10);
  assert.equal(text, 'same-child:hello');
  assert.equal(session.snapshot().status, 'ready');
  await session.close();
  assert.equal(f.child.exitCode, null);
  await delay(10);
  const next = await connectRunChat(f.home, f.target, f.port);
  assert.equal(next.snapshot().status, 'ready');
  await next.close();
});
test('generation/source/native-session/supervisor drift and revoked binding cannot send', async (t) => {
  const f = await setup(t),
    s = f.seed.snapshot;
  await assert.rejects(resolveRunChatTarget(f.port, { ...f.selected, sourceId: 'wrong' }), /unavailable/);
  const session = await connectRunChat(f.home, f.target, f.port);
  s.currentChildBinding!.sessionRef = { ...s.currentChildBinding!.sessionRef, sessionId: 'replacement' };
  s.status.link.childRef = s.currentChildBinding!.sessionRef;
  await assert.rejects(session.send('must not go to replacement'), /unavailable/);
  await session.close();
  s.currentChildBinding!.revokedAt = 2;
  await assert.rejects(resolveRunChatTarget(f.port, f.selected), /unavailable/);
});
test('missing legacy endpoint refuses; stale generation cannot attach; pending disconnect is unknown', async (t) => {
  const f = await setup(t, false);
  await assert.rejects(connectRunChat(f.home, { ...f.target, bindingGeneration: 99 }, f.port), /unavailable/);
  const session = await connectRunChat(f.home, f.target, f.port);
  const pending = session.send('no response');
  await delay(30);
  f.channel.close();
  await assert.rejects(pending, /outcome_unknown/);
  assert.equal(session.snapshot().status, 'uncertain');
  await assert.rejects(connectRunChat(f.home, f.target, f.port));
});
