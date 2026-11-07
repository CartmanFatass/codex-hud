import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { NativeSessionHost } from '../../src/managed/host.js';
import { RelationStore, type NativeOwner } from '../../src/managed/relations.js';
import { NativeHostClient, serveNativeHost } from '../../src/managed/host-ipc.js';
import type {
  AdapterCallbacks,
  AdapterCreate,
  AdapterEvent,
  ManagedAdapterFactory,
  NativeRef,
} from '../../src/managed/types.js';
const owner: NativeOwner = { harness: 'codex', sourceId: 'source', sessionId: 'parent-a', threadId: null };
function setup() {
  const home = mkdtempSync(join(tmpdir(), 'hud-thin-'));
  const store = new RelationStore(home);
  let callbacks!: AdapterCallbacks;
  let closes = 0;
  let cancels = 0;
  const sent: unknown[] = [];
  const origins: AdapterCreate['origin'][] = [];
  const ref: NativeRef = { harness: 'codex', threadId: 'child' };
  const factory: ManagedAdapterFactory = {
    harness: 'codex',
    async create(input, cb) {
      callbacks = cb;
      origins.push(input.origin);
      cb.event({ type: 'binding', nativeRef: ref });
      return {
        snapshot: () => ({ nativeRef: ref, nativeStatus: { type: 'active', activeFlags: ['waitingOnApproval'] } }),
        async send(input) {
          sent.push(input);
          return { payload: { turn: { id: 'native-turn', status: 'inProgress' } } };
        },
        async read(options) {
          return { thread: { id: 'child', status: { type: 'idle' } }, options };
        },
        async cancel(input) {
          cancels++;
          return input;
        },
        async close() {
          closes++;
          return { connectionReleased: true };
        },
      };
    },
  };
  const host = new NativeSessionHost(owner, [{ id: 'fake', factory }], store);
  return {
    home,
    store,
    host,
    ref,
    origins,
    sent,
    get callbacks() {
      return callbacks;
    },
    get closes() {
      return closes;
    },
    get cancels() {
      return cancels;
    },
    cleanup() {
      rmSync(home, { recursive: true, force: true });
    },
  };
}
async function create(s: ReturnType<typeof setup>) {
  return (await s.host.create({
    profileId: 'fake',
    callId: 'mcp-call',
    workspace: s.home,
    origin: { kind: 'new' },
  })) as { connectionId: string };
}
test('only direct relations persist; official payload and read state remain unchanged', async () => {
  const s = setup();
  try {
    const target = await create(s);
    assert.deepEqual(await s.host.send(target, { callId: 'input', text: 'hello' }), {
      payload: { turn: { id: 'native-turn', status: 'inProgress' } },
    });
    assert.equal(s.store.list(owner)[0]?.child.harness, 'codex');
    assert.deepEqual(readdirSync(s.home), ['native-relations']);
    assert.deepEqual(await s.host.read(target), {
      thread: { id: 'child', status: { type: 'idle' } },
      options: undefined,
    });
  } finally {
    s.cleanup();
  }
});
test('wait timeout and abort never interrupt or close native work', async () => {
  const s = setup();
  try {
    const target = await create(s);
    await s.host.wait(target, 999, 1);
    const controller = new AbortController();
    const wait = s.host.wait(target, 999, 10000, controller.signal);
    controller.abort();
    await wait;
    assert.equal(s.closes, 0);
    assert.equal(s.cancels, 0);
  } finally {
    s.cleanup();
  }
});
test('native callback response goes to exact connection and native request ID', async () => {
  const s = setup();
  try {
    const target = await create(s);
    const payload = { tool: 'native', newField: { values: [null, 1, true] } };
    const response = s.callbacks.request({ requestId: 'number:17', kind: 'item/approval', payload });
    assert.deepEqual((s.host.requests(target) as any[])[0].payload, payload);
    assert.throws(() => s.host.respond(target, 'string:17', {}), /not_pending/);
    const result = { decision: 'accept', opaque: [true, null] };
    s.host.respond(target, 'number:17', result);
    assert.deepEqual(await response, { result });
  } finally {
    s.cleanup();
  }
});
test('native request withdrawal removes callback with no invented response', async () => {
  const s = setup();
  try {
    const target = await create(s);
    const c = new AbortController();
    const response = s.callbacks.request({ requestId: 'r', kind: 'native', payload: {}, signal: c.signal });
    const rejected = assert.rejects(response, /withdrawn/);
    c.abort();
    await rejected;
    assert.deepEqual(s.host.requests(target), []);
    assert.throws(() => s.host.respond(target, 'r', {}), /not_pending/);
    assert.equal(s.closes, 0);
  } finally {
    s.cleanup();
  }
});
test('different native owner cannot read, resume or respond to this owner', async () => {
  const s = setup();
  try {
    const target = await create(s);
    const other = { ...owner, sessionId: 'parent-b' };
    await assert.rejects(s.host.invoke(other, 'status', target), /owner_mismatch/);
    const hostB = new NativeSessionHost(other, [], s.store);
    assert.deepEqual(hostB.list(), { connections: [], relations: [] });
  } finally {
    s.cleanup();
  }
});
test('host restart uses official resume and persisted direct relation, not HUD lifecycle', async () => {
  const s = setup();
  try {
    await create(s);
    const restart = new NativeSessionHost(
      owner,
      [
        {
          id: 'fake',
          factory: {
            harness: 'codex',
            async create(input) {
              assert.deepEqual(input.origin, { kind: 'resume', source: s.ref });
              return {
                snapshot: () => ({ nativeRef: s.ref }),
                async send() {
                  return {};
                },
                async read() {
                  return { native: true };
                },
                async cancel() {},
                async close() {},
              };
            },
          },
        },
      ],
      s.store
    );
    await restart.create({
      profileId: 'fake',
      workspace: s.home,
      callId: 'resume',
      origin: { kind: 'resume', source: s.ref },
    });
    assert.equal(s.store.list(owner).length, 2);
  } finally {
    s.cleanup();
  }
});
test('resume rejects a native ID absent from direct ownership relations', async () => {
  const s = setup();
  try {
    await assert.rejects(
      s.host.create({ profileId: 'fake', callId: 'c', workspace: s.home, origin: { kind: 'resume', source: s.ref } }),
      /not_owned/
    );
  } finally {
    s.cleanup();
  }
});
test('only explicit cancel and close invoke corresponding official methods', async () => {
  const s = setup();
  try {
    const target = await create(s);
    s.callbacks.event({ type: 'disconnected', reason: 'pipe ended' });
    assert.equal(s.closes, 0);
    await s.host.cancel(target, 'turn');
    assert.equal(s.cancels, 1);
    await s.host.close(target);
    assert.equal(s.closes, 1);
  } finally {
    s.cleanup();
  }
});
test('bounded events report truncation and never synthesize business status', async () => {
  const s = setup();
  try {
    const target = await create(s);
    for (let i = 0; i < 600; i++)
      s.callbacks.event({ type: 'native_event', kind: 'arbitrary/new/method', payload: { i } });
    const page = (await s.host.wait(target, 0, 0)) as any;
    assert.equal(page.events.length, 512);
    assert.equal(page.truncated, true);
    assert.equal(page.events.at(-1).event.payload.i, 599);
    assert.equal(s.closes, 0);
  } finally {
    s.cleanup();
  }
});
test('relation write failure remains visible without closing the successful native connection', async () => {
  const s = setup();
  try {
    s.store.record = () => {
      throw new Error('disk_full');
    };
    const created = (await create(s)) as any;
    assert.equal(created.relationWriteError, 'disk_full');
    await s.host.send(created, { callId: 's', text: 'continue' });
    assert.equal(s.closes, 0);
  } finally {
    s.cleanup();
  }
});
test('IPC client cancellation disconnects observer, host and official connection survive', async (t) => {
  const s = setup();
  let server;
  try {
    server = await serveNativeHost(s.home, s.host);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      s.cleanup();
      t.skip('Environment prohibits Unix socket listen (EPERM), including escalated probe');
      return;
    }
    throw error;
  }
  try {
    const client = new NativeHostClient(s.home, false);
    const created = (await client.invoke(owner, 'create', {
      profileId: 'fake',
      callId: 'c',
      workspace: s.home,
      origin: { kind: 'new' },
    })) as any;
    const c = new AbortController();
    const pending = client.invoke(owner, 'wait', { ...created, afterSeq: 999, waitMs: 10000 }, c.signal);
    setTimeout(() => c.abort(), 10);
    await assert.rejects(pending, /cancelled/);
    assert.equal(s.closes, 0);
    assert.equal(((await client.invoke(owner, 'read', created)) as any).thread.id, 'child');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    s.cleanup();
  }
});

