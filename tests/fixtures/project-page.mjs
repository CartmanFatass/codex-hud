/** Synthetic Project facts collected from disk, never an owner's home. */
import * as fs from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { ProjectCollector } from '../../dist/collectors/project-board.js';
import { readThinJobs } from '../../dist/collectors/thin-jobs.js';
import { initialMonitorState, renderMonitor } from '../../dist/render/monitor.js';
import { setDisplayConfig } from '../../dist/render/hud-config.js';
import { setLanguage } from '../../dist/render/i18n.js';
import { stripAnsi } from '../../dist/render/colors.js';
import { placeItem } from '../../dist/roles/role-control.js';
export const NOW = Date.parse('2026-11-12T12:35:00Z');
export const TREE = { rootId: '', nodes: [], totalCount: 0, updatedAt: new Date(NOW) };
export async function projectFixture(root) {
  const cwd = join(root, 'project'), hud = join(root, 'hud'), home = join(root, 'home'), bin = join(root, 'bin');
  const env = { HOME: home, HUD_HOME: hud, PATH: bin, CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: join(home, '.claude') };
  const put = (path, text, age = 0) => {
    fs.mkdirSync(join(path, '..'), { recursive: true });
    fs.writeFileSync(path, typeof text === 'string' ? text : JSON.stringify(text));
    fs.utimesSync(path, new Date(NOW - age * 60000), new Date(NOW - age * 60000));
  };
  put(join(cwd, 'docs/handoff/STATE.md'), '# State\n\nMilestone: M3b · AI-THIN\n\n## Waiting for the owner\n\n- Try the Project tab\n- Choose the browser profile\n  after trying the synthetic setup\n\n## Next\n- NATIVE-TREE: native subagents on Home\n  beside package lanes\n- PROGRESS-BOARD: project progress\n- Try the milestone\n- Review the milestone\n- Later follow-up\n\n## Slices\n\n<!-- One line per synthetic slice; this comment is ignored. -->\n- working · M3b · NATIVE-TREE · native subagents on Home, one lane per main session\n- working · M4 · ORPHAN · a working slice without a worktree\n- blocked · M4 · BLOCKED · waiting for a synthetic prerequisite\n- try · M3b · LANDING · a landed slice (1234567)\n- accepted · M3 · SHIPPED · an accepted slice (2345678)\n- todo · M4 · QUEUE · a later slice\n- dropped · M4 · RETIRED · a dropped slice\n- mystery · M4 · INVISIBLE · an unknown state must not count\n\n## Now (2026-11-12): Synthetic milestone closing; pages building in worktrees\n\n## Later\n- Never show this unrelated bullet\n');
  put(join(cwd, 'docs/spec.md'), '# Synthetic spec\n\n## 5. Milestones\n\n- **M1, usable**\n- **M2, clean**\n- **M3, extend**\n- **M3b, AI-THIN**\n  - **NOT-A-MILESTONE, nested**\n- **M4, project view**\n\n## 6. Other\n- **M5, not in the ladder**\n');
  put(join(cwd, 'docs/reviews/2026-11-11-review.md'), '# Older review', 120);
  put(join(cwd, 'docs/reviews/2026-11-12-review.md'), 'Verdict: accept', 30);
  put(join(cwd, 'hud-convention.md'), '# Project convention');
  // Unregistered `.hud/` must not load. The control plane only notes that it was ignored.
  put(join(cwd, '.hud/roles/secret.json'), { role: 'secret', harness: 'pi', pi_role: 'implementer', split: false, can_continue: true, model: 'NEVER_RENDER_PROJECT_ROLE' });
  put(join(cwd, '.hud/project.json'), { version: 1, roles: ['secret'] });
  put(join(cwd, '.hud/hud-convention.md'), 'NEVER_RENDER_PROJECT_CONVENTION');
  put(join(cwd, 'CLAUDE.md'), '# Claude instructions');
  put(join(cwd, 'AGENTS.md'), '# Agent instructions');
  put(join(hud, 'roles/imp.json'), { role: 'imp', harness: 'pi', pi_role: 'implementer', split: true, can_continue: true });
  put(join(hud, 'roles/bad.json'), '{ NEVER_RENDER_ROLE_FILE');
  put(join(root, 'roles/implementer.md'), '---\nmodel: synthetic/model\nthinking: high\n---\nRole text\n');
  put(join(bin, 'pi-role'), '#!/bin/sh\nexit 99\n');
  fs.chmodSync(join(bin, 'pi-role'), 0o700);
  put(join(home, '.claude/agents/user-agent.md'), '# Synthetic user agent');
  put(join(cwd, '.claude/agents/project-agent.md'), '# Synthetic project agent');
  put(join(home, '.codex/agents/codex-agent.toml'), 'model = "synthetic"');
  put(join(hud, 'credentials.env'), '# Synthetic names and values only\nMISTRAL_API_KEY=NEVER_RENDER_MISTRAL_VALUE\nOPENAI_API_KEY=""\nTYPESAFE_API_KEY=NEVER_RENDER_TYPESAFE_VALUE\nexport SYNTHETIC_KEY=NEVER_RENDER_OTHER_VALUE\n');
  for (const name of ['google-chrome', 'jev-ask']) {
    put(join(bin, name), '#!/bin/sh\nexit 99\n');
    fs.chmodSync(join(bin, name), 0o700);
  }
  const id = 'j0000000000000001', job = join(hud, 'jobs', id);
  put(join(job, 'job.json'), { job: id, role: 'imp', cwd, herdr_pane: 'w4E:p1', package: 'M4-PROJECT', created_at: new Date(NOW - 20 * 60000).toISOString() });
  put(join(job, 'STATUS.json'), { state: 'working', started_at: new Date(NOW - 20 * 60000).toISOString() });
  put(join(job, 'brief.md'), '# Build the Project tab');
  const lanes = readThinJobs(hud, { project: cwd, pane: 'w4E:p1' });
  const board = { revision: 'synthetic', lanes, workers: lanes.flatMap((l) => l.workers), decisions: [], coverage: { incomplete: false, diagnostics: [], workspace: cwd } };
  // A real, entirely synthetic Git repository; no git commit command or user config.
  const object = (kind, text) => {
    const bytes = Buffer.from(`${kind} ${Buffer.byteLength(text)}\0${text}`), hash = createHash('sha1').update(bytes).digest('hex');
    const path = join(cwd, '.git/objects', hash.slice(0, 2), hash.slice(2));
    fs.mkdirSync(join(path, '..'), { recursive: true }); fs.writeFileSync(path, deflateSync(bytes));
    return hash;
  };
  const tree = object('tree', ''), stamp = NOW / 1000 - 7200;
  const hash = object('commit', `tree ${tree}\nauthor Synthetic <synthetic@invalid> ${stamp} +0000\ncommitter Synthetic <synthetic@invalid> ${stamp} +0000\n\nSynthetic Project baseline\n`);
  put(join(cwd, '.git/HEAD'), 'ref: refs/heads/synthetic-project\n');
  put(join(cwd, '.git/refs/heads/synthetic-project'), hash + '\n');
  put(join(cwd, '.git/info/exclude'), '.hud/\n');
  const linked = ['NATIVE-TREE', 'NO-JOB'].map((name) => {
    const path = join(root, name), admin = join(cwd, '.git/worktrees', name);
    put(join(path, '.git'), `gitdir: ${admin}\n`);
    put(join(admin, 'gitdir'), join(path, '.git') + '\n');
    put(join(admin, 'commondir'), '../..\n');
    put(join(admin, 'HEAD'), `ref: refs/heads/wt/${name}\n`);
    put(join(cwd, '.git/refs/heads/wt', name), hash + '\n');
    return path;
  });
  const sliceJob = join(hud, 'jobs/j0000000000000002');
  put(join(sliceJob, 'job.json'), { job: 'j0000000000000002', role: 'imp', cwd: linked[0], herdr_pane: 'w4E:p1', created_at: new Date(NOW - 12 * 60000).toISOString() });
  put(join(sliceJob, 'STATUS.json'), { state: 'working', started_at: new Date(NOW - 12 * 60000).toISOString() });
  put(join(sliceJob, 'qa/q1.md'), 'Question: Which synthetic option?');
  put(join(sliceJob, 'brief.md'), '# NATIVE-TREE: synthetic subagents');
  put(join(sliceJob, 'report.md'), '# Synthetic progress report');
  board.lanes = readThinJobs(hud, { project: cwd, pane: 'w4E:p1' });
  board.workers = board.lanes.flatMap((l) => l.workers);
  const collector = new ProjectCollector(cwd, hud, env, home);
  const data = await collector.collect(true, board, NOW);
  // `state` may be a page name ('progress', 'tickets', 'tree', 'docs', 'control') or a full state; none is the hub.
  const render = (width, lang = 'en', state = undefined, height = 56, snapshot = data, modelEnabled = true, icons = 'unicode', theme = 'none', extra = {}) => {
    state = typeof state === 'string' ? onPage(state) : state ?? onPage();
    const display = setDisplayConfig({ theme, icons }), previous = setLanguage(lang);
    try { return renderMonitor({ tree: TREE, workboard: board, project: snapshot, projectName: 'demo-project', state, width, height, nowMs: NOW, modelEnabled, ...extra }); }
    finally { setDisplayConfig(display); setLanguage(previous); }
  };
  return { cwd, hud, home, env, put, board, collector, data, rich: richProgress(data), render, job, linked, sliceJob };
}
/** Progress material the base fixture has too little of, all synthetic: a ledger across milestones in ledger order (one row
 *  with no milestone, one with its commit first, one with no commit), long Next bullets, a job no slice shows. */
