import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachNativeWake, sendNativeWake, validateNativeWakeTarget } from '../../src/managed/host-wake.js';
import { nativeWakeDetails, nativeWakeMessage } from '../../src/managed/wake-message.js';
import type { HostMessage } from '../../src/managed/host.js';
import type { NativeOwner } from '../../src/managed/relations.js';
import { parseWait, runNativeWait } from '../../src/cli/run-wait.js';
import type { HudIO } from '../../src/cli/link-export.js';
import hudWake, {
  piWakeSocketPath,
  validWakeRequest,
  deliverPiWake,
  type PiWakeAPI,
} from '../../src/harness/pi/wake-extension.js';

const owner: NativeOwner = {
  harness: 'codex',
  sourceId: 'synthetic-source',
  sessionId: 'parent-a',
  threadId: 'parent-thread',
};
const message: HostMessage = {
  seq: 3,
  connectionId: 'connection-a',
  nativeRef: { harness: 'claude', sessionId: 'child-a' },
  event: { type: 'native_result', kind: 'result', payload: { secret: 'must-not-notify' } },
};

test('native wake forwards result/request pointers only and ignores ordinary events', () => {
  const details = nativeWakeDetails(message)!;
  assert.deepEqual(details, {
    connectionId: 'connection-a',
    nativeRef: message.nativeRef,
    eventSeq: 3,
    kind: 'result',
  });
  assert.doesNotMatch(nativeWakeMessage(details), /secret|success|ledger/);
  assert.equal(
    nativeWakeDetails({ ...message, event: { type: 'native_event', kind: 'agent_end', payload: {} } }),
    undefined
  );
  const request = nativeWakeDetails({
    ...message,
    event: undefined,
    request: { requestId: 'native-request', kind: 'permission', payload: { private: true } },
  })!;
  assert.equal(request.requestId, 'native-request');
  assert.doesNotMatch(JSON.stringify(request), /private|permission/);
});

test('native wake registration cannot target another parent or harness', () => {
  const home = '/tmp/synthetic-wake';
  assert.throws(() =>
    validateNativeWakeTarget(home, owner, {
      adapter: 'codex_queue',
      executable: '/bin/codex',
      codexHome: '/tmp/codex',
      threadId: 'other',
    })
  );
  assert.throws(() => validateNativeWakeTarget(home, owner, { adapter: 'claude_background_wait' }));
});

test('host wake transport failure never closes, retries or turns acceptance into read acknowledgement', async () => {
  let listener: ((m: HostMessage) => void) | undefined,
    calls = 0;
  const wake = attachNativeWake(
    '/tmp/synthetic-wake',
    {
      owner,
      subscribe(fn) {
        listener = fn;
        return () => {
          listener = undefined;
        };
      },
    },
    async () => {
      calls++;
      throw new Error('endpoint gone');
    }
  );
  wake.register({
    adapter: 'codex_queue',
    executable: '/bin/codex',
    codexHome: '/tmp/codex',
    threadId: 'parent-thread',
  });
  listener!(message);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(wake.status().last?.receipt.reason, 'endpoint gone');
  assert.equal(wake.status().modelReadAcknowledged, false);
  wake.close();
  assert.equal(listener, undefined);
});

test('Codex queue uses original thread/home and retains warning stdout/stderr and exit meaning', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hud-native-wake-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, 'codex');
  await writeFile(
    executable,
    '#!/bin/sh\nprintf "%s\\n" "$CODEX_HOME" "$1" "$2" "$3"\nprintf "warning: resume unavailable" >&2\n',
    { mode: 0o700 }
  );
  const receipt = await sendNativeWake(
    { adapter: 'codex_queue', executable, codexHome: root, threadId: 'parent-thread' },
    owner,
    nativeWakeDetails(message)!
  );
  assert.equal(receipt.result, 'accepted');
  assert.equal(receipt.code, 0);
  assert.equal(receipt.stderr, 'warning: resume unavailable');
  assert.equal(receipt.stdout, `${root}\nqueue\n--thread\nparent-thread\n`);
});

