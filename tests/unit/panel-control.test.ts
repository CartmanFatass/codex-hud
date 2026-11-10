import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  PanelStore,
  panelKey,
  displayTarget,
  decodeReceipt,
  readJson,
  saveJson,
  type PanelContext,
  type PanelReceipt,
  type PaneIdentity,
} from '../../src/integrations/panel/receipt.js';
import { controlPanel, type PanelControlOptions } from '../../src/integrations/panel/control.js';
import {
  CliPanelHerdr,
  PanelDeadline,
  panelArgv,
  registeredProcess,
  type PanelHerdr,
} from '../../src/integrations/panel/herdr.js';
import { workerLaunch, type NativePanelEvidence } from '../../src/integrations/panel/eligibility.js';
import { installPanelLifetime } from '../../src/integrations/panel/lifetime.js';
import {
  readPanelInput,
  PANEL_INPUT_MAX,
  PANEL_OPERATION_MS,
  PANEL_HOOK_TIMEOUT_MS,
} from '../../src/integrations/panel/cli.js';
import { panelSelection, panelRoot } from '../../src/cli/panel.js';
import { commandText } from '../../src/integrations/herdr/host.js';
import { runCommand } from '../../src/roles/herdr-run.js';
import { readProcess, processState, type ProcRecord } from '../../src/core/run/process.js';
import { hudClose } from '../../src/roles/facade.js';
import type { ProcessStamp } from '../../src/core/types/supervision.js';
const FAKE = fileURLToPath(new URL('../../../tests/fakes/panel-herdr.mjs', import.meta.url));
const STAMP: ProcessStamp = {
  pid: 12345,
  proc_start: '987',
  boot_id: 'synthetic-boot',
  pid_domain: 'synthetic-domain',
};
const SHELL = { ...STAMP, pid: 12346 };
const PROC: ProcRecord = {
  stamp: STAMP,
  state: 'S',
  flags: 0,
  pgid: STAMP.pid,
  sid: 123,
  ppid: 1,
  tty: 999,
  foregroundPgid: STAMP.pid,
};
function setup(t: TestContext, settings: { HUD_SETTINGS_PATH?: string; CODEX_HUD_SETTINGS_PATH?: string } = {}) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'hud-panel-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const n of ['home', 'hud', 'codex', 'source']) fs.mkdirSync(join(dir, n), { mode: 0o700 });
  const env: NodeJS.ProcessEnv & { HOME: string; HUD_HOME: string; CODEX_HOME: string } = {
    ...process.env,
    HOME: join(dir, 'home'),
    HUD_HOME: join(dir, 'hud'),
    CODEX_HOME: join(dir, 'codex'),
  };
  delete env.NO_COLOR;
  delete env.FORCE_COLOR;
  delete env.HUD_SETTINGS_PATH;
  delete env.CODEX_HUD_SETTINGS_PATH;
  Object.assign(env, settings);
  const target = displayTarget('pi', 'session-1', join(dir, 'source'));
  const origin = { pane: 'main', tab: 'main-tab', terminal: 'main-terminal', workspace: 'workspace-1', process: STAMP };
  const c: PanelContext = {
    target,
    main: STAMP,
    instance: 'herdr:synthetic-1',
    origin,
    runtime: { node: process.execPath, entry: join(dir, 'hud.js'), digest: 'a'.repeat(64) },
  };
  const native: NativePanelEvidence = {
    verified: true,
    identity: { harness: 'pi', root: { namespace: target.ref.sourceId, sessionId: 'session-1' } },
    topology: 'top-level',
    ui: 'tui',
  };
  const s = new PanelStore(env);
  const log = join(dir, 'herdr.log');
  let pending = 0;
  let peak = 0;
  let instance = c.instance;
  let missingRegistration = false;
  let splitTimeout = false;
  let splitCount = 0;
  let splitGate: Promise<void> | undefined;
  let startTimeout = false;
  const panes = new Map<string, PaneIdentity>([['main', origin]]);
  const effects: string[] = [];
  const invoke = async (op: string, argv: string[], d: PanelDeadline) => {
    pending++;
    peak = Math.max(peak, pending);
    try {
      const out = await runCommand(process.execPath, [FAKE, log, op, ...argv], env, {
        budgetMs: d.remaining(1500),
        signal: d.signal,
      });
      assert.equal(out.ok, true, out.reason + out.stderr);
    } finally {
      pending--;
    }
  };
  const h: PanelHerdr = {
    async preflight(d) {
      await invoke('preflight', [], d);
      return instance;
    },
    async instance() {
      return instance;
    },
    async observe(pane) {
      return panes.get(pane) ?? null;
    },
    async split(r, passed, d) {
      assert.equal(readJson(s.file(panelKey(c), 'intent')) !== null, true, 'intent precedes split');
      assert.equal(s.read(panelKey(c))?.token, r.token);
      assert.equal(passed.HUD_PANEL_TOKEN, r.token);
      assert.equal(
        passed.HUD_SETTINGS_PATH,
        env.HUD_SETTINGS_PATH ?? env.CODEX_HUD_SETTINGS_PATH ?? join(env.HUD_HOME, 'hud-settings.json')
      );
      assert.equal(passed.HUD_DISPLAY_HOME, join(env.HUD_HOME, 'display'));
      assert.equal('CODEX_HOME' in passed, false);
      effects.push('split');
      await invoke('split', [s.file(panelKey(c), 'intent'), JSON.stringify(passed)], d);
      const pane = `panel-${++splitCount}`;
      panes.set(pane, {
        pane,
        tab: origin.tab,
        terminal: 'panel-term',
        workspace: origin.workspace,
        process: SHELL,
        atPrompt: true,
      });
      await splitGate;
      if (splitTimeout) {
        splitTimeout = false;
        throw new Error('herdr_timeout');
      }
      return pane;
    },
    async start(pane, argv, d) {
      effects.push('start');
      const r = s.read(panelKey(c))!;
      assert.deepEqual(argv, panelArgv(r));
      await invoke('start', [pane, ...argv], d);
      if (!missingRegistration) saveJson(s.registration(r.token), { generation: r.generation, panel: panes.get(pane) });
      if (startTimeout) throw new Error('herdr_timeout');
    },
    async close(pane, d) {
      assert.match(pane, /^panel-\d+$/, 'never close main or a worker');
      effects.push('close');
      await invoke('close', [pane], d);
      panes.delete(pane);
    },
  };
  const options: PanelControlOptions = {
    env,
    herdr: h,
    native,
    processInfo: () => PROC,
    processLaunch: () => ({ argv: ['pi'], env: {} }),
    registered: () => true,
    budgetMs: 4000,
  };
  return {
    dir,
    env,
    c,
    s,
    h,
    native,
    options,
    effects,
    panes,
    log,
    get peak() {
      return peak;
    },
    replaceInstance: () => {
      instance = 'herdr:replacement';
    },
    noRegistration: () => {
      missingRegistration = true;
    },
    timeoutSplit: () => {
      splitTimeout = true;
    },
    timeoutStart: () => {
      startTimeout = true;
    },
    gate: (p: Promise<void>) => {
      splitGate = p;
    },
  };
}
async function open(f: ReturnType<typeof setup>, options = f.options) {
  const result = await controlPanel('open', f.c, options);
  assert.equal(result.diagnostic, 'open');
  assert.equal(result.receipt?.phase, 'open');
  return result.receipt!;
}
test('panel intent precedes split, unique tokens, duplicate open is idempotent, display-only paths and exact env', async (t) => {
  const f = setup(t);
  const [r, duplicate] = await Promise.all([open(f), open(f)]);
  assert.equal(r.generation, duplicate.generation);
  assert.deepEqual(f.effects, ['split', 'start']);
  assert.equal(f.peak, 1);
  assert.deepEqual(fs.readdirSync(f.env.CODEX_HOME), []);
  assert.ok(f.s.directory.startsWith(join(f.env.HUD_HOME, 'display')));
  assert.equal(fs.statSync(f.s.file(panelKey(f.c))).mode & 0o777, 0o600);
  await controlPanel('close', f.c, { ...f.options, generation: r.generation });
  const next = await open(f);
  assert.notEqual(next.token, r.token);
  assert.notEqual(next.generation, r.generation);
  const effects = f.effects.length;
  const late = await controlPanel('close', f.c, { ...f.options, generation: r.generation });
  assert.equal(late.diagnostic, 'panel_stale_generation');
  assert.equal(f.effects.length, effects);
});
test('panel split env keeps the caller settings path, neutral name first, legacy alias second', async (t) => {
  const legacy = setup(t, { CODEX_HUD_SETTINGS_PATH: '/synthetic/legacy/hud-settings.json' });
  await open(legacy);
  assert.deepEqual(legacy.effects, ['split', 'start']);
  const both = setup(t, {
    HUD_SETTINGS_PATH: '/synthetic/neutral/hud-settings.json',
    CODEX_HUD_SETTINGS_PATH: '/synthetic/legacy/hud-settings.json',
  });
  await open(both);
  assert.deepEqual(both.effects, ['split', 'start']);
});
test('panel receipt loss reconciles original token instead of creating again', async (t) => {
  const f = setup(t);
  const r = await open(f);
  fs.unlinkSync(f.s.file(panelKey(f.c)));
  const again = await open(f);
  assert.equal(again.token, r.token);
  assert.deepEqual(f.effects, ['split', 'start']);
});
test('panel total receipt loss fails closed and generation-specific close fences cannot overwrite one another', async (t) => {
  const f = setup(t);
  const old = await open(f);
  const next = { ...old, generation: 'b'.repeat(36) };
  f.s.fence(next);
  f.s.fence(old);
  assert.equal(f.s.fenced(next), true);
  const reordered = {
    ...f.c,
    main: { proc_start: STAMP.proc_start, boot_id: STAMP.boot_id, pid_domain: STAMP.pid_domain, pid: STAMP.pid },
  };
  assert.equal(panelKey(reordered), panelKey(f.c));
  fs.unlinkSync(f.s.file(panelKey(f.c)));
  fs.unlinkSync(f.s.file(panelKey(f.c), 'intent'));
  assert.equal((await controlPanel('open', f.c, f.options)).diagnostic, 'panel_receipt_lost');
  assert.equal((await controlPanel('status', f.c, f.options)).diagnostic, 'panel_receipt_lost');
  assert.deepEqual(f.effects, ['split', 'start']);
});
test('panel split-only lost reply is uncertain with guidance and never automatically recreates or guesses a pane', async (t) => {
  const f = setup(t);
  f.timeoutSplit();
  const first = await controlPanel('open', f.c, f.options);
  assert.equal(first.receipt?.phase, 'uncertain');
  assert.equal(first.receipt?.reason, 'split_reply_lost');
  assert.equal(first.diagnostic, 'split_reply_lost');
  assert.match(first.message!, /empty pane.*manual closing/);
  assert.equal(first.receipt?.createdPane, undefined);
  assert.equal(first.receipt?.panel, null);
  assert.equal(readJson(f.s.registration(first.receipt!.token)), null);
  const originals = { ...f.h };
  for (const name of Object.keys(f.h) as (keyof PanelHerdr)[])
    Object.assign(f.h, {
      [name]: async () => {
        assert.fail('lost split must make no further herdr calls automatically');
      },
    });
  const auto = await controlPanel('open', f.c, { ...f.options, automatic: true });
  assert.equal(auto.diagnostic, 'split_reply_lost');
  assert.equal(auto.receipt?.generation, first.receipt?.generation);
  assert.equal((await controlPanel('status', f.c, f.options)).diagnostic, 'split_reply_lost');
  assert.deepEqual(f.effects, ['split']);
  Object.assign(f.h, originals);
});
test('panel explicit open after a lost split starts exactly one fresh generation and leaves the unknown orphan untouched', async (t) => {
  const f = setup(t);
  f.timeoutSplit();
  const lost = await controlPanel('open', f.c, f.options);
  const next = await open(f);
  assert.notEqual(next.generation, lost.receipt?.generation);
  assert.notEqual(next.token, lost.receipt?.token);
  assert.equal(next.panel?.pane, 'panel-2');
  assert.equal(f.panes.has('panel-1'), true);
  assert.deepEqual(f.effects, ['split', 'split', 'start']);
  await controlPanel('open', f.c, { ...f.options, automatic: true });
  assert.deepEqual(f.effects, ['split', 'split', 'start']);
});
test('panel known-pane lost run reply with late token registration reconciles without another start', async (t) => {
  const f = setup(t);
  f.noRegistration();
  const start = f.h.start;
  f.h.start = async (pane, argv, d) => {
    await start(pane, argv, d);
    const r = f.s.read(panelKey(f.c))!;
    assert.equal(r.createdPane, pane);
    assert.ok(f.effects.includes('start'));
    const timer = setTimeout(
      () => saveJson(f.s.registration(r.token), { generation: r.generation, panel: f.panes.get(pane) }),
      100
    );
    t.after(() => clearTimeout(timer));
    throw new Error('herdr_timeout');
  };
  const r = await open(f);
  assert.equal(r.createdPane, 'panel-1');
  await open(f);
  assert.deepEqual(f.effects, ['split', 'start']);
});
test('panel lost start reply reconciles token without resending start', async (t) => {
  const f = setup(t);
  f.timeoutStart();
  await open(f);
  await open(f);
  assert.deepEqual(f.effects, ['split', 'start']);
});
test('panel missing token registration stays uncertain and makes one bounded guarded close', async (t) => {
  const f = setup(t);
  f.noRegistration();
  const result = await controlPanel('open', f.c, { ...f.options, budgetMs: 1500 });
  assert.equal(result.receipt?.phase, 'uncertain');
  assert.equal(result.diagnostic, 'panel_registration_missing');
  assert.deepEqual(f.effects, ['split', 'start', 'close']);
  await controlPanel('open', f.c, { ...f.options, automatic: true });
  assert.deepEqual(f.effects, ['split', 'start', 'close']);
});
test('panel close before open completes fences the opening generation without another split/start', async (t) => {
  const f = setup(t);
  let release!: () => void;
  f.gate(
    new Promise<void>((r) => {
      release = r;
    })
  );
  const opening = controlPanel('open', f.c, f.options);
  while (!f.effects.includes('split')) await delay(5);
  const r = f.s.read(panelKey(f.c))!;
  const closing = controlPanel('close', f.c, { ...f.options, generation: r.generation });
  assert.equal(f.s.fenced(r), true);
  release();
  assert.equal((await opening).receipt?.phase, 'closed');
  assert.equal((await closing).receipt?.phase, 'closed');
  assert.deepEqual(f.effects, ['split', 'close']);
});
test('panel native epoch replacement while preflight is pending refuses without intent or split', async (t) => {
  const f = setup(t);
  let release!: () => void;
  let entered!: () => void;
  let current = true;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.h.preflight = async () => {
    entered();
    await gate;
    return f.c.instance;
  };
  const opening = controlPanel('open', f.c, { ...f.options, isCurrent: () => current });
  await ready;
  current = false;
  release();
  const result = await opening;
  assert.equal(result.diagnostic, 'panel_stale_context');
  assert.equal(result.receipt, null);
  assert.equal(readJson(f.s.file(panelKey(f.c), 'intent')), null);
  assert.deepEqual(f.effects, []);
});
test('panel origin reused during preflight is refused before intent or split', async (t) => {
  const f = setup(t);
  f.h.preflight = async () => {
    f.panes.set('main', { ...f.c.origin, terminal: 'reused-main' });
    return f.c.instance;
  };
  const result = await controlPanel('open', f.c, f.options);
  assert.equal(result.diagnostic, 'panel_origin_unverified');
  assert.equal(readJson(f.s.file(panelKey(f.c), 'intent')), null);
  assert.deepEqual(f.effects, []);
});
test('panel native epoch replacement after split closes only that created pane and leaves the new generation untouched', async (t) => {
  const f = setup(t);
  let release!: () => void;
  let current = true;
  f.gate(
    new Promise<void>((resolve) => {
      release = resolve;
    })
  );
  const opening = controlPanel('open', f.c, { ...f.options, isCurrent: () => current });
  while (!f.effects.includes('split')) await delay(5);
  const old = f.s.read(panelKey(f.c))!;
  current = false;
  const context = { ...f.c, target: displayTarget('pi', 'session-2', f.c.target.source) };
  const native = {
    ...f.native,
    identity: { harness: 'pi' as const, root: { namespace: context.target.ref.sourceId, sessionId: 'session-2' } },
  };
  const replacement = controlPanel('open', context, { ...f.options, native, isCurrent: () => true });
  release();
  assert.equal((await opening).receipt?.phase, 'closed');
  const next = await replacement;
  assert.equal(next.receipt?.phase, 'open');
  assert.deepEqual(f.effects, ['split', 'close', 'split', 'start']);
  const late = await controlPanel('close', f.c, { ...f.options, generation: old.generation });
  assert.equal(late.diagnostic, 'panel_stale_generation');
  assert.equal(f.panes.has(next.receipt!.panel!.pane), true);
  assert.equal(f.s.fenced(next.receipt!), false);
});
test('panel late old generation end cannot close a replacement root', async (t) => {
  const f = setup(t);
  const old = await open(f);
  const newC = { ...f.c, target: displayTarget('pi', 'session-2', f.c.target.source) };
  const native = {
    ...f.native,
    identity: { harness: 'pi' as const, root: { namespace: newC.target.ref.sourceId, sessionId: 'session-2' } },
  };
  const next = await controlPanel('open', newC, { ...f.options, native });
  assert.equal(next.receipt?.phase, 'open');
  const before = f.effects.length;
  const late = await controlPanel('close', f.c, { ...f.options, generation: old.generation });
  assert.equal(late.diagnostic, 'panel_stale_generation');
  assert.equal(f.effects.length, before);
  assert.equal(f.s.read(panelKey(f.c))!.target.root, newC.target.root);
});
test('panel occupied/reused pane is refused, and close never touches other tabs/jobs/main', async (t) => {
  const f = setup(t);
  const r = await open(f);
  f.panes.set('worker-pane', { ...f.c.origin, pane: 'worker-pane', tab: 'worker-tab' });
  f.panes.set('panel-1', { ...r.panel!, terminal: 'reused-terminal', process: { ...STAMP, pid: 99999 } });
  const close = await controlPanel('close', f.c, { ...f.options, generation: r.generation });
  assert.equal(close.diagnostic, 'panel_occupant_changed');
  assert.equal(close.receipt?.phase, 'uncertain');
  assert.deepEqual(f.effects, ['split', 'start']);
  assert.ok(f.panes.has('main'));
  assert.ok(f.panes.has('worker-pane'));
  await controlPanel('open', f.c, f.options);
  assert.deepEqual(f.effects, ['split', 'start']);
});
test('panel instance replacement refuses close; missing herdr reports a diagnostic without split', async (t) => {
  const f = setup(t);
  const r = await open(f);
  f.replaceInstance();
  const result = await controlPanel('close', f.c, { ...f.options, generation: r.generation });
  assert.equal(result.diagnostic, 'herdr_instance_changed');
  assert.deepEqual(f.effects, ['split', 'start']);
  const g = setup(t);
  g.h.preflight = async () => {
    throw new Error('herdr_unavailable');
  };
  assert.equal((await controlPanel('open', g.c, g.options)).diagnostic, 'herdr_unavailable');
  assert.deepEqual(g.effects, []);
});
test('panel auto-open requires native top-level TUI proof; inherited HERDR_PANE_ID alone is not proof', async (t) => {
  const f = setup(t);
  const no = await controlPanel('open', f.c, {
    ...f.options,
    native: null,
    automatic: true,
    env: { ...f.env, HERDR_PANE_ID: 'main' },
  });
  assert.equal(no.diagnostic, 'panel_eligibility_unknown');
  assert.deepEqual(f.effects, []);
  for (const native of [
    { ...f.native, topology: 'worker' as const },
    { ...f.native, ui: 'rpc' as const },
    { ...f.native, verified: false },
  ]) {
    assert.notEqual((await controlPanel('open', f.c, { ...f.options, native, automatic: true })).diagnostic, 'open');
  }
  assert.deepEqual(f.effects, []);
  const r = await open(f, { ...f.options, automatic: true });
  assert.equal(r.phase, 'open');
});
test('panel worker negatives, foreground identity, PID reuse and disabled preference are checked independently', async (t) => {
  const f = setup(t);
  for (const argv of [
    ['pi', '--hud-role-contract', '/synthetic'],
    ['claude', '--agent-id=worker'],
    ['pi', '--role-bundle', 'bundle'],
  ]) {
    assert.ok(workerLaunch({ argv, env: {} }));
    assert.equal(
      (await controlPanel('open', f.c, { ...f.options, processLaunch: () => ({ argv, env: {} }) })).diagnostic,
      'panel_worker_session'
    );
  }
  // Named top-level agents are not implicitly workers.
  assert.equal(workerLaunch({ argv: ['claude', '--agent', 'named-top-level'], env: {} }), false);
  const changed = await controlPanel('open', f.c, {
    ...f.options,
    processInfo: () => ({ ...PROC, stamp: { ...STAMP, proc_start: 'new' } }),
  });
  assert.equal(changed.diagnostic, 'panel_process_unknown');
  const notForeground = await controlPanel('open', f.c, {
    ...f.options,
    processInfo: () => ({ ...PROC, foregroundPgid: 999 }),
  });
  assert.equal(notForeground.diagnostic, 'panel_origin_unverified');
  saveJson(join(f.env.HUD_HOME, 'integration-config.json'), { panelAutoOpen: false });
  assert.equal(
    (await controlPanel('open', f.c, { ...f.options, automatic: true })).diagnostic,
    'panel_auto_open_disabled'
  );
  assert.deepEqual(f.effects, []);
});
test('panel split-reported workspace is durable before the first readiness observation', async (t) => {
  const f = setup(t);
  const split = f.h.split,
    observe = f.h.observe;
  f.h.split = async (...args) => {
    const p = await split(...args);
    return { pane: typeof p === 'string' ? p : p.pane, workspace: 'workspace-1' };
  };
  f.h.observe = async (pane, d) => {
    if (pane !== 'main') assert.equal(f.s.read(panelKey(f.c))?.createdWorkspace, 'workspace-1');
    return observe(pane, d);
  };
  assert.equal((await open(f)).createdWorkspace, 'workspace-1');
});
test('panel startup retains the split ID and waits for transient evidence and the original shell to become ready', async (t) => {
  const f = setup(t);
  const observe = f.h.observe;
  let samples = 0;
  f.h.observe = async (pane, d) => {
    if (pane === 'main') return observe(pane, d);
    assert.equal(f.s.read(panelKey(f.c))?.createdPane, pane);
    const actual = (await observe(pane, d))!;
    samples++;
    if (samples === 1) throw new Error('panel_occupant_unknown');
    if (samples === 2) return { ...actual, shell: SHELL, process: { ...SHELL, pid: 12347 }, atPrompt: false };
    return { ...actual, shell: SHELL, atPrompt: true };
  };
  const r = await open(f);
  assert.ok(samples >= 3);
  assert.equal(r.createdPane, 'panel-1');
  assert.deepEqual(f.effects, ['split', 'start']);
});
test('panel startup readiness expiry closes only the recorded original occupant without running a command', async (t) => {
  const f = setup(t);
  const observe = f.h.observe;
  f.h.observe = async (pane, d) => {
    const p = await observe(pane, d);
    return pane === 'main' || !p ? p : { ...p, shell: SHELL, atPrompt: false };
  };
  const result = await controlPanel('open', f.c, { ...f.options, budgetMs: 1500 });
  assert.equal(result.receipt?.createdPane, 'panel-1');
  assert.equal(result.receipt?.phase, 'closed');
  assert.deepEqual(f.effects, ['split', 'close']);
  await controlPanel('open', f.c, { ...f.options, automatic: true });
  assert.deepEqual(f.effects, ['split', 'close']);
});
test('panel startup with unavailable identity retains its known pane ID and never closes a guessed occupant', async (t) => {
  const f = setup(t);
  const observe = f.h.observe;
  f.h.observe = async (pane, d) => {
    if (pane === 'main') return observe(pane, d);
    throw new Error('startup_unknown');
  };
  const result = await controlPanel('open', f.c, { ...f.options, budgetMs: 1500 });
  assert.equal(result.receipt?.phase, 'uncertain');
  assert.equal(result.receipt?.createdPane, 'panel-1');
  assert.equal(result.receipt?.panel, null);
  assert.deepEqual(f.effects, ['split']);
});
test('panel startup refuses a reused terminal while waiting for readiness', async (t) => {
  const f = setup(t);
  const observe = f.h.observe;
  let samples = 0;
  f.h.observe = async (pane, d) => {
    const p = await observe(pane, d);
    if (pane === 'main' || !p) return p;
    return { ...p, shell: SHELL, terminal: ++samples === 1 ? p.terminal : 'foreign-terminal', atPrompt: false };
  };
  const result = await controlPanel('open', f.c, f.options);
  assert.equal(result.diagnostic, 'panel_occupant_changed');
  assert.equal(result.receipt?.createdPane, 'panel-1');
  assert.deepEqual(f.effects, ['split']);
});
test('panel startup refuses a changed non-shell foreground rather than closing or typing into it', async (t) => {
  const f = setup(t);
  const observe = f.h.observe;
  let n = 0;
  f.h.observe = async (pane, d) => {
    const p = await observe(pane, d);
    if (pane === 'main' || !p) return p;
    return { ...p, shell: SHELL, process: { ...SHELL, pid: 12347 + n++ }, atPrompt: false };
  };
  const result = await controlPanel('open', f.c, f.options);
  assert.equal(result.diagnostic, 'panel_occupant_changed');
  assert.deepEqual(f.effects, ['split']);
});
test('panel production absence observation suppresses automatic reopening and permits an explicit fresh open', async (t) => {
  const f = setup(t);
  const r = await open(f);
  const socket = join(f.dir, 'absent-pane.sock');
  let inventory: unknown = [{ pane_id: 'panel-1' }];
  let workspaces: unknown = [{ workspace_id: 'workspace-1' }, { workspace_id: 'focused-other' }];
  let inventoryFails = false;
  let unscopedMetadata = false;
  const methods: string[] = [];
  const server = createServer((connection) => {
    let input = '';
    connection.on('data', (chunk) => {
      input += chunk.toString();
      if (!input.includes('\n')) return;
      const request = JSON.parse(input.trim());
      methods.push(request.method);
      connection.end(
        JSON.stringify(
          request.method === 'pane.get' && unscopedMetadata
            ? {
                id: request.id,
                result: { pane: { pane_id: 'panel-1', tab_id: 'main-tab', terminal_id: 'panel-term' } },
              }
            : request.method === 'workspace.list'
              ? { id: request.id, result: { workspaces } }
              : request.method === 'pane.list' && !inventoryFails
                ? {
                    id: request.id,
                    result: {
                      panes: request.params.workspace_id === 'workspace-1' ? inventory : [{ pane_id: 'other-pane' }],
                    },
                  }
                : { id: request.id, error: { code: 'pane_not_found', message: 'synthetic missing pane or workspace' } }
        ) + '\n'
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const adapter = new CliPanelHerdr({ socket, server: readProcess(process.pid)!.stamp, env: f.env });
  const observe = f.h.observe;
  f.panes.delete('panel-1');
  f.h.observe = (pane, d, workspace) => (pane === 'panel-1' ? adapter.observe(pane, d, workspace) : observe(pane, d));
  const d = new PanelDeadline(3500);
  t.after(() => d.dispose());
  // Explicit original scope still finds the pane after focus moved elsewhere.
  await assert.rejects(() => adapter.observe('panel-1', d, 'workspace-1'), /herdr_transport_unavailable/);
  assert.deepEqual(methods.splice(0), ['pane.get', 'pane.list']);
  // Even a successful get cannot claim ownership without a reported workspace.
  unscopedMetadata = true;
  await assert.rejects(() => adapter.observe('panel-1', d), /panel_workspace_unknown/);
  assert.deepEqual(methods.splice(0), ['pane.get']);
  unscopedMetadata = false;
  // Unknown scope neither accepts a focus-scoped inventory nor closes/recreates.
  f.s.write({ ...r, createdWorkspace: undefined, panel: { ...r.panel!, workspace: undefined } });
  const unknown = await controlPanel('open', f.c, { ...f.options, automatic: true });
  assert.equal(unknown.receipt?.phase, 'uncertain');
  assert.equal(unknown.diagnostic, 'panel_workspace_unknown');
  assert.equal(
    (await controlPanel('close', f.c, { ...f.options, generation: r.generation })).diagnostic,
    'panel_workspace_unknown'
  );
  assert.deepEqual(methods.splice(0), ['pane.get', 'pane.get']);
  assert.deepEqual(f.effects, ['split', 'start']);
  f.s.write(r);
  inventory = [{ pane_id: 'main' }];
  const automatic = await controlPanel('open', f.c, { ...f.options, automatic: true });
  assert.equal(automatic.receipt?.phase, 'closed');
  assert.equal(automatic.diagnostic, 'panel_manually_closed');
  assert.deepEqual(methods.splice(0), ['pane.get', 'pane.list', 'workspace.list']);
  assert.deepEqual(f.effects, ['split', 'start']);
  const next = await open(f);
  assert.notEqual(next.generation, r.generation);
  assert.equal(next.panel?.pane, 'panel-2');
  assert.deepEqual(f.effects, ['split', 'start', 'split', 'start']);
  // A get error plus invalid/incomplete inventory is uncertainty, not absence.
  inventory = null;
  await assert.rejects(() => adapter.observe('panel-1', d, 'workspace-1'), /herdr_transport_unavailable/);
  // If the workspace is gone, only its own authoritative list can confirm that.
  inventoryFails = true;
  workspaces = null;
  await assert.rejects(() => adapter.observe('panel-1', d, 'workspace-1'), /herdr_transport_unavailable/);
  workspaces = [];
  assert.equal(await adapter.observe('panel-1', d, 'workspace-1'), null);
  const replaced = new CliPanelHerdr({
    socket,
    server: { ...readProcess(process.pid)!.stamp, proc_start: '999' },
    env: f.env,
  });
  const count = methods.length;
  await assert.rejects(() => replaced.observe('panel-1', d, 'workspace-1'), /herdr_instance_changed/);
  assert.equal(methods.length, count);
});
for (const variant of ['missing workspace', 'different workspace', 'unavailable occupant'] as const) {
  test(`panel positive get with ${variant} never becomes absence through an excluding inventory`, async (t) => {
    const f = setup(t);
    const r = await open(f);
    const socket = join(f.dir, 'positive-get.sock');
    const methods: string[] = [];
    const server = createServer((connection) => {
      let input = '';
      connection.on('data', (chunk) => {
        input += chunk.toString();
        if (!input.includes('\n')) return;
        const request = JSON.parse(input.trim());
        methods.push(request.method);
        const result =
          request.method === 'pane.get'
            ? {
                pane: {
                  pane_id: 'panel-1',
                  tab_id: 'main-tab',
                  terminal_id: 'panel-term',
                  ...(variant === 'missing workspace'
                    ? {}
                    : { workspace_id: variant === 'different workspace' ? 'workspace-2' : 'workspace-1' }),
                },
              }
            : request.method === 'pane.list'
              ? { panes: [] }
              : request.method === 'workspace.list'
                ? { workspaces: [{ workspace_id: 'workspace-1' }, { workspace_id: 'workspace-2' }] }
                : null;
        connection.end(
          JSON.stringify(
            result
              ? { id: request.id, result }
              : {
                  id: request.id,
                  error: { code: 'process_unavailable', message: 'synthetic process evidence failure' },
                }
          ) + '\n'
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const adapter = new CliPanelHerdr({ socket, server: readProcess(process.pid)!.stamp, env: f.env });
    const observe = f.h.observe;
    f.h.observe = (pane, d, workspace) => (pane === 'panel-1' ? adapter.observe(pane, d, workspace) : observe(pane, d));
    for (const operation of ['automatic open', 'explicit open', 'close']) {
      const result = await controlPanel(operation === 'close' ? 'close' : 'open', f.c, {
        ...f.options,
        automatic: operation === 'automatic open',
        generation: r.generation,
      });
      assert.equal(result.receipt?.phase, 'uncertain');
      assert.equal(result.receipt?.generation, r.generation);
      assert.equal(
        result.diagnostic,
        variant === 'missing workspace'
          ? 'panel_workspace_unknown'
          : variant === 'different workspace'
            ? 'panel_workspace_changed'
            : 'herdr_transport_unavailable'
      );
      assert.deepEqual(f.effects, ['split', 'start']);
    }
    assert.deepEqual(
      methods,
      variant === 'unavailable occupant'
        ? Array.from({ length: 3 }, () => ['pane.get', 'pane.process_info']).flat()
        : ['pane.get', 'pane.get', 'pane.get']
    );
  });
}
test('panel manual close is not resurrected by repeated auto-open; explicit on reopens', async (t) => {
  const f = setup(t);
  const r = await open(f);
  f.panes.delete('panel-1');
  const manual = await controlPanel('open', f.c, { ...f.options, automatic: true });
  assert.equal(manual.diagnostic, 'panel_manually_closed');
  assert.equal(manual.receipt?.phase, 'closed');
  await controlPanel('open', f.c, { ...f.options, automatic: true });
  assert.equal(f.effects.length, 2);
  const reopened = await open(f);
  assert.notEqual(reopened.generation, r.generation);
});
test('panel display receipt is refused by actual job-control API, including when placed in a job path', async (t) => {
  const f = setup(t);
  const r = await open(f);
  const ctx = { home: f.env.HUD_HOME, root: f.native.identity.root, env: f.env };
  assert.equal((await hudClose(ctx, { job: r })).code, 'invalid_arguments');
  saveJson(join(f.env.HUD_HOME, 'jobs', r.token, 'receipt.json'), r);
  const result = await hudClose(ctx, { job: r.token });
  assert.equal(result.ok, false);
  assert.equal(f.effects.includes('close'), false);
});
test('panel CLI harness/session/source parsing preserves --root and rejects unvalidated session before split', async (t) => {
  const f = setup(t);
  for (const harness of ['claude', 'pi', 'codex']) {
    const result = panelSelection(
      ['--harness', harness, '--session', 'synthetic', '--source', f.c.target.source],
      f.env
    );
    assert.notEqual(result.root, `${harness}/synthetic`);
    assert.equal(result.target?.harness, harness);
  }
  assert.equal(panelRoot(['--root', 'synthetic/session']), 'synthetic/session');
  for (const id of ['bad\nid', 'bad\x1bid', '../bad', 'bad id', '$(touch nope)']) {
    assert.throws(() => panelSelection(['--harness', 'pi', '--session', id, '--source', f.c.target.source], f.env));
    await assert.rejects(() =>
      controlPanel('open', { ...f.c, target: { ...f.c.target, ref: { ...f.c.target.ref, sessionId: id } } }, f.options)
    );
  }
  assert.deepEqual(f.effects, []);
});
test('panel HUD-built command argv quoting round-trip executes no shell expansion from source path', async (t) => {
  const f = setup(t);
  const source = join(f.dir, "spaces 'quote' $DOLLAR `touch injected` $(touch injected2)");
  fs.mkdirSync(source);
  const dump = join(f.dir, 'dump.mjs');
  const output = join(f.dir, 'argv.json');
  fs.writeFileSync(
    dump,
    'import fs from "node:fs";fs.writeFileSync(process.env.OUT, JSON.stringify(process.argv.slice(2)));'
  );
  const target = displayTarget('pi', 'strict-id', source);
  const r = {
    ...f.c,
    target,
    runtime: { ...f.c.runtime, entry: dump },
    schema: 1,
    kind: 'hud-panel-display',
    token: 'a'.repeat(36),
    generation: 'b'.repeat(36),
    phase: 'opening',
    panel: null,
  } as PanelReceipt;
  const argv = panelArgv(r);
  const result = spawnSync('/bin/sh', ['-c', commandText({ argv })], { env: { ...f.env, OUT: output }, cwd: f.dir });
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')), argv.slice(2));
  assert.equal(fs.existsSync(join(f.dir, 'injected')), false);
  assert.equal(fs.existsSync(join(f.dir, 'injected2')), false);
});
test('panel hook-facing input is <=64 KiB and has a deadline below hook timeout', async () => {
  assert.ok(PANEL_OPERATION_MS + 500 < PANEL_HOOK_TIMEOUT_MS);
  const valid = new PassThrough();
  const parsed = readPanelInput(valid);
  valid.end('{"op":"status"}');
  assert.deepEqual(await parsed, { op: 'status' });
  const big = new PassThrough();
  const rejected = readPanelInput(big);
  big.end(Buffer.alloc(PANEL_INPUT_MAX + 1));
  await assert.rejects(rejected, /panel_input_oversize/);
  await assert.rejects(readPanelInput(new PassThrough(), 10), /panel_input_deadline/);
});
test('panel bounded transport detaches leaked stdout descriptors and does not retain subprocess handles', async (t) => {
  const f = setup(t);
  const before = fs.readdirSync('/proc/self/fd').length;
  const out = await runCommand(process.execPath, [FAKE, f.log, 'leak'], f.env, { budgetMs: 700 });
  assert.equal(out.reason, 'timeout');
  const pid = Number(fs.readFileSync(f.log + '.pid', 'utf8'));
  t.after(() => {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  });
  await delay(20);
  assert.ok(fs.readdirSync('/proc/self/fd').length <= before + 2);
});
function monitor(
  f: ReturnType<typeof setup>,
  r: PanelReceipt,
  more: Partial<Parameters<typeof installPanelLifetime>[0]> = {}
) {
  const reasons: string[] = [];
  const signals = new EventEmitter();
  const m = installPanelLifetime({
    env: f.env,
    receipt: r,
    herdr: f.h,
    end: (s) => reasons.push(s),
    terminal: () => true,
    signals,
    processAlive: () => 'alive',
    registered: () => true,
    ...more,
  });
  return { m, signals, reasons };
}
test('panel lifetime ends on main exit, replaced generation, terminal HUP/loss, lost identity and manual close', async (t) => {
  for (const scenario of ['main', 'generation', 'hup', 'terminal', 'identity', 'closed', 'instance']) {
    const f = setup(t);
    const r = await open(f);
    const x = monitor(
      f,
      r,
      scenario === 'main' ? { processAlive: () => 'dead' } : scenario === 'terminal' ? { terminal: () => false } : {}
    );
    t.after(() => x.m.dispose());
    if (scenario === 'generation') f.s.write({ ...r, generation: 'c'.repeat(36) });
    if (scenario === 'identity') f.panes.set('panel-1', { ...r.panel!, terminal: 'reused' });
    if (scenario === 'closed') f.s.fence(r);
    if (scenario === 'instance') f.replaceInstance();
    if (scenario === 'hup') x.signals.emit('SIGHUP');
    else await delay(1100);
    assert.equal(x.reasons.length, 1, scenario);
    assert.equal(x.m.disposed, true);
    assert.equal(x.signals.listenerCount('SIGHUP'), 0);
    assert.deepEqual(f.effects, ['split', 'start']);
  }
});
test('panel lifetime detects a real synthetic parent crash using its pinned process stamp', async (t) => {
  const f = setup(t);
  const initial = await open(f);
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { env: f.env, stdio: 'ignore' });
  t.after(() => child.kill('SIGKILL'));
  const r = { ...initial, main: readProcess(child.pid!)!.stamp };
  f.s.write(r);
  const x = monitor(f, r, { processAlive: processState });
  t.after(() => x.m.dispose());
  child.kill('SIGKILL');
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  await delay(1100);
  assert.deepEqual(x.reasons, ['panel_main_exited']);
  assert.equal(x.m.disposed, true);
});
test('panel lifetime has one single-flight cadence, at most one herdr sample per 3s, deadline, and no restart', async (t) => {
  const f = setup(t);
  const r = await open(f);
  const times: number[] = [];
  let active = 0;
  let peak = 0;
  f.h.observe = async () => {
    active++;
    peak = Math.max(peak, active);
    times.push(performance.now());
    await delay(100);
    active--;
    return r.panel;
  };
  const x = monitor(f, r);
  t.after(() => x.m.dispose());
  await delay(5300);
  x.m.dispose();
  assert.ok(times.length >= 2 && times.length <= 3);
  assert.equal(peak, 1);
  for (let n = 1; n < times.length; n++) assert.ok(times[n]! - times[n - 1]! >= 2950);
  const count = times.length;
  await delay(1100);
  assert.equal(times.length, count);
  assert.deepEqual(f.effects, ['split', 'start']);
});
test('panel lifetime bounds unavailable herdr and disposes timers rather than polling/restarting forever', async (t) => {
  const f = setup(t);
  const r = await open(f);
  let wall = 0;
  let observations = 0;
  f.h.instance = async () => {
    observations++;
    wall += 4000;
    return new Promise<string>(() => {}); // deliberately ignores the adapter deadline
  };
  const x = monitor(f, r, { now: () => wall });
  t.after(() => x.m.dispose());
  const until = Date.now() + 5000;
  while (!x.m.disposed && Date.now() < until) await delay(20);
  // Each hung observation has a 500ms deadline; prolonged uncertainty exits locally.
  assert.equal(observations, 4);
  assert.deepEqual(x.reasons, ['panel_ownership_unavailable']);
  assert.equal(x.m.disposed, true);
});
test('panel real synthetic process stamps and forged registration are rejected by the process-image check', async (t) => {
  const f = setup(t);
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { env: f.env, stdio: 'ignore' });
  t.after(() => child.kill('SIGKILL'));
  assert.ok(child.pid);
  const stamp = readProcess(child.pid!)!.stamp;
  const r = await open(f);
  const pane = { ...r.panel!, process: stamp };
  assert.equal(registeredProcess(r, pane), false);
  assert.ok(readProcess(child.pid!));
  child.kill('SIGKILL');
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  assert.equal(readProcess(child.pid!), null);
});
test('panel actual internal CLI status works without herdr; hook JSON cannot forge native eligibility', async (t) => {
  const f = setup(t);
  const r = await open(f);
  const entry = fileURLToPath(new URL('../../src/integrations/panel/cli.js', import.meta.url));
  const payload = {
    context: f.c,
    endpoint: { socket: join(f.dir, 'absent.sock'), server: STAMP },
    native: f.native,
    generation: r.generation,
  };
  const status = spawnSync(process.execPath, [entry, 'status'], {
    env: f.env,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 8000,
  });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).phase, 'open');
  fs.unlinkSync(f.s.file(panelKey(f.c)));
  fs.unlinkSync(f.s.file(panelKey(f.c), 'intent'));
  const lost = spawnSync(process.execPath, [entry, 'status'], {
    env: f.env,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 8000,
  });
  assert.equal(lost.status, 3);
  assert.equal(JSON.parse(lost.stdout).phase, 'uncertain');
  assert.equal(JSON.parse(lost.stdout).diagnostic, 'panel_receipt_lost');
  const g = setup(t);
  const unverified = spawnSync(process.execPath, [entry, 'open'], {
    env: g.env,
    input: JSON.stringify({ ...payload, context: g.c }),
    encoding: 'utf8',
    timeout: 8000,
  });
  assert.equal(unverified.status, 3);
  assert.equal(JSON.parse(unverified.stdout).diagnostic, 'panel_eligibility_unknown');
  assert.equal(g.s.read(panelKey(g.c)), null);
  g.timeoutSplit();
  await controlPanel('open', g.c, g.options);
  const splitLost = spawnSync(process.execPath, [entry, 'status'], {
    env: g.env,
    input: JSON.stringify({ ...payload, context: g.c }),
    encoding: 'utf8',
    timeout: 8000,
  });
  assert.equal(splitLost.status, 3);
  assert.equal(JSON.parse(splitLost.stdout).diagnostic, 'split_reply_lost');
  assert.match(JSON.parse(splitLost.stdout).message, /empty pane.*manual closing/);
});
test('panel production preflight preserves the compatibility gate and refuses missing split/close capabilities before effects', async (t) => {
  const f = setup(t);
  const socket = join(f.dir, 'fake.sock');
  const server = createServer((connection) => {
    let input = '';
    connection.on('data', (chunk) => {
      input += chunk.toString();
      if (!input.includes('\n')) return;
      const request = JSON.parse(input.trim());
      connection.end(JSON.stringify({ id: request.id, result: { version: '0.9.5', protocol: 22 } }) + '\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const binary = join(f.dir, 'herdr');
  fs.copyFileSync(FAKE, binary);
  fs.chmodSync(binary, 0o700);
  const log = join(f.dir, 'preflight.log');
  const schemaFile = join(f.dir, 'schema.json');
  const methods = [
    'ping',
    'session.snapshot',
    'pane.get',
    'pane.process_info',
    'pane.layout',
    'tab.create',
    'pane.split',
    'agent.prompt',
    'pane.close',
  ];
  const schema = {
    schema_version: 1,
    protocol: 22,
    schemas: {
      request: {
        oneOf: methods.map((name) => ({ properties: { method: { const: name } } })),
        $defs: { PaneSplitParams: { properties: { env: {}, focus: {}, target_pane_id: {} } } },
      },
    },
  };
  const make = () =>
    new CliPanelHerdr({
      socket,
      server: readProcess(process.pid)!.stamp,
      env: { ...f.env, PANEL_FAKE_LOG: log, PANEL_FAKE_SCHEMA_FILE: schemaFile },
      binary,
    });
  fs.writeFileSync(schemaFile, JSON.stringify(schema));
  const d = new PanelDeadline(4000);
  t.after(() => d.dispose());
  assert.ok(await make().preflight(d));
  schema.schemas.request.oneOf.pop();
  fs.writeFileSync(schemaFile, JSON.stringify(schema));
  const missing = new PanelDeadline(4000);
  t.after(() => missing.dispose());
  await assert.rejects(() => make().preflight(missing), /panel_launch_unsupported/);
  schema.protocol = 99;
  fs.writeFileSync(schemaFile, JSON.stringify(schema));
  const incompatible = new PanelDeadline(4000);
  t.after(() => incompatible.dispose());
  await assert.rejects(() => make().preflight(incompatible), /herdr_schema_mismatch/);
  const calls = fs
    .readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as string[]);
  assert.ok(calls.every((args) => args[0] === 'api' || args[0] === '--version' || args[2] === '--help'));
});
test('panel production adapter sends exact no-focus split env and quoted argv to subprocess fake herdr', async (t) => {
  const f = setup(t);
  const r = await open(f);
  const binary = join(f.dir, 'herdr');
  fs.copyFileSync(FAKE, binary);
  fs.chmodSync(binary, 0o700);
  const log = join(f.dir, 'production-argv.log');
  const adapter = new CliPanelHerdr({
    socket: join(f.dir, 'synthetic.sock'),
    server: STAMP,
    env: { ...f.env, PANEL_FAKE_LOG: log },
    binary,
  });
  const d = new PanelDeadline(3000);
  t.after(() => d.dispose());
  const env = { HUD_PANEL_TOKEN: r.token, HUD_HOME: f.env.HUD_HOME };
  assert.deepEqual(await adapter.split(r, env, d), { pane: 'panel-1', workspace: 'workspace-1' });
  await adapter.start('panel-1', panelArgv(r), d);
  await adapter.close('panel-1', d);
  const calls = fs
    .readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(calls, [
    [
      'pane',
      'split',
      'main',
      '--direction',
      'right',
      '--no-focus',
      '--cwd',
      r.target.source,
      '--env',
      `HUD_PANEL_TOKEN=${r.token}`,
      '--env',
      `HUD_HOME=${f.env.HUD_HOME}`,
      '--env',
      `HUD_PANEL_SOCKET=${join(f.dir, 'synthetic.sock')}`,
      '--env',
      `HUD_PANEL_SERVER=${JSON.stringify(STAMP)}`,
    ],
    ['pane', 'run', 'panel-1', commandText({ argv: panelArgv(r) })],
    ['pane', 'close', 'panel-1'],
  ]);
});
test('panel self-registers its actual process with the exact launch token without waiting on the control lock', async (t) => {
  const f = setup(t);
  const initial = await open(f);
  const module = new URL('../../src/integrations/panel/control.js', import.meta.url).href;
  const processModule = new URL('../../src/core/run/process.js', import.meta.url).href;
  fs.writeFileSync(
    f.c.runtime.entry,
    `import {registerPanel} from ${JSON.stringify(module)};
    import {readProcess} from ${JSON.stringify(processModule)};
    const panel={pane:'panel-1',tab:'main-tab',terminal:'panel-term',workspace:'workspace-1',process:readProcess(process.pid).stamp};
    const receipt=registerPanel(process.env,panel); console.log(receipt.panel.process.pid);
    setTimeout(()=>{},10000);`
  );
  const r = { ...initial, phase: 'opening' as const, panel: null };
  f.s.write(r);
  const argv = panelArgv(r);
  const child = spawn(argv[0]!, argv.slice(1), {
    env: { ...f.env, HUD_PANEL_KEY: panelKey(r), HUD_PANEL_TOKEN: r.token, HUD_PANEL_GENERATION: r.generation },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGKILL'));
  let stderr = '';
  child.stderr.on('data', (data) => {
    stderr += data;
  });
  const pid = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('registration deadline ' + stderr)), 3000);
    child.stdout.once('data', (chunk) => {
      clearTimeout(timer);
      resolve(Number(chunk.toString().trim()));
    });
    child.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('registration failed ' + stderr));
    });
  });
  assert.equal(pid, child.pid);
  const registration = readJson(f.s.registration(r.token)) as { generation: string; panel: PaneIdentity };
  assert.equal(registration.generation, r.generation);
  assert.equal(registration.panel.process.pid, pid);
  assert.equal(registeredProcess(r, registration.panel), true);
  assert.equal(registeredProcess({ ...r, token: 'c'.repeat(36) }, registration.panel), false);
});

test('panel codec refuses symlinks, oversized/corrupt receipt and main-pane ownership', async (t) => {
  const f = setup(t);
  const r = await open(f);
  assert.throws(() => decodeReceipt({ ...r, panel: f.c.origin }));
  fs.writeFileSync(f.s.file(panelKey(f.c)), ' '.repeat(16385));
  assert.throws(() => f.s.read(panelKey(f.c)), /unsafe|oversize/);
  fs.writeFileSync(f.s.file(panelKey(f.c)), '{bad json');
  assert.throws(() => f.s.read(panelKey(f.c)));
  fs.unlinkSync(f.s.file(panelKey(f.c)));
  fs.symlinkSync(join(f.dir, 'foreign'), f.s.file(panelKey(f.c)));
  assert.throws(() => f.s.read(panelKey(f.c)), /unsafe/);
});