export function richProgress(data) {
  const day = 864e5, path = data.statePath;
  const row = (id, state, milestone, text, age, commit) => ({ id, state, milestone, text, ...(commit ? { commit } : {}), ...(age === undefined ? {} : { at: NOW - age * day }) });
  const ledger = [
    row('BAR-LINES', 'accepted', 'M3', 'one-line bars on every client (a1b2c3d4)', 30, 'a1b2c3d4'),
    row('PANEL-KEYS', 'accepted', 'M3', 'whole key hints and readable tab labels (b2c3d4e5, c3d4e5f6)', 29, 'c3d4e5f6'),
    row('SKILL-MOVE', 'accepted', '—', 'old skills retired to the private config (d4e5f6a7)', 28, 'd4e5f6a7'),
    row('ONE-PAGE', 'accepted', 'M3b', 'Home and Work on one page (e5f6a7b8)', 20, 'e5f6a7b8'),
    row('NATIVE-ROWS', 'try', 'M3b', 'native rows keep one order (f6a7b8c9)', 19, 'f6a7b8c9'),
    row('REVIEW-ONE', 'accepted', 'M4', 'the whole-project review, changes required (a7b8c9d0)', 8, 'a7b8c9d0'),
    row('SENTENCE-CUT', 'try', 'M4', 'job sentences are cut at a word, never between a name and its flag (b8c9d0e1)', 7, 'b8c9d0e1'),
    row('WATCH-LINK', 'try', 'M4', 'c9d0e1f2 · the watcher survives a link loop', 5, 'c9d0e1f2'),
    row('NO-HASH', 'try', 'M4', 'landed with no commit in its text'),
    row('PAGE-ONE', 'working', '0.1.3', 'the hub and one page per section'),
    row('PAGE-TWO', 'blocked', '0.1.3', 'waits for page one'),
    row('DATA-ONE', 'try', '0.1.3', 'ledger history, live jobs and ticket detail (d0e1f2a3)', 1, 'd0e1f2a3'),
    row('LATER-ONE', 'todo', '0.1.3', 'a later slice'),
  ];
  const counts = { working: 0, blocked: 0, try: 0, todo: 0, accepted: 0, dropped: 0 };
  for (const r of ledger) counts[r.state]++;
  const long = 'A long bullet that runs over two rows even at one hundred and twenty columns, because it keeps going with one detail after another, '
    + 'and then some more words about what should happen next, and after that, and finally what the owner decides at the end of it all';
  return { ...data, ledger, counts, summary: 'Synthetic hub work in two worktrees', ladder: { ids: [], current: '0.1.3' },
    slices: [{ label: 'PAGE-ONE', value: 'the hub and one page per section', path, ledgerState: 'working' },
      { label: 'PAGE-TWO', value: 'waits for page one', path, ledgerState: 'blocked' }],
    active: [{ jobId: 'j00000000000000aa', role: 'imp', state: 'working', title: 'Tidy the synthetic docs in the main checkout', at: NOW - 5 * 60000, asking: false }],
    next: ['A short bullet', long, 'Another short bullet that still fits in two rows at forty columns', 'Last: ' + long].map((value) => ({ label: '', value, path })) };
}
/** Control plane material the base fixture has too little of, all synthetic: fallbacks, every mark, a project role, a long model. */
export function richControl(data) {
  const place = (harness, label, model, thinking, state, extra = {}) => ({ harness, label, model, thinking, state, ...extra });
  const role = (name, group, source, places) => ({ role: name, group, source, path: `/synthetic/${source}/roles/${name}.json`, places });
  const roles = [
    role('imp', 'roles', 'yours', [place('pi', 'pi', 'openai/gpt-6.1-sol', 'high', 'exhausted', { until: NOW + 42 * 60000 }),
      place('cli', 'agy', 'gemini-4-hydrogen-high', 'xhigh', 'active'), place('cli', 'claude', 'opus', 'high', 'standby')]),
    role('reviewer', 'roles', 'default', [place('pi', 'pi', 'mistral/deepseek-v4-1-flash-1017', 'xhigh', 'active'), place('cli', 'codex', 'gpt-6.1-sol', 'high', 'missing')]),
    role('sonic', 'roles', 'default', [place('pi', 'pi', null, null, 'active')]),
    role('architect', 'roles', 'default', [place('pi', 'pi', 'openai/gpt-6.1-sol', 'max', 'active')]),
    role('oracle', 'roles', 'default', [place('cli', 'claude', 'fable', null, 'active'), place('pi', 'pi', null, null, 'standby')]),
    role('frontend', 'project', 'project', [place('pi', 'pi', 'project/model', 'high', 'active')]),
    role('pro', 'browser', 'default', [place('bro', 'chatgpt', '6 Pro', null, 'exhausted', { until: NOW + 5 * 60000 }),
      place('bro', 'gemini', null, null, 'active'), place('bro', 'aistudio', 'gemini-4-argon', null, 'standby')]),
    role('flow', 'browser', 'default', [place('bro', 'flow', null, null, 'missing', { kind: 'video' })]),
  ];
  return { ...data, roles, roleCount: roles.length, models: MODEL_LISTS };
}
/** What the harnesses list for the model picker, all synthetic but shaped like the real ids: versions (4-5, 5-5, 6.1), a dated
 *  snapshot beside its undated id, a family that ended (o1), a provider the include list does not name, a CLI's short list. */
