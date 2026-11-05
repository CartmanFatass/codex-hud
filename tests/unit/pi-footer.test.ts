import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { visualWidth } from '../../src/render/colors.js';
import {
  capturePiFooter,
  createPiFooterController,
  piFooterBranchUsage,
  renderPiFooter,
  validatePiFooterSummary,
  PI_FOOTER_MAX_ENTRIES,
  PI_FOOTER_SUMMARY_MAX_AGE_MS,
  PI_FOOTER_SOURCE,
  type PiFooterContext,
  type PiFooterFactory,
  type PiFooterHudSummary,
  type PiFooterIdentity,
} from '../../src/harness/pi/footer.js';

const NOW = 1_800_000_000_000;
const native: PiFooterIdentity = {
  sessionId: 'synthetic-session-a',
  sessionFile: '/synthetic/pi/a.jsonl',
  sessionDir: '/synthetic/pi',
  leafId: 'assistant-a',
};
function assistant(id = 'assistant-a', overrides: Record<string, unknown> = {}) {
  return {
    type: 'message',
    id,
    message: {
      role: 'assistant',
      content: [{ type: 'thinking', thinking: 'PRIVATE_THINKING' }],
      usage: {
        input: 100,
        output: 20,
        cacheRead: 40,
        cacheWrite: 10,
        cost: { total: 0.025 },
        ...overrides,
      },
    },
  };
}
const summary = (identity = native): PiFooterHudSummary => ({
  identity: { ...identity },
  observedAt: NOW,
  coverage: 'complete',
  delegated: { total: 3, working: 1, waiting: 1 },
});

function harness() {
  let identity = { ...native };
  let entries: unknown[] = [assistant()];
  let context: ReturnType<PiFooterContext['getContextUsage']> = { tokens: 150, contextWindow: 200000, percent: 0.075 };
  let idle = false,
    now = NOW,
    reads = 0,
    renders = 0,
    subscriptions = 0,
    restores = 0;
  let branch = 'synthetic-main';
  let component: ReturnType<PiFooterFactory> | undefined;
  const callbacks = new Set<() => void>();
  const statuses = new Map<string, string>();
  const notifications: string[] = [];
  const ctx: PiFooterContext & { ui: PiFooterContext['ui'] & { notify(text: string): void } } = {
    mode: 'tui',
    hasUI: true,
    model: { id: 'synthetic-model', provider: 'synthetic' },
    thinkingLevel: 'high',
    sessionManager: {
      getSessionId: () => identity.sessionId,
      getSessionFile: () => identity.sessionFile ?? undefined,
      getSessionDir: () => identity.sessionDir,
      getLeafId: () => identity.leafId,
      getBranch: () => {
        reads++;
        return entries;
      },
    },
    getContextUsage: () => context,
    isIdle: () => idle,
    ui: {
      notify: (text) => {
        notifications.push(text);
      },
      setFooter: (factory) => {
        component?.dispose();
        if (!factory) {
          component = undefined;
          restores++;
          return;
        }
        component = factory(
          {
            requestRender: () => {
              renders++;
            },
          },
          { fg: (_color, text) => text },
          {
            getGitBranch: () => branch,
            getExtensionStatuses: () => statuses,
            onBranchChange: (callback) => {
              callbacks.add(callback);
              subscriptions++;
              return () => {
                if (callbacks.delete(callback)) subscriptions--;
              };
            },
          }
        );
      },
    },
  };
  return {
    ctx,
    notifications,
    statuses,
    identity: (value: PiFooterIdentity) => {
      identity = value;
    },
    entries: (value: unknown[]) => {
      entries = value;
    },
    context: (value: typeof context) => {
      context = value;
    },
    idle: (value: boolean) => {
      idle = value;
    },
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    branch: (value: string) => {
      branch = value;
      for (const callback of callbacks) callback();
    },
    render: (width = 100) => component?.render(width) ?? [],
    component: () => component,
    stats: () => ({ reads, renders, subscriptions, restores }),
  };
}

test('Pi footer counts only current-branch assistant interactions, preserves components, and deduplicates IDs', () => {
  const result = piFooterBranchUsage([
    assistant(),
    assistant(),
    { type: 'usage', kind: 'cache_warm', usage: { input: 999, cost: { total: 99 } } },
    { type: 'compaction', usage: { input: 999, cost: { total: 99 } }, summary: 'PRIVATE_SUMMARY' },
    { type: 'message', id: 'tool', message: { role: 'toolResult', content: 'PRIVATE_TOOL' } },
    assistant('assistant-b', { input: 10, output: 2, cacheRead: 3, cacheWrite: 4, cost: { total: 0 } }),
  ]);
  assert.deepEqual(result, {
    input: 110,
    output: 22,
    cacheRead: 43,
    cacheWrite: 14,
    costUsd: 0.025,
    coverage: 'complete',
  });
  const message = assistant();
  Object.defineProperty(message.message, 'content', {
    get: () => {
      throw new Error('body must not be accessed');
    },
  });
  assert.equal(piFooterBranchUsage([message]).input, 100);
});

