/** Synthetic jobs of one project and a fake herdr fork for the Project Execution page; never an owner's home or server. */
import * as fs from 'node:fs';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

/** The current minute: ages stay stable and freshly written records never look stalled. */
export const NOW = Math.floor(Date.now() / 60000) * 60000;
export const PANE = 'w4E:p1';
export const IDS = {
  imp: 'j0a01000000000000', sonic: 'j0a02000000000000', reviewer: 'j0a03000000000000', queued: 'j0a04000000000000',
  scout: 'j0a05000000000000', quiet: 'j0a06000000000000', settled: 'j0a07000000000000', reaped: 'j0a08000000000000',
  foreign: 'j0a09000000000000',
};
const CLAUDE = { harness: 'claude', id: '5e55a0de-0000-4000-8000-000000000001' };
const CODEX = { harness: 'codex', id: 'c0de0000-0000-4000-8000-000000000002' };
const ago = (minutes) => new Date(NOW - minutes * 60000).toISOString();
/** A tab worker's pane as the fork knows it; its tab starts hidden. */
export const tabPane = (n, name, text) => ({ pane_id: `w4E:p${n}`, tab_id: `w4E:t${n}`, launch_id: `launch_${name}`, terminal_id: `term_${name}`, text, hidden: true });
export const panes = () => [
  tabPane(3, 'imp', ['$ npm run build', '', '────────────────────────', '• Edited src/render/execution-view.ts', '• Running the build',
    '\ttsc finished with 0 errors', `  ${'a very long synthetic line that cannot fit '.repeat(5)}`, '合成的中文屏幕内容，宽字符必须按列计算'.repeat(4),
    '╭──────────────╮', '│ >            │', '╰──────────────╯', ''].join('\n')),
  tabPane(4, 'reviewer', ['Review of the synthetic diff', 'Reading three files', 'One question for the main session', ''].join('\n')),
];

/** A herdr fork that knows `list` and records every request. */
export async function fakeFork(t, socket, list = panes()) {
  const known = new Map(list.map((pane) => [pane.pane_id, pane]));
  const requests = [], open = new Set();
  const server = createServer((conn) => {
    open.add(conn);
    conn.on('close', () => open.delete(conn));
    conn.on('error', () => {});
    createInterface({ input: conn }).on('line', (line) => {
      const req = JSON.parse(line);
      requests.push(req);
      const send = (body) => conn.write(JSON.stringify({ id: req.id, ...body }) + '\n');
      const missing = (code) => send({ error: { code, message: code } });
      if (req.method === 'ping') return send({ result: { type: 'pong', version: '0.9.5-hud.synthetic', capabilities: { hidden_tabs: true } } });
      if (req.method === 'pane.read' || req.method === 'pane.get') {
        const pane = known.get(req.params.pane_id);
        if (!pane) return missing('pane_not_found');
        const { text, hidden, ...info } = pane;
        return send({ result: req.method === 'pane.read' ? { type: 'pane_read', read: { pane_id: pane.pane_id, text } } : { type: 'pane_info', pane: info } });
      }
      if (['tab.get', 'tab.focus', 'tab.set_hidden'].includes(req.method)) {
        const pane = [...known.values()].find((p) => p.tab_id === req.params.tab_id);
        if (!pane) return missing('tab_not_found');
        if (req.method === 'tab.focus') pane.hidden = false;
        if (req.method === 'tab.set_hidden') pane.hidden = req.params.hidden;
        return send({ result: { type: 'tab_info', tab: { tab_id: pane.tab_id, launch_id: pane.launch_id, terminal_id: pane.terminal_id, hidden: pane.hidden } } });
      }
      // Anything else (the panel's own housekeeping) is not part of this fork.
      return missing('unknown_method');
    });
  });
  await new Promise((done) => server.listen(socket, done));
  t.after(() => {
    for (const conn of open) conn.destroy();
    server.close();
  });
  return { panes: known, requests, calls: (...methods) => requests.filter((r) => methods.includes(r.method)) };
}

