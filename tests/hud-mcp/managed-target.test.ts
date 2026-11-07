import { test } from 'node:test';
import type { SDKResultSuccess } from '@anthropic-ai/claude-agent-sdk';
import assert from 'node:assert/strict';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { NativeManagedTools } from '../../packages/hud-mcp/src/managed-tools.js';
import type { CallResolution } from '../../packages/hud-mcp/src/resolvers.js';
import { NativeSessionHost, type HostMessage } from '../../src/managed/host.js';
import { RelationStore } from '../../src/managed/relations.js';
import type { NativeRef } from '../../src/managed/types.js';
import { createPiAdapterFactory } from '../../src/harness/pi/rpc-adapter.js';
import { ClaudeSdkAdapterFactory } from '../../src/harness/claude/sdk-adapter.js';
import { CLAUDE_NATIVE_ID, SyntheticClaudeQuery } from '../fixtures/native-managed-target/claude.js';
// The final test below preserves a historical, explicitly non-default service contract.
import { ledgerRuntimeSupported } from '../../src/ledger/runtime.js';
import { handshakeFixture, hashClaim } from '../unit/b45-handshake-fixture.js';
import { scopeSnapshot } from '../../src/ledger/call-context.js';
import { DelegationService } from '../../packages/hud-mcp/src/delegation.js';
import type { LaunchProfile } from '../../src/core/types/capabilities.js';
const supported = process.platform === 'linux' && ledgerRuntimeSupported();

async function until<T>(read: () => T | Promise<T>): Promise<NonNullable<T>> {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value as NonNullable<T>;
    await delay(5);
  }
  throw Error('native_target_deadline');
}
function source(sessionId = 'native-parent-a'): Extract<CallResolution, { ok: true }> {
  return {
    ok: true,
    callId: 'native-call',
    processKey: 'same-process',
    evidenceDigest: 'synthetic-evidence',
    sessionRef: { harness: 'codex', sourceId: 'same-source', sessionId, threadId: null },
  };
}
type Reply = { ok: boolean; code?: string; value: any };

