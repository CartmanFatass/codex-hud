import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createPiAdapterFactory } from '../../src/harness/pi/rpc-adapter.js';
import {
  NativePiRpcClient,
  type PiRpcRecord,
  type PiTransportEvent,
} from '../../src/harness/pi/native-rpc-transport.js';
import type { AdapterEvent } from '../../src/managed/types.js';

function peer(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), 'hud-pi-jsonl-'));
  const executable = join(home, 'pi');
  const log = join(home, 'commands.jsonl');
  const argv = join(home, 'argv.json');
  const envlog = join(home, 'env.json');
  writeFileSync(
    executable,
    `#!${process.execPath}
import { appendFileSync, writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(argv)}, JSON.stringify(process.argv.slice(2)));
writeFileSync(${JSON.stringify(envlog)}, JSON.stringify({HOME:process.env.HOME, HUD_CUSTOM:process.env.HUD_CUSTOM, HUD_RUN:process.env.HUD_RUN}));
let buffer = '';
let sessionId = 'synthetic-new';
let sessionFile = ${JSON.stringify(join(home, 'new.jsonl'))};
const write = (record) => process.stdout.write(JSON.stringify(record) + '\\n');
write({type:'synthetic_ready'});
process.stdin.setEncoding('utf8');
process.stdin.on('end', () => process.exit(0));
process.stdin.on('data', chunk => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf('\\n')) !== -1) {
    const command = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    appendFileSync(${JSON.stringify(log)}, JSON.stringify(command) + '\\n');
    const response = {type:'response', command:command.type, id:command.id, success:true};
    if (command.type === 'get_state') write({...response, data:{sessionId,sessionFile,isStreaming:false,isCompacting:false,pendingMessageCount:0, nativeExtra:'unchanged'}});
    else if (command.type === 'get_entries') write({...response,data:{entries:[{id:'native-entry-2',type:'message'}],leafId:'native-entry-2'}});
    else if (command.type === 'switch_session') { sessionId='synthetic-source'; sessionFile=command.sessionPath; write({...response,data:{cancelled:false}}); }
    else if (command.type === 'clone') {sessionId='synthetic-clone';write({...response,data:{cancelled:false}});}
    else if (command.type === 'prompt') {
      if (command.message === 'reject') write({...response,success:false,error:'Native rejection',nativeDiagnostic:123});
      else if (command.message === 'delayed') setTimeout(() => write({...response,data:{disposition:'started'}}), 120);
      else {
        write({...response,data:{disposition:'started'}});
        write({type:'extension_ui_request',id:'native-dialog',method:'confirm',title:'Synthetic'});
      }
    } else if (command.type === 'extension_ui_response') {
      write({type:'agent_end',messages:[],willRetry:false});
      write({type:'agent_settled',aborted:false,confirmed:command.confirmed});
    } else if (command.type === 'stdout_end') { write(response); process.stdout.end(); }
    else write(response);
  }
});
`,
    { mode: 0o700 }
  );
  chmodSync(executable, 0o700);
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return {
    home,
    executable,
    log,
    argv,
    envlog,
    env: { HOME: home, HUD_HOME: join(home, 'hud'), PATH: home, HUD_CUSTOM: 'keep', HUD_RUN: 'parent-must-not-leak' },
    commands: () =>
      readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as PiRpcRecord),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

test(
  'Installed executable via PATH gets --mode rpc and original-ID UI response, state, history and resume',
  { timeout: 10000 },
  async (t) => {
    const f = peer(t);
    const events: AdapterEvent[] = [];
    const settled = deferred<AdapterEvent>();
    const exited = deferred<AdapterEvent>();
    const session = await createPiAdapterFactory({ env: f.env, commandTimeoutMs: 1000 }).create(
      {
        workspace: f.home,
        origin: {
          kind: 'resume',
          source: { harness: 'pi', sessionId: 'synthetic-source', sessionFile: join(f.home, 'source.jsonl') },
        },
      },
      {
        event(event) {
          events.push(event);
          if (event.type === 'native_result') settled.resolve(event);
          if (event.type === 'process_exit') exited.resolve(event);
        },
        async request(request) {
          assert.equal(request.requestId, 'native-dialog');
          return { result: { type: 'untrusted-type', id: 'untrusted-id', confirmed: false } };
        },
      }
    );
    t.after(async () => {
      await session.close();
      await exited.promise;
    });
    assert.deepEqual(JSON.parse(readFileSync(f.argv, 'utf8')), ['--mode', 'rpc']);
    assert.deepEqual(JSON.parse(readFileSync(f.envlog, 'utf8')), { HOME: f.home, HUD_CUSTOM: 'keep' });
    assert.equal((session.snapshot().nativeRef as { sessionId: string }).sessionId, 'synthetic-source');
    const receipt = await session.send({ callId: 'native-call', text: 'Synthetic prompt' });
    assert.deepEqual((receipt.payload as PiRpcRecord).data, { disposition: 'started' });
    const result = await settled.promise;
    assert.deepEqual(result, {
      type: 'native_result',
      kind: 'pi.agent_settled',
      payload: { type: 'agent_settled', aborted: false, confirmed: false },
    });
    assert.equal(events.filter((event) => event.type === 'native_result').length, 1);
    const history = (await session.read({ method: 'get_entries', since: 'native-entry-1' })) as PiRpcRecord;
    assert.deepEqual(history.data, { entries: [{ id: 'native-entry-2', type: 'message' }], leafId: 'native-entry-2' });
    const commands = f.commands();
    assert.deepEqual(
      commands.find((command) => command.type === 'extension_ui_response'),
      { type: 'extension_ui_response', id: 'native-dialog', confirmed: false }
    );
    assert.equal(commands.find((command) => command.type === 'get_entries')?.since, 'native-entry-1');
    assert.equal(
      commands.some((command) => command.type === 'abort'),
      false
    );
  }
);