/** Nine jobs under `root`: a worktree imp with a Sonic child and a scout, a reviewer asking, a second session's queued and quiet jobs, and three the page must leave out. */
export function executionJobs(root, socket) {
  const project = join(root, 'project'), tree = join(root, 'wt-imp'), elsewhere = join(root, 'elsewhere'), hud = join(root, 'hud');
  for (const dir of [project, tree, elsewhere]) fs.mkdirSync(dir, { recursive: true });
  const put = (path, value) => {
    fs.mkdirSync(join(path, '..'), { recursive: true });
    fs.writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
  };
  const job = (name, receipt, status, files = {}) => {
    const id = IDS[name], dir = join(hud, 'jobs', id);
    put(join(dir, 'job.json'), { job: id, cwd: project, herdr_pane: PANE, dispatcher: CLAUDE, dispatch_exit_code: 0, ...receipt });
    put(join(dir, 'STATUS.json'), status);
    for (const [file, body] of Object.entries(files)) put(join(dir, file), body);
  };
  const progress = (...entries) => entries.map(([minutes, text]) => JSON.stringify({ at: ago(minutes), text })).join('\n') + '\n';
  const session = (n, name) => { const pane = tabPane(n, name); return [`LAUNCH_ID=${pane.launch_id}`, `TERMINAL_ID=${pane.terminal_id}`,
    'DIRECT_EXEC=1', `HERDR_SOCKET_PATH=${socket}`, `TAB=${pane.tab_id}`, `LEFT=${pane.pane_id}`, ''].join('\n'); };
  job('imp', { role: 'imp', cwd: tree, worktree: { root: fs.realpathSync(tree), main_root: project, branch: 'wt/exec' }, preset: 'fast', created_at: ago(13) },
    { state: 'working', started_at: ago(12), model: 'openai/gpt-6.1-sol' },
    { 'brief.md': '# EXEC-01: add the synthetic page\n', 'progress.jsonl': progress([9, 'Read the ticket'], [2, 'Build passes; writing frame tests']), 'SESSION.txt': session(3, 'imp') });
  // A Sonic child works in its parent's worktree: only its receipt's project root ties it to the project.
  job('sonic', { role: 'sonic', cwd: tree, project_root: project, headless: true, parent_job: IDS.imp, caller_pane: PANE,
    dispatcher: { harness: 'pi', id: 'worker-session' }, created_at: ago(4) },
    { state: 'working', started_at: ago(3), model: 'mistral/deepseek-v4-1-flash-1017' },
    { 'brief.md': '# Collect the synthetic callers\n', 'progress.jsonl': progress([3, 'Reading the architecture rules'], [1, 'Found three callers']) });
  job('scout', { role: 'sonic', headless: true, parent_job: IDS.imp, scout_only: true, prewalk_kind: 'code', created_at: ago(14) },
    { state: 'closed', started_at: ago(14), settled_at: ago(13) }, { 'brief.md': '# Scout the synthetic code\n', 'report.md': 'Done.' });
  job('reviewer', { role: 'reviewer', created_at: ago(6) }, { state: 'waiting_orchestrator', started_at: ago(5), model: 'anthropic/claude-opus-5-5' },
    { 'brief.md': '# Review the synthetic diff\n', 'qa/q1.md': '# Question\n\nKeep the synthetic shim for one more release?\n\nDefault if unanswered: keep it\n', 'SESSION.txt': session(4, 'reviewer') });
  job('queued', { role: 'imp', herdr_pane: 'w4E:p9', dispatcher: CODEX, imp_preset: 'neon', created_at: ago(2), queued_at: ago(2) }, { state: 'queued' },
    { 'brief.md': '# EXEC-02: the next synthetic slice\n' });
  job('quiet', { role: 'sonic', herdr_pane: undefined, caller_pane: 'w4E:p9', headless: true, dispatcher: CODEX, created_at: ago(1) },
    { state: 'working', started_at: ago(1) }, { 'brief.md': '# Check the synthetic docs\n',
      'stdout.jsonl': JSON.stringify({ type: 'tool_execution_start', toolName: 'read', args: { path: 'docs/synthetic.md' } }) + '\n' });
  job('settled', { role: 'imp', created_at: ago(50) }, { state: 'closed', started_at: ago(50), settled_at: ago(40) }, { 'brief.md': '# Finished earlier\n' });
  job('reaped', { role: 'imp', reaped_at: ago(30), created_at: ago(60) }, { state: 'working', started_at: ago(60) }, { 'brief.md': '# Reaped long ago\n' });
  job('foreign', { role: 'imp', cwd: elsewhere, project_root: elsewhere, created_at: ago(7) }, { state: 'working', started_at: ago(7) }, { 'brief.md': '# Another project\n' });
  return { project, hud, env: { HERDR_SOCKET_PATH: socket }, dir: (name) => join(hud, 'jobs', IDS[name]) };
}