export const MODEL_LISTS = {
  pi: ['arena/gpt-6.1-sol', 'arena/claude-opus-5-5', 'arena/deepseek-v4-1-flash-1017', 'arena/qwen-4-coder',
    'anthropic/claude-opus-4-5', 'anthropic/claude-opus-4-6', 'anthropic/claude-opus-5', 'anthropic/claude-opus-5-5', 'anthropic/claude-opus-5-5-20261101',
    'anthropic/claude-sonnet-5', 'anthropic/claude-haiku-5',
    'openai/gpt-6-sol', 'openai/gpt-6.1-sol', 'openai/gpt-6-luna', 'openai/gpt-6.1-luna', 'openai/gpt-6-astra', 'openai/gpt-5-mini', 'openai/o1',
    'mistral/deepseek-v4-1-flash-1017', 'mistral/deepseek-v4-1-flash-0912', 'mistral/mistral-large-3', 'google/gemini-4-argon'],
  include: { arena: ['*'], mistral: ['deepseek*'], anthropic: ['*opus*'], openai: ['gpt-6*'] },
  cli: { agy: ['gemini-4-argon-high', 'gemini-4-hydrogen-high', 'gemini-3.8-flash-high'], claude: ['opus', 'sonnet', 'haiku'], codex: ['gpt-6.1-sol', 'gpt-6-luna'], grok: ['grok-4.7'] },
  bro: { chatgpt: ['6 Pro'], 'jev-aistudio': ['gemini-4-argon'] },
};
/** The projects a panel can switch between, for the hub's switch row. */
export const PROJECTS = [{ root: '/synthetic/demo-project', name: 'demo-project' }, { root: '/synthetic/second-project', name: 'second-project' }, { root: '/synthetic/third', name: 'third' }];
/** A Project tab state: the hub, or one page of it. */
export const onPage = (projectPage, extra) => ({ ...initialMonitorState(), mainTab: 'project', projectPage, projectFolded: new Set(['agents', 'healthy', 'files']), ...extra });
export const plain = (frame) => frame.lines.map((s) => stripAnsi(s).trimEnd());
export const PAGES = ['progress', 'tickets', 'tree', 'docs', 'control'];
/** The hub at 40/80/120 (and text icons at 40), and each page at 40 and 120, so a regression shows in the diff. */
export function projectFrames(f) {
  const frames = {};
  for (const lang of ['en', 'zh']) {
    for (const width of [40, 80, 120]) frames[`hub-${width}-${lang}`] = plain(f.render(width, lang, undefined, 24));
    for (const page of PAGES.filter((p) => p !== 'tickets')) for (const width of [40, 120])
      frames[`${page}-${width}-${lang}`] = plain(f.render(width, lang, page, 40));
  }
  const open = onPage('progress', { projectFolded: new Set(['agents', 'healthy', 'files', 'hist:m:M3b', 'hist:m:M4', 'hist:DATA-ONE', 'next', 'next:1']) });
  for (const lang of ['en', 'zh']) for (const width of [40, 120]) frames[`progress-rich-${width}-${lang}`] = plain(f.render(width, lang, 'progress', 64, f.rich));
  frames['progress-rich-open-40-en'] = plain(f.render(40, 'en', open, 80, f.rich));
  frames['progress-rich-40-text'] = plain(f.render(40, 'en', 'progress', 64, f.rich, true, 'text'));
  const second = { projects: PROJECTS, projectName: PROJECTS[1].name };
  for (const lang of ['en', 'zh']) frames[`hub-switch-40-${lang}`] = plain(f.render(40, lang, onPage(undefined, { projectRoot: PROJECTS[1].root }), 24, f.data, true, 'unicode', 'none', second));
  frames['progress-switch-40-en'] = plain(f.render(40, 'en', onPage('progress', { projectRoot: PROJECTS[1].root }), 12, f.data, true, 'unicode', 'none', second));
  const control = richControl(f.data);
  // The hub on a tall panel and on shorter ones: Latest loses rows, then goes, then the bar and the blank rows.
  for (const [height, lang] of [[40, 'en'], [40, 'zh'], [20, 'en'], [16, 'en'], [12, 'en']]) frames[`hub-rich-40-${height}-${lang}`] = plain(f.render(40, lang, undefined, height, f.rich));
  frames['hub-rich-120-40-en'] = plain(f.render(120, 'en', undefined, 40, f.rich));
  // The Control plane: what needs the owner first, healthy roles folded; opened, with the files.
  for (const lang of ['en', 'zh']) for (const width of [40, 120]) frames[`control-rich-${width}-${lang}`] = plain(f.render(width, lang, 'control', 48, control));
  const opened = onPage('control', { projectFolded: new Set(['agents']) });
  for (const lang of ['en', 'zh']) frames[`control-rich-open-40-${lang}`] = plain(f.render(40, lang, opened, 56, control));
  frames['control-rich-open-120-en'] = plain(f.render(120, 'en', opened, 56, control));
  frames['control-rich-40-text'] = plain(f.render(40, 'en', 'control', 48, control, true, 'text'));
  // The model picker over the page: providers, one provider's models, a filter, every model, a short CLI list.
  const pick = (role, index, input) => onPage('control', { projectCursor: placeItem(role, index), projectInput: { role, index, text: '', ...input } });
  for (const lang of ['en', 'zh']) {
    frames[`pick-provider-40-${lang}`] = plain(f.render(40, lang, pick('imp', 0), 16, control));
    frames[`pick-model-40-${lang}`] = plain(f.render(40, lang, pick('imp', 0, { provider: 'openai' }), 16, control));
  }
  frames['pick-filter-40-en'] = plain(f.render(40, 'en', pick('imp', 0, { provider: 'arena', text: 'opus' }), 16, control));
  frames['pick-typed-40-en'] = plain(f.render(40, 'en', pick('imp', 0, { provider: 'arena', text: 'zz-new' }), 16, control));
  frames['pick-all-40-en'] = plain(f.render(40, 'en', pick('imp', 0, { all: true }), 16, control));
  frames['pick-cli-40-en'] = plain(f.render(40, 'en', pick('imp', 1), 16, control));
  frames['pick-model-120-en'] = plain(f.render(120, 'en', pick('imp', 0, { provider: 'openai' }), 20, control));
  frames['hub-40-text'] = plain(f.render(40, 'en', undefined, 24, f.data, true, 'text'));
  frames['progress-40-text'] = plain(f.render(40, 'en', 'progress', 40, f.data, true, 'text'));
  return frames;
}
