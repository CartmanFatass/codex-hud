import { expect, mock, test } from 'claude-code/testing';
import type { Engine } from 'claude-code/testing';
import type { On } from 'claude-code';

const surfaces = ['terminal', 'desktop', 'vscode', 'mobile'] as const;
const props = { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 8, bodyColumns: 60, scroll: { offset: 0, bodyRows: 8 }, view: {} };
const state = { lang: 'en', waiting: 2, first: 'Decide the export format' };

/** What the band draws from the state `held` says (none when undefined): each row's words, its button in brackets. */
function band(on: On) {
  let held: unknown;
  on('state.get', () => ({ value: { value: held ?? null, version: held === undefined ? 0 : 1 } }));
  return async ($: Engine, state: unknown, surface: (typeof surfaces)[number] = 'terminal', extra = {}) => {
    held = state;
    const ui = await $.ui.mount({ plugin: 'hud-mod', surface, component: 'AbovePrompt', props: { ...props, ...extra } });
    const texts = (await ui.findAll({ type: 'Text' })).map(text => text.text);
    const buttons = (await ui.findAll({ type: 'Button' })).map(button => button.text);
    await ui.unmount();
    return texts.map((text, i) => `${text.trimEnd()} [${buttons[i]}]`);
  };
}

for (const surface of surfaces) test(`the band shows the waiting item and no Accept all prompt on ${surface}`, async ($, on) => {
  const rows = band(on);
  expect(await rows($, { ...state, accept: 3 }, surface)).toEqual(['? 2 waiting for you · Decide the export format [Open]']);
});

test('the band is empty without waiting items (even with legacy pending tries) or during a survey', async ($, on) => {
  const rows = band(on);
  expect(await rows($, { ...state, waiting: 0, first: '', accept: 3 })).toEqual([]);
  expect(await rows($, { ...state, waiting: 1, first: '' })).toEqual(['? 1 waiting for you [Open]']);
  expect(await rows($, undefined)).toEqual([]);
  expect(await rows($, state, 'terminal', { hasSurvey: true })).toEqual([]);
});

test('the band follows the panel language and is cut to the columns it has, its buttons whole', async ($, on) => {
  const rows = band(on), zh = { ...state, lang: 'zh', first: '决定导出格式' };
  expect(await rows($, zh)).toEqual(['? 2 项等你处理 · 决定导出格式 [打开]']);
  // Chinese characters take two cells each.
  expect(await rows($, zh, 'terminal', { bodyColumns: 24 })).toEqual(['? 2 项等你处理 · … [打开]']);
  expect(await rows($, state, 'terminal', { bodyColumns: 30 })).toEqual(['? 2 waiting for you · De… [Open]']);
  expect(await rows($, state, 'terminal', { bodyColumns: 20 })).toEqual(['? 2 waiting fo… [Open]']);
});

/** The Open press: argv (nothing run for the model) and the toast the owner sees. */
function presses(on: On, pane: string | undefined, surface: (typeof surfaces)[number]) {
  const runs: string[][] = [], toasts: string[] = [];
  mock.env(on, { HUD_HOME: '/state', ...(pane ? { HERDR_PANE_ID: pane } : {}) });
  on('state.get', () => ({ value: { value: state, version: 1 } }));
  on('session.cwd', () => ({ value: '/demo' }));
  on('process.run', (_, e) => {
    runs.push([...e.argv]);
    return { value: { exitCode: 0, stdout: 'w4E:p9\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } };
  });
  on('ui.toast', (_, e) => { toasts.push(e.text); return { value: undefined }; });
  return async ($: Engine, key: string) => {
    const ui = await $.ui.mount({ plugin: 'hud-mod', surface, component: 'AbovePrompt', props });
    await ui.press({ key });
    await ui.unmount();
    return { runs, toasts };
  };
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`Open shows the panel beside the pane, and only in a herdr pane, on ${surface}`, async ($, on) => {
    expect(await presses(on, 'w4E:p1', surface)($, 'open')).toEqual({ runs: [['hud', 'panel']], toasts: ['HUD panel w4E:p9'] });
  });

  test(`Open outside a herdr pane starts nothing, on ${surface}`, async ($, on) => {
    expect(await presses(on, undefined, surface)($, 'open')).toEqual({ runs: [], toasts: ['Run /hud to open the panel'] });
  });
}

/** A session whose watch child yields `records`, one after the other. */
function session(on: On, records: object[]) {
  const clock = mock.clock(on), toasts: string[] = [], writes: unknown[] = [];
  mock.env(on, { HERDR_PANE_ID: 'w4E:p1', HUD_HOME: '/state' });
  on('env.set', () => ({ value: {} }));
  on('session.start', (_, e) => ({ cwd: e.cwd }));
  on('session.root', () => ({ value: '/demo' }));
  on('fs.exists', () => ({ value: true }));
  on('state.get', () => ({ value: { value: null, version: 0 } }));
  on('state.set', async (_, e, next) => { writes.push(e.value); return next(e); });
  on('ui.toast', (_, e) => { toasts.push(e.text); return { value: undefined }; });
  on('process.spawn', async function* () {
    yield { stream: 'stdout', text: '{"type":"ready"}\n' };
    for (const record of records) { await clock.sleep(10); yield { stream: 'stdout', text: JSON.stringify(record) + '\n' }; }
    await clock.sleep(1000);
    return { value: { code: 0, signal: null } };
  });
  return { clock, toasts, writes };
}
const record = (extra: object) => ({ type: 'band', lang: 'en', waiting: 1, first: 'Pick a name', fresh: false, ...extra });
const start = { cwd: '/demo', surface: 'terminal' as const, isInteractive: true };

test('the watch records are kept in state, and a toast shows only for a new item, once for each record', async ($, on) => {
  const f = session(on, [
    record({}), // Catch-up on the first read: shown, never announced.
    record({ waiting: 2, fresh: true }),
    record({ waiting: 0, first: '', accept: 4, fresh: true }),
    record({ waiting: 0, first: '' }), // Resolved: the band clears without a toast.
    { type: 'band', lang: 'fr', waiting: 'x', first: 1, fresh: true }, // Not a band this mod knows.
  ]);
  await $.session.start(start);
  await f.clock.advance(100);
  expect(f.writes).toEqual([
    { lang: 'en', waiting: 1, first: 'Pick a name' },
    { lang: 'en', waiting: 2, first: 'Pick a name' },
    { lang: 'en', waiting: 0, first: '' },
    { lang: 'en', waiting: 0, first: '' },
  ]);
  expect(f.toasts).toEqual(['Needs you: 2 waiting for you']);
});

test('the toast follows the panel language', async ($, on) => {
  const f = session(on, [record({ lang: 'zh', waiting: 1, fresh: true })]);
  await $.session.start(start);
  await f.clock.advance(100);
  expect(f.toasts).toEqual(['需要你: 1 项等你处理']);
});
