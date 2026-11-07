import { validateNativeSourceConfig } from '../../packages/hud-mcp/src/config.js';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeManagedTools, MANAGED_TOOLS, nativeManagedPrincipal } from '../../packages/hud-mcp/src/managed-tools.js';
import { HudMcpServer } from '../../packages/hud-mcp/src/server.js';
import { validateToolArguments } from '../../packages/hud-mcp/src/tools.js';
import type { CallResolution } from '../../packages/hud-mcp/src/resolvers.js';
function resolution(id: string): Extract<CallResolution, { ok: true }> {
  return {
    ok: true,
    callId: 'native-call',
    processKey: 'same-process',
    evidenceDigest: 'evidence',
    sessionRef: { harness: 'codex', sourceId: 'source', sessionId: id, threadId: null },
  };
}
test('native principal isolates sessions even on identical process and source', () => {
  assert.notEqual(nativeManagedPrincipal(resolution('a')), nativeManagedPrincipal(resolution('b')));
});
test('native tools have no model owner, operation, grant, task or report arguments', () => {
  for (const t of MANAGED_TOOLS) {
    const properties = t.inputSchema.properties as any;
    for (const forbidden of ['owner', 'principalId', 'operationId', 'grantId', 'report', 'task'])
      assert.equal(properties[forbidden], undefined);
    assert.equal(validateToolArguments(t, { owner: 'someone' }), false);
  }
});
test('source resolved every call; only trusted native owner and call ID reach host', async () => {
  const calls: any[] = [];
  let resolves = 0;
  const extension = new NativeManagedTools({
    async invoke(owner, method, args) {
      calls.push({ owner, method, args });
      return { native: true };
    },
  });
  const server = new HudMcpServer(
    {
      async resolve() {
        return resolution(++resolves === 1 ? 'a' : 'b');
      },
    },
    undefined,
    undefined,
    undefined,
    extension
  );
  for (let id = 1; id <= 2; id++)
    await server.handle({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: 'managed_send', arguments: { connectionId: 'child', text: 'hello' } },
    });
  assert.equal(calls[0].owner.sessionId, 'a');
  assert.equal(calls[1].owner.sessionId, 'b');
  assert.equal(calls[0].args.callId, 'native-call');
});
test('default thin server advertises only native tools, never old delegation workflow', async () => {
  const server = new HudMcpServer(
    {
      async resolve() {
        return resolution('a');
      },
    },
    undefined,
    undefined,
    undefined,
    new NativeManagedTools({ async invoke() {} })
  );
  const list = (await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })) as any;
  assert.equal(list.result.tools.length, MANAGED_TOOLS.length);
  assert.ok(list.result.tools.every((t: any) => t.name.startsWith('managed_')));
});
test('missing native identity blocks calls without starting host', async () => {
  let invoked = false;
  const server = new HudMcpServer(
    {
      async resolve() {
        return { ok: false, code: 'identity_source_missing' };
      },
    },
    undefined,
    undefined,
    undefined,
    new NativeManagedTools({
      async invoke() {
        invoked = true;
      },
    })
  );
  const reply = (await server.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'managed_list', arguments: {} },
  })) as any;
  assert.equal(invoked, false);
  assert.equal(reply.result.structuredContent.code, 'identity_source_missing');
});
test('native response JSON stays unchanged and advertised validator accepts nested values', async () => {
  const definition = MANAGED_TOOLS.find((t) => t.name === 'managed_respond')!;
  const args = { connectionId: 'c', requestId: 'native-r', result: { opaque: [null, true, { newField: 7 }] } };
  assert.equal(validateToolArguments(definition, args), true);
  let forwarded: any;
  const tools = new NativeManagedTools({
    async invoke(_owner, _method, input) {
      forwarded = input.result;
      return { forwarded: true };
    },
  });
  await tools.invoke(resolution('a'), 'managed_respond', args, new AbortController().signal);
  assert.deepEqual(forwarded, args.result);
});
test('native ask is one send then observation, without synthetic operation status', async () => {
  const methods: string[] = [];
  const tools = new NativeManagedTools({
    async invoke(_owner, method) {
      methods.push(method);
      return method === 'wait' ? { throughSeq: 8, events: [] } : { payload: { native: true } };
    },
  });
  const output = (await tools.invoke(
    resolution('a'),
    'managed_ask',
    { connectionId: 'c', text: 'hello' },
    new AbortController().signal
  )) as any;
  assert.deepEqual(methods, ['wait', 'send', 'wait']);
  assert.equal(output.value.receipt.payload.native, true);
});

test('source configuration accepts minimal native fields and never applies old retirement or claim policy', () => {
  const config = validateNativeSourceConfig({
    version: 1,
    profiles: [
      {
        name: 'native',
        harness: 'codex',
        source: { root: tmpdir() },
        retire: { maxRunMs: 0 },
        claimTransport: 'unused',
        clientToolTimeoutMs: 'unused',
      },
    ],
  });
  const profile = config.profiles[0];
  assert.equal(profile.name, 'native');
  assert.deepEqual(profile.launch, { argv: ['codex'] });
  assert.equal(profile.mcpServerName, 'hud');
  assert.equal(profile.source.label, 'native');
});

test('installed delegation skill examples match the native tool schemas and current waiter interface', async () => {
  const { readFileSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  const { JEV_TOOLS } = await import('../../packages/hud-mcp/src/jev-tools.js');
  const skill = readFileSync(resolve('integrations/skills/hud-delegate/SKILL.md'), 'utf8');
  const definitions = [...MANAGED_TOOLS, ...JEV_TOOLS];
  const names = new Set(definitions.map((tool) => tool.name));
  for (const match of skill.matchAll(/\b(?:managed|jev)_[a-z]+\b/g))
    assert.ok(names.has(match[0]), `documented tool ${match[0]} exists`);
  let examples = 0;
  for (const match of skill.matchAll(/```json\s*([\s\S]*?)```/g)) {
    const example = JSON.parse(match[1]) as { tool: string; arguments: unknown };
    const definition = definitions.find((tool) => tool.name === example.tool);
    assert.ok(definition, `example tool ${example.tool} exists`);
    assert.equal(validateToolArguments(definition, example.arguments), true, example.tool);
    examples++;
  }
  assert.ok(examples >= 3);
  assert.match(skill, /backgroundWaiter\.argv/);
  assert.match(skill, /--native-owner/);
  assert.match(skill, /--after-seq/);
  assert.match(skill, /truncated:true/);
  assert.match(skill, /nativeAcknowledged:false/);
  assert.doesNotMatch(
    skill,
    /delegate_spawn|delegate_wait|delegate_report|delegate_resume|delegate_close|request_key|owner-generation/
  );
});