test('missing, conflicting, invalid and oversize native usage stays unknown/partial rather than a partial total', () => {
  const conflict = piFooterBranchUsage([assistant(), assistant('assistant-a', { output: 21 })]);
  assert.equal(conflict.input, 100);
  assert.equal(conflict.output, null);
  assert.equal(conflict.coverage, 'partial');
  const missing = piFooterBranchUsage([
    assistant(),
    assistant('assistant-b', { cost: undefined, cacheWrite: undefined }),
  ]);
  assert.equal(missing.input, 200);
  assert.equal(missing.costUsd, null);
  assert.equal(missing.cacheWrite, null);
  assert.equal(piFooterBranchUsage([assistant('a', { input: -1 })]).input, null);
  assert.equal(piFooterBranchUsage([assistant('a', { cost: { total: Infinity } })]).costUsd, null);
  assert.equal(piFooterBranchUsage([{ ...assistant(), id: '' }]).input, null);
  assert.equal(piFooterBranchUsage([{ type: 'message', message: null }]).input, null);
  assert.equal(piFooterBranchUsage(Array(PI_FOOTER_MAX_ENTRIES + 1).fill(null)).coverage, 'partial');
  assert.deepEqual(piFooterBranchUsage([]), {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    costUsd: 0,
    coverage: 'complete',
  });
});

test('native context keeps its estimated and post-compaction unknown semantics with explicit current identity', () => {
  const h = harness();
  const first = capturePiFooter(h.ctx, undefined, NOW);
  assert.deepEqual(first.identity, native);
  assert.equal(first.context.tokens, 150);
  assert.match(renderPiFooter(first, 200, NOW)[0], /ctx ~150\/200.0k/);
  h.context({ tokens: null, contextWindow: 200000, percent: null });
  h.idle(true);
  const compact = capturePiFooter(h.ctx, undefined, NOW);
  assert.equal(compact.context.tokens, null);
  assert.equal(compact.context.percent, null);
  assert.equal(compact.activity, 'idle');
  assert.match(renderPiFooter(compact, 200, NOW)[0], /ctx ~\?\/200.0k/);
  h.context(undefined);
  h.ctx.model = undefined;
  const absent = renderPiFooter(capturePiFooter(h.ctx), 200, NOW).join('\n');
  assert.match(absent, /model unknown/);
  assert.match(absent, /ctx unknown/);
  assert.match(absent, /HUD unavailable/);
  assert.ok(!absent.includes('PRIVATE_'));
});

test('explicit HUD summary requires exact native identity, complete coverage, bounded age and valid counts', () => {
  assert.equal(validatePiFooterSummary(summary(), native, NOW).state, 'current');
  for (const key of ['sessionId', 'sessionFile', 'sessionDir', 'leafId'] as const) {
    assert.equal(
      validatePiFooterSummary(summary({ ...native, [key]: 'other' }), native, NOW).state,
      'identity_mismatch'
    );
  }
  assert.equal(validatePiFooterSummary({ ...summary(), observedAt: NOW + 1 }, native, NOW).state, 'stale');
  assert.equal(validatePiFooterSummary(summary(), native, NOW + PI_FOOTER_SUMMARY_MAX_AGE_MS + 1).state, 'stale');
  assert.equal(validatePiFooterSummary({ ...summary(), coverage: 'partial' }, native, NOW).state, 'partial');
  assert.equal(
    validatePiFooterSummary({ ...summary(), delegated: { total: 1, working: 1, waiting: 1 } }, native, NOW).state,
    'invalid'
  );
  assert.equal(validatePiFooterSummary({ ...summary(), content: 'PRIVATE_SUMMARY' }, native, NOW).state, 'invalid');
  assert.equal(validatePiFooterSummary(undefined, native, NOW).state, 'unavailable');
  const raw = summary();
  const accepted = validatePiFooterSummary(raw, native, NOW);
  raw.delegated.total = 999;
  raw.identity.sessionId = 'changed';
  assert.equal(accepted.summary?.delegated.total, 3);
  assert.equal(accepted.summary?.identity.sessionId, native.sessionId);
});

test('footer renders safe, width-bounded native data and keeps extension status text', () => {
  const h = harness();
  h.ctx.model = { id: '模型\x1b[2J\n\u009b2J\u202eunsafe' };
  const snapshot = capturePiFooter(h.ctx);
  for (const width of [0, 1, 8, 32, 56, 100]) {
    const lines = renderPiFooter(snapshot, width, NOW, '分支\x1b]52;secret\x07', ['other\nstatus', '\u009b2J']);
    assert.ok(lines.every((line) => visualWidth(line) <= width));
    assert.ok(lines.every((line) => !/[\x00-\x1f\x7f-\x9f\u202a-\u202e]/.test(line)));
  }
  assert.deepEqual(renderPiFooter(snapshot, NaN), []);
  assert.match(renderPiFooter(snapshot, 100, NOW, null, ['other status']).at(-1)!, /other status/);
});

