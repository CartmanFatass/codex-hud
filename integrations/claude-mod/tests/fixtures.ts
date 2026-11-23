// Synthetic HUD results. The key sets are the real ones (dumped from src/mcp/mcp/operations.ts through the
// tests/unit/thin-mcp-* harness); every id, path and sentence is made up.
const home = '/hud-home';
const [a1, a2, a3] = ['j00000000000000a1', 'j00000000000000a2', 'j00000000000000a3'];
const readHint = (job: string) => `hud_read job=${job} (mode: "full" for the whole report)`;
const changed = [
  'src/billing/invoice-total.ts', 'src/billing/rounding-rules.ts', 'src/billing/currency-table.ts',
  'src/billing/index.ts', 'src/invoices/render-line.ts', 'src/invoices/render-header.ts',
  'src/invoices/templates/default.ts', 'src/invoices/templates/compact.ts', 'src/export/csv-writer.ts',
  'src/export/pdf-writer.ts', 'tests/unit/invoice-total.test.mjs', 'tests/unit/rounding-rules.test.mjs',
  'tests/unit/render-line.test.mjs', 'tests/unit/csv-writer.test.mjs', 'docs/billing.md', 'docs/export.md',
];
const summary = 'Synthetic slice done: totals round per line; 14 checks pass.';
const report = [
  '# Report for the synthetic slice', '',
  '**Verdict:** Accept', 'Blockers: None', '',
  '## What changed',
  ...changed.slice(0, 8).map((p) => `- \`${p}\`: renamed the helper and added a case for the empty row.`), '',
  '## Evidence',
  ...Array.from({ length: 10 }, (_, i) => `- check ${i + 1}: passed in ${40 + i * 7} ms; no output beyond the summary line.`), '',
  'Everything in the brief was done; nothing was skipped.',
].join('\n');
const progress = [
  'read the ticket', 'wrote the parser', 'added tests', 'tests pass', 'wrote the report',
].map((text, i) => ({ at: `2026-01-01T10:0${i}:00.000Z`, text }));
const route = { tier: 'standard', mode: 'tab', source: 'default', reason: 'Imp routing is off' };
const base = 'a'.repeat(40), head = 'b'.repeat(40);

const question = `[imp] QUESTION q1: Keep the old field name or rename it? | options: keep / rename | default: keep | context: two callers use it | full text: ${home}/jobs/${a1}/qa/q1.md | reply: hud_respond job=${a1} request_id=q1`;
const lines = {
  working: `${a1} imp ticket-01: working`,
  waiting: `${a1} imp ticket-01: waiting_orchestrator | QUESTION`,
  closed: `${a2} imp ticket-02: closed | report | ${summary} | ${readHint(a2)}`,
  land: `${a3} imp ticket-03: closed | report | Synthetic landing ready. | ${readHint(a3)}`,
};
const row = (...events: string[]) =>
  `<task-notification>\n<task-id>b00000001</task-id>\n<summary>Monitor event: "HUD job state changes and worker questions"</summary>\n<event>${events.join('\n')}</event>\n</task-notification>`;

export const results: { name: string; value: unknown }[] = [
  { name: 'hud_create', value: {
    job: a1, role: 'imp', package: null, state: 'working', display_state: 'working', reason: null, blocked: false,
    open_questions: 0, report_present: false, task_dir: `${home}/jobs/${a1}`, agent: `${a1}-primary`,
    attempts: [{ index: 0, place: 'claude (synthetic/default)' }], used_place: 'claude (synthetic/default)', route,
    thinking: 'low', watcher_alive: true,
    hint: 'Claude Code: `hud watch` is live under Monitor; re-arm after expiry. Keep working until notified, then collect reports with `hud_read`.',
  } },
  { name: 'hud_read digest', value: {
    job: a2, role: 'imp', route, state: 'closed', display_state: 'done', changed_files: changed, report_exists: true,
    digest: { state: 'closed', read_hint: readHint(a2), report_bytes: 2412, changed_files: changed.length, verdict: 'Accept', blockers: 'None', result: summary },
  } },
  { name: 'hud_read full', value: {
    job: a2, role: 'imp', route, state: 'closed', display_state: 'done',
    git_summary: { branch: 'wt/ticket-02', base_head: base, head, ahead_commits: 1, changed_files: changed.length, dirty: false, overlaps: [] },
    worktree: { main_root: '/work/project', root: '/work/project-wt/ticket-02', branch: 'wt/ticket-02', base_head: base },
    report_exists: true, report_meta: { summary }, report_unread: true, progress, latest_progress: progress.at(-1),
    report_path: `${home}/jobs/${a2}/report.md`, report,
  } },
  { name: 'hud_land', value: {
    flow: 'f00000000000000b1', job: a2, state: 'completed', step: 'done', landed_sha: 'c'.repeat(40), records_sha: 'd'.repeat(40),
    replayed_onto: 'main@e4f5a6b',
    timings: ['replay', 'build', 'unit', 'integration', 'records'].map((step, i) => ({ step, ms: 1200 + i * 3100, ok: true })),
    tail: ['> npm run build', 'built 212 files', '> npm test', 'pass 411', 'fail 0'],
  } },
];

/** One turn: Monitor rows, then a tool result whose `changes` repeat lines a row already carried. */
export const burst = {
  rows: [
    row(lines.working),
    row(lines.waiting, question),
    row(lines.waiting, question),
    row(lines.closed),
    row(lines.closed, lines.land),
    row(lines.land),
  ],
  result: { name: 'hud_read digest + changes', value: {
    job: a2, role: 'imp', state: 'closed', display_state: 'done', report_exists: true,
    digest: { state: 'closed', read_hint: readHint(a2), report_bytes: 2412, result: summary },
    changes: [lines.closed, lines.land],
  } },
};
export const ids = { a1, a2, a3, question, lines, changed, summary, readHint };
