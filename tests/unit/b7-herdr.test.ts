import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { HerdrClient } from '../../src/integrations/herdr/client.js';
import { HerdrHost } from '../../src/integrations/herdr/host.js';
import { HerdrRegistry } from '../../src/integrations/herdr/registry.js';
import { HerdrRunControl } from '../../src/integrations/herdr/run-control.js';
import type { HerdrTransport, ObjectValue } from '../../src/integrations/herdr/transport.js';
import type { ProcRecord } from '../../src/core/run/process.js';
import { readProcess } from '../../src/core/run/process.js';
import type { RunControl } from '../../src/core/interfaces/run-control.js';
import type { LifecycleStatus } from '../../src/core/types/lifecycle.js';

const schema = JSON.parse(readFileSync('tests/herdr/fixtures/schema.json', 'utf8'));
class Transport implements HerdrTransport {
  commands: string[][] = [];
  methods: string[] = [];
  version = 'herdr 0.9.5';
  schema = structuredClone(schema);
  server: string | null = 'synthetic-server-instance';
  failed = false;
  promptFailure = false;
  onCommand?: (args: readonly string[]) => void;
  pane: ObjectValue = {
    pane_id: 'w1:p2',
    workspace_id: 'w1',
    tab_id: 'w1:t2',
    terminal_id: 'synthetic-terminal',
    agent: null,
    agent_status: 'unknown',
  };
  async command(args: readonly string[]) {
    this.commands.push([...args]);
    this.onCommand?.(args);
    if (this.failed || (this.promptFailure && args[1] === 'prompt')) throw new Error('transport gone');
    if (args[0] === '--version') return this.version;
    if (args[0] === 'api') return this.schema;
    return { result: { root_pane: this.pane, pane: this.pane } };
  }
  async instance() {
    return this.server;
  }
  async request(method: string) {
    this.methods.push(method);
    if (this.failed) throw new Error('server gone');
    if (method === 'ping') return { version: '0.9.5', protocol: 22 };
    if (method === 'pane.get') return { pane: this.pane };
    if (method === 'pane.process_info')
      return { process_info: { pane_id: 'w1:p2', shell_pid: 100, foreground_process_group_id: 100 } };
    if (method === 'pane.layout') return { layout: { panes: [{}, {}] } };
    return { snapshot: { panes: [this.pane] } };
  }
}
const proc: ProcRecord = {
  stamp: { pid: 100, proc_start: '10', boot_id: 'synthetic-boot', pid_domain: 'synthetic-domain' },
  state: 'S',
  flags: 0,
  pgid: 100,
  sid: 100,
  ppid: 1,
  tty: 10,
  foregroundPgid: 100,
};
function setup(timeout = 100, knownAgent = false, liveSupervisor = false) {
  const record = liveSupervisor ? { ...proc, stamp: readProcess(process.pid)!.stamp } : proc;
  const transport = new Transport();
  const diagnostics: string[] = [];
  const client = new HerdrClient(transport, { HERDR_ENV: '1' }, (code) => diagnostics.push(code));
  const registry = new HerdrRegistry(
    client,
    async (observation) =>
      knownAgent && observation.pane.agent === 'codex'
        ? {
            sessionRef: {
              harness: 'codex',
              sourceId: 'synthetic-source',
              sessionId: 'synthetic-session',
              threadId: null,
            },
            harness: record.stamp,
          }
        : null,
    () => structuredClone(record)
  );
  const host = new HerdrHost(client, registry, { workspace: 'w1', pane: 'w1:p1' }, timeout);
  return { transport, client, registry, host, diagnostics };
}
const options = {
  cwd: '/synthetic/work',
  env: { HUD_HOME: '/synthetic/hud', HUD_CLAIM: 'synthetic-claim' },
  managed: { runId: 'synthetic-run', bindingGeneration: 9 },
};

test('B7 schema mismatch, missing CLI, disabled integration degrade without mutations', async () => {
  for (const mode of ['schema', 'version', 'missing', 'server'] as const) {
    const f = setup();
    if (mode === 'schema') f.transport.schema.protocol++;
    if (mode === 'version') f.transport.version = 'herdr 0.9.6';
    if (mode === 'missing') f.transport.failed = true;
    if (mode === 'server') f.transport.server = null;
    const result = await f.client.preflight();
    assert.equal(result.ready, false);
    assert.equal(result.fallbackAllowed, true);
    assert.ok(f.diagnostics.length);
    await assert.rejects(f.host.openSurface('tab', options), (error: any) => error.fallbackAllowed === true);
    assert.deepEqual(await f.registry.list(), []);
    assert.ok(f.transport.commands.every((args) => args[0] === 'api' || args[0] === '--version'));
  }
  const t = new Transport();
  const disabled = new HerdrClient(t, { HERDR_ENV: '1', HUD_HERDR: '0' });
  assert.equal((await disabled.preflight()).ready, false);
  assert.deepEqual(await new HerdrRegistry(disabled).list(), []);
  assert.equal(t.commands.length, 0);
  assert.equal(t.methods.length, 0);
});

