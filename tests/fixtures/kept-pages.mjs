/** PAGES-DESIGN's synthetic rows, collected through the real thin-job reader. */
import { mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { readThinJobs } from '../../dist/collectors/thin-jobs.js';
import { initialMonitorState, renderMonitor } from '../../dist/render/monitor.js';
import { defaultSettings } from '../../dist/settings.js';
import { renderSettingsPage, SETTING_ROWS } from '../../dist/render/settings-page.js';
import { setLanguage } from '../../dist/render/i18n.js';
import { setDisplayConfig } from '../../dist/render/hud-config.js';
import { withDisplaySettings } from '../../dist/settings-runtime.js';
import { stripAnsi } from '../../dist/render/colors.js';
export const NOW = Date.parse('2026-11-12T12:35:00Z');
export const TREE = { rootId: '', nodes: [], totalCount: 0, updatedAt: new Date(NOW) };
export function pageFixture(home) {
  const ago = (m) => new Date(NOW - m * 60000);
  const put = (file, text, minutes) => {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, typeof text === 'string' ? text : JSON.stringify(text));
    utimesSync(file, ago(minutes), ago(minutes));
  };
  function job(n, pkg, title, state, started, settled, role = 'imp') {
    const id = `j${String(n).padStart(16, '0')}`,
      dir = join(home, 'jobs', id);
    put(
      join(dir, 'job.json'),
      { job: id, role, package: pkg, herdr_pane: 'w4E:p1', created_at: ago(started).toISOString() },
      started
    );
    put(join(dir, 'brief.md'), '# ' + title, started);
    put(
      join(dir, 'STATUS.json'),
      {
        state,
        model: 'openai/gpt-6.1-sol',
        thinking: 'high',
        started_at: ago(started).toISOString(),
        ...(settled === null ? {} : { settled_at: ago(settled).toISOString() }),
      },
      settled ?? 4
    );
    return dir;
  }
  const api = job(1, 'R5-API', 'Retry on HTTP 429', 'working', 47, null);
  const old = job(2, 'R5-API', 'Add the retry helper', 'done', 140, 72);
  put(join(old, 'report.md'), 'Added retryWithBackoff with its unit tests.', 72);
  job(3, 'R5-API', "Probe the provider's 429 reply", 'failed', 170, 160, 'sonic');
  const ux = job(4, 'R5-UX', 'Dedupe the sync queue', 'working', 65, null);
  const done = job(5, 'R5', 'Move sessions to v2 tables', 'done', 360, 320);
  put(join(done, 'report.md'), 'Moved sessions to v2 tables.', 320);
  const recent = job(6, 'R5-API', 'Check the retry tests', 'done', 6, 2);
  put(join(recent, 'report.md'), 'Tests pass.', 2);
  function qa(dir, qid, question, fallback, answer, minutes) {
    put(
      join(dir, `qa/${qid}.md`),
      `# Question\n\n${question}\n\nOptions:\n- a: ${fallback}\n- ${answer?.startsWith('b:') ? answer.split('\n')[0] : dir === ux && qid === 'q3' ? 'b: remove it now' : 'b: backoff with jitter, cap 30s'}\n\nDefault if unanswered: a: ${fallback}\n\nContext: the parser still reads the v1 theme\n`,
      minutes + 1
    );
    if (answer) put(join(dir, `qa/${qid}.answer.md`), answer, minutes);
  }
  qa(
    api,
    'q1',
    'Keep the card at three lines?',
    'keep the card at three lines',
    'a: keep the card at three lines',
    192
  );
  qa(
    api,
    'q2',
    'Retry policy for the HTTP client?',
    'fixed 5s retry',
    'b: backoff with jitter, cap 30s\n\nWhy: same policy as the payment client',
    38
  );
  qa(ux, 'q1', 'Where should the cursor stay?', 'cursor stays in IndexedDB', 'a: cursor stays in IndexedDB', 12);
  qa(
    ux,
    'q2',
    'Keep the v1 shim for one more release?',
    'remove it now',
    'b: keep the v1 shim for one more release',
    185
  );
  qa(ux, 'q3', 'Keep the v1 shim for one more release?', 'keep it for one more release', null, 3);
  put(join(api, 'review-1.md'), 'Verdict: changes-required\n\n2 major · 1 minor', 9);
  const lanes = readThinJobs(home, { project: '/synthetic/repo', pane: 'w4E:p1' });
  // The overlay is the stored model result, not a model fake on a render path.
  for (const lane of lanes) {
    lane.workers = lane.workers.map((w) =>
      w.id.endsWith('1')
        ? {
            ...w,
            modelSentence:
              'Fixing the retry cap finding: «jitter» is now bounded at 30 s; the tests cover 429 and 503.',
          }
        : w
    );
    lane.decisions = lane.decisions.map((d) => ({
      ...d,
      modelTitle:
        d.evidence[0].sourceId.endsWith('1') && d.evidence[0].relativePath === 'qa/q2.md'
          ? 'Backoff with jitter, cap 30s'
          : d.option?.replace(/^[ab]:\s*/, ''),
    }));
  }
  const board = {
    revision: 'synthetic',
    lanes,
    workers: lanes.flatMap((l) => l.workers),
    decisions: lanes.flatMap((l) => l.decisions),
    coverage: { incomplete: false, diagnostics: [], workspace: '/synthetic/repo' },
  };
  const worktrees = {
    sourcePath: '/synthetic/repo',
    updatedAt: NOW,
    entries: [
      {
        path: '/synthetic/repo',
        branch: 'universal-hud',
        head: '1234567',
        observedAt: NOW,
        status: { ahead: 2, behind: 0, staged: 1, unstaged: 3, untracked: 2, changed: 6 },
      },
      {
        path: '/synthetic/side',
        branch: 'R5-API',
        head: '7654321',
        observedAt: NOW,
        status: { ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0, changed: 0 },
      },
    ],
  };
  const apiWorker = board.workers.find((w) => w.id.endsWith('1')),
    askingWorker = board.workers.find((w) => w.id.endsWith('4'));
  const decision = board.decisions.find((d) => d.modelTitle === 'Backoff with jitter, cap 30s');
  const inspect = (item) => ({
    ...initialMonitorState(),
    focus: 'details',
    modes: { agents: 'open', changes: 'closed', details: 'open' },
    boardInspect: item,
  });
  const target = (w) => ({ kind: 'worker', laneId: w.laneId, workerId: w.id });
  const states = {
    home: initialMonitorState(),
    older: { ...initialMonitorState(), tree: { ...initialMonitorState().tree, showAll: true } },
    job: inspect(target(apiWorker)),
    asking: inspect(target(askingWorker)),
    decision: inspect({ kind: 'decision', laneId: decision.laneId, decisionId: decision.id }),
    help: { ...initialMonitorState(), help: true },
    changes: {
      ...initialMonitorState(),
      focus: 'changes',
      modes: { agents: 'open', changes: 'open', details: 'closed' },
    },
  };
  const render = (page, width, lang = 'en', height = 40) => {
    const display = setDisplayConfig({ theme: 'none', icons: 'unicode' }),
      previous = setLanguage(lang);
    try {
      if (page === 'settings') {
        const original = { ...defaultSettings(), modelEnabled: true, theme: 'none', barStyle: 'line' };
        const draft = { ...original, modelCallsPerHour: 120 };
        return withDisplaySettings(draft, () =>
          renderSettingsPage(
            {
              draft,
              original,
              selected: SETTING_ROWS.findIndex((r) => r.key === 'modelCallsPerHour'),
              offset: 0,
              message: '',
            },
            width,
            height,
            { state: undefined, modelCalls: { today: 14, lastHour: 14, cap: 60 }, decisionCalls: { lastHour: 140, cap: 0 } }
          )
        );
      }
      return renderMonitor({
        tree: TREE,
        workboard: board,
        worktrees,
        state: { ...states[page], tree: { ...states[page].tree }, scroll: { ...states[page].scroll } },
        width,
        height,
        modelEnabled: true,
        embedded: true,
        mouse: true,
        nowMs: NOW,
      });
    } finally {
      setDisplayConfig(display);
      setLanguage(previous);
    }
  };
  return { board, worktrees, states, render, apiWorker, askingWorker, decision, api, ux };
}
export const plainFrame = (frame) => frame.lines.map((s) => stripAnsi(s).trimEnd());
export function pageFrames(fixture) {
  const frames = {};
  for (const width of [80, 120])
    for (const page of ['home', 'older', 'job', 'asking', 'decision', 'settings', 'help', 'changes']) {
      frames[`${page}-${width}-en`] = plainFrame(fixture.render(page, width));
      if (['home', 'older', 'settings'].includes(page))
        frames[`${page}-${width}-zh`] = plainFrame(fixture.render(page, width, 'zh'));
    }
  // Settings' help/gauge also reflow at the ordinary narrow panel width.
  for (const lang of ['en', 'zh']) frames[`settings-40-${lang}`] = plainFrame(fixture.render('settings', 40, lang));
  return frames;
}
