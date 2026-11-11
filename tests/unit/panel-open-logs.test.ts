/** E1 simulation: private real log files/SQLite, fake pinned Herdr 0.9.5 protocol 22. No real host or provider. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendFileSync,
  mkdtempSync,
  rmSync,
  closeSync,
  writeSync,
  writeFileSync,
  symlinkSync,
  unlinkSync,
  readFileSync,
  renameSync,
  chmodSync,
  linkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunArtifacts } from '../../src/core/run/artifacts.js';
import { DelegationLogView, LOG_PAGE_BYTES } from '../../src/utils/delegation-log-view.js';
import { dispatchDelegationAction } from '../../src/utils/delegation-actions.js';
import {
  panelHostTarget,
  panelHostStamp,
  serverStampCandidate,
  PanelHostController,
  withPanelHostAvailability,
  PANEL_HOST_FRESH_MS,
} from '../../src/integrations/herdr/panel-host.js';
import type { HerdrTransport, ObjectValue } from '../../src/integrations/herdr/transport.js';
import { canonicalJson } from '../../src/core/canonical.js';
import { openPanelLedgerReader, panelLedgerPin } from '../../src/integrations/herdr/panel-ledger.js';
import { readProcess, type ProcRecord } from '../../src/core/run/process.js';
import { insertRecord } from '../../src/ledger/records.js';
import { sessionRefKey } from '../../src/core/identity.js';
import { openLinkLedgerReader } from '../../src/core/link-ledger-read.js';
import { handshakeFixture } from './b45-handshake-fixture.js';
import { buildVm, S, ago } from '../fixtures/b10b-delegation.js';
import { draw, press, click } from '../fixtures/b10b-s3.js';
import { visualLength } from '../../src/render/colors.js';

function view(mode: 'headless' | 'visible' = 'headless') {
  return buildVm([
    { id: 'main', root: true, harness: 'claude', status: S.working(ago(10)) },
    {
      id: 'worker',
      parent: 'main',
      harness: 'codex',
      label: 'worker',
      status: S.working(ago(5)),
      run: { state: 'running', mode },
      pane: 'pane 4',
    },
  ]);
}
function logFixture() {
  const home = mkdtempSync(join(tmpdir(), 'hud-e1-logs-'));
  const built = view();
  const run = built.vm.tree.nodes.find((node) => node.key === built.keys.worker)!.currentRun!;
  run.expectedGeneration = 1;
  run.sourceId = 'ab'.repeat(32);
  run.harness = 'codex';
  const artifacts = RunArtifacts.create(home, run.runId);
  artifacts.writeMeta({
    schema_version: 1,
    run_id: run.runId,
    link_id: run.linkId,
    source_id: run.sourceId,
    binding_generation: run.expectedGeneration,
    mode: 'headless',
    supervision_strategy: 'headless',
    supervisor: null,
    command_leader: null,
    harness: null,
    scope: null,
    launch_digest: 'a'.repeat(64),
    profile_digest: 'b'.repeat(64),
    launch_call_id: 'test-call',
    launch_correlation_id: 'test-correlation',
    created_at: 1000,
    stdin_mode: 'closed',
    capture: 'file',
    launch_cwd: '/synthetic/project',
    project_origin: null,
  });
  const logs = artifacts.openLogs();
  writeSync(logs.stdout, 'safe\n\x1b]52;c;secret\x07\x1b[2J\u202eevil\n' + 'x'.repeat(LOG_PAGE_BYTES));
  writeSync(logs.stderr, 'synthetic stderr\n');
  closeSync(logs.stdout);
  closeSync(logs.stderr);
  return {
    home,
    ...built,
    artifacts,
    context: { vm: built.vm, root: 'main', epoch: 1, selected: built.keys.worker },
    close: () => rmSync(home, { recursive: true, force: true }),
  };
}

test('real monitor L/click opens bounded sanitized stdout, stream, pages, scroll and close', async () => {
  const f = logFixture();
  try {
    for (const kind of ['key', 'click']) {
      const viewer = new DelegationLogView();
      const frame = draw(f.vm, { selected: f.keys.worker, width: 80, height: 24 });
      const button = frame.controls.find((c) => c.kind === 'delegation-open')!;
      const action = (kind === 'key' ? press(frame, 'log') : click(frame, button.x, button.y)).action!;
      assert.equal(action.type, 'delegation-log');
      assert.equal(
        await dispatchDelegationAction(action as never, frame.delegation?.vm, f.vm, true, {
          home: f.home,
          copy: async () => false,
          openLog: () => viewer.open(f.home, f.keys.worker, f.context),
        }),
        'Log viewer opened.'
      );
      let output = viewer.render(80, 14);
      assert.match(output.lines.join('\n'), /safe/);
      assert.match(output.lines.join('\n'), /page truncated/);
      assert.doesNotMatch(output.lines.join('\n'), /\x1b|\x07|\u202e/);
      assert.ok(output.lines.every((line) => visualLength(line) === 80));
      viewer.input({ type: 'key', key: 'right' }, output, f.context);
      assert.match(viewer.render(80, 14).lines[1], new RegExp(`Bytes ${LOG_PAGE_BYTES}`));
      viewer.input({ type: 'key', key: 'left' }, output, f.context);
      assert.match(viewer.render(80, 14).lines[1], /Bytes 0/);
      viewer.input({ type: 'key', key: 'tab' }, output, f.context);
      output = viewer.render(80, 14);
      assert.match(output.lines.join('\n'), /synthetic stderr/);
      const close = output.controls.find((c) => c.action === 'close')!;
      viewer.input({ type: 'mouse', button: 'left', x: close.x, y: close.y }, output, f.context);
      assert.equal(viewer.isOpen, false);
    }
  } finally {
    f.close();
  }
});

test('log viewer binds root, epoch, selection and exact generation; symlink and replaced run fail closed', () => {
  const f = logFixture();
  try {
    for (const changed of [{ root: 'other' }, { epoch: 2 }, { selected: 'other' }]) {
      const v = new DelegationLogView();
      assert.ok(v.open(f.home, f.keys.worker, f.context));
      v.input({ type: 'key', key: 'reset' }, undefined, { ...f.context, ...changed });
      assert.equal(v.isOpen, false);
    }
    const changed = structuredClone(f.vm);
    changed.tree.nodes.find((n) => n.key === f.keys.worker)!.currentRun!.expectedGeneration++;
    const v = new DelegationLogView();
    assert.ok(v.open(f.home, f.keys.worker, f.context));
    v.input({ type: 'key', key: 'reset' }, undefined, { ...f.context, vm: changed });
    assert.equal(v.isOpen, false);
    assert.ok(v.open(f.home, f.keys.worker, f.context));
    const metaPath = join(f.artifacts.directory, 'meta.json');
    const originalMeta = readFileSync(metaPath, 'utf8');
    writeFileSync(metaPath, JSON.stringify({ ...JSON.parse(originalMeta), binding_generation: 99 }));
    v.input({ type: 'key', key: 'r' }, undefined, f.context);
    assert.match(v.render(80, 10).lines.join('\n'), /unsafe, replaced or unreadable/);
    writeFileSync(metaPath, originalMeta);
    v.input({ type: 'key', key: 'r' }, undefined, f.context);
    assert.match(v.render(80, 10).lines.join('\n'), /safe/);
    unlinkSync(join(f.artifacts.directory, 'stdout.log'));
    symlinkSync('/etc/passwd', join(f.artifacts.directory, 'stdout.log'));
    v.input({ type: 'key', key: 'reset' }, undefined, f.context);
    assert.match(v.render(80, 10).lines.join('\n'), /unsafe, replaced or unreadable/);
    assert.doesNotMatch(v.render(80, 10).lines.join('\n'), /root:x:/);
    renameSync(f.artifacts.directory, f.artifacts.directory + '-old');
    RunArtifacts.create(f.home, f.artifacts.runId);
    v.input({ type: 'key', key: 'reset' }, undefined, f.context);
    assert.match(v.render(80, 10).lines.join('\n'), /unsafe, replaced or unreadable/);
    const outside = join(f.home, 'alias');
    symlinkSync(f.home, outside);
    assert.equal(new DelegationLogView().open(outside, f.keys.worker, f.context), false);
  } finally {
    f.close();
  }
});

test('log viewer refuses oversized metadata at open and refresh without exposing log bytes', () => {
  const f = logFixture();
  try {
    const viewer = new DelegationLogView();
    assert.ok(viewer.open(f.home, f.keys.worker, f.context));
    const path = join(f.artifacts.directory, 'meta.json');
    appendFileSync(path, ' '.repeat(8 * 1024 * 1024));
    viewer.input({ type: 'key', key: 'r' }, undefined, f.context);
    for (const v of [viewer, new DelegationLogView()]) {
      if (v !== viewer) v.open(f.home, f.keys.worker, f.context);
      const output = v.render(100, 10).lines.join('\n');
      assert.match(output, /Log unavailable/);
      assert.doesNotMatch(output, /secret|evil|synthetic stderr/);
    }
  } finally {
    f.close();
  }
});

test('log viewer allows same-inode append/truncate but refuses stream replacement across refresh and stream switch', () => {
  const f = logFixture();
  try {
    // Start with small files so appended bytes fit in the first page.
    writeFileSync(join(f.artifacts.directory, 'stdout.log'), 'original stdout\n');
    const viewer = new DelegationLogView();
    assert.ok(viewer.open(f.home, f.keys.worker, f.context));
    for (const stream of ['stdout', 'stderr']) {
      if (stream === 'stderr') viewer.input({ type: 'key', key: 'tab' }, undefined, f.context);
      const path = join(f.artifacts.directory, `${stream}.log`);
      appendFileSync(path, `appended ${stream}\n`);
      viewer.input({ type: 'key', key: 'r' }, undefined, f.context);
      assert.match(viewer.render(100, 10).lines.join('\n'), new RegExp(`appended ${stream}`));
      writeFileSync(path, `truncated ${stream}\n`);
      viewer.input({ type: 'key', key: 'r' }, undefined, f.context);
      assert.match(viewer.render(100, 10).lines.join('\n'), new RegExp(`truncated ${stream}`));
      renameSync(path, path + '-old');
      writeFileSync(path, `REPLACEMENT ACCEPTED ${stream}\n`, { mode: 0o600 });
      viewer.input({ type: 'key', key: 'r' }, undefined, f.context);
      assert.match(viewer.render(100, 10).lines.join('\n'), /Log unavailable/);
      assert.doesNotMatch(viewer.render(100, 10).lines.join('\n'), /REPLACEMENT ACCEPTED|appended/);
    }
    // Returning to a previously read stream must not reset its pin.
    viewer.input({ type: 'key', key: 'tab' }, undefined, f.context);
    assert.match(viewer.render(100, 10).lines.join('\n'), /Log unavailable/);
    unlinkSync(join(f.artifacts.directory, 'stdout.log'));
    viewer.input({ type: 'key', key: 'r' }, undefined, f.context);
    assert.match(viewer.render(100, 10).lines.join('\n'), /Log unavailable/);
  } finally {
    f.close();
  }
});

const schema = JSON.parse(readFileSync('tests/herdr/fixtures/schema.json', 'utf8'));
class FakeHost implements HerdrTransport {
  commands: string[][] = [];
  methods: string[] = [];
  changed = false;
  version = 'herdr 0.9.5';
  schema = structuredClone(schema);
  beforeFocus?: () => void;
  constructor(
    readonly server: string,
    readonly process: ProcRecord
  ) {}
  async instance() {
    return this.changed ? this.server + '-changed' : this.server;
  }
  async command(argv: readonly string[]) {
    this.commands.push([...argv]);
    if (argv[0] === 'api') return this.schema;
    if (argv[0] === '--version') return this.version;
    if (argv[0] === 'pane' && argv[1] === 'focus') return {};
    throw new Error('unexpected mutation');
  }
  async request(method: string): Promise<ObjectValue> {
    this.methods.push(method);
    if (method === 'ping') return { version: '0.9.5', protocol: 22 };
    if (method === 'pane.get')
      return {
        pane: {
          pane_id: 'w1:p1',
          workspace_id: 'w1',
          tab_id: 'w1:t1',
          terminal_id: 'test-terminal',
          agent: 'codex',
          agent_status: 'idle',
        },
      };
    if (method === 'pane.process_info') {
      this.beforeFocus?.();
      return {
        process_info: {
          pane_id: 'w1:p1',
          shell_pid: this.process.stamp.pid,
          foreground_process_group_id: this.process.stamp.pid,
        },
      };
    }
    throw new Error('unexpected read');
  }
}
async function hostFixture() {
  const f = await handshakeFixture(true);
  const real = readProcess(process.pid)!;
  const proc: ProcRecord = { ...real, pgid: process.pid, sid: process.pid, tty: 10, foregroundPgid: process.pid };
  const harness: ProcRecord = { ...proc, stamp: { ...real.stamp, pid: real.stamp.pid + 100000, proc_start: '12345' } };
  const server = `herdr:${canonicalJson(real.stamp)}:1:2:3`;
  const locator = {
    kind: 'herdr',
    server,
    workspace: 'w1',
    tab: 'w1:t1',
    pane: 'w1:p1',
    process: harness.stamp,
    runId: 'run-a',
    bindingGeneration: 1,
  };
  await f.ledger.transaction((tx) => {
    tx.run(
      "UPDATE runs SET state='running',locator=?,supervisor_pid=?,supervisor_proc_start=? WHERE run_id='run-a'",
      JSON.stringify(locator),
      real.stamp.pid,
      real.stamp.proc_start
    );
    tx.run(
      "UPDATE claims SET supervisor_pid=?,supervisor_proc_start=? WHERE run_id='run-a'",
      real.stamp.pid,
      real.stamp.proc_start
    );
    tx.run(
      "UPDATE events SET payload=? WHERE kind='supervisor.registered'",
      JSON.stringify({ sourceId: f.source.sourceId, bindingGeneration: 1, supervisor: real.stamp })
    );
    tx.run(
      "UPDATE links SET child_ref=?,current_owner=1,state='bound' WHERE link_id='link-a'",
      sessionRefKey(f.child.ref)
    );
    insertRecord(tx, 'child_bindings', {
      bindingId: 'synthetic-binding',
      runId: 'run-a',
      sessionRef: f.child.ref,
      bindingGeneration: 1,
      callerId: 'child',
      callerContextId: f.child.context.contextId,
      contextGeneration: 1,
      boundBy: 'trusted_session',
      capabilities: 'mcp',
      evidenceId: 'identity-child',
      isCurrent: true,
      createdAt: 1005,
      revokedAt: null,
    });
  });
  const artifacts = RunArtifacts.create(f.root, 'run-a');
  artifacts.writeMeta({
    ...f.meta,
    supervisor: real.stamp,
    harness: harness.stamp,
    command_leader: harness.stamp,
    scope: null,
    mode: 'visible',
    supervision_strategy: 'wrapper',
    stdin_mode: 'tty',
    capture: 'tty_passthrough',
  });
  const reader = await openLinkLedgerReader(join(f.root, 'ledger.sqlite'));
  const read = reader.read();
  reader.close();
  assert.equal(read.state, 'available');
  if (read.state !== 'available') throw new Error('fixture');
  const built = view('visible');
  const node = built.vm.tree.nodes.find((n) => n.key === built.keys.worker)!;
  node.currentRun = read.snapshot.runs.find((r) => r.runId === 'run-a')!;
  node.identity = { kind: 'session', ref: f.child.ref };
  built.vm.tree.ledger.ledgerId = read.snapshot.ledgerId;
  const target = panelHostTarget(built.vm, built.keys.worker)!;
  const transport = new FakeHost(server, proc);
  const options = {
    home: f.root,
    env: { HERDR_SOCKET_PATH: '/synthetic/socket' },
    transport: () => transport,
    processInfo: (pid: number) => structuredClone(pid === harness.stamp.pid ? harness : proc),
  };
  return { ...built, target, transport, options, close: f.close, ledger: f.ledger };
}

test('recorded server candidate is strict; untrusted env alone never enables Open', async () => {
  for (const bad of [null, '123', 'herdr:123:1:2:3', 'herdr:{"pid":123}:1:2:3'])
    assert.equal(serverStampCandidate(bad), null);
  const built = view('visible');
  const target = panelHostTarget(built.vm, built.keys.worker)!;
  const controller = new PanelHostController({ home: null, env: { HERDR_ENV: '1', HERDR_PID: String(process.pid) } });
  await controller.refresh(target, () => true);
  assert.equal(controller.snapshot?.available, false);
  const frame = draw(withPanelHostAvailability(built.vm, controller.snapshot)!, {
    selected: built.keys.worker,
    width: 80,
    height: 24,
  });
  assert.equal(press(frame, 'open-session').action, undefined);
});

test('selected host availability is read-only; real panel action focuses once with pinned schema and fresh binding', async () => {
  const f = await hostFixture();
  try {
    const before = f.ledger.snapshot((tx) => tx.get('SELECT max(seq) AS n FROM events')!.n);
    const controller = new PanelHostController(f.options);
    await controller.refresh(f.target, () => true);
    assert.equal(controller.snapshot?.available, true);
    assert.ok(f.transport.commands.every((a) => ['api', '--version'].includes(a[0])));
    const vm = withPanelHostAvailability(f.vm, controller.snapshot)!;
    const frame = draw(vm, { selected: f.keys.worker, width: 80, height: 24 });
    const action = press(frame, 'open-session').action!;
    assert.equal(action.type, 'delegation-open');
    assert.equal(
      await dispatchDelegationAction(action as never, frame.delegation?.vm, vm, true, {
        home: f.options.home,
        copy: async () => false,
        open: () => controller.open(f.target, () => true),
      }),
      'Opened run.'
    );
    assert.equal(f.transport.commands.filter((a) => a[1] === 'focus').length, 1);
    assert.equal(
      f.ledger.snapshot((tx) => tx.get('SELECT max(seq) AS n FROM events')!.n),
      before
    );
    assert.ok(
      f.transport.commands.every((a) => ['api', '--version'].includes(a[0]) || a.join(' ') === 'pane focus w1:p1')
    );
  } finally {
    await f.close();
  }
});

test('Open refuses oversized artifact metadata during availability and after an available snapshot with zero focus', async () => {
  const f = await hostFixture();
  try {
    const controller = new PanelHostController(f.options);
    await controller.refresh(f.target, () => true);
    assert.equal(controller.snapshot?.available, true);
    const vm = withPanelHostAvailability(f.vm, controller.snapshot)!;
    const frame = draw(vm, { selected: f.keys.worker, width: 80, height: 24 });
    const action = press(frame, 'open-session').action!;
    assert.equal(action.type, 'delegation-open');
    appendFileSync(join(f.options.home, 'runs', f.target.run.runId, 'meta.json'), ' '.repeat(8 * 1024 * 1024));
    assert.match(
      await dispatchDelegationAction(action as never, frame.delegation?.vm, vm, true, {
        home: f.options.home,
        copy: async () => false,
        open: () => controller.open(f.target, () => true),
      }),
      /unavailable/
    );
    await controller.refresh(f.target, () => true);
    assert.equal(controller.snapshot?.available, false);
    assert.equal(f.transport.commands.filter((a) => a[1] === 'focus').length, 0);
    controller.close();
  } finally {
    await f.close();
  }
});

test('host restart, schema drift, late selection change and revoked binding never focus', async () => {
  for (const kind of ['server', 'schema', 'selection', 'binding']) {
    const f = await hostFixture();
    try {
      const controller = new PanelHostController(f.options);
      let current = true;
      await controller.refresh(f.target, () => current);
      assert.equal(controller.snapshot?.available, true);
      if (kind === 'server') f.transport.changed = true;
      if (kind === 'schema') f.transport.schema.protocol++;
      if (kind === 'selection')
        f.transport.beforeFocus = () => {
          current = false;
        };
      if (kind === 'binding')
        await f.ledger.transaction((tx) => {
          tx.run('UPDATE child_bindings SET is_current=0,revoked_at=2000');
        });
      assert.match(await controller.open(f.target, () => current), /unavailable/);
      assert.equal(f.transport.commands.filter((a) => a[1] === 'focus').length, 0);
    } finally {
      await f.close();
    }
  }
});

test('production panel entry consumes viewer and separate host snapshot without launching a pager', () => {
  const source = readFileSync('src/tree-page.ts', 'utf8');
  for (const use of [
    'runLogs.open(',
    'runLogs.input(',
    'runLogs.render(',
    'panelHost.refresh(',
    'panelHost.open(',
    'withPanelHostAvailability(',
  ])
    assert.ok(source.includes(use), use);
  assert.doesNotMatch(readFileSync('src/utils/delegation-log-view.ts', 'utf8'), /execFile|spawn\(|eval\(/);
});

test('log paint is bounded at narrow sizes and has no invisible mouse targets', () => {
  const f = logFixture();
  try {
    const viewer = new DelegationLogView();
    viewer.open(f.home, f.keys.worker, f.context);
    for (const width of [1, 10, 32, 80])
      for (const height of [1, 2, 3, 4, 24]) {
        const frame = viewer.render(width, height);
        assert.equal(frame.lines.length, height);
        assert.ok(frame.lines.every((line) => visualLength(line) === width));
        assert.ok(frame.controls.every((control) => control.y < height && control.x + control.width <= width));
      }
  } finally {
    f.close();
  }
});

test('availability refresh is single flight and cannot publish after selection invalidation', async () => {
  const f = await hostFixture();
  try {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = f.transport.instance.bind(f.transport);
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let calls = 0;
    f.transport.instance = async () => {
      calls++;
      entered();
      await pending;
      return original();
    };
    const controller = new PanelHostController(f.options);
    const first = controller.refresh(f.target, () => true);
    await started;
    await controller.refresh(f.target, () => true);
    controller.invalidate();
    release();
    await first;
    assert.equal(calls, 1);
    assert.equal(controller.snapshot, null);
    assert.equal(f.transport.commands.length, 0);
  } finally {
    await f.close();
  }
});

test('fixed-run worker reads bounded metadata, ignores unrelated payloads and preserves cross-link conflicts', async () => {
  const f = await hostFixture();
  const reader = openPanelLedgerReader(join(f.options.home, 'ledger.sqlite'), 'link-a', 'run-a');
  try {
    await f.ledger.transaction((tx) => {
      tx.run(
        "INSERT INTO events(link_id,run_id,kind,payload,at) VALUES('link-a','run-a','synthetic.large',?,2000)",
        JSON.stringify({ text: 'x'.repeat(1000000) })
      );
    });
    const first = await reader.read();
    assert.equal(first.run.supervisor?.pid, process.pid);
    assert.ok(JSON.stringify(first).length < 16000);
    assert.doesNotMatch(JSON.stringify(first), /launchTokenHash|claimHash|synthetic.large/);
    await f.ledger.transaction((tx) => {
      insertRecord(tx, 'links', { ...first.link, linkId: 'other-link', currentOwner: false, predecessor: null });
      insertRecord(tx, 'evidence', {
        evidenceId: 'cross-link-conflict',
        runId: null,
        linkId: 'other-link',
        kind: 'conflict',
        producer: 'reconciler',
        fingerprint: 'a'.repeat(64),
        payload: {},
        observedAt: 2000,
        validatedAt: null,
        validation: 'pending',
      });
    });
    assert.equal((await reader.read()).conflict, true);
    const controller = new PanelHostController(f.options);
    await controller.refresh(f.target, () => true);
    assert.equal(controller.snapshot?.available, false);
    assert.equal(f.transport.commands.filter((a) => a[1] === 'focus').length, 0);
  } finally {
    await reader.close();
    await f.close();
  }
});

test('fixed-run worker timeout, close and oversized data fail closed without accepting late replies', async () => {
  const f = await hostFixture();
  const path = join(f.options.home, 'ledger.sqlite');
  try {
    const timeout = openPanelLedgerReader(path, 'link-a', 'run-a', 1);
    await assert.rejects(timeout.read(), /unavailable/);
    await timeout.close();
    await assert.rejects(timeout.read(), /unavailable/);
    const closed = openPanelLedgerReader(path, 'link-a', 'run-a');
    const pending = assert.rejects(closed.read(), /unavailable/);
    await closed.close();
    await pending;
    const oversized = openPanelLedgerReader(path, 'link-a', 'run-a');
    await f.ledger.transaction((tx) => {
      tx.run("UPDATE links SET label=? WHERE link_id='link-a'", 'x'.repeat(8193));
    });
    await assert.rejects(oversized.read(), /unavailable/);
    await oversized.close();
  } finally {
    await f.close();
  }
});

test('ledger privacy and link-count changes invalidate reads and never focus', async () => {
  for (const kind of ['mode', 'hardlink']) {
    const f = await hostFixture();
    const path = join(f.options.home, 'ledger.sqlite');
    try {
      const controller = new PanelHostController(f.options);
      await controller.refresh(f.target, () => true);
      assert.equal(controller.snapshot?.available, true);
      if (kind === 'mode') chmodSync(path, 0o644);
      else linkSync(path, join(f.options.home, 'ledger-copy.sqlite'));
      assert.throws(() => panelLedgerPin(path), /unavailable/);
      assert.match(await controller.open(f.target, () => true), /unavailable/);
      assert.equal(f.transport.commands.filter((a) => a[1] === 'focus').length, 0);
    } finally {
      await f.close();
    }
  }
});

test('host availability expires from paint and Open without starting host I/O', async () => {
  const f = await hostFixture();
  try {
    let now = Date.now();
    const controller = new PanelHostController(f.options, () => now);
    await controller.refresh(f.target, () => true);
    const snapshot = controller.snapshot;
    assert.equal(snapshot?.available, true);
    const before = f.transport.commands.length + f.transport.methods.length;
    now += PANEL_HOST_FRESH_MS;
    assert.equal(controller.snapshot, null);
    const expired = withPanelHostAvailability(f.vm, snapshot, now)!;
    const frame = draw(expired, { selected: f.keys.worker, width: 80, height: 24 });
    assert.equal(press(frame, 'open-session').action, undefined);
    assert.match(await controller.open(f.target, () => true), /unavailable/);
    assert.equal(f.transport.commands.length + f.transport.methods.length, before);
    assert.equal(f.transport.commands.filter((a) => a[1] === 'focus').length, 0);
    now -= PANEL_HOST_FRESH_MS + 1;
    assert.equal(controller.snapshot, null, 'a backward wall clock cannot extend availability');
  } finally {
    await f.close();
  }
});