test('B7 one shared single-flight preflight cache and bounded recovery', async () => {
  const f = setup();
  await Promise.all(Array.from({ length: 20 }, () => f.client.preflight()));
  assert.equal(f.transport.commands.length, 2);
  f.transport.server = 'replacement-server';
  await assert.rejects(f.client.require(), /instance_changed/);
  assert.ok(f.diagnostics.includes('herdr_instance_changed'));
});

test('B7 readiness timeout after creation never enables fallback or another creation', async () => {
  const f = setup(35);
  f.transport.pane.agent = 'synthetic';
  await assert.rejects(
    f.host.openSurface('tab', options),
    (e: any) => e.code === 'herdr_readiness_timeout' && !e.fallbackAllowed
  );
  assert.equal(f.transport.commands.filter((args) => args[1] === 'create').length, 1);
});

test('B7 --env injection, protected argv and unknown launch prohibit resubmission', async () => {
  const f = setup();
  const locator = await f.host.openSurface('tab', options);
  const creation = f.transport.commands.find((args) => args[1] === 'create')!;
  assert.ok(creation.includes('HUD_CLAIM=synthetic-claim'));
  f.transport.onCommand = (args) => {
    if (args[1] === 'run') throw new Error('lost ack');
  };
  await assert.rejects(
    f.host.runInSurface(locator, { argv: ['/synthetic/hud-run', 'with space', "'", '$();'] }),
    (e: any) => e.code === 'herdr_launch_unknown' && !e.fallbackAllowed
  );
  await assert.rejects(f.host.runInSurface(locator, { argv: ['true'] }), /submission_forbidden/);
  assert.equal(f.transport.commands.filter((args) => args[1] === 'run').length, 1);
});

test('B7 unknown/ref-source, stale occupant, server restart and observer restart never bind or control', async () => {
  const f = setup();
  const locator = await f.host.openSurface('tab', options);
  assert.deepEqual(await f.registry.list(), []); // native ID alone supplies no source.
  f.transport.pane.agent_session = { agent: 'codex', kind: 'id', value: 'synthetic-session', source: 'native' };
  assert.equal(await f.registry.sessionOf(locator), null);
  assert.equal((await f.host.checkLocator(locator)).state, 'stale');
  await assert.rejects(f.host.focus(locator), /locator_stale|interaction_unavailable/);
  const freshRegistry = new HerdrRegistry(
    f.client,
    async () => null,
    () => structuredClone(proc)
  );
  assert.equal(freshRegistry.matches(locator, await freshRegistry.observe('w1:p2')), false);
  f.transport.server = 'replacement-server';
  assert.equal((await f.host.checkLocator(locator)).state, 'unknown');
});

test('B7 registry uses trusted complete source resolution, nullable managed and separate clocks', async () => {
  const f = setup();
  const ref = {
    harness: 'codex' as const,
    sourceId: 'synthetic-source',
    sessionId: 'synthetic-session',
    threadId: null,
  };
  f.transport.pane.agent = 'codex';
  const registry = new HerdrRegistry(
    f.client,
    async () => ({ sessionRef: ref, harness: proc.stamp }),
    () => structuredClone(proc),
    () => 2000
  );
  const records = await registry.list();
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].binding?.sessionRef, ref);
  assert.equal(records[0].binding?.managed, null);
  assert.equal(records[0].evidence.eventAt, null);
  assert.equal(records[0].evidence.lastSuccessfulReadAt, 2000);
  assert.notEqual(records[0].evidence.sourceGeneration, records[0].locator?.occupantGeneration);
});

test('B7 H08 fixed managed locator handoff never persists env or overwrites a conflicting run', async () => {
  const f = setup(100, true);
  const shell = await f.host.openSurface('tab', options);
  await f.host.runInSurface(shell, { argv: ['/synthetic/hud-run'] });
  f.transport.pane.agent = 'codex';
  const locator = (await f.registry.observe('w1:p2')).locator;
  let stored: unknown;
  const fixed = await f.host.recordLocator('synthetic-run', 9, locator, proc.stamp, async (value) => {
    stored = value;
  });
  assert.equal(fixed.bindingGeneration, 9);
  assert.deepEqual(stored, fixed);
  assert.ok(!JSON.stringify(stored).includes('CLAIM'));
  await assert.rejects(
    f.host.recordLocator('synthetic-run', 8, locator, proc.stamp, async () => {}),
    /run_surface_mismatch/
  );
});

