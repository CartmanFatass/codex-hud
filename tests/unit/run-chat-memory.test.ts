// In-memory state-machine checks only. No Unix endpoint is listened to or connected.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { mkdtempSync, rmSync, renameSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunChatChannel, resolveRunChatTarget, chatEndpointFailure } from '../../src/core/run/chat-channel.js';
import { RunArtifacts } from '../../src/core/run/artifacts.js';
import { readProcess } from '../../src/core/run/process.js';
import { PiChatProtocol } from '../../src/harness/pi/chat-protocol.js';
import { MemoryRunFactPort } from '../../src/core/run/fake-port.js';
import { seedRun } from '../run/fixtures.js';
import type { RunMeta } from '../../src/core/types/supervision.js';

class MemorySocket extends EventEmitter {
  destroyed = false;
  writableLength = 0;
  output: Record<string, unknown>[] = [];
  setTimeout() {
    return this;
  }
  write(text: string) {
    this.output.push(JSON.parse(text));
    return true;
  }
  destroy() {
    if (!this.destroyed) {
      this.destroyed = true;
      this.emit('close');
    }
    return this;
  }
  end() {
    return this.destroy();
  }
  receive(value: unknown) {
    this.emit('data', Buffer.from(JSON.stringify(value) + '\n'));
  }
}
const tick = () => new Promise<void>((r) => setImmediate(r));
async function settle() {
  await tick();
  await tick();
}
async function setup(t: test.TestContext) {
  const home = mkdtempSync(join(tmpdir(), 'hud-chat-memory-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const { seed } = seedRun(home, []);
  const s = seed.snapshot,
    r = s.run;
  const supervisor = readProcess(process.pid)!.stamp,
    harness = readProcess(process.pid)!.stamp;
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
  const writes: Buffer[] = [];
  // Substitute only the endpoint transport, keeping actual fencing/codec/admission implementation.
  const state = channel as unknown as {
    connect(socket: Socket): void;
    write(bytes: Buffer): Promise<void>;
    directory: ReturnType<RunArtifacts['pinDirectory']>;
  };
  state.directory = RunArtifacts.open(home, r.runId).pinDirectory();
  state.write = async (bytes) => {
    writes.push(bytes);
  };
  const socket = new MemorySocket();
  state.connect(socket as unknown as Socket);
  socket.receive({ type: 'attach', target });
  await settle();
  assert.equal(socket.output[0]?.type, 'ready');
  t.after(() => channel.close());
  return { home, seed, port, target, channel, socket, writes, state };
}
const response = (id: string, success: boolean) =>
  Buffer.from(JSON.stringify({ type: 'response', command: 'prompt', id, success }) + '\n');
test('correlated rejection stays rejected; another explicit send remains usable with no replay', async (t) => {
  const f = await setup(t);
  f.socket.receive({ type: 'send', id: 'first', text: 'first' });
  await settle();
  assert.equal(f.writes.length, 1);
  f.channel.consume(response('first', false));
  await settle();
  assert.equal(f.socket.output.at(-1)?.type, 'rejected');
  assert.equal(f.socket.destroyed, false);
  f.socket.receive({ type: 'send', id: 'second', text: 'second' });
  await settle();
  f.channel.consume(response('second', true));
  await settle();
  assert.equal(f.writes.length, 2);
  assert.deepEqual(f.socket.output.at(-1), { type: 'accepted', id: 'second' });
});
test('uncorrelated response is unknown and never automatically replayed', async (t) => {
  const f = await setup(t);
  f.socket.receive({ type: 'send', id: 'first', text: 'first' });
  await settle();
  f.channel.consume(response('other', true));
  await settle();
  assert.equal(f.socket.output.at(-1)?.type, 'outcome_unknown');
  assert.equal(f.socket.destroyed, true);
  assert.equal(f.writes.length, 1);
});
for (const accepted of [true, false]) {
  test(`late pipe failure after correlated ${accepted ? 'acceptance' : 'rejection'} never reports not submitted`, async (t) => {
    const f = await setup(t);
    let rejectWrite!: (error: Error) => void;
    f.state.write = (bytes) => {
      f.writes.push(bytes);
      return new Promise<void>((_, reject) => {
        rejectWrite = reject;
      });
    };
    f.socket.receive({ type: 'send', id: 'late', text: 'once only' });
    await settle();
    f.channel.consume(response('late', accepted));
    await settle();
    assert.equal(f.socket.output.at(-1)?.type, accepted ? 'accepted' : 'rejected');
    rejectWrite(new Error('synthetic delayed write failure'));
    await settle();
    assert.equal(
      f.socket.output.some((frame) => frame.type === 'not_submitted'),
      false
    );
    assert.equal(f.socket.output.at(-1)?.type, 'outcome_unknown');
    assert.equal(f.socket.destroyed, true);
    assert.equal(f.writes.length, 1);
  });
}
for (const accepted of [true, false]) {
  test(`a next explicit send after ${accepted ? 'acceptance' : 'rejection'} does not await the prior pipe callback`, async (t) => {
    const f = await setup(t);
    let finishFirst!: () => void;
    f.state.write = (bytes) => {
      f.writes.push(bytes);
      return f.writes.length === 1
        ? new Promise<void>((resolve) => {
            finishFirst = resolve;
          })
        : Promise.resolve();
    };
    f.socket.receive({ type: 'send', id: 'first', text: 'first' });
    await settle();
    f.channel.consume(response('first', accepted));
    await settle();
    assert.equal(f.socket.output.at(-1)?.type, accepted ? 'accepted' : 'rejected');
    f.socket.receive({ type: 'send', id: 'second', text: 'second' });
    await settle();
    assert.equal(f.socket.destroyed, false);
    assert.equal(f.writes.length, 2);
    finishFirst();
    await settle();
    assert.equal(f.socket.output.filter((frame) => frame.type === 'submitted' && frame.id === 'first').length, 0);
    f.channel.consume(response('second', true));
    await settle();
    assert.deepEqual(f.socket.output.at(-1), { type: 'accepted', id: 'second' });
  });
}
test('an old pipe callback cannot release a newer awaited admission lock', async (t) => {
  const f = await setup(t);
  let finishFirst!: () => void;
  f.state.write = (bytes) => {
    f.writes.push(bytes);
    return new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
  };
  f.socket.receive({ type: 'send', id: 'first', text: 'first' });
  await settle();
  f.channel.consume(response('first', true));
  await settle();
  const read = f.port.read.bind(f.port);
  let finishRead!: () => void;
  f.port.read = async (id) => {
    const value = await read(id);
    await new Promise<void>((resolve) => {
      finishRead = resolve;
    });
    return value;
  };
  f.socket.receive({ type: 'send', id: 'second', text: 'second' });
  await settle();
  finishFirst();
  await settle();
  f.socket.receive({ type: 'send', id: 'third', text: 'must not bypass admission' });
  assert.equal(f.socket.destroyed, true);
  finishRead();
  await settle();
  assert.equal(f.writes.length, 1);
});
test('escaped input exceeds wire limit before submission and does not write', async (t) => {
  const f = await setup(t);
  f.socket.receive({ type: 'send', id: 'large', text: 'a' + '"'.repeat(32767) });
  await settle();
  assert.deepEqual(f.socket.output.at(-1), { type: 'not_submitted', id: 'large' });
  assert.equal(f.writes.length, 0);
});
test('binding changes are rejected before submission, not labelled ambiguous delivery', async (t) => {
  const f = await setup(t);
  f.seed.snapshot.currentChildBinding!.revokedAt = Date.now();
  f.socket.receive({ type: 'send', id: 'stale', text: 'must not send' });
  await settle();
  assert.deepEqual(f.socket.output.at(-1), { type: 'not_submitted', id: 'stale' });
  assert.equal(f.writes.length, 0);
});
test('private run directory replacement during awaited ledger read prevents submission', async (t) => {
  const f = await setup(t);
  const read = f.port.read.bind(f.port);
  f.port.read = async (id) => {
    const value = await read(id);
    const path = join(f.home, 'runs', id);
    renameSync(path, path + '-old');
    mkdirSync(path, { mode: 0o700 });
    return value;
  };
  f.socket.receive({ type: 'send', id: 'replacement', text: 'must not send' });
  await settle();
  assert.deepEqual(f.socket.output.at(-1), { type: 'not_submitted', id: 'replacement' });
  assert.equal(f.writes.length, 0);
});
test('endpoint diagnostics preserve only allowlisted cause, never paths or private message bodies', () => {
  assert.equal(chatEndpointFailure(Object.assign(new Error('/private/socket'), { code: 'EPERM' })), 'EPERM');
  assert.equal(
    chatEndpointFailure(Object.assign(new Error('private'), { code: 'secret\nvalue' })),
    'chat_endpoint_unavailable'
  );
  assert.equal(chatEndpointFailure(new Error('chat_pipe_unavailable')), 'chat_pipe_unavailable');
});
