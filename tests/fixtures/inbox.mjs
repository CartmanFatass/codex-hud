/** The Inbox layout's synthetic scene (one invented project, harbor-api): jobs through the real thin-job reader, the project's facts built by hand. */
import { mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { readThinJobs } from '../../dist/collectors/thin-jobs.js';
import { initialMonitorState, renderMonitor } from '../../dist/render/monitor.js';
import { setLanguage } from '../../dist/render/i18n.js';
import { setDisplayConfig } from '../../dist/render/hud-config.js';
import { stripAnsi } from '../../dist/render/colors.js';
export const NOW = Date.parse('2026-11-17T12:00:00Z');
const TREE = { rootId: '', nodes: [], totalCount: 0, updatedAt: new Date(NOW) };
const DAY = 864e5, HOUR = 36e5;
export const plain = (frame) => frame.lines.map((s) => stripAnsi(s).trimEnd());

/** `jobs`: what runs, `idle` leaves only settled work and no question, so Home is the idle frame. */
export function inboxFixture(home, { idle = false } = {}) {
  const ago = (m) => new Date(NOW - m * 60000);
  const put = (file, text, minutes) => {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, typeof text === 'string' ? text : JSON.stringify(text));
    utimesSync(file, ago(minutes), ago(minutes));
  };
  let n = 0;
  const job = (pkg, title, state, started, settled, role = 'imp') => {
    const id = `j${String(++n).padStart(16, '0')}`, dir = join(home, 'jobs', id);
    put(join(dir, 'job.json'), { job: id, role, package: pkg, herdr_pane: 'w4E:p1', created_at: ago(started).toISOString() }, started);
    put(join(dir, 'brief.md'), '# ' + title, started);
    put(join(dir, 'STATUS.json'), { state, started_at: ago(started).toISOString(), ...(settled === null ? {} : { settled_at: ago(settled).toISOString() }) }, settled ?? 3);
    return { id, dir };
  };
  const question = (dir, qid, text, options, dflt, answer, minutes) => {
    put(join(dir, `qa/${qid}.md`), `# Question\n\n${text}\n\nOptions:\n${options.map((o) => `- ${o}`).join('\n')}\n\nDefault if unanswered: ${dflt}\n`, minutes + 1);
    if (answer) put(join(dir, `qa/${qid}.answer.md`), answer, minutes);
  };
  const sentences = new Map();
  const say = (j, text) => sentences.set(j.id, text);
  const failed = job('EXPORT-CSV', 'EXPORT-CSV slow run', 'failed', 40, 9, 'sonic');
  say(failed, 'HTTP 429 on the second request; no report was written.');
  const ready = job('SYNC-QUEUE', 'SYNC-QUEUE tests', 'done', 30, 2, 'reviewer');
  put(join(ready.dir, 'report.md'), 'Tests pass.', 2);
  say(ready, 'tests pass; 2 minor items left');
  const retry = job('SYNC-QUEUE', 'SYNC-QUEUE retry on 429', idle ? 'done' : 'working', 47, idle ? 12 : null);
  if (idle) put(join(retry.dir, 'report.md'), 'Done.', 12);
  question(retry.dir, 'q1', 'Cap the jitter at 30 s?', ['a: cap it at 30 s', 'b: no cap'], 'a: cap it at 30 s', 'a: cap it at 30 s', 25);
  question(retry.dir, 'q2', 'Which retry shape?', ['a: fixed delay', 'b: backoff with jitter'], 'a: fixed delay', 'b: backoff with jitter', 70);
  question(retry.dir, 'q3', 'Keep the v1 shim?', ['a: keep it', 'b: drop it'], 'a: keep it', 'a: keep it', 10);
  if (!idle) {
    say(retry, 'fixing the retry cap finding');
    const rev = job('AUTH-REFRESH', 'AUTH-REFRESH rotation', 'working', 6, null, 'reviewer');
    say(rev, 'comparing the rotation window');
    job('DOCS-SWEEP', 'Tidy the changelog', 'working', 20, null);
    const ask = job('SYNC-QUEUE', 'SYNC-QUEUE 04: shim', 'working', 25, null);
    question(ask.dir, 'q4', 'Keep the v1 shim for one more release or drop it with this change?',
      ['a: keep it for one more release', 'b: drop it with this change'], 'a: keep it for one more release', null, 4);
  }
  const lanes = readThinJobs(home, { project: '/synthetic/harbor-api', pane: 'w4E:p1' });
  for (const lane of lanes) lane.workers = lane.workers.map((w) => ([...sentences].some(([id]) => w.id.endsWith(id)) ? { ...w, modelSentence: [...sentences].find(([id]) => w.id.endsWith(id))[1] } : w));
  const first = lanes.flatMap((l) => l.workers).find((w) => w.settledAt === null) ?? lanes[0].workers[0];
  const done = lanes.flatMap((l) => l.workers).find((w) => w.settledAt !== null);
  const native = (id, task, from, extra) => ({ ...from, id, laneId: 'native-session', task, nativeDepth: 1, homeNeedsHuman: false, role: 'Explore', modelSentence: undefined, ...extra });
  if (!idle)
    lanes.push({ ...lanes[0], id: 'native-session', identity: { kind: 'native' }, label: 'this session', decisions: [], workers: [
      native('native-1', 'retryPolicy callers', first, { modelSentence: '4 callers found; reading the peek' }), native('native-2', 'scan tests', first, { nativeDepth: 2 }),
      native('native-3', 'diff check', done, { role: 'code-reviewer', settledAt: NOW - 4 * 60000 })] });
  const board = { revision: 'synthetic', lanes, workers: lanes.flatMap((l) => l.workers), decisions: lanes.flatMap((l) => l.decisions),
    coverage: { incomplete: false, diagnostics: [], workspace: '/synthetic/harbor-api' } };
  return { board, data: harbor(), render: (width, opts = {}) => frame(board, opts.data ?? harbor(), width, opts) };
}