test('B7 first delegated prompt only, concurrent/unknown submission consumed and core cancel unchanged', async () => {
  const f = setup(100, true, true);
  const locator = await f.host.openSurface('tab', options);
  f.transport.pane.agent = 'codex';
  f.transport.pane.agent_status = 'idle';
  const active = (await f.registry.observe('w1:p2')).locator;
  const calls: string[] = [];
  const status = {
    currentRun: {
      runId: 'synthetic-run',
      expectedGeneration: 9,
      state: 'running',
      locator: { ...active, runId: 'synthetic-run', bindingGeneration: 9 },
      supervisor: readProcess(process.pid)!.stamp,
    },
    interaction: { input: true },
  } as unknown as LifecycleStatus;
  const core: RunControl = {
    status: async () => status,
    cancel: async () => {
      calls.push('cancel');
      return status;
    },
    reconcile: async () => status,
  };
  const control = new HerdrRunControl(core, f.host, [
    { runId: 'synthetic-run', bindingGeneration: 9, locator: active },
  ]);
  const result = await Promise.allSettled([
    control.sendInput('synthetic-run', 'synthetic first prompt'),
    control.sendInput('synthetic-run', 'duplicate'),
  ]);
  assert.equal(result.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(f.transport.commands.filter((args) => args[1] === 'prompt').length, 1);
  await assert.rejects(control.sendInput('synthetic-run', 'again'), /initial_input_only/);
  await control.cancel('synthetic-run');
  assert.deepEqual(calls, ['cancel']);
  assert.ok(!f.transport.commands.some((args) => args.includes('close') || args.includes('stop')));
  const second = new HerdrRunControl(core, f.host, [{ runId: 'synthetic-run', bindingGeneration: 9, locator: active }]);
  f.transport.promptFailure = true;
  await assert.rejects(second.sendInput('synthetic-run', 'synthetic lost ack'), /prompt_unknown/);
  await assert.rejects(second.sendInput('synthetic-run', 'retry'), /initial_input_only/);
  assert.ok(locator.process);
});

test('B7 content revisions preserve occupancy; unknown generation and missing foreground refuse actions', async () => {
  const f = setup();
  const locator = await f.host.openSurface('tab', options);
  f.transport.pane.revision = 99;
  assert.equal((await f.host.checkLocator(locator)).state, 'valid');
  assert.equal((await f.host.checkLocator({ ...locator, occupantGeneration: null })).state, 'stale');
  await assert.rejects(f.host.focus(locator), /interaction_unavailable/);
  await assert.rejects(f.host.sendKeys(locator, ['enter']), /interaction_unavailable/);
  assert.ok(!f.transport.commands.some((args) => args[1] === 'focus' || args[1] === 'send-keys'));
  await assert.rejects(f.host.attachIdentity('codex'), /identity_requires_launch_env/);
});

test('B7 missing foreground evidence stays unknown; historical run lookup rechecks stored full anchors', async () => {
  const f = setup();
  const locator = await f.host.openSurface('tab', options);
  const unknown = new HerdrRegistry(
    f.client,
    async () => null,
    () => null
  );
  const host = new HerdrHost(f.client, unknown, { workspace: 'w1' });
  assert.equal((await host.checkLocator(locator)).state, 'unknown');
  assert.ok(locator.kind === 'herdr');
  const fixed = {
    kind: 'herdr' as const,
    server: locator.server,
    workspace: locator.workspace,
    tab: locator.tab,
    pane: locator.pane,
    process: locator.process,
    runId: 'synthetic-run',
    bindingGeneration: 9,
  };
  const restored = new HerdrHost(f.client, f.registry, { workspace: 'w1' }, 100, async () => fixed);
  assert.equal((await restored.locate('synthetic-run'))?.occupantGeneration, locator.occupantGeneration);
  assert.equal(await restored.locate('different-run'), null);
  f.transport.pane.terminal_id = 'replacement-terminal';
  // Full process alone is still the same, but stored HostLocator cannot prove a terminal incarnation;
  // observation generations are always rebuilt, never borrowed from bindingGeneration.
  const fresh = await restored.locate('synthetic-run');
  assert.notEqual(fresh?.occupantGeneration, 9);
});

test('B7 review: concurrent surface launch reserves once after fresh refusal checks', async () => {
  const f = setup();
  const locator = await f.host.openSurface('tab', options);
  const results = await Promise.allSettled([
    f.host.runInSurface(locator, { argv: ['/synthetic/hud-run'] }),
    f.host.runInSurface(locator, { argv: ['/synthetic/hud-run'] }),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(f.transport.commands.filter((args) => args[1] === 'run').length, 1);
});

test('B7 review: recovered managed locator retains permission checks after host restart', async () => {
  const f = setup(100, true);
  f.transport.pane.agent = 'codex';
  f.transport.pane.agent_status = 'idle';
  const active = (await f.registry.observe('w1:p2')).locator;
  const fixed = {
    kind: 'herdr' as const,
    server: active.server,
    workspace: active.workspace,
    tab: active.tab,
    pane: active.pane,
    process: active.process,
    runId: 'synthetic-run',
    bindingGeneration: 9,
  };
  let statusCalls = 0;
  const restored = new HerdrHost(f.client, f.registry, { workspace: 'w1' }, 100, async () => fixed, {
    status: async () => {
      statusCalls++;
      throw Error('supervisor_failed');
    },
  });
  const locator = await restored.locate('synthetic-run');
  assert.ok(locator);
  await assert.rejects(restored.focus(locator), /supervisor_failed/);
  await assert.rejects(restored.sendKeys(locator, ['enter']), /supervisor_failed/);
  assert.equal(statusCalls, 2);
  assert.ok(!f.transport.commands.some((args) => args[1] === 'focus' || args[1] === 'send-keys'));
});

test('B7 review: independently resolved harness replacement invalidates a stable supervisor/session locator', async () => {
  const t = new Transport();
  t.pane.agent = 'codex';
  t.pane.agent_status = 'idle';
  const client = new HerdrClient(t, { HERDR_ENV: '1' });
  let selected = 201;
  let resolvedSession = 'synthetic-session';
  const processInfo = (pid: number) =>
    pid === 100
      ? structuredClone(proc)
      : [201, 202].includes(pid)
        ? { ...structuredClone(proc), stamp: { ...proc.stamp, pid, proc_start: String(pid) }, ppid: 100 }
        : null;
  const registry = new HerdrRegistry(
    client,
    async () => ({
      sessionRef: { harness: 'codex', sourceId: 'synthetic-source', sessionId: resolvedSession, threadId: null },
      harness: processInfo(selected)!.stamp,
    }),
    processInfo
  );
  const host = new HerdrHost(client, registry, { workspace: 'w1' });
  const old = (await registry.observe('w1:p2')).locator;
  selected = 202;
  const fresh = (await registry.observe('w1:p2')).locator;
  assert.notEqual(old.occupantGeneration, fresh.occupantGeneration);
  assert.equal((await host.checkLocator(old)).state, 'stale');
  assert.equal(old.process?.pid, 201);
  assert.equal(fresh.process?.pid, 202);
  resolvedSession = 'replacement-session';
  const changedRef = (await registry.observe('w1:p2')).locator;
  assert.notEqual(changedRef.occupantGeneration, fresh.occupantGeneration);
  selected = 0;
  await assert.rejects(registry.observe('w1:p2'), /herdr_occupant_unknown/);
  selected = 202;
  assert.notEqual((await registry.observe('w1:p2')).locator.occupantGeneration, changedRef.occupantGeneration);
});

test('B7 source resolver timeout invalidates controls without exposing resolver details', async () => {
  const f = setup();
  f.transport.pane.agent = 'codex';
  let aborted = false;
  const registry = new HerdrRegistry(
    f.client,
    async (_observation, signal) => {
      signal.addEventListener(
        'abort',
        () => {
          aborted = true;
        },
        { once: true }
      );
      return new Promise(() => {});
    },
    () => structuredClone(proc)
  );
  const start = performance.now();
  await assert.rejects(registry.observe('w1:p2'), /herdr_occupant_unknown/);
  assert.ok(performance.now() - start < 500);
  assert.equal(aborted, true);
});

test('B7 review: prior managed dispatch permanently forbids fallback after later failed preflight', async () => {
  const f = setup();
  f.transport.onCommand = (args) => {
    if (args[1] === 'create') throw Error('lost acknowledgement');
  };
  await assert.rejects(f.host.openSurface('tab', options), (e: any) => e.fallbackAllowed === false);
  f.client.invalidate();
  f.transport.failed = true;
  await assert.rejects(
    f.host.openSurface('tab', options),
    (e: any) => e.code === 'herdr_surface_already_dispatched' && e.fallbackAllowed === false
  );
  await assert.rejects(f.host.openSurface('pane', options), (e: any) => e.fallbackAllowed === false);
  assert.equal(f.transport.commands.filter((args) => args[1] === 'create').length, 1);
});

test('B7 review: all negative preflight results remain shared and cached across registry consumers', async () => {
  for (const kind of ['method', 'protocol'] as const) {
    const t = new Transport();
    if (kind === 'method') t.schema.schemas.request.oneOf = [];
    else t.schema.protocol++;
    let clock = 1000;
    const client = new HerdrClient(
      t,
      { HERDR_ENV: '1' },
      () => {},
      () => clock
    );
    const a = new HerdrRegistry(client);
    const b = new HerdrRegistry(client);
    await client.preflight();
    await a.list();
    await b.list();
    await client.preflight();
    assert.equal(t.commands.filter((args) => args[0] === 'api').length, 1);
    assert.equal(t.commands.length, kind === 'method' ? 1 : 2);
    clock = 4001;
    t.schema = structuredClone(schema);
    assert.equal((await client.preflight()).ready, true);
    assert.equal(t.commands.filter((args) => args[0] === 'api').length, 2);
  }
});

test('B7 final review: unresolved source pane does not discard a separate resolved pane or its generation', async () => {
  const t = new Transport();
  const pane = (id: string) => ({ ...t.pane, pane_id: id, agent: 'codex', agent_status: 'idle' });
  const transport: HerdrTransport = {
    command: t.command.bind(t),
    instance: t.instance.bind(t),
    request: async (method, params) => {
      if (method === 'session.snapshot') return { snapshot: { panes: [pane('w1:p1'), pane('w1:p2')] } };
      if (method === 'pane.get') return { pane: pane(String(params.pane_id)) };
      if (method === 'pane.process_info')
        return { process_info: { pane_id: params.pane_id, shell_pid: 100, foreground_process_group_id: 100 } };
      return t.request(method);
    },
  };
  const client = new HerdrClient(transport, { HERDR_ENV: '1' });
  const registry = new HerdrRegistry(
    client,
    async (o) =>
      o.locator.pane === 'w1:p1'
        ? {
            sessionRef: {
              harness: 'codex',
              sourceId: 'synthetic-source',
              sessionId: 'synthetic-session',
              threadId: null,
            },
            harness: proc.stamp,
          }
        : null,
    () => structuredClone(proc)
  );
  const old = (await registry.observe('w1:p1')).locator;
  const records = await registry.list();
  assert.equal(records.length, 1);
  assert.equal(records[0].locator?.pane, 'w1:p1');
  assert.equal(registry.matches(old, await registry.observe('w1:p1')), true);
  assert.equal(await registry.sessionOf({ ...old, pane: 'w1:p2' }), null);
});

test('B7 final review: dead or moved final OS reads cannot validate or focus the earlier live occupant', async () => {
  for (const final of ['shell-z', 'leader-x', 'harness-z', 'harness-sid', 'harness-tty'] as const) {
    const t = new Transport();
    t.pane.agent = 'codex';
    t.pane.agent_status = 'idle';
    const client = new HerdrClient(t, { HERDR_ENV: '1' });
    let active = false;
    const counts = new Map<number, number>();
    const harness = { ...structuredClone(proc), stamp: { ...proc.stamp, pid: 201, proc_start: '201' }, ppid: 100 };
    const processInfo = (pid: number) => {
      const n = (counts.get(pid) ?? 0) + 1;
      counts.set(pid, n);
      const value = structuredClone(pid === 100 ? proc : harness);
      if (active) {
        if (final === 'shell-z' && pid === 100 && n >= 3) value.state = 'Z';
        if (final === 'leader-x' && pid === 100 && n >= 4) value.state = 'X';
        if (pid === 201 && n >= 2) {
          if (final === 'harness-z') value.state = 'Z';
          if (final === 'harness-sid') value.sid = 999;
          if (final === 'harness-tty') value.tty = 999;
        }
      }
      return value;
    };
    const registry = new HerdrRegistry(
      client,
      async () => ({
        sessionRef: { harness: 'codex', sourceId: 'synthetic-source', sessionId: 'synthetic-session', threadId: null },
        harness: harness.stamp,
      }),
      processInfo
    );
    const host = new HerdrHost(client, registry, { workspace: 'w1' });
    const old = (await registry.observe('w1:p2')).locator;
    active = true;
    counts.clear();
    assert.equal((await host.checkLocator(old)).state, 'unknown', final);
    counts.clear();
    await assert.rejects(host.focus(old), /herdr_occupant_unknown/, final);
    assert.ok(!t.commands.some((args) => args[1] === 'focus'), final);
  }
});
