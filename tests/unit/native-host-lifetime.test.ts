import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { nativeProfiles } from '../../src/managed/host-config.js';
import { NativeSessionHost } from '../../src/managed/host.js';
import { updateNativeHostReference } from '../../src/managed/host-ipc.js';
import { createJevHost, type JevBridge } from '../../src/managed/jev-host.js';
import { RelationStore, type NativeOwner } from '../../src/managed/relations.js';
import type { AdapterCallbacks, ManagedAdapterFactory, NativeRef } from '../../src/managed/types.js';
import type { PiRpcClient, PiRpcOptions } from '../../src/harness/pi/native-rpc-transport.js';

const owner: NativeOwner = { harness: 'codex', sourceId: 'synthetic', sessionId: 'parent', threadId: null };
function temp(t: { after(fn: () => void): void }) {
  const home = mkdtempSync(join(tmpdir(), 'hud-host-lifetime-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}
function listener() {
  const calls: ('ref' | 'unref')[] = [];
  return {
    calls,
    ref() {
      calls.push('ref');
    },
    unref() {
      calls.push('unref');
    },
  };
}
for (const mode of ['native-default', 'explicit-option', 'explicit-argv', 'explicit-env'] as const) {
  test(`Pi host composition preserves ${mode} session location rather than redirecting to HUD_HOME`, async (t) => {
    const home = temp(t),
      configured = join(home, 'user-chosen-pi-sessions');
    let launch: PiRpcOptions | undefined;
    const nativeRef: NativeRef = {
      harness: 'pi',
      sessionId: 'official-id',
      sessionFile: join(configured, 'official.jsonl'),
    };
    const peer: PiRpcClient = {
      async start() {},
      async close() {
        return { stdinEnded: true };
      },
      onEvent() {
        return () => {};
      },
      async respond() {},
      async request(type) {
        return {
          type: 'response',
          command: type,
          success: true,
          data: { sessionId: 'official-id', sessionFile: nativeRef.sessionFile, isStreaming: false },
        };
      },
    };
    const [profile] = nativeProfiles(home, {
      version: 1,
      profiles: [
        {
          id: 'local-pi',
          harness: 'pi',
          executable: 'user-pi',
          env: {
            HOME: home,
            PI_CODING_AGENT_DIR: join(home, 'user-agent-home'),
            ...(mode === 'explicit-env' ? { PI_CODING_AGENT_SESSION_DIR: configured } : {}),
          },
          ...(mode === 'explicit-argv' ? { args: ['--session-dir', configured] } : {}),
          options: {
            rpcClientFactory: (options: PiRpcOptions) => {
              launch = options;
              return peer;
            },
            ...(mode === 'explicit-option' ? { sessionDirectory: configured } : {}),
          },
        },
      ],
    });
    const session = await profile.factory.create(
      { workspace: home, origin: { kind: 'new' } },
      {
        event() {},
        async request() {
          throw new Error('unexpected native request');
        },
      }
    );
    assert.ok(launch);
    assert.equal(launch.cliPath, 'user-pi');
    assert.deepEqual(
      launch.args,
      mode === 'native-default' || mode === 'explicit-env' ? [] : ['--session-dir', configured]
    );
    assert.equal(launch.env?.PI_CODING_AGENT_DIR, join(home, 'user-agent-home'));
    assert.equal(launch.env?.HOME, home);
    if (mode === 'explicit-env') assert.equal(launch.env?.PI_CODING_AGENT_SESSION_DIR, configured);
    assert.deepEqual(session.snapshot().nativeRef, nativeRef);
    assert.ok(!launch.args?.includes(join(home, 'pi-sessions')));
    await session.close();
  });
}

test('empty bootstrap and in-flight IPC stay referenced; only an explicitly emptied host can unref', (t) => {
  const home = temp(t),
    host = new NativeSessionHost(owner, [], new RelationStore(home)),
    server = listener();
  updateNativeHostReference(server, host, 0, false);
  assert.deepEqual(server.calls, ['ref'], 'wake-only bootstrap must survive separate subsequent create');
  updateNativeHostReference(server, host, 1, true);
  assert.equal(server.calls.at(-1), 'ref', 'observer or startup IPC still in flight');
  updateNativeHostReference(server, host, 0, true);
  assert.equal(server.calls.at(-1), 'unref', 'only the empty listener reference is released');
  updateNativeHostReference(server, host, 1, false);
  assert.equal(server.calls.at(-1), 'ref', 'a newly entered call restores the listener reference');
});

test('native create placeholders, idle notifications and disconnected handles retain the host until explicit close', async (t) => {
  const home = temp(t);
  let callbacks!: AdapterCallbacks;
  let finishCreate!: () => void;
  let closes = 0;
  const nativeRef: NativeRef = { harness: 'codex', threadId: 'child' };
  const factory: ManagedAdapterFactory = {
    harness: 'codex',
    async create(_input, cb) {
      callbacks = cb;
      await new Promise<void>((resolve) => {
        finishCreate = resolve;
      });
      return {
        snapshot: () => ({ nativeRef }),
        async send() {
          return {};
        },
        async read() {
          return {};
        },
        async cancel() {
          throw new Error('unexpected interrupt');
        },
        async close() {
          closes++;
          return { connectionReleased: true };
        },
      };
    },
  };
  const host = new NativeSessionHost(owner, [{ id: 'fake', factory }], new RelationStore(home)),
    server = listener();
  const creating = host.create({ profileId: 'fake', callId: 'create', workspace: home, origin: { kind: 'new' } });
  assert.equal(host.hasRetainedHandles(), true);
  updateNativeHostReference(server, host, 0, true);
  assert.equal(server.calls.at(-1), 'ref');
  finishCreate();
  const target = (await creating) as { connectionId: string };
  callbacks.event({ type: 'native_result', kind: 'idle', payload: { status: 'idle' } });
  callbacks.event({ type: 'disconnected', reason: 'pipe disconnected, process lifetime unknown' });
  updateNativeHostReference(server, host, 0, true);
  assert.equal(server.calls.at(-1), 'ref');
  assert.equal(closes, 0);
  await host.close(target);
  assert.equal(closes, 1);
  assert.equal(host.hasRetainedHandles(), false);
  updateNativeHostReference(server, host, 0, true);
  assert.equal(server.calls.at(-1), 'unref');
});

test('a retained Jev instance keeps the host referenced after the last native connection closes', async (t) => {
  const home = temp(t);
  let released = 0;
  const bridge: JevBridge = {
    async invoke(method) {
      return method === 'create' ? { targetId: 'native-tab', sessionId: 'native-cdp' } : { status: 'blocked' };
    },
    release() {
      released++;
    },
  };
  const jev = createJevHost(home, owner, () => bridge);
  const factory: ManagedAdapterFactory = {
    harness: 'codex',
    async create() {
      return {
        snapshot: () => ({ nativeRef: { harness: 'codex', threadId: 'child' } }),
        async send() {
          return {};
        },
        async read() {
          return {};
        },
        async cancel() {},
        async close() {
          return { connectionReleased: true };
        },
      };
    },
  };
  const host = new NativeSessionHost(owner, [{ id: 'fake', factory }], new RelationStore(home)),
    server = listener();
  host.registerExtension('jev_', jev);
  const native = (await host.create({
    profileId: 'fake',
    callId: 'native',
    workspace: home,
    origin: { kind: 'new' },
  })) as { connectionId: string };
  const browser = (await host.invoke(owner, 'jev_create', {
    callId: 'browser',
    url: 'https://example.test',
    goals: 'synthetic',
  })) as { instanceId: string };
  await host.close(native);
  updateNativeHostReference(server, host, 0, true);
  assert.equal(server.calls.at(-1), 'ref');
  assert.equal(released, 0);
  await host.invoke(owner, 'jev_snapshot', { instanceId: browser.instanceId });
  assert.equal(host.hasRetainedHandles(), true, 'blocked is not permission to close the Agent');
  await host.invoke(owner, 'jev_close', { instanceId: browser.instanceId });
  assert.equal(released, 1);
  updateNativeHostReference(server, host, 0, true);
  assert.equal(server.calls.at(-1), 'unref');
});

test('wake registration after explicit last close re-arms the same empty host until the following create', (t) => {
  const home = temp(t),
    host = new NativeSessionHost(owner, [], new RelationStore(home)),
    server = listener();
  let explicitCloseRequested = true;
  updateNativeHostReference(server, host, 0, explicitCloseRequested);
  assert.equal(server.calls.at(-1), 'unref');
  explicitCloseRequested = updateNativeHostReference(server, host, 1, explicitCloseRequested, 'wake_register');
  assert.equal(explicitCloseRequested, false);
  assert.equal(server.calls.at(-1), 'ref');
  updateNativeHostReference(server, host, 0, explicitCloseRequested);
  assert.equal(server.calls.at(-1), 'ref', 'registered wake must survive the separate next IPC create');
  explicitCloseRequested = updateNativeHostReference(server, host, 1, explicitCloseRequested, 'create');
  assert.equal(explicitCloseRequested, false);
  assert.equal(server.calls.at(-1), 'ref');
});

test('later wake registration wins over an earlier close whose native response resolves last', async (t) => {
  const home = temp(t),
    server = listener();
  let finishClose!: () => void;
  let closeCalls = 0;
  const factory: ManagedAdapterFactory = {
    harness: 'codex',
    async create() {
      return {
        snapshot: () => ({ nativeRef: { harness: 'codex', threadId: 'child' } }),
        async send() {
          return {};
        },
        async read() {
          return {};
        },
        async cancel() {
          throw new Error('unexpected interrupt');
        },
        async close() {
          closeCalls++;
          await new Promise<void>((resolve) => {
            finishClose = resolve;
          });
          return { connectionReleased: true };
        },
      };
    },
  };
  const host = new NativeSessionHost(owner, [{ id: 'fake', factory }], new RelationStore(home));
  const target = (await host.create({
    profileId: 'fake',
    callId: 'create',
    workspace: home,
    origin: { kind: 'new' },
  })) as { connectionId: string };
  let explicitCloseRequested = updateNativeHostReference(server, host, 1, false, 'close');
  const closing = host.close(target);
  assert.equal(explicitCloseRequested, true);
  assert.equal(host.hasRetainedHandles(), true);
  explicitCloseRequested = updateNativeHostReference(server, host, 2, explicitCloseRequested, 'wake_register');
  assert.equal(explicitCloseRequested, false, 'later authenticated wake cancels empty-listener release intent');
  updateNativeHostReference(server, host, 1, explicitCloseRequested);
  assert.equal(server.calls.at(-1), 'ref');
  finishClose();
  await closing;
  assert.equal(host.hasRetainedHandles(), false);
  assert.equal(closeCalls, 1);
  updateNativeHostReference(server, host, 0, explicitCloseRequested);
  assert.equal(server.calls.at(-1), 'ref', 'older close completion must not override the newer wake/create handshake');
});