test('Claude native waiter observes native results, not ordinary events, with no control calls', async () => {
  const args = parseWait([
    '--native-owner',
    JSON.stringify({ ...owner, harness: 'claude', threadId: null }),
    '--connection',
    'connection-a',
    '--notify',
  ]);
  assert.ok('nativeOwner' in args);
  const output: string[] = [];
  const methods: string[] = [];
  let count = 0;
  await runNativeWait(
    args,
    '/tmp/synthetic-wake',
    {
      stdout: async (s) => {
        output.push(s);
      },
    } as HudIO,
    {
      async invoke(received, method, params) {
        assert.equal(received.sessionId, owner.sessionId);
        methods.push(method);
        count++;
        if (count === 1)
          return {
            events: [{ ...message, seq: 1, event: { type: 'native_event', kind: 'agent_end', payload: {} } }],
            throughSeq: 1,
            truncated: false,
          };
        assert.equal(params.afterSeq, 1);
        return { events: [message], throughSeq: 3, truncated: false };
      },
    }
  );
  assert.deepEqual(methods, ['wait', 'wait']);
  assert.match(output.join(''), /native result/);
  assert.doesNotMatch(output.join(''), /secret|ledger|succeeded/);
});

test('native waiter deadline is observation only', async () => {
  const output: string[] = [];
  await runNativeWait(
    { nativeOwner: owner, afterSeq: 0, timeoutMs: 0, json: true },
    '/tmp/synthetic-wake',
    {
      stdout: async (s) => {
        output.push(s);
      },
    } as HudIO,
    {
      async invoke(_owner, method) {
        assert.equal(method, 'wait');
        return { events: [], throughSeq: 0, truncated: false };
      },
    }
  );
  assert.equal(JSON.parse(output[0]).timedOut, true);
});

test('Pi loaded extension triggers followUp for exact current session, rejects a switched session', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hud-native-pi-'));
  const previous = process.env.HUD_HOME;
  process.env.HUD_HOME = root;
  const handlers = new Map<string, (event: unknown, ctx: any) => void | Promise<void>>();
  const delivered: unknown[] = [];
  hudWake({
    on(event, handler) {
      handlers.set(event, handler);
    },
    sendMessage(message, options) {
      delivered.push({ message, options });
    },
  } satisfies PiWakeAPI);
  const ctx = { sessionManager: { getSessionId: () => 'pi-parent' } };
  t.after(async () => {
    await handlers.get('session_shutdown')!(null, ctx);
    if (previous === undefined) delete process.env.HUD_HOME;
    else process.env.HUD_HOME = previous;
    await rm(root, { recursive: true, force: true });
  });
  try {
    await handlers.get('session_start')!(null, ctx);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      t.skip('Local Unix socket listen prohibited by execution environment');
      return;
    }
    throw error;
  }
  const details = nativeWakeDetails(message)!;
  assert.equal(
    validWakeRequest({
      parentSessionId: 'pi-parent',
      content: nativeWakeMessage(details),
      details,
      command: 'read native session',
    }),
    true
  );
  const target = { adapter: 'pi_extension' as const, socketPath: await piWakeSocketPath(root) };
  const piOwner = { ...owner, harness: 'pi' as const, sessionId: 'pi-parent', threadId: null };
  assert.equal((await sendNativeWake(target, piOwner, details)).result, 'accepted');
  assert.equal(delivered.length, 1);
  assert.deepEqual((delivered[0] as any).options, { triggerTurn: true, deliverAs: 'followUp' });
  ctx.sessionManager.getSessionId = () => 'pi-other';
  assert.equal((await sendNativeWake(target, piOwner, details)).reason, 'stale_session');
  assert.equal(delivered.length, 1);
});

test('Pi native API boundary uses triggerTurn/followUp and checks current session on every delivery', () => {
  const sent: unknown[] = [];
  const pi: PiWakeAPI = {
    on() {},
    sendMessage(message, options) {
      sent.push({ message, options });
    },
  };
  const details = nativeWakeDetails(message)!;
  const request = {
    parentSessionId: 'pi-parent',
    content: nativeWakeMessage(details),
    details,
    command: 'read native session' as const,
  };
  const ctx = { sessionManager: { getSessionId: () => 'pi-parent' } };
  assert.equal(deliverPiWake(pi, request, 'pi-parent', ctx).result, 'accepted');
  assert.deepEqual((sent[0] as any).options, { triggerTurn: true, deliverAs: 'followUp' });
  ctx.sessionManager.getSessionId = () => 'other-parent';
  assert.equal(deliverPiWake(pi, request, 'pi-parent', ctx).reason, 'stale_session');
  assert.equal(sent.length, 1);
  assert.equal(validWakeRequest({ ...request, details: { ...details, payload: 'not a pointer' } }), false);
  assert.equal(validWakeRequest({ ...request, command: 'read the ledger' }), false);
});
