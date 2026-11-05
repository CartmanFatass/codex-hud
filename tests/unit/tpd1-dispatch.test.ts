import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, closeSync, unlinkSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunArtifacts } from '../../src/core/run/artifacts.js';
import {
  dispatchDelegationAction,
  createClipboardProvider,
  delegationPickerLabel,
  withInputRefresh,
  delegationActivityTarget,
  createNavigationGate,
  revealDelegationAncestors,
  createOpenGate,
  sameDelegationActionTarget,
  boundedActionNotice,
} from '../../src/utils/delegation-actions.js';
import { S, ago, buildVm, type NodeSpec } from '../fixtures/b10b-delegation.js';
import { draw, press, monitorInput, text } from '../fixtures/b10b-s3.js';
import { renderMonitor } from '../../src/render/monitor.js';

const root: NodeSpec = { id: 'main', root: true, harness: 'claude', status: S.working(ago(300)), label: null };
function view(mode: 'headless' | 'visible', reconcile = false) {
  const built = buildVm([
    root,
    {
      id: 'worker',
      parent: 'main',
      harness: 'codex',
      label: 'worker',
      status: S.working(ago(100)),
      run: { state: 'running', mode },
      reconcile,
      pane: 'pane 4',
    },
  ]);
  const frame = draw(built.vm, { selected: built.keys.worker, width: 80, height: 24 });
  return { ...built, frame };
}
test('R from the displayed frame copies exactly the displayed descriptor, and stale selection refuses', async () => {
  const { vm, frame } = view('headless', true);
  const action = press(frame, 'resume-reconcile').action;
  assert.equal(action?.type, 'delegation-copy');
  if (!action || action.type !== 'delegation-copy') throw new Error('missing action');
  const seen: string[] = [];
  const ports = {
    home: '/nonexistent',
    copy: async (text: string) => {
      seen.push(text);
      return true;
    },
  };
  assert.equal(
    await dispatchDelegationAction(action, frame.delegation?.vm, vm, true, ports),
    'Reconcile command copied.'
  );
  assert.deepEqual(seen, [action.descriptor.displayCommand]);
  assert.match(await dispatchDelegationAction(action, frame.delegation?.vm, vm, false, ports), /changed/);
  assert.equal(seen.length, 1);
});
test('L from the displayed frame exposes a verified log path; missing logs are unavailable', async () => {
  const { vm, frame } = view('headless');
  const action = press(frame, 'log').action;
  assert.equal(action?.type, 'delegation-log');
  if (!action || action.type !== 'delegation-log') throw new Error('missing action');
  const home = mkdtempSync(join(tmpdir(), 'tpd1-'));
  try {
    const node = vm.tree.nodes.find((n) => n.key === action.key)!;
    const artifacts = RunArtifacts.create(home, node.currentRun!.runId);
    const logs = artifacts.openLogs();
    closeSync(logs.stdout);
    closeSync(logs.stderr);
    const ports = { home, copy: async () => false };
    assert.equal(
      await dispatchDelegationAction(action, frame.delegation?.vm, vm, true, ports),
      `Log: stdout: ${join(artifacts.directory, 'stdout.log')} · stderr: ${join(artifacts.directory, 'stderr.log')}`
    );
    unlinkSync(join(artifacts.directory, 'stderr.log'));
    assert.equal(
      await dispatchDelegationAction(action, frame.delegation?.vm, vm, true, ports),
      `Log: stdout: ${join(artifacts.directory, 'stdout.log')} · stderr: unavailable`
    );
    assert.equal(
      await dispatchDelegationAction(action, frame.delegation?.vm, vm, true, { ...ports, home: null }),
      'Log unavailable for this run.'
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
test('o uses the host interface and rechecks current selection after locate', async () => {
  const { vm, frame } = view('visible');
  const action = press(frame, 'open-session').action;
  assert.equal(action?.type, 'delegation-open');
  if (!action || action.type !== 'delegation-open') throw new Error('missing action');
  const calls: string[] = [];
  const host = {
    locate: async (_target: unknown) => {
      calls.push('locate');
      return {} as never;
    },
    focus: async (_locator: never) => {
      calls.push('focus');
    },
  };
  const ports = { home: '/nonexistent', copy: async () => false, host, isCurrent: () => true };
  assert.equal(await dispatchDelegationAction(action, frame.delegation?.vm, vm, true, ports), 'Opened run.');
  assert.deepEqual(calls, ['locate', 'focus']);
  ports.isCurrent = () => false;
  assert.match(await dispatchDelegationAction(action, frame.delegation?.vm, vm, true, ports), /changed/);
  assert.deepEqual(calls, ['locate', 'focus', 'locate']);
});

test('narrow picker labels reject whitespace and main collisions', () => {
  const built = buildVm([
    { ...root, harness: 'codex' },
    { id: 'a', parent: 'main', native: true, harness: 'codex', label: 'a', status: S.working(ago(10)) },
    { id: 'b', parent: 'main', native: true, harness: 'codex', label: 'b', status: S.working(ago(10)) },
  ]);
  const a = built.vm.tree.nodes.find((n) => n.key === built.keys.a)!;
  const b = built.vm.tree.nodes.find((n) => n.key === built.keys.b)!;
  a.native = { title: 'a', kind: null, pickerLabel: 'alpha beta' };
  b.native = { title: 'b', kind: null, pickerLabel: 'alphabeta' };
  assert.equal(delegationPickerLabel(built.vm, 'main-0001', 'a-0001'), undefined);
  b.native.pickerLabel = 'Main[default]';
  assert.equal(delegationPickerLabel(built.vm, 'main-0001', 'main-0001'), undefined);
  b.native.pickerLabel = 'other';
  assert.equal(delegationPickerLabel(built.vm, 'main-0001', 'main-0001'), 'Main [default]');
});

test('input dispatch acts on its drawn epoch before requesting refresh', async () => {
  const { vm, frame } = view('headless', true);
  let epoch = 7;
  const drawnEpoch = epoch;
  let copied = '';
  const result = withInputRefresh(
    true,
    () => {
      const action = press(frame, 'resume-reconcile').action;
      if (!action || action.type !== 'delegation-copy') throw new Error('missing action');
      return dispatchDelegationAction(action, frame.delegation?.vm, vm, epoch === drawnEpoch, {
        home: '/nonexistent',
        copy: async (text) => {
          copied = text;
          return true;
        },
      });
    },
    () => {
      epoch++;
    }
  );
  assert.equal(await result, 'Reconcile command copied.');
  assert.ok(copied);
  assert.equal(epoch, 8);
});

test('activity target uses projected keys and refuses missing or ambiguous identities', () => {
  const { vm } = view('headless');
  const node = vm.tree.nodes.find((n) => n.identity.kind === 'session' && n.identity.ref.sessionId === 'worker-0001')!;
  assert.deepEqual(delegationActivityTarget(vm, 'main-0001', 'worker-0001'), { root: false, key: node.key });
  assert.deepEqual(delegationActivityTarget(vm, 'main-0001', 'main-0001'), { root: true, key: null });
  assert.equal(delegationActivityTarget(vm, 'main-0001', 'missing'), null);
  vm.tree.nodes.push({ ...node, key: 'duplicate' });
  assert.equal(delegationActivityTarget(vm, 'main-0001', 'worker-0001'), null);
});

test('duplicate switch presses submit once and stale completion cannot update the view', async () => {
  const gate = createNavigationGate();
  let resolve!: (value: string) => void;
  let current = true;
  let calls = 0;
  const outcomes: string[] = [];
  const execute = () => {
    calls++;
    return new Promise<string>((done) => {
      resolve = done;
    });
  };
  const finish = (value: { value: string } | { error: unknown }) => {
    if ('value' in value) outcomes.push(value.value);
  };
  const first = gate(
    'one',
    execute,
    () => current,
    () => {},
    finish
  );
  assert.equal(
    await gate(
      'one',
      execute,
      () => current,
      () => {},
      finish
    ),
    false
  );
  assert.equal(calls, 1);
  current = false;
  resolve('done');
  assert.equal(await first, true);
  assert.deepEqual(outcomes, []);
  current = true;
  const next = gate(
    'one',
    execute,
    () => current,
    () => {},
    finish
  );
  resolve('next');
  await next;
  assert.deepEqual(outcomes, ['next']);
});

test('activity target unfolds its ancestors and remains selected when redrawn', () => {
  const built = buildVm([
    { ...root, harness: 'codex' },
    { id: 'a', parent: 'main', native: true, harness: 'codex', label: 'a', status: S.working(ago(10)) },
    { id: 'b', parent: 'a', native: true, harness: 'codex', label: 'b', status: S.working(ago(10)) },
  ]);
  const target = delegationActivityTarget(built.vm, 'main-0001', 'b-0001');
  assert.equal(target?.key, built.keys.b);
  const collapsed = new Set([built.keys.a, 'unrelated']);
  const revealed = revealDelegationAncestors(built.vm, target!.key!, collapsed);
  assert.equal(revealed.has(built.keys.a), false);
  assert.equal(revealed.has('unrelated'), true);
  const frame = draw(built.vm, { selected: target!.key!, collapsed: [...revealed], showAll: true, height: 30 });
  assert.equal(frame.state.tree.selectedId, target!.key);
});

test('repeated Open key cannot start simultaneous host actions; copying remains explicit per press', async () => {
  const { vm, frame } = view('visible');
  const first = press(frame, 'open-session').action;
  const second = press(frame, 'open-session').action;
  assert.equal(first?.type, 'delegation-open');
  assert.deepEqual(second, first);
  if (!first || first.type !== 'delegation-open') throw new Error('missing action');
  let complete!: (value: never) => void;
  let locations = 0;
  let focuses = 0;
  const host = {
    locate: async () => {
      locations++;
      return new Promise<never>((done) => {
        complete = done;
      });
    },
    focus: async () => {
      focuses++;
    },
  };
  const gate = createOpenGate();
  const execute = () =>
    dispatchDelegationAction(first, frame.delegation?.vm, vm, true, {
      home: '/nonexistent',
      copy: async () => false,
      host,
      isCurrent: () => true,
    });
  const pending = gate(first.key, execute);
  assert.equal(await gate(first.key, execute), null);
  assert.equal(locations, 1);
  complete({} as never);
  assert.equal(await pending, 'Opened run.');
  assert.equal(focuses, 1);
  const copyView = view('headless', true);
  const copy = press(copyView.frame, 'resume-reconcile').action;
  if (!copy || copy.type !== 'delegation-copy') throw new Error('missing copy');
  let copies = 0;
  const ports = {
    home: '/nonexistent',
    copy: async () => {
      copies++;
      return true;
    },
  };
  await dispatchDelegationAction(copy, copyView.frame.delegation?.vm, copyView.vm, true, ports);
  await dispatchDelegationAction(copy, copyView.frame.delegation?.vm, copyView.vm, true, ports);
  assert.equal(copies, 2);
});

for (const succeeds of [true, false])
  test(`delayed clipboard ${succeeds ? 'success' : 'failure'} survives equivalent refresh but rejects changed target`, async () => {
    const { vm, frame } = view('headless', true);
    const action = press(frame, 'resume-reconcile').action;
    if (!action || action.type !== 'delegation-copy') throw new Error('missing action');
    let resolve!: (ok: boolean) => void;
    const pending = dispatchDelegationAction(action, frame.delegation?.vm, vm, true, {
      home: '/nonexistent',
      copy: () =>
        new Promise((done) => {
          resolve = done;
        }),
    });
    const refreshed = structuredClone(vm);
    assert.equal(sameDelegationActionTarget(frame.delegation?.vm, refreshed, action.key), true);
    resolve(succeeds);
    const message = await pending;
    assert.match(message, succeeds ? /copied/ : /Not copied:/);
    const changed = {
      ...refreshed,
      details: { ...refreshed.details, [action.key]: { ...refreshed.details[action.key], reconcile: null } },
    };
    assert.equal(sameDelegationActionTarget(frame.delegation?.vm, changed, action.key), false);
  });

test('WSL clipboard sends data on stdin and requires the fixed read-back acknowledgment', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tpd1-clipboard-'));
  const capture = join(dir, 'capture');
  const argsPath = join(dir, 'args');
  try {
    writeFileSync(
      join(dir, 'powershell.exe'),
      `#!${process.execPath}\nconst fs = require('fs'); let data=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', x => data+=x); process.stdin.on('end', () => { fs.writeFileSync(process.env.CAPTURE_FILE,data); fs.writeFileSync(process.env.ARGS_FILE, JSON.stringify(process.argv.slice(2))); process.stdout.write('HUD_CLIPBOARD_OK_V1'); });\n`,
      { mode: 0o700 }
    );
    const command = "HUD_HOME='/tmp/中文 home' hud run reconcile r_123";
    const env = { PATH: dir, WSL_DISTRO_NAME: 'Ubuntu', CAPTURE_FILE: capture, ARGS_FILE: argsPath };
    const provider = createClipboardProvider({ platform: 'linux', env });
    assert.equal(await provider.copy(command), 'copied');
    assert.equal(Buffer.from(readFileSync(capture, 'utf8'), 'base64').toString('utf8'), command);
    const args = JSON.parse(readFileSync(argsPath, 'utf8')) as string[];
    assert.deepEqual(args.slice(0, 5), ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-Command']);
    assert.ok(args.every((arg) => !arg.includes(command)));
    assert.match(args[5], /SetText/);
    assert.match(args[5], /GetText/);
    assert.match(args[5], /Ordinal/);
    provider.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('clipboard refuses missing route and malformed acknowledgment', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tpd1-clipboard-'));
  try {
    const env = { PATH: dir, WSL_DISTRO_NAME: 'Ubuntu' };
    assert.equal(await createClipboardProvider({ platform: 'linux', env }).copy('text'), 'unavailable');
    writeFileSync(
      join(dir, 'powershell.exe'),
      `#!${process.execPath}\nprocess.stdin.resume(); process.stdout.write('not-the-ack');\n`,
      { mode: 0o700 }
    );
    assert.equal(await createClipboardProvider({ platform: 'linux', env }).copy('text'), 'unconfirmed');
    assert.equal(await createClipboardProvider({ platform: 'linux', env }).copy('bad\0text'), 'unavailable');
    assert.equal(
      await createClipboardProvider({ platform: 'linux', env }).copy('x'.repeat(256 * 1024 + 1)),
      'unavailable'
    );
    assert.equal(await createClipboardProvider({ platform: 'linux', env }).copy('\ud800'), 'unavailable');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a timed-out provider that ignores TERM is killed, never falls back, and cannot write later', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tpd1-clipboard-'));
  const late = join(dir, 'late');
  const fallback = join(dir, 'fallback');
  const started = join(dir, 'started');
  try {
    writeFileSync(
      join(dir, 'powershell.exe'),
      `#!${process.execPath}\nprocess.on('SIGTERM', () => {}); require('fs').writeFileSync(process.env.STARTED, 'started'); process.stdin.resume(); setTimeout(() => { require('fs').writeFileSync(process.env.LATE, 'late'); process.stdout.write('HUD_CLIPBOARD_OK_V1'); }, 1200);\n`,
      { mode: 0o700 }
    );
    writeFileSync(
      join(dir, 'xclip'),
      `#!${process.execPath}\nrequire('fs').writeFileSync(process.env.FALLBACK, 'fallback');\n`,
      { mode: 0o700 }
    );
    const env = { PATH: dir, WSL_DISTRO_NAME: 'Ubuntu', LATE: late, FALLBACK: fallback, STARTED: started };
    const provider = createClipboardProvider({ platform: 'linux', env, timeoutMs: 800, cleanupMs: 1000 });
    const pending = provider.copy('first');
    for (let i = 0; i < 30 && !existsSync(started); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(existsSync(started), true);
    assert.equal(await provider.copy('second'), 'unavailable');
    assert.equal(await pending, 'unconfirmed');
    assert.equal(await provider.copy('after-timeout'), 'unavailable');
    await new Promise((resolve) => setTimeout(resolve, 1300));
    assert.equal(existsSync(late), false);
    assert.equal(existsSync(fallback), false);
    provider.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('closing the page terminates the owned clipboard child and prevents new launches', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tpd1-clipboard-'));
  const started = join(dir, 'started');
  try {
    writeFileSync(
      join(dir, 'powershell.exe'),
      `#!${process.execPath}\nrequire('fs').writeFileSync(process.env.STARTED, 'started'); process.stdin.resume(); setTimeout(() => {}, 3000);\n`,
      { mode: 0o700 }
    );
    const provider = createClipboardProvider({
      platform: 'linux',
      env: { PATH: dir, WSL_DISTRO_NAME: 'Ubuntu', STARTED: started },
      cleanupMs: 1000,
    });
    const pending = provider.copy('first');
    for (let i = 0; i < 50 && !existsSync(started); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(existsSync(started), true);
    const closed = provider.close();
    assert.equal(await pending, 'unconfirmed');
    await closed;
    assert.equal(await provider.copy('later'), 'unavailable');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('clipboard failure is honestly reported by the real monitor notice without a truncated command', async () => {
  const { vm, frame, keys } = view('headless', true);
  const action = press(frame, 'resume-reconcile').action;
  if (!action || action.type !== 'delegation-copy') throw new Error('missing action');
  const longAction = {
    ...action,
    descriptor: { ...action.descriptor, displayCommand: action.descriptor.displayCommand + ' ' + 'x'.repeat(100) },
  };
  const message = await dispatchDelegationAction(longAction, frame.delegation?.vm, vm, true, {
    home: null,
    copy: async () => false,
  });
  for (const width of [32, 80]) {
    const displayed = text(
      renderMonitor({
        ...monitorInput(vm, { selected: keys.worker, width, height: 24 }),
        notice: boundedActionNotice(message, width),
      })
    ).join(' ');
    assert.match(displayed.replace(/\s+/g, ' '), /Not copied; command not shown\./);
    assert.ok(!displayed.includes(longAction.descriptor.displayCommand));
  }
});

test('long log paths render an explicit truncation notice in a narrow monitor', async () => {
  const { vm, frame, keys } = view('headless');
  const action = press(frame, 'log').action;
  if (!action || action.type !== 'delegation-log') throw new Error('missing action');
  const home = mkdtempSync(join(tmpdir(), 'tpd1-a-very-long-home-with-a-distinctive-ledger-'));
  try {
    const node = vm.tree.nodes.find((n) => n.key === action.key)!;
    const artifacts = RunArtifacts.create(home, node.currentRun!.runId);
    const logs = artifacts.openLogs();
    closeSync(logs.stdout);
    closeSync(logs.stderr);
    const message = await dispatchDelegationAction(action, frame.delegation?.vm, vm, true, {
      home,
      copy: async () => false,
    });
    const notice = boundedActionNotice(message, 32);
    assert.equal(notice, 'Log paths too long to display.');
    const displayed = text(
      renderMonitor({ ...monitorInput(vm, { selected: keys.worker, width: 32, height: 24 }), notice })
    )
      .join(' ')
      .replace(/\s+/g, ' ');
    assert.match(displayed, /Log paths too long to display\./);
    assert.ok(!displayed.includes(home));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('short captured command is displayed in full when clipboard is unavailable', async () => {
  const { vm, frame, keys } = view('headless', true);
  const original = press(frame, 'resume-reconcile').action;
  if (!original || original.type !== 'delegation-copy') throw new Error('missing action');
  const action = { ...original, descriptor: { ...original.descriptor, displayCommand: 'hud run reconcile r_1' } };
  const message = await dispatchDelegationAction(action, frame.delegation?.vm, vm, true, {
    home: null,
    copy: async () => 'unavailable',
  });
  const notice = boundedActionNotice(message, 80);
  const displayed = text(
    renderMonitor({ ...monitorInput(vm, { selected: keys.worker, width: 80, height: 24 }), notice })
  ).join(' ');
  assert.ok(displayed.includes('Not copied: hud run reconcile r_1'));
  assert.equal(boundedActionNotice('Not copied: a\nb', 80), 'Not copied; command not shown.');
});