for (const harness of ['pi', 'claude'] as const)
  test(
    `native ${harness} tools → host → official adapter: raw IO, callbacks, owner isolation and explicit resume`,
    { timeout: 15000 },
    async (t) => {
      // Always execute this in-process composition, including where Unix sockets are forbidden.
      // Only the public provider boundary is synthetic; tools, host, relations and adapters are real.
      const root = mkdtempSync(join(tmpdir(), `hud-native-${harness}-`));
      const home = join(root, 'hud-home');
      const userHome = join(root, 'user-home');
      mkdirSync(userHome);
      const executable = join(root, harness);
      if (harness === 'pi') copyFileSync(resolve('tests/fixtures/native-managed-target/pi.mjs'), executable);
      else writeFileSync(executable, '#!/bin/sh\nexit 99\n'); // Public SDK Query is injected, never a live provider.
      chmodSync(executable, 0o700);
      const queries: SyntheticClaudeQuery[] = [];
      const historyReads: { id: string; options: unknown }[] = [];
      const history = [
        {
          type: 'user',
          uuid: 'native-history-1',
          session_id: CLAUDE_NATIVE_ID,
          parent_tool_use_id: null,
          message: { role: 'user', content: 'synthetic history' },
        },
      ];
      const factory =
        harness === 'pi'
          ? createPiAdapterFactory({
              cliPath: executable,
              env: { HOME: userHome, HUD_HOME: home, SYNTHETIC_NATIVE_ROOT: root },
            })
          : new ClaudeSdkAdapterFactory({
              sdkOptions: { pathToClaudeCodeExecutable: executable, env: { HOME: userHome, HUD_HOME: home } },
              queryFactory(input) {
                const query = new SyntheticClaudeQuery(input);
                queries.push(query);
                return query;
              },
              async getSessionMessages(id, options) {
                historyReads.push({ id, options });
                return history as never;
              },
            });
      const relations = new RelationStore(home);
      const owner = source();
      let host = new NativeSessionHost(owner.sessionRef, [{ id: harness, factory }], relations);
      let tools = new NativeManagedTools(host);
      const events: HostMessage[] = [];
      host.subscribe((event) => events.push(event));
      let call = 0;
      const invoke = async (
        name: string,
        args: Record<string, unknown> = {},
        signal = new AbortController().signal
      ) => {
        const reply = (await tools.invoke({ ...owner, callId: `native-call-${++call}` }, name, args, signal)) as Reply;
        assert.equal(reply.ok, true, JSON.stringify(reply));
        return reply.value;
      };
      const wire = () =>
        readFileSync(join(root, 'pi-wire.jsonl'), 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
      const stops = () =>
        harness === 'pi'
          ? {
              interrupts: wire().filter((r) => r.type === 'abort').length,
              closes: wire().filter((r) => r.type === 'stdin_eof').length,
            }
          : {
              interrupts: queries.reduce((n, q) => n + q.interrupts, 0),
              closes: queries.reduce((n, q) => n + q.closes, 0),
            };
      try {
        const created = await invoke('managed_create', { profileId: harness, workspace: root });
        const target = { connectionId: created.connectionId };
        const nativeRef = (await until(
          async () => (await invoke('managed_list')).connections[0]?.nativeRef
        )) as NativeRef;
        assert.equal(nativeRef.harness, harness);
        assert.equal(relations.list(owner.sessionRef).length, 1);
        if (harness === 'claude') {
          assert.equal(queries[0].options.pathToClaudeCodeExecutable, executable);
          assert.equal(queries[0].options.resume, undefined);
          assert.equal(queries[0].inputs.length, 0, 'creation must not submit probe input');
        } else assert.equal(wire().filter((r) => r.type === 'prompt').length, 0);

        const sent = await invoke('managed_send', { ...target, text: 'synthetic input' });
        let callback: Promise<unknown> | undefined;
        if (harness === 'claude') {
          await until(() => queries[0].inputs.length === 1);
          assert.equal(queries[0].inputs[0].message.content, 'synthetic input');
          assert.equal(sent.correlation.userMessageUuid, queries[0].inputs[0].uuid);
          callback = queries[0].requestPermission();
        } else assert.deepEqual(sent.payload.data, { nativeReceipt: { accepted: true } });
        const requests = await until(async () => {
          const requests = await invoke('managed_requests', target);
          return requests.length ? requests : undefined;
        });
        const request = requests[0];
        assert.equal(request.requestId, harness === 'pi' ? 'native-ui-1' : 'native-permission-1');
        if (harness === 'pi') assert.deepEqual(request.payload.future_native_field, { retained: true });
        else
          assert.deepEqual(request.payload, {
            toolName: 'Read',
            input: { file_path: 'synthetic.txt' },
            options: { requestId: 'native-permission-1', toolUseID: 'native-tool-1' },
          });

        // A second native source sharing this process/config cannot operate on the first source's child.
        for (const name of [
          'managed_send',
          'managed_read',
          'managed_requests',
          'managed_respond',
          'managed_cancel',
          'managed_close',
        ]) {
          const denied = (await tools.invoke(
            source('native-parent-b'),
            name,
            { ...target, text: 'must not send', requestId: request.requestId, result: { confirmed: false } },
            new AbortController().signal
          )) as Reply;
          assert.equal(denied.ok, false);
          assert.equal(denied.code, 'native_owner_mismatch');
        }
        const answer =
          harness === 'pi'
            ? { confirmed: true, future_native_field: ['retained'] }
            : { behavior: 'allow', updatedInput: { file_path: 'synthetic.txt' } };
        assert.deepEqual(await invoke('managed_respond', { ...target, requestId: request.requestId, result: answer }), {
          forwarded: true,
          requestId: request.requestId,
          nativeAcknowledged: false,
        });
        if (callback) {
          assert.deepEqual(await callback, answer);
          const rawResult = {
            type: 'result',
            subtype: 'success',
            session_id: CLAUDE_NATIVE_ID,
            uuid: '33333333-3333-4333-8333-333333333333',
            user_message_uuid: queries[0].inputs[0].uuid,
            result: 'Synthetic native answer',
            is_error: false,
            num_turns: 1,
            duration_ms: 1,
            duration_api_ms: 1,
            total_cost_usd: 0,
            stop_reason: 'end_turn',
            usage: {
              input_tokens: 1,
              output_tokens: 1,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
              cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
              fallback_credit: null,
              inference_geo: 'not_applicable',
              iterations: [],
              output_tokens_details: { thinking_tokens: 0 },
              server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
              service_tier: 'standard',
              speed: 'standard',
            },
            modelUsage: {},
            permission_denials: [],
            future_native_field: { retained: true },
          } satisfies SDKResultSuccess & { future_native_field: unknown };
          queries[0].emit(rawResult);
          const result = await until(() => events.find((e) => e.event?.type === 'native_result'));
          assert.deepEqual((result.event as any).payload, rawResult);
          assert.equal((result.event as any).correlation.userMessageUuid, sent.correlation.userMessageUuid);
        } else {
          await until(() => events.some((e) => e.event?.type === 'native_result'));
          assert.deepEqual(
            wire().find((r) => r.type === 'extension_ui_response'),
            { ...answer, type: 'extension_ui_response', id: request.requestId }
          );
          const ended = events.find((e) => e.event?.type === 'native_event' && e.event.kind === 'pi.agent_end')!;
          assert.equal(ended.event?.type, 'native_event', 'agent_end is not settled');
          const settled = events.find((e) => e.event?.type === 'native_result')!;
          assert.equal(settled.event?.type === 'native_result' && settled.event.kind, 'pi.agent_settled');
          assert.deepEqual(
            (settled.event as any).payload.nativeAnswer,
            wire().find((r) => r.type === 'extension_ui_response')
          );
        }
        assert.deepEqual(await invoke('managed_requests', target), []);
        const stale = (await tools.invoke(
          owner,
          'managed_respond',
          { ...target, requestId: request.requestId, result: answer },
          new AbortController().signal
        )) as Reply;
        assert.equal(stale.code, 'native_request_not_pending');

        if (harness === 'pi') {
          const raw = await invoke('managed_read', { nativeRef });
          assert.deepEqual(raw.data.future_native_field, { retained: true });
          const entries = await invoke('managed_read', { nativeRef, options: { method: 'get_entries' } });
          assert.deepEqual(entries.data.entries, [
            { id: 'entry-1', type: 'message', message: { role: 'user', content: 'synthetic input' } },
          ]);
        } else {
          assert.deepEqual(await invoke('managed_read', { nativeRef }), queries[0].initialization);
          assert.deepEqual(
            await invoke('managed_read', { nativeRef, options: { method: 'getSessionMessages' } }),
            history
          );
          assert.equal(historyReads[0].id, CLAUDE_NATIVE_ID);
        }

        const page = await invoke('managed_wait', { ...target, waitMs: 0 });
        const controller = new AbortController();
        const waiting = invoke(
          'managed_wait',
          { ...target, afterSeq: page.throughSeq, waitMs: 10000 },
          controller.signal
        );
        controller.abort();
        assert.deepEqual((await waiting).events, []);
        const timeout = await invoke('managed_wait', { ...target, afterSeq: page.throughSeq, waitMs: 5 });
        assert.deepEqual(timeout.events, []);
        assert.deepEqual(stops(), { interrupts: 0, closes: 0 }, 'cancelled/expired observer must not stop native work');
        await invoke('managed_read', target);
        await invoke('managed_cancel', target);
        assert.deepEqual(stops(), { interrupts: 1, closes: 0 });
        await invoke('managed_close', target);
        await until(() => stops().closes === 1);

        // Recreate the host from only direct relations, then explicitly resume the official ID.
        host = new NativeSessionHost(owner.sessionRef, [{ id: harness, factory }], new RelationStore(home));
        tools = new NativeManagedTools(host);
        const foreign = new NativeManagedTools(
          new NativeSessionHost(
            source('native-parent-b').sessionRef,
            [{ id: harness, factory }],
            new RelationStore(home)
          )
        );
        const foreignResume = (await foreign.invoke(
          source('native-parent-b'),
          'managed_create',
          { profileId: harness, workspace: root, origin: { kind: 'resume', source: nativeRef } },
          new AbortController().signal
        )) as Reply;
        assert.equal(foreignResume.code, 'native_relation_not_owned');
        const resumed = await invoke('managed_create', {
          profileId: harness,
          workspace: root,
          origin: { kind: 'resume', source: { harness, sessionId: (nativeRef as { sessionId: string }).sessionId } },
        });
        await until(async () => (await invoke('managed_list')).connections[0]?.nativeRef);
        const listed = await invoke('managed_list');
        assert.deepEqual(listed.connections[0].nativeRef, nativeRef);
        assert.notEqual(resumed.connectionId, created.connectionId);
        if (harness === 'pi') {
          assert.equal(wire().filter((r) => r.type === 'switch_session').length, 1);
          assert.equal(wire().find((r) => r.type === 'switch_session').sessionPath, (nativeRef as any).sessionFile);
          assert.equal(wire().filter((r) => r.type === 'prompt').length, 1, 'resume never replays input');
          assert.equal(
            (await invoke('managed_read', { nativeRef, options: { method: 'get_entries' } })).data.entries[0].id,
            'entry-1'
          );
          await invoke('managed_send', { nativeRef, text: 'explicit next input' });
          await until(async () => (await invoke('managed_requests', { nativeRef })).length === 1);
          await invoke('managed_respond', { nativeRef, requestId: 'native-ui-1', result: { confirmed: true } });
          assert.deepEqual(
            wire()
              .filter((r) => r.type === 'prompt')
              .map((r) => r.message),
            ['synthetic input', 'explicit next input']
          );
        } else {
          assert.equal(queries.length, 2);
          assert.equal(queries[1].options.resume, CLAUDE_NATIVE_ID);
          assert.equal(queries[1].options.forkSession, undefined);
          assert.equal(queries[1].inputs.length, 0, 'resume never replays input');
          await invoke('managed_send', { nativeRef, text: 'explicit next input' });
          await until(() => queries[1].inputs.length === 1);
          assert.equal(queries[1].inputs[0].session_id, CLAUDE_NATIVE_ID);
        }
        await invoke('managed_close', { nativeRef });
        await until(() => stops().closes === 2);
        assert.deepEqual(readdirSync(home), ['native-relations'], 'no runs, reports, claims, or operation database');
        for (const relation of relations.list())
          assert.deepEqual(
            Object.keys(relation).sort(),
            ['owner', 'callId', 'child', 'workspace', 'profileId', 'createdAt'].sort()
          );
        t.diagnostic(
          'Synthetic public protocol/SDK integration only; not a real provider or detached-process survival claim.'
        );
      } finally {
        const listed = host.list() as { connections: { connectionId: string }[] };
        for (const connection of listed.connections) await host.close(connection);
        if (harness === 'pi' && listed.connections.length)
          await until(
            () =>
              wire().filter((r) => r.type === 'stdin_eof').length ===
              wire().filter((r) => r.type === 'get_state' && r.id === 'hud-1').length
          );
        rmSync(root, { recursive: true, force: true });
      }
    }
  );

test(
  'historical DelegationService Claude target retains its partial-coverage gate (not the default native path)',
  { skip: !supported },
  async () => {
    const f = await handshakeFixture();
    const root = join(f.root, 'claude-source');
    mkdirSync(root);
    writeFileSync(
      join(root, '.claude.json'),
      JSON.stringify({
        mcpServers: {
          hud: {
            command: process.execPath,
            args: [resolve('packages/hud-mcp/bin/hud-mcp.mjs')],
            env: { SYNTHETIC_KEEP: 'preserved' },
          },
        },
      })
    );
    const brief = join(f.root, 'brief.md');
    writeFileSync(brief, 'Synthetic Claude task');
    const profile: LaunchProfile = {
      name: 'claude-target',
      harness: 'claude',
      source: { root, label: 'Synthetic Claude' },
      launch: { argv: [process.execPath] },
      headless: { argv: [process.execPath, '-p', '--output-format', 'stream-json', '--verbose'] },
      resume: null,
      resumeHeadless: {
        argv: [process.execPath, '-p', '--output-format', 'stream-json', '--verbose', '--resume', '{{sessionId}}'],
      },
      host: { kind: 'none', layout: 'none' },
      env: {},
      mcpServerName: 'hud',
      claimTransport: 'config_env',
      clientToolTimeoutMs: null,
      responseMarginMs: 1000,
      orphan_policy: 'continue',
      managedShellVerified: false,
      callSource: { kind: 'claude_pre_tool_use_v1' },
      roles: { worker: { model: 'synthetic-model' } },
    };
    let launches = 0,
      checked = false;
    const service = new DelegationService({
      ledger: f.ledger,
      home: f.root,
      config: { version: 1, profiles: [profile] },
      registration: f.parent.registration,
      reader: f.reader,
      env: { HOME: f.root, PATH: process.env.PATH },
      executableIdentity: { path: process.execPath, version: '2.1.305' },
      hudRunPath: resolve('bin/hud-run'),
      capability: {
        verify(request) {
          checked = true;
          assert.equal(request.key.harness, 'claude');
          assert.equal(request.configurationCoverage, 'partial');
          return { ok: false, reason: 'capability_unverified' };
        },
      },
      launch: async () => {
        launches++;
        throw Error('must_not_launch');
      },
    });
    try {
      const source = {
        ok: true as const,
        callId: 'claude-capability',
        sessionRef: f.parent.ref,
        processKey: f.parent.authority.evidence.processKey,
        evidenceDigest: hashClaim('synthetic'),
        scopePremise: f.ledger.snapshot((tx) =>
          scopeSnapshot(tx, f.ledger.ledgerId, f.parent.authority.evidence.processKey)
        ),
      };
      await assert.rejects(
        service.invoke(source, 'delegate_spawn', {
          backend: profile.name,
          role: 'worker',
          brief,
          cwd: f.root,
          mode: 'headless',
          request_key: 'claude-refused',
        }),
        /capability_unverified/
      );
      assert.equal(checked, true);
      assert.equal(launches, 0);
      assert.equal(
        f.ledger.snapshot((tx) => tx.get("SELECT count(*) AS n FROM runs WHERE harness='claude'")?.n),
        0
      );
    } finally {
      await service.close();
      await f.close();
    }
  }
);