/** harbor-api's facts: milestone M3 (9 slices), two to try, two waiting items, earlier milestones accepted. */
export function harbor() {
  const row = (id, state, milestone, text, age) => ({ id, state, milestone, text, ...(age === undefined ? {} : { at: NOW - age * DAY }) });
  const ledger = [
    ...Array.from({ length: 7 }, (_, i) => row(`M1-${i + 1}`, 'accepted', 'M1', 'earlier work', 24 + i)),
    ...Array.from({ length: 9 }, (_, i) => row(`M2-${i + 1}`, 'accepted', 'M2', 'earlier work', 11 + i)),
    row('SYNC-QUEUE', 'working', 'M3', 'retry on 429'), row('AUTH-REFRESH', 'working', 'M3', 'rotation'), row('SEARCH-INDEX', 'blocked', 'M3', 'build on write'),
    row('AUDIT-LOG', 'try', 'M3', 'read one audit row', 0.125), row('EXPORT-CSV', 'try', 'M3', 'header and quoting', 1), row('METRICS', 'todo', 'M3', 'request counts per route'),
    row('RATE-LIMIT', 'accepted', 'M3', 'per-key budget', 2), row('CONFIG-LOAD', 'accepted', 'M3', 'layered config', 4), row('LOG-FORMAT', 'accepted', 'M3', 'structured lines', 6),
  ];
  const counts = Object.fromEntries(['working', 'blocked', 'try', 'accepted', 'todo', 'dropped'].map((s) => [s, ledger.filter((r) => r.state === s).length]));
  const statePath = '/synthetic/harbor-api/docs/handoff/STATE.md';
  const ticket = (number, title, status, state, checked, total) => ({ number, title, path: `/synthetic/harbor-api/.scratch/export-csv/issues/${number}.md`, at: NOW, status, checked, total, items: [], blockers: [], state });
  return {
    tickets: [{ slug: 'export-csv', at: NOW, tickets: [ticket('01', 'Header row', 'done', 'done', 1, 1), ticket('02', 'Quoting rules', 'needs-info', 'ready', 0, 2), ticket('03', 'Smoke run', 'ready-for-agent', 'ready', 0, 1)] }],
    waiting: [{ label: '', value: 'Try AUDIT-LOG: read one audit row', path: statePath, at: NOW - 3 * HOUR }, { label: '', value: 'Try EXPORT-CSV: header and quoting', path: statePath, at: NOW - DAY },
      { label: '', value: 'Choose the browser profile', path: statePath }],
    docs: [{ label: 'spec', value: 'M3 · review 2d', path: '/synthetic/harbor-api/docs/spec.md' }], control: [], roles: [{ role: 'imp', group: 'roles', source: 'default', path: '/synthetic/roles/imp.json',
      places: [{ harness: 'pi', label: 'pi', model: null, thinking: null, state: 'exhausted', until: NOW + 42 * 60000 }] }], harnesses: [], models: { pi: [], include: {}, cli: {}, bro: {} },
    agents: [], keys: [], browser: false, roleCount: 5, git: { branch: 'main', changed: 5, ahead: 1, behind: 0 }, worktreeCount: 2, ladder: { ids: ['M1', 'M2', 'M3'], current: 'M3' },
    slices: [{ label: 'SYNC-QUEUE', value: 'retry on 429', path: statePath, ledgerState: 'working', role: 'imp', at: NOW - 47 * 60000, jobId: 'j0000000000000003' },
      { label: 'AUTH-REFRESH', value: 'rotation', path: statePath, ledgerState: 'working', role: 'reviewer', at: NOW - 6 * 60000, jobId: 'j0000000000000005' },
      { label: 'SEARCH-INDEX', value: 'build on write', path: statePath, ledgerState: 'blocked' }],
    ledger, active: [], counts, statePath, updatedAt: NOW - 10 * 60000, editing: [], summary: 'M3 closing: retries and token rotation in flight; exports wait for your try',
    next: [{ label: '', value: 'SEARCH-INDEX: build on write', path: statePath }, { label: '', value: 'METRICS: request counts per route', path: statePath }, { label: '', value: 'DOCS-SWEEP: changelog', path: statePath }],
  };
}

