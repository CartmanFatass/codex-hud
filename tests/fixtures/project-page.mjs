import { viewFor, withState } from './state-helpers.mjs';
/** Synthetic Project facts collected from disk, never an owner's home. */
import * as fs from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { ProjectCollector } from '../../dist/collectors/project-board.js';
import { readThinJobs } from '../../dist/collectors/thin-jobs.js';
import { handleMonitorInput, initialMonitorState, renderMonitor } from '../../dist/render/monitor.js';
import { modelInput, rememberModel } from '../../dist/render/model-input.js';
import { setDisplayConfig } from '../../dist/render/hud-config.js';
import { setLanguage } from '../../dist/render/i18n.js';
import { stripAnsi } from '../../dist/render/colors.js';
import { LISTED, PROVIDER_COUNT, ROLES } from '../../docs/design/model-picker/gen/world.mjs';
export const NOW = Date.parse('2026-11-12T12:35:00Z');
export const TREE = { rootId: '', nodes: [], totalCount: 0, updatedAt: new Date(NOW) };
export async function projectFixture(root, { progressTickets = true } = {}) {
  const cwd = join(root, 'project'), hud = join(root, 'hud'), home = join(root, 'home'), bin = join(root, 'bin');
  const env = { HOME: home, HUD_HOME: hud, PATH: bin, CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: join(home, '.claude') };
  const put = (path, text, age = 0) => {
    fs.mkdirSync(join(path, '..'), { recursive: true });
    fs.writeFileSync(path, typeof text === 'string' ? text : JSON.stringify(text));
    fs.utimesSync(path, new Date(NOW - age * 60000), new Date(NOW - age * 60000));
  };
  put(join(cwd, 'docs/handoff/STATE.md'), '# State\n\nMilestone: M3b · AI-THIN\n\n## Waiting for the owner\n\n- Try the Project tab\n- Choose the browser profile\n  after trying the synthetic setup\n\n## Next\n- NATIVE-TREE: native subagents on Home\n  beside package lanes\n- PROGRESS-BOARD: project progress\n- Try the milestone\n- Review the milestone\n- Later follow-up\n\n## Now (2026-11-12): Synthetic milestone closing; pages building in worktrees\n\n## Later\n- Never show this unrelated bullet\n');
  const issue = (feature, number, title, status, commit, blockers = 'none', age = 0) => put(
    join(cwd, '.scratch', feature, 'issues', `${number}-sample.md`),
    `# ${number}: ${title}\n**Status:** ${status}\n**Blocked by:** ${blockers}\n${commit ? `\n## Comments\n- Landed ${commit}\n` : ''}`, age);
  if (progressTickets) {
    issue('native-tree', '01', 'native subagents on Home, one lane per main session', 'ready-for-agent');
    issue('native-tree', '02', 'a landed ticket', 'ready-for-human', '1234567');
    issue('shipped', '01', 'an accepted ticket', 'done', '2345678');
    issue('queue', '01', 'a later ticket', 'ready-for-agent');
    issue('queue', '02', 'a dropped ticket', 'wontfix');
    issue('queue', '03', 'waiting for a synthetic prerequisite', 'ready-for-agent', undefined, 'missing/01');
    issue('queue', '04', 'working without a worktree', 'claimed');
  }
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
  for (const name of ['pi', 'google-chrome', 'jev-ask']) {
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
  const linked = ['NATIVE-TREE-01', 'NO-JOB'].map((name) => {
    const path = join(root, name), admin = join(cwd, '.git/worktrees', name);
    put(join(path, '.git'), `gitdir: ${admin}\n`);
    put(join(admin, 'gitdir'), join(path, '.git') + '\n');
    put(join(admin, 'commondir'), '../..\n');
    put(join(admin, 'HEAD'), `ref: refs/heads/wt/${name}\n`);
    put(join(cwd, '.git/refs/heads/wt', name), hash + '\n');
    return path;
  });
  const sliceJob = join(hud, 'jobs/j0000000000000002');
  put(join(sliceJob, 'job.json'), { job: 'j0000000000000002', role: 'imp', cwd: linked[0], herdr_pane: 'w4E:p1',
    worktree: { root: linked[0], main_root: cwd, branch: 'wt/NATIVE-TREE-01' }, ...(progressTickets ? { ticket: 'native-tree/01' } : {}),
    created_at: new Date(NOW - 12 * 60000).toISOString() });
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
    state = typeof state === 'string' ? state === 'control' ? onControl() : onPage(state) : state ?? onPage();
    const display = setDisplayConfig({ theme, icons }), previous = setLanguage(lang);
    try { return renderMonitor({ tree: TREE, workboard: board, project: snapshot, projectName: 'demo-project', state: state, width, height, nowMs: NOW, modelEnabled, ...extra }); }
    finally { setDisplayConfig(display); setLanguage(previous); }
  };
  return { cwd, hud, home, env, put, issue, board, collector, data, rich: richProgress(data), render, job, linked, sliceJob };
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
const mockEditor = (places) => ({ places: places.map((fact) => ({ fact, raw: { harness: fact.harness,
  ...(fact.harness === 'pi' ? { pi_role: 'implementer' } : fact.harness === 'cli' ? { agent: fact.label } : {}),
  ...(fact.model ? { model: fact.model } : {}), ...(fact.thinking ? { thinking: fact.thinking } : {}) } })), targets: [] });
export function richControl(data) {
  const place = (harness, label, model, thinking, state, extra = {}) => ({ harness, label, model, thinking, state,
    ...(harness === 'pi' ? { provider: model?.split('/')[0] ?? null } : {}), ...extra });
  const role = (name, group, source, places) => ({ role: name, group, source, path: `/synthetic/${source}/roles/${name}.json`, places,
    ...(source !== 'project' ? { editor: mockEditor(places) } : {}),
    ...(['imp', 'reviewer', 'oracle'].includes(name) ? { preset: name === 'imp' ? null : name === 'oracle' ? 'fable' : 'default' } : {}),
    ...(name === 'imp' ? { presets: [{ name: 'default', next: 'pi/openai' }, { name: 'grok', next: 'pi/xai' }] }
      : name === 'reviewer' ? { presets: [{ name: 'default', next: 'pi/mistral' }] }
        : name === 'oracle' ? { presets: [{ name: 'fable', next: 'claude' }] } : {}) });
  const roles = [
    role('imp', 'roles', 'yours', [place('pi', 'pi', 'openai/gpt-6.1-sol', 'high', 'exhausted', { until: NOW + 42 * 60000 }),
      place('cli', 'agy', 'gemini-4-hydrogen-high', 'xhigh', 'active'), place('cli', 'claude', 'opus', 'high', 'standby')]),
    role('reviewer', 'roles', 'default', [place('pi', 'pi', 'mistral/deepseek-v4-1-flash-1017', 'xhigh', 'active'), place('cli', 'codex', 'gpt-6.1-sol', 'high', 'missing')]),
    role('sonic', 'roles', 'default', [place('pi', 'pi', null, null, 'active')]),
    role('oracle', 'roles', 'default', [place('cli', 'claude', 'fable', 'high', 'active'), place('pi', 'pi', null, null, 'standby')]),
    role('frontend', 'project', 'project', [place('pi', 'pi', 'project/model', 'high', 'active')]),
    role('pro', 'browser', 'default', [place('bro', 'chatgpt', '6 Pro', null, 'exhausted', { until: NOW + 5 * 60000 }),
      place('bro', 'gemini', null, null, 'active'), place('bro', 'aistudio', 'gemini-4-argon', null, 'standby')]),
    role('flow', 'browser', 'default', [place('bro', 'flow', null, null, 'missing', { kind: 'video' })]),
  ];
  return { ...data, roles, roleCount: roles.length, models: MODEL_LISTS };
}
/** Synthetic lists with old versions, timestamps, repeated suffixes across providers and nested model IDs. */
export const MAVERICK = 'arena/meta-llama/llama-4-maverick-17b-128e-instruct';
export const MODEL_LISTS = {
  pi: ['arena/gpt-6.1-sol', 'arena/claude-opus-5-5', 'arena/anthropic.claude-opus-5-5', 'arena/deepseek-v4-1-flash-1017', 'arena/qwen-4-coder',
    'anthropic/claude-opus-4-5', 'anthropic/claude-opus-4-6', 'anthropic/claude-opus-5', 'anthropic/claude-opus-5-5', 'anthropic/claude-opus-5-5-20261101',
    'anthropic/claude-sonnet-5', 'anthropic/claude-haiku-5',
    'openai/gpt-6-sol', 'openai/gpt-6.1-sol', 'openai/gpt-6-luna', 'openai/gpt-6.1-luna', 'openai/gpt-6-astra', 'openai/gpt-5-mini', 'openai/o1',
    'mistral/deepseek-v4-1-flash-1017', 'mistral/deepseek-v4-1-flash-0912', 'mistral/mistral-large-3', 'google/gemini-4-argon',
    'arena/grok-4.6', 'arena/grok-4.7', 'xai/grok-4.7', 'xai/grok-4.7-fast', 'xai/grok-4.7-mini', MAVERICK, `${MAVERICK}-fp8`, 'new-provider/new-model'],
  piStatus: { fetchedAt: NOW - 2 * 3600000, failed: false, offline: false, empty: false, runnerOff: false },
  cli: { agy: ['gemini-4-argon-high', 'gemini-4-hydrogen-high', 'gemini-3.8-flash-high'], claude: ['opus', 'sonnet', 'haiku'], codex: ['gpt-6.1-sol', 'gpt-6-luna'], grok: ['grok-4.7'] },
  bro: { chatgpt: ['6 Pro'], 'jev-aistudio': ['gemini-4-argon'] },
};
/** The projects a panel can switch between, for the hub's switch row. */
export const PROJECTS = [{ root: '/synthetic/demo-project', name: 'demo-project' }, { root: '/synthetic/second-project', name: 'second-project' }, { root: '/synthetic/third', name: 'third' }];
/** A Project tab state: the hub, or one page of it. */
export const onPage = (projectPage, extra) => (withState(initialMonitorState(), { activeTab: 'project', project: { folded: new Set(['agents', 'healthy', 'files']), view: viewFor(projectPage) } }, extra));
export const onControl = ({ folded, ...nav } = {}, extra, controlPatch) => {
  const state = initialMonitorState(), { control } = state;
  const roles = { nav: { ...control.roles.nav, ...nav }, folded: folded ?? control.roles.folded };
  return { ...withState(state, { activeTab: 'control' }, extra), control: { ...control, roles, ...controlPatch } };
};
export const chainOverlay = (role, at = 0) => ({ kind: 'control-chain', role, at, mode: { kind: 'places' } });
export const withChainPicker = (state, patch) => ({ ...state, overlay: { ...state.overlay,
  mode: { ...state.overlay.mode, picker: { ...state.overlay.mode.picker, ...patch } } } });
export const plain = (frame) => frame.lines.map((s) => stripAnsi(s).trimEnd());
export const PAGES = ['progress', 'tickets', 'tree', 'docs', 'control'];
/** The hub and Progress at 40/80/120 EN/ZH (and text icons at 40); other pages at 40/120. */
export function projectFrames(f) {
  const frames = {}, baseline = { ...f.data, radar: undefined }; // Keep the no-radar baseline despite synthetic jobs from today.
  for (const lang of ['en', 'zh']) {
    for (const width of [40, 80, 120]) frames[`hub-${width}-${lang}`] = plain(f.render(width, lang, undefined, 24));
    for (const page of PAGES.filter((p) => p !== 'tickets')) for (const width of page === 'progress' ? [40, 80, 120] : [40, 120])
      frames[`${page}-${width}-${lang}`] = plain(f.render(width, lang, page, 40, baseline));
  }
  const open = onPage('progress', { project: { folded: new Set(['inbox:done', 'hist:DATA-ONE', 'next', 'next:1']) } });
  for (const lang of ['en', 'zh']) for (const width of [40, 120]) frames[`progress-rich-${width}-${lang}`] = plain(f.render(width, lang, 'progress', 64, f.rich));
  frames['progress-rich-open-40-en'] = plain(f.render(40, 'en', open, 80, f.rich));
  frames['progress-rich-40-text'] = plain(f.render(40, 'en', 'progress', 64, f.rich, true, 'text'));
  const second = { projects: PROJECTS, projectName: PROJECTS[1].name };
  for (const lang of ['en', 'zh']) frames[`hub-switch-40-${lang}`] = plain(f.render(40, lang, onPage(undefined, { selectedProject: PROJECTS[1].root }), 24, f.data, true, 'unicode', 'none', second));
  frames['progress-switch-40-en'] = plain(f.render(40, 'en', onPage('progress', { selectedProject: PROJECTS[1].root }), 12, f.data, true, 'unicode', 'none', second));
  const control = richControl(baseline);
  // The hub on a tall panel and on shorter ones: keep ranked Needs-you rows ahead of optional facts.
  for (const [height, lang] of [[40, 'en'], [40, 'zh'], [20, 'en'], [16, 'en'], [12, 'en']]) frames[`hub-rich-40-${height}-${lang}`] = plain(f.render(40, lang, undefined, height, f.rich));
  frames['hub-rich-120-40-en'] = plain(f.render(120, 'en', undefined, 40, f.rich));
  // The Control plane: what needs the owner first, healthy roles folded; opened, with the files.
  for (const lang of ['en', 'zh']) for (const width of [40, 120]) frames[`control-rich-${width}-${lang}`] = plain(f.render(width, lang, 'control', 48, control));
  const opened = onControl({ folded: new Set(['agents', 'usage']) });
  for (const lang of ['en', 'zh']) {
    frames[`control-rich-open-40-${lang}`] = plain(f.render(40, lang, opened, 56, control));
    frames[`control-chain-40-${lang}`] = plain(f.render(40, lang,
      onControl({ cursor: 'project:role:imp', folded: new Set(['agents', 'files', 'usage']) },
        { overlay: chainOverlay(control.roles.find((r) => r.role === 'imp')) }), 26, control));
  }
  frames['control-rich-open-120-en'] = plain(f.render(120, 'en', opened, 56, control));
  frames['control-rich-40-text'] = plain(f.render(40, 'en', 'control', 48, control, true, 'text'));
  Object.assign(frames, pickerFrames(f, control), pickerOrderFrames(f), flatPickerFrames(f), presetFrames(f, control), quickModelFrames(f, control));
  frames['hub-40-text'] = plain(f.render(40, 'en', undefined, 24, f.data, true, 'text'));
  frames['progress-40-text'] = plain(f.render(40, 'en', 'progress', 40, f.data, true, 'text'));
  return frames;
}

export function presetFrames(f, control) {
  const base = control.roles.find((r) => r.role === 'imp');
  const agy = { ...base.places[1], state: 'standby', thinking: null };
  const fileChain = [{ harness: 'pi', label: 'pi', provider: 'openai', model: 'openai/gpt-6.1-sol', thinking: 'xhigh', state: 'active' }, agy];
  const imp = { ...base, preset: 'daily', fileChain,
    presets: [{ name: 'default', next: 'pi/openai' }, { name: 'grok', next: null, offBy: 'cli:grok' }, { name: 'daily', next: 'pi/xai' }],
    places: [{ harness: 'pi', label: 'pi', provider: 'xai', model: 'xai/grok-4.7', thinking: 'high', state: 'active' },
      agy, { ...base.places[2], model: 'claude-opus-5-5' }] };
  const withImp = (role) => ({ ...control, roles: control.roles.map((r) => r === base ? role : r) });
  const nav = { cursor: 'project:role:imp' };
  const views = {
    row: {}, list: { overlay: { kind: 'control-preset', sheet: { mode: 'list', role: imp, text: '', at: 0 } } },
    delete: { overlay: { kind: 'control-preset', sheet: { mode: 'delete', role: imp } } },
  };
  const frames = {};
  for (const panelLayout of ['split', 'classic']) for (const lang of ['en', 'zh']) for (const [name, extra] of Object.entries(views))
    frames[`preset-${name}-40-${panelLayout}-${lang}`] = plain(f.render(40, lang, onControl(nav, withState({ prefs: { panelLayout } }, extra)),
      name === 'row' ? 34 : 23, withImp(imp), true, 'unicode', 'none', { projectName: 'harbor-api' }));
  for (const lang of ['en', 'zh']) frames[`preset-switched-40-split-${lang}`] = plain(f.render(40, lang, onControl(nav, { prefs: { panelLayout: 'split' } }, { notice: { kind: 'preset', role: 'imp', name: 'default' } }), 34, withImp({ ...imp, preset: 'default', places: fileChain }), true, 'unicode', 'none', { projectName: 'harbor-api' }));
  return frames;
}

export function quickModelFrames(f, control) {
  const imp = control.roles.find((r) => r.role === 'imp'), reviewer = control.roles.find((r) => r.role === 'reviewer');
  const places = [{ ...imp.places[0], state: 'active', until: undefined, provider: 'xai', model: 'xai/grok-4.7' },
    { ...imp.places[1], state: 'standby', thinking: null }, { ...imp.places[2], model: 'claude-opus-5-5' }];
  const review = { ...reviewer, places: [{ ...reviewer.places[0], model: 'mistral/mistral-small-4' }] };
  const data = (chain) => ({ ...control, control: [], roles: [
    { ...imp, preset: 'daily', places: chain, editor: mockEditor(chain) }, review,
    ...control.roles.filter((r) => ['sonic', 'oracle', 'frontend'].includes(r.role)),
  ] });
  const nav = { cursor: 'project:role:imp', folded: new Set(['usage', 'files']) };
  const frames = {};
  for (const width of [40, 120]) for (const panelLayout of ['split', 'classic']) for (const lang of ['en', 'zh']) {
    const draw = (state, snapshot = data(places)) => f.render(width, lang, state, modelInput(state.overlay) ? 24 : 28, snapshot);
    const send = (frame, key, text) => handleMonitorInput(frame.state, { type: 'key', key, text }, { frame, tree: TREE, nowMs: NOW });
    const row = draw(onControl(nav, { prefs: { panelLayout } }));
    const picker = draw(send(row, 'place-model').state);
    const picked = send(draw(send(picker, '', 'grok-4.7-fast').state), 'enter');
    const { modelIndex: index, run } = picked.action;
    const model = run[index].model;
    const saved = draw({ ...picked.state, control: { ...picked.state.control, notice: { kind: 'model', role: 'imp', index, model } } },
      data(places.map((p, i) => i === index ? { ...p, model } : p)));
    for (const [name, frame] of Object.entries({ row, picker, saved }))
      frames[`quick-model-${name}-${width}-${panelLayout}-${lang}`] = frame.lines.map(stripAnsi);
  }
  return frames;
}

export function pickerFrames(f, control = richControl(f.data), layout = 'split') {
  const frames = {};
  const draw = (lang, snapshot, height, text = '', pick) => {
    const role = snapshot.roles.find((r) => r.role === 'imp');
    const state = onControl({ cursor: 'project:role:imp' }, { prefs: { panelLayout: layout }, overlay: chainOverlay(role) });
    const frame = f.render(40, lang, state, height, snapshot);
    const opened = handleMonitorInput(frame.state, { type: 'key', key: 'place-model' }, { frame, tree: TREE, nowMs: NOW }).state;
    return plain(f.render(40, lang, withChainPicker(opened, { text, pick }), height, snapshot));
  };
  const scenario = (isDefault, current = isDefault ? 'openai/gpt-6.1-sol' : 'xai/grok-4.7', state = 'active', off = []) => ({
    ...control,
    models: { ...control.models, pi: control.models.pi.filter((id) => !off.includes(id.split('/')[0])),
      piFacts: {
        'openai/gpt-6.1-sol': ['272K', '128K', true, true], 'xai/grok-4.7': ['2M', '32K', true, true],
        'xai/grok-4.7-fast': ['2M', '32K', true, true], [`${MAVERICK}-fp8`]: ['1M', '16K', false, true],
      }, piExhausted: { 'openai/gpt-6.1-sol': NOW + 42 * 60000 }, editor: { off: off.map((provider) => `pi:${provider}`) } },
    harnessSwitches: off.map((name) => ({ id: `pi:${name}`, name, group: 'provider', off: true, present: false, uses: [] })),
    roles: control.roles.map((role) => {
      if (role.role !== 'imp') return role;
      const places = [{ ...role.places[0], state, until: undefined, provider: current.includes('/') ? current.split('/')[0] : null,
        model: isDefault ? null : current, piModel: { current, isDefault, defaultId: 'openai/gpt-6.1-sol', defaultSource: 'from pi settings', defaultOff: false },
      }, ...role.places.slice(1)];
      return { ...role, preset: 'daily', places, editor: mockEditor(places) };
    }),
  });
  for (const lang of ['en', 'zh']) {
    frames[`pick-grouped-40-${lang}`] = draw(lang, scenario(true), 24);
    frames[`pick-filter-40-${lang}`] = draw(lang, scenario(false), 20, 'grok', 'model:xai/grok-4.7-fast');
    frames[`pick-long-40-${lang}`] = draw(lang, scenario(false), 16, 'maverick', `model:${MAVERICK}-fp8`);
    frames[`pick-exhausted-40-${lang}`] = draw(lang, scenario(false, undefined, 'active', ['deepseek']), 16, 'openai/gpt-6.1-sol');
    frames[`pick-unknown-40-${lang}`] = draw(lang, scenario(false, 'grok-4.7', 'active', ['deepseek']), 16);
    frames[`pick-off-40-${lang}`] = draw(lang, scenario(false, 'xai/grok-4.7', 'off', ['deepseek', 'xai']), 16);
  }
  frames['pick-no-match-40-en'] = draw('en', scenario(false), 16, 'zz-new');
  return frames;
}

/** The sample's roles and model counts, without the superseded Recent rows. */
export function modelPickerSample(f) {
  const current = { imp: 'daily', 'frontend-imp': 'default', oracle: 'fable', reviewer: 'pi' };
  const cutoff = NOW + 42 * 60000;
  const placesOf = (name, preset) => ROLES[name].presets[preset].map((p, i) => ({
    harness: p.h, label: p.h === 'pi' ? 'pi' : p.agent, thinking: p.think ?? null,
    model: p.prov ? `${p.prov}/${p.model}` : p.model, provider: p.h === 'pi' ? p.prov || null : undefined,
    state: name === 'imp' && preset === 'default' && i === 0 ? 'exhausted' : i === 0 ? 'active' : 'standby',
  }));
  const roles = ['frontend-imp', 'imp', 'reviewer', 'oracle'].map((name) => ({
    role: name, source: 'yours', group: 'roles', path: `/synthetic/roles/${name}.json`,
    preset: current[name], places: placesOf(name, current[name]), editor: mockEditor(placesOf(name, current[name])),
    presets: ROLES[name].order.map((preset) => ({ name: preset, places: placesOf(name, preset) })),
  }));
  const pi = [], piFacts = {};
  for (const [provider, count] of Object.entries(PROVIDER_COUNT)) {
    for (const model of LISTED[provider] ?? []) {
      const id = `${provider}/${model.id}`;
      pi.push(id);
      piFacts[id] = [model.ctx, model.out, !!model.think, !!model.img];
    }
    for (let i = LISTED[provider]?.length ?? 0; i < count; i++) pi.push(`${provider}/synthetic-${i}`);
  }
  const data = { ...f.data, control: [], roles, models: { ...MODEL_LISTS, pi, piFacts, piExhausted: { 'openai/gpt-6.1-sol': cutoff } },
    harnessSwitches: [{ id: 'pi:deepseek', name: 'deepseek', group: 'provider', off: true }], radar: undefined };
  const state = (layout = 'split') => onControl({
    folded: new Set(['usage', 'files']), cursor: 'project:role:imp',
  }, { prefs: { panelLayout: layout }, overlay: chainOverlay(roles.find((r) => r.role === 'imp')) });
  const draw = (lang, state, height = 28, snapshot = data) => f.render(40, lang, state, height, snapshot, true, 'unicode', 'none', {
    projectName: 'harbor-api', projects: PROJECTS, projectWaiting: 2,
  });
  return { state, draw, data };
}

/** S4's 88-model scene. The clear option is off here, so all eight mistral rows fit the first screen. */
export function pickerOrderSample(f) {
  const { data: sample } = modelPickerSample(f), base = sample.roles.find((r) => r.role === 'imp');
  const active = { ...base.places[0], piModel: { current: 'xai/grok-4.7', isDefault: false, defaultId: 'deepseek/offline', defaultOff: true } };
  const old = { ...active, model: 'xai/grok-4.6', piModel: { ...active.piModel, current: 'xai/grok-4.6' } };
  const places = [active, ...base.places.slice(1)], oldPlaces = [old, ...places.slice(1)];
  const sol = { name: 'sol', places: base.presets.find((p) => p.name === 'default').places };
  const role = { ...base, places, editor: mockEditor(places), presets: [sol, { name: 'daily', places }] };
  const reviewer = { ...sample.roles.find((r) => r.role === 'reviewer'), preset: null, presets: [], places: [
    { ...active, provider: 'mistral', model: 'mistral/mistral-small-4', piModel: undefined },
  ] };
  const mistral = ['codestral-3', 'magistral-2', 'mistral-large-4', 'mistral-medium-4', 'mistral-nemo-2', 'mistral-small-4', 'pixtral-3', 'voxtral-2'];
  const data = { ...sample, roles: [role, reviewer], models: { ...sample.models, pi: [
    ...sample.models.pi.filter((id) => !id.startsWith('mistral/')), ...mistral.map((id) => `mistral/${id}`),
  ] } };
  const send = (frame, key, text) => handleMonitorInput(frame.state, { type: 'key', key, text }, { frame, tree: TREE, nowMs: NOW });
  const draw = (width, lang, state, snapshot = data) => f.render(width, lang, state, 24, snapshot, true, 'unicode', 'none', {
    projectWaiting: 2,
  });
  const open = (width, lang, panelLayout = 'split') => {
    const state = onControl({ cursor: 'project:role:imp' }, { prefs: { panelLayout } });
    const shipped = { ...role, source: 'default', path: '/synthetic/shipped/roles/imp.json', places: oldPlaces, editor: mockEditor(oldPlaces) };
    const before = send(draw(width, lang, state, { ...data, roles: [shipped, reviewer] }), 'place-model');
    rememberModel(state, before.state, role, active.model);
    return draw(width, lang, send(draw(width, lang, state), 'place-model').state);
  };
  return { data, draw, open, send };
}

export function pickerOrderFrames(f, layout = 'split') {
  const { draw, open, send } = pickerOrderSample(f), frames = {};
  for (const width of [40, 120]) for (const lang of ['en', 'zh']) {
    const browse = open(width, lang, layout);
    const filter = draw(width, lang, send(browse, '', 'grok').state);
    for (const [name, frame] of Object.entries({ browse, filter })) frames[`pick-order-${name}-${width}-${lang}`] = frame.lines.map(stripAnsi);
  }
  return frames;
}

export function flatPickerFrames(f, panelLayout = 'split') {
  const data = { ...richControl(f.data), models: { ...MODEL_LISTS, cli: { ...MODEL_LISTS.cli,
    claude: [...MODEL_LISTS.cli.claude, 'fable'] } } }, frames = {};
  const state = onControl({ cursor: 'project:role:oracle', folded: new Set(['files', 'usage']) }, { prefs: { panelLayout } });
  for (const width of [40, 120]) for (const lang of ['en', 'zh']) {
    const draw = (state) => f.render(width, lang, state, 24, data);
    const frame = draw(state);
    const opened = handleMonitorInput(frame.state, { type: 'key', key: 'place-model', text: 'm' }, { frame, tree: TREE, nowMs: NOW });
    frames[`pick-flat-claude-${width}-${lang}`] = draw(opened.state).lines.map(stripAnsi);
  }
  return frames;
}