test('Native rejection is returned intact and does not disconnect or resubmit', { timeout: 10000 }, async (t) => {
  const f = peer(t);
  const exited = deferred<AdapterEvent>();
  const session = await createPiAdapterFactory({ env: f.env }).create(
    { workspace: f.home, origin: { kind: 'new' } },
    {
      event: (event) => {
        if (event.type === 'process_exit') exited.resolve(event);
      },
      request: async () => ({ result: {} }),
    }
  );
  t.after(async () => {
    await session.close();
    await exited.promise;
  });
  const response = (await session.send({ callId: 'reject', text: 'reject' })).payload as PiRpcRecord;
  assert.equal(response.success, false);
  assert.equal(response.error, 'Native rejection');
  assert.equal(response.nativeDiagnostic, 123);
  assert.equal(((await session.read()) as PiRpcRecord).success, true);
  assert.equal(f.commands().filter((command) => command.type === 'prompt').length, 1);
});

test(
  'RPC wait timeout neither kills Pi nor loses late response or later state reads',
  { timeout: 10000 },
  async (t) => {
    const f = peer(t);
    const client = new NativePiRpcClient({ cliPath: f.executable, cwd: f.home, env: f.env, commandTimeoutMs: 40 });
    const events: PiTransportEvent[] = [];
    const ready = deferred<PiRpcRecord>();
    const late = deferred<PiRpcRecord>();
    const exited = deferred<PiTransportEvent>();
    client.onEvent((event) => {
      events.push(event);
      if (event.type === 'record' && event.record.type === 'synthetic_ready') ready.resolve(event.record);
      if (event.type === 'record' && event.record.command === 'prompt') late.resolve(event.record);
      if (event.type === 'process_exit') exited.resolve(event);
    });
    await client.start();
    t.after(async () => {
      await client.close();
      await exited.promise;
    });
    // Wait for process startup independently; prompt delay then exceeds only its command wait.
    await ready.promise;
    await client.request('get_state');
    await assert.rejects(client.request('prompt', { message: 'delayed' }), /pi_rpc_wait_timeout: prompt/);
    const response = await late.promise;
    assert.deepEqual(response.data, { disposition: 'started' });
    assert.equal(
      events.some((event) => event.type === 'disconnected'),
      false
    );
    assert.equal((await client.request('get_state')).success, true);
    assert.equal(f.commands().filter((command) => command.type === 'prompt').length, 1);
  }
);

test(
  'stdout EOF is observable separately from an actual process exit, with no implicit kill',
  { timeout: 10000 },
  async (t) => {
    const f = peer(t);
    const client = new NativePiRpcClient({ cliPath: f.executable, cwd: f.home, env: f.env });
    const events: PiTransportEvent[] = [];
    const disconnected = deferred<PiTransportEvent>();
    const exited = deferred<PiTransportEvent>();
    client.onEvent((event) => {
      events.push(event);
      if (event.type === 'disconnected') disconnected.resolve(event);
      if (event.type === 'process_exit') exited.resolve(event);
    });
    await client.start();
    t.after(async () => {
      await client.close();
      await exited.promise;
    });
    await client.request('stdout_end');
    assert.deepEqual(await disconnected.promise, { type: 'disconnected', reason: 'pi_stdout_eof' });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(
      events.some((event) => event.type === 'process_exit'),
      false
    );
    await client.close();
    assert.deepEqual(await exited.promise, { type: 'process_exit', code: 0, signal: null });
  }
);