function frame(board, data, width, { height = 48, lang = 'en', layout = 'inbox', state, tab, page, marks, icons = 'unicode', ...rest } = {}) {
  const display = setDisplayConfig({ theme: 'none', icons }), previous = setLanguage(lang);
  try {
    const s = state ?? { ...initialMonitorState(), mainTab: tab ?? 'home', projectPage: page, panelLayout: layout, projectFolded: new Set(['agents', 'healthy', 'files']) };
    return renderMonitor({ tree: TREE, workboard: board, project: data, projectName: 'harbor-api', tryMarks: marks, state: s, width, height, nowMs: NOW, modelEnabled: true, ...rest });
  } finally { setDisplayConfig(display); setLanguage(previous); }
}

/** The frames the snapshot holds: Home busy (47 and 24 rows) and idle, the hub and Progress, at 40 columns in English and Chinese. */
export function inboxFrames(busy, idle) {
  const frames = {};
  for (const lang of ['en', 'zh']) {
    frames[`home-busy-40-${lang}`] = plain(busy.render(40, { lang }));
    frames[`home-busy-24-40-${lang}`] = plain(busy.render(40, { lang, height: 24 }));
    frames[`home-idle-40-${lang}`] = plain(idle.render(40, { lang }));
    frames[`hub-40-${lang}`] = plain(busy.render(40, { lang, tab: 'project', height: 30 }));
    frames[`progress-40-${lang}`] = plain(busy.render(40, { lang, tab: 'project', page: 'progress', height: 50 }));
  }
  frames['home-busy-80-en'] = plain(busy.render(80, { lang: 'en' }));
  frames['hub-24-40-en'] = plain(busy.render(40, { lang: 'en', tab: 'project', height: 24 }));
  return frames;
}