test('controller never traverses history on paint, refreshes current branch/model, and drops stale HUD summary', () => {
  const h = harness();
  let calls = 0;
  const controller = createPiFooterController({
    now: h.now,
    summary: (value) => {
      calls++;
      assert.ok(Object.isFrozen(value));
      return summary();
    },
  });
  controller.start(h.ctx);
  assert.match(h.render(200).join('\n'), /HUD 3 delegated/);
  for (let i = 0; i < 10; i++) h.render(80 + i);
  assert.equal(h.stats().reads, 1);
  assert.equal(calls, 1);
  h.advance(PI_FOOTER_SUMMARY_MAX_AGE_MS + 1);
  assert.match(h.render(200).join('\n'), /HUD stale/);
  h.identity({ ...native, leafId: 'other-branch' });
  h.entries([assistant('other', { input: 7, cost: { total: 0.001 } })]);
  h.ctx.model = { id: 'different-model' };
  controller.update(h.ctx);
  const next = h.render(200).join('\n');
  assert.match(next, /different-model/);
  assert.match(next, /↑7 /);
  assert.match(next, /HUD identity mismatch/);
  assert.ok(!next.includes('↑100 '));
  h.branch('different-git');
  assert.match(h.render(200).join('\n'), /git different-git/);
  assert.equal(h.stats().reads, 2);
  const old = h.component()!;
  controller.shutdown();
  controller.shutdown();
  assert.deepEqual(old.render(100), []);
  assert.equal(h.stats().subscriptions, 0);
});

test('TUI-only mounting, toggles and session replacement dispose subscriptions and never claim RPC UI', () => {
  const h = harness(),
    controller = createPiFooterController();
  for (const mode of ['rpc', 'json', 'print']) {
    h.ctx.mode = mode;
    controller.start(h.ctx);
    assert.deepEqual(h.render(), []);
    assert.equal(h.stats().reads, 0);
  }
  h.ctx.mode = 'tui';
  h.ctx.hasUI = false;
  controller.start(h.ctx);
  assert.deepEqual(h.render(), []);
  h.ctx.hasUI = true;
  controller.start(h.ctx);
  controller.start(h.ctx);
  assert.equal(h.stats().subscriptions, 1);
  controller.setEnabled(false, h.ctx);
  controller.update(h.ctx);
  assert.equal(h.stats().subscriptions, 0);
  controller.start(h.ctx);
  assert.deepEqual(h.render(), []);
  h.identity({ ...native, sessionId: 'new-session', sessionFile: '/synthetic/pi/new.jsonl', leafId: null });
  h.entries([]);
  controller.setEnabled(true, h.ctx);
  assert.match(h.render(200).join('\n'), /session new-session/);
  assert.match(h.render(200).join('\n'), /current branch: ↑0/);
  controller.shutdown();
  assert.equal(h.stats().subscriptions, 0);
});

test('actual extension entry registers pinned public events and command and runs its native footer factory', async () => {
  const source = readFileSync(resolve('extensions/pi/hud-footer.ts'), 'utf8');
  assert.ok(source.includes(PI_FOOTER_SOURCE));
  // Type-only SDK import is erased. Only the local build path is redirected to
  // this test build; all event handlers and factory/controller code are real.
  const js = ts
    .transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } })
    .outputText.replace(
      '../../dist/harness/pi/footer.js',
      new URL('../../src/harness/pi/footer.js', import.meta.url).href
    );
  const entry = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
  const h = harness();
  const handlers = new Map<string, (event: unknown, ctx: typeof h.ctx) => void>();
  let command: { handler(args: string, ctx: typeof h.ctx): Promise<void> } | undefined;
  entry.default({
    on: (name: string, handler: (event: unknown, ctx: typeof h.ctx) => void) => {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    },
    registerCommand: (name: string, value: typeof command) => {
      assert.equal(name, 'hud-footer');
      command = value;
    },
  });
  assert.deepEqual(
    [...handlers.keys()].sort(),
    [
      'agent_end',
      'agent_start',
      'message_end',
      'model_select',
      'session_compact',
      'session_shutdown',
      'session_start',
      'session_tree',
      'thinking_level_select',
    ].sort()
  );
  handlers.get('session_start')!({ type: 'session_start' }, h.ctx);
  assert.match(h.render(200).join('\n'), /current branch: ↑100/);
  h.context({ tokens: null, contextWindow: 200000, percent: null });
  handlers.get('session_compact')!({ type: 'session_compact' }, h.ctx);
  assert.match(h.render(200).join('\n'), /ctx ~\?/);
  await command!.handler('off', h.ctx);
  assert.deepEqual(h.render(), []);
  await command!.handler('on', h.ctx);
  assert.equal(h.stats().subscriptions, 1);
  await command!.handler('bad', h.ctx);
  assert.match(h.notifications.at(-1)!, /Usage/);
  handlers.get('session_shutdown')!({ type: 'session_shutdown' }, h.ctx);
  assert.equal(h.stats().subscriptions, 0);
});