test('synthetic native connection continues after its frontend process exits', async () => {
  const home = mkdtempSync(join(tmpdir(), 'hud-detached-'));
  const entry = join(home, 'synthetic-host.mjs');
  const hostUrl = new URL('../../src/managed/host.js', import.meta.url).href;
  const relationsUrl = new URL('../../src/managed/relations.js', import.meta.url).href;
  const ipcUrl = new URL('../../src/managed/host-ipc.js', import.meta.url).href;
  writeFileSync(
    entry,
    `import {NativeSessionHost} from ${JSON.stringify(hostUrl)}; import {RelationStore} from ${JSON.stringify(relationsUrl)}; import {writeFileSync} from 'node:fs'; import {join} from 'node:path';
 const home=process.argv[2],owner=JSON.parse(process.argv[3]); let cb;
 const host=new NativeSessionHost(owner,[{id:'fake',factory:{harness:'codex',async create(_input,callbacks){cb=callbacks;return {snapshot:()=>({nativeRef:{harness:'codex',threadId:'detached'}}),async send(){setTimeout(()=>{cb.event({type:'native_result',kind:'turn/completed',payload:{native:'result after parent exit'}});},300);return {payload:{id:'native-turn'}};},async read(){return{};},async cancel(){throw new Error('unexpected cancel');},async close(){throw new Error('unexpected close');}};}}}],new RelationStore(home));
 host.subscribe(message=>{writeFileSync(join(home,'result.json'),JSON.stringify(message));});
 const target=await host.create({profileId:'fake',callId:'create',workspace:home,origin:{kind:'new'}}); await host.send(target,{callId:'send',text:'synthetic'});writeFileSync(join(home,'ready'),'ready');`
  );
  const parent = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import {spawnDetachedHost} from ${JSON.stringify(ipcUrl)}; import {writeFileSync} from 'node:fs';const child=spawnDetachedHost(${JSON.stringify(entry)},${JSON.stringify(home)},${JSON.stringify(owner)});writeFileSync(${JSON.stringify(join(home, 'child.pid'))},String(child.pid));setInterval(()=>{},1000);`,
    ],
    { stdio: 'ignore' }
  );
  let childPid: number | undefined;
  try {
    for (let i = 0; i < 100 && !existsSync(join(home, 'ready')); i++) await delay(20);
    assert.equal(existsSync(join(home, 'ready')), true, 'detached synthetic host started');
    childPid = Number(readFileSync(join(home, 'child.pid'), 'utf8'));
    const exited = once(parent, 'exit');
    parent.kill('SIGTERM');
    await exited;
    for (let i = 0; i < 100 && !existsSync(join(home, 'result.json')); i++) await delay(20);
    const event = JSON.parse(readFileSync(join(home, 'result.json'), 'utf8'));
    assert.equal(event.event.payload.native, 'result after parent exit');
  } finally {
    parent.kill('SIGTERM');
    if (childPid)
      try {
        process.kill(childPid, 'SIGTERM');
      } catch {}
    rmSync(home, { recursive: true, force: true });
  }
});

test('explicit resume reuses a live connection without submitting native input again', async () => {
  const s = setup();
  try {
    const original = await create(s);
    const resumed = (await s.host.create({
      profileId: 'fake',
      callId: 'resume',
      workspace: s.home,
      origin: { kind: 'resume', source: s.ref },
    })) as { connectionId: string };
    assert.equal(resumed.connectionId, original.connectionId);
    assert.equal(s.origins.length, 1);
    assert.equal(s.sent.length, 0);
    assert.equal(s.closes, 0);
  } finally {
    s.cleanup();
  }
});
for (const ended of [
  { type: 'disconnected', reason: 'native pipe ended' },
  { type: 'process_exit', code: 7, signal: null },
] as const) {
  test(`explicit resume after ${ended.type} obtains a new official handle and routes nativeRef to it`, async () => {
    const s = setup();
    try {
      const original = await create(s);
      s.callbacks.event(ended);
      assert.equal(s.origins.length, 1, 'observing transport end does not auto-resume');
      assert.equal(s.closes, 0, 'observing transport end does not close or kill the native backend');
      const resumed = (await s.host.create({
        profileId: 'fake',
        callId: 'resume',
        workspace: s.home,
        origin: { kind: 'resume', source: s.ref },
      })) as { connectionId: string };
      assert.notEqual(resumed.connectionId, original.connectionId);
      assert.deepEqual(s.origins, [{ kind: 'new' }, { kind: 'resume', source: s.ref }]);
      const status = (await s.host.status({ nativeRef: s.ref })) as { connection: { connectionId: string } };
      assert.equal(
        status.connection.connectionId,
        resumed.connectionId,
        'native ID targets the new usable handle, not the stale one'
      );
      const connections = (s.host.list() as { connections: { connectionId: string; transportEnd?: AdapterEvent }[] })
        .connections;
      assert.deepEqual(connections.find((c) => c.connectionId === original.connectionId)?.transportEnd, ended);
      assert.equal(connections.find((c) => c.connectionId === resumed.connectionId)?.transportEnd, undefined);
      assert.equal(s.sent.length, 0);
      assert.equal(s.closes, 0);
      assert.equal(s.cancels, 0);
    } finally {
      s.cleanup();
    }
  });
}

test('native resume startup request can be listed and answered before factory returns a session', async () => {
  const home = mkdtempSync(join(tmpdir(), 'hud-startup-callback-'));
  let received: unknown;
  let sends = 0;
  const factory: ManagedAdapterFactory = {
    harness: 'pi',
    async create(_input, callbacks) {
      received = await callbacks.request({
        requestId: 'native-startup-1',
        kind: 'extension_ui_request',
        payload: { method: 'confirm', message: 'startup confirmation' },
      });
      const nativeRef: NativeRef = {
        harness: 'pi',
        sessionId: 'native-session',
        sessionFile: join(home, 'native.jsonl'),
      };
      callbacks.event({ type: 'binding', nativeRef });
      return {
        snapshot: () => ({ nativeRef }),
        async send() {
          sends++;
          return {};
        },
        async read() {
          return {};
        },
        async cancel() {},
        async close() {},
      };
    },
  };
  const source: NativeRef = { harness: 'pi', sessionId: 'native-session', sessionFile: join(home, 'native.jsonl') };
  const relations = new RelationStore(home);
  relations.record({
    owner,
    callId: 'earlier-create',
    child: source,
    workspace: home,
    profileId: 'startup',
    createdAt: 1,
  });
  const host = new NativeSessionHost(owner, [{ id: 'startup', factory }], relations);
  try {
    const creating = host.create({ profileId: 'startup', callId: 'create', workspace: home, origin: { kind: 'new' } });
    const pending = host.requests() as { connectionId: string; requestId: string }[];
    assert.equal(pending.length, 1);
    const target = { connectionId: pending[0].connectionId };
    assert.equal((host.requests(target) as unknown[]).length, 1);
    assert.equal(((await host.wait(target, 0, 0)) as { events: unknown[] }).events.length, 1);
    await assert.rejects(
      host.invoke({ ...owner, sessionId: 'other-parent' }, 'respond', {
        ...target,
        requestId: 'native-startup-1',
        result: { confirmed: true },
      }),
      /owner_mismatch/
    );
    assert.throws(() => host.respond(target, 'wrong-id', {}), /not_pending/);
    host.respond(target, 'native-startup-1', { confirmed: true });
    const created = (await creating) as { connectionId: string };
    assert.equal(created.connectionId, target.connectionId);
    assert.deepEqual(received, { result: { confirmed: true } });
    assert.equal(sends, 0);
    assert.deepEqual(host.requests(target), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('resume and fork reject substituted Pi files, backend profiles and workspaces before native dispatch', async () => {
  const home = mkdtempSync(join(tmpdir(), 'hud-owned-locator-'));
  const relations = new RelationStore(home);
  const child: NativeRef = { harness: 'pi', sessionId: 'owned-a', sessionFile: join(home, 'a.jsonl') };
  relations.record({ owner, callId: 'original-create', child, workspace: home, profileId: 'original', createdAt: 1 });
  const dispatched: AdapterCreate[] = [];
  const factory: ManagedAdapterFactory = {
    harness: 'pi',
    async create(input) {
      dispatched.push(input);
      return {
        snapshot: () => ({ nativeRef: child }),
        async send() {
          return {};
        },
        async read() {
          return {};
        },
        async cancel() {},
        async close() {},
      };
    },
  };
  const host = new NativeSessionHost(
    owner,
    [
      { id: 'original', factory },
      { id: 'other-profile', factory },
    ],
    relations
  );
  try {
    const substituted: NativeRef = { ...child, sessionFile: join(home, 'private-b.jsonl') };
    assert.equal(relations.owns(owner, substituted), false);
    for (const kind of ['resume', 'fork'] as const) {
      await assert.rejects(
        host.create({
          profileId: 'original',
          callId: `${kind}-file`,
          workspace: home,
          origin: { kind, source: substituted },
        }),
        /native_relation_locator_mismatch/
      );
      await assert.rejects(
        host.create({
          profileId: 'other-profile',
          callId: `${kind}-profile`,
          workspace: home,
          origin: { kind, source: child },
        }),
        /native_relation_profile_mismatch/
      );
      await assert.rejects(
        host.create({
          profileId: 'original',
          callId: `${kind}-workspace`,
          workspace: join(home, 'other'),
          origin: { kind, source: child },
        }),
        /native_relation_workspace_mismatch/
      );
    }
    assert.equal(
      dispatched.length,
      0,
      'no switch_session, clone, or any factory action occurs for conflicting locators'
    );
    await host.create({
      profileId: 'original',
      callId: 'valid-resume',
      workspace: home,
      origin: { kind: 'resume', source: { harness: 'pi', sessionId: 'owned-a' } },
    });
    assert.equal(dispatched.length, 1);
    assert.deepEqual(
      dispatched[0].origin,
      { kind: 'resume', source: child },
      'omitted optional locator is populated from the stored official source'
    );
    assert.equal(dispatched[0].workspace, home);
    assert.equal((dispatched[0] as AdapterCreate & { profileId: string }).profileId, 'original');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('oversized native result marks a cursor gap even while earlier and later small events remain retained', async () => {
  const s = setup();
  try {
    const target = await create(s);
    const start = ((await s.host.wait(target, 0, 0)) as { throughSeq: number }).throughSeq;
    s.callbacks.event({ type: 'native_event', kind: 'small', payload: { value: 'retained' } });
    s.callbacks.event({ type: 'native_result', kind: 'large-result', payload: { text: 'x'.repeat(1_048_577) } });
    const page = (await s.host.wait(target, start, 0)) as {
      events: { seq: number; event?: AdapterEvent }[];
      throughSeq: number;
      truncated: boolean;
    };
    assert.equal(page.events.length, 1);
    assert.equal(page.events[0].seq, start + 1);
    assert.equal(page.throughSeq, start + 2);
    assert.equal(page.truncated, true);
    const hole = (await s.host.wait(target, start + 1, 0)) as { events: unknown[]; truncated: boolean };
    assert.deepEqual(hole.events, []);
    assert.equal(hole.truncated, true);
    s.callbacks.event({ type: 'native_event', kind: 'later-small', payload: { value: 'also retained' } });
    const across = (await s.host.wait(target, start, 0)) as { events: { seq: number }[]; truncated: boolean };
    assert.deepEqual(
      across.events.map((event) => event.seq),
      [start + 1, start + 3]
    );
    assert.equal(across.truncated, true);
    const after = (await s.host.wait(target, start + 2, 0)) as { events: { seq: number }[]; truncated: boolean };
    assert.equal(after.truncated, false);
    assert.deepEqual(
      after.events.map((event) => event.seq),
      [start + 3]
    );
    assert.equal(s.closes, 0);
    assert.equal(s.cancels, 0);
  } finally {
    s.cleanup();
  }
});
