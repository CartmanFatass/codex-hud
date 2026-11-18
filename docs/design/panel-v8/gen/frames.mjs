// The frames: one invented project ("harbor-api"), the same facts in every option. Synthetic data only.
import { parse, row, lr, blank, sec, cut, fit, tabs, crumb, foot, bar, meter, frame, askCard } from './lib.mjs';
const plain = (m) => parse(m).reduce((n, s) => n + [...s.t].length, 0);

const H = 48, S = 24;
// ---------------------------------------------------------------------------------------------- shared vocabulary
const RC = { imp: 'imp', reviewer: 'rev', sonic: 'son', oracle: 'ora' };
const rl = (r) => `{${RC[r] ?? 't'} ${r}}`;
const INK = { run: 'b', ask: 'a', fail: 'd', done: 's', stall: 'o' };
const GL = { run: '◉', ask: '?', fail: '✗', done: '✓', stall: '◷' };
/** Today's card: a title band, then body rows (a failed card's body is tinted). `ind` indents a native subagent's child. */
function card({ k, role, title, right, lines = [], ind = '' }) {
  const ink = INK[k];
  return [
    lr(`${ind}{${ink} ${GL[k]}} ${role}  ${title}`, `{${ink} ${right}}`, 'title'),
    ...lines.map((l) => row(`${ind}{${ink} ┃} ${l}`, k === 'fail' ? 'fail' : 'body')),
  ];
}
/** A job as one plain row, no band (the options' lighter card). */
const job = ({ k, role, title, right, ind = '', bg }) => {
  // The title is cut to what the glyph, the role and the right side leave (work-card.ts `workCardName`).
  const room = 40 - ind.length - 2 - plain(role) - 2 - right.length - 2;
  return lr(`${ind}{${INK[k]} ${GL[k]}} ${role}  ${cut(title, room)}`, `{${k === 'run' ? 'm' : INK[k]} ${right}}`, bg);
};
const stem = (k, text, ind = '', bg = 'body') => row(`${ind}{${INK[k]} ┃} ${text}`, k === 'fail' ? 'fail' : bg);
const SL = { try: ['◇', 'i'], accepted: ['✓', 's'], working: ['◐', 'b'], blocked: ['◆', 'a'], todo: ['○', 'm'] };
/** A ledger slice row: mark, id, text, and what the right side says. */
const slice = (st, id, text, right, { ind = '  ', bg, ink } = {}) => {
  const [g, k] = SL[st];
  // The text rides on the row only when it fits whole (project-view.ts `inline`).
  const fits = text && ind.length + 2 + id.length + 2 + text.length + 1 + (right ?? '').length <= 40;
  return lr(`${ind}{${k} ${g}} ${id}${fits ? '  {m ' + text + '}' : ''}`, right ? `{${ink ?? (st === 'try' ? 'i' : 'm')} ${right}}` : '', bg);
};
const wait = (text, right = '') => lr(`{a ?} ${text}`, right ? `{m ${right}}` : '');
const sel = (r) => ({ ...r, bg: 'sel' });
/** A collapsed decision row (workboard-rows.ts decisionRows): the title takes what the head and the age leave. */
const dec = (departure, lane, role, q, title, age, bg = 'title', flag = '') => {
  const ink = departure ? 'a' : 'm', head = `${lane} · ${role} ${q}`, right = flag ? `${flag} · ${age}` : age;
  const room = 40 - 2 - head.length - 2 - right.length - 1;
  return lr(`{${ink} ${departure ? '◆' : '◇'}} ${lane} · ${rl(role)} ${q}  {${ink} ${cut(title, room)}}`, `{${ink} ${right}}`, bg);
};

// The counts of the current milestone M3 (9 slices) and the project's other facts.
const M3 = { working: 2, blocked: 1, try: 2, todo: 1, accepted: 3 };
const WAIT = ['Try AUDIT-LOG: read one audit row', 'Try EXPORT-CSV: header and quoting', 'Choose the browser profile'];
const SUMMARY = 'M3 closing: retries and token rotation in flight; exports wait for your try';
const ASK = {
  title: 'imp · SYNC-QUEUE', right: 'asking 4m', lines: ['Keep the v1 shim for one more release', 'or drop it with this change?'],
  options: [['a', 'keep it for one more release'], ['b', 'drop it with this change']],
};
const HOME_HINTS = '↑↓ move  ⏎ expand  o open  v inspect  a all  , settings  ? help  ←→ tab';
const PROJ_HINTS = '↑↓ move  ⏎ open  ←→ tab  [ ] project  ? help';
const PAGE_HINTS = '↑↓ move  ⏎ open  esc back  ? help';
const done3 = '{s ✓ 3 done today}';
const nameRow = (ms = 'M3') => {
  const tail = `${ms} ▾ project 1/3`, rule = 40 - 'harbor-api'.length - [...tail].length - 2;
  return lr(`{t* harbor-api} {f ${'─'.repeat(rule)}}`, `{b ${ms}} {m ▾ project 1/3}`);
};

// ------------------------------------------------------------------------------------------------------- TODAY
function todayHome() {
  const r = [tabs('home', 1, 3), blank(), row('{a ? 4 waiting for you · 3 running}'), blank()];
  r.push(lr('{ask ? imp · SYNC-QUEUE}', '{ask asking 4m}', 'askT'), ...ASK.lines.map((l) => row(`{a ┃} {a ${l}}`, 'slab')),
    row(`{a ┃} {a ${cut('2 options · default: a: keep it for one more release', 38)}}`, 'slab'), lr('{a ┃} {m qa/q3.md}', '{m ⏎ expand  o open}', 'slab'));
  r.push(blank());
  const lane = (label, phase, strip) => lr(`${label}  {m ${phase}}`, strip);
  r.push(lane('SYNC-QUEUE', 'review r1 · fixing', '{a ?} {b ◉} {s ✓} {m imp}'));
  r.push(lr(`{a ?} ${rl('imp')}  dedupe sync queue`, '{a asking 4m}', 'title'));
  r.push(...card({ k: 'run', role: rl('imp'), title: 'retry on HTTP 429', right: '47m', lines: ['fixing the retry cap finding: jitter', 'is now bounded at 30 s'] }));
  r.push(...card({ k: 'done', role: rl('reviewer'), title: 'retry tests', right: 'report ready 2m', lines: ['tests pass; 2 minor items left', ''] }));
  r.push(blank(), lane('AUTH-REFRESH', 'build', '{b ◉} {m reviewer}'));
  r.push(...card({ k: 'run', role: rl('reviewer'), title: 'token rotation', right: '6m', lines: ['comparing the rotation window', '{m …}'] }));
  r.push(blank(), lane('EXPORT-CSV', 'build', '{d ✗}'));
  r.push(...card({ k: 'fail', role: rl('sonic'), title: 'slow tests', right: 'failed 9m', lines: ['HTTP 429 on the second request; no', 'report was written.'] }));
  r.push(blank(), lane('this session', '', '{b ◉} {b ◉} {s ✓} {m Explore}'));
  r.push(...card({ k: 'run', role: '{t Explore}', title: 'retryPolicy callers', right: '2m', lines: ['4 callers found; reading the peek', '{m …}'] }));
  r.push(...card({ k: 'run', role: '{t Explore}', title: 'scan tests', right: '1m', ind: '  ', lines: ['{m …}', ''] }));
  r.push(lr(`{s ✓} {t code-reviewer}  diff check`, '{s done 4m}', 'title'));
  r.push(blank(), sec('Decided for you', '3'));
  r.push(dec(true, 'SYNC-QUEUE', 'imp', 'q3', 'Add jitter to the backoff', '6m'), dec(false, 'AUTH-REFRESH', 'imp', 'q2', 'Keep the 15 min window', '14m'),
    dec(false, 'SYNC-QUEUE', 'imp', 'q1', 'Cursor stays in IndexedDB', '58m'));
  // What is left under the cards is Home's progress block, which takes the spare rows first (project-view.ts homeProgressRows).
  r.push(blank(), sec('Progress', 'Milestone M3'), row('  {t M3 closing: retries and token rotation}'),
    row(`  ${bar(M3, 28)}`));
  return { frame: frame(r, H, foot(done3, HOME_HINTS), 'today home'), title: 'Home busy', note: [
    '<b>Today.</b> Each lane is a header row plus cards of a fixed three rows; the header repeats what the card title says. Questions, failures, decisions and the progress block each bring their own block, and the spare rows are gone before Waiting, Latest or tickets can appear.'] };
}
function todayHub() {
  const r = [tabs('project', 1, 3), blank(), nameRow()];
  r.push(sec('Waiting for you', '3 · 2 to try'), wait(WAIT[0]), wait(WAIT[1]), wait(WAIT[2]), blank());
  r.push(sec('Now', '3'));
  r.push(lr('  {b ◐} SYNC-QUEUE', `${rl('imp')} {m 47m}`), lr('  {b ◐} AUTH-REFRESH', `${rl('reviewer')} {m 6m}`), lr('  {a ◆} SEARCH-INDEX', '{a blocked}'), blank());
  r.push(sec('Latest', 'newest first'), slice('try', 'AUDIT-LOG', '', 'to try 3h'), slice('try', 'EXPORT-CSV', '', 'to try 1d'), slice('accepted', 'RATE-LIMIT', '', 'accepted 2d'), blank());
  const page = (name, facts) => row(`{t/title ${fit(name, 14)}}${facts}`);
  r.push(page('Progress', 'M3 · 2 working · 2 to try'), row(bar(M3, 40)));
  r.push(page('Tickets', '3/10 done · 1 working'), page('Working tree', 'wt/sync-queue · 5 changed'), page('Docs', 'M3 · sync · review 2d'), page('Control plane', '{a 1 at limit} · 5 roles'));
  return { frame: frame(r, H, foot('', PROJ_HINTS), 'today hub'), title: 'Project hub', note: [
    '<b>Today.</b> Four blocks of rows that look alike (Waiting, Now, Latest, then pages), the same to-try slices twice (Waiting and Latest), and one-line facts that cut off. The pages are one Enter away, and Esc back.'] };
}
function todayProgress() {
  const r = [crumb('harbor-api › Progress', 'updated 14:02'), blank(), row('  {t M3 closing: retries and token rotation}'), row('  {t in flight; exports wait for your try}')];
  r.push(row(`   {t/title  M3 } ${bar(M3, 24)} {m 3/9}`), row('  {b 2 working}  {a 1 blocked}  {i 2 to try}  {m 1 todo}'), row('  {s ✓} {m 16 accepted in 2 earlier milestones}'), blank());
  r.push(sec('Now', '3'));
  r.push(row('  {b ◐} SYNC-QUEUE'), row('    {m retry on HTTP 429 with a capped}'), row('    now: fixing the retry cap… imp 47m'.replace('now:', '{m now:}')));
  r.push(row('  {b ◐} AUTH-REFRESH'), row('    {m rotate refresh tokens before they}'), row('    now: comparing the rotation… rev 6m'.replace('now:', '{m now:}')));
  r.push(row('  {a ◆} SEARCH-INDEX'), row('    {m build the index on write}'), blank());
  r.push(sec('Next', '3'), row('  {m →} SEARCH-INDEX: build the index on'), row('    write'), row('  {m →} METRICS: request counts per route'), row('  {m ▸ 1 more}'), blank());
  r.push(sec('History', 'newest first'));
  r.push(slice('try', 'AUDIT-LOG', 'read one audit row', 'to try 3h'), slice('try', 'EXPORT-CSV', 'header and quoting', 'to try 1d'), slice('accepted', 'RATE-LIMIT', 'per-key budget', '2d'),
    slice('accepted', 'CONFIG-LOAD', 'layered config', '4d'), slice('accepted', 'LOG-FORMAT', 'structured lines', '6d'));
  r.push(lr('  {m ▸} M2  {s ✓ 9 accepted}', '{m 11–19d}'), lr('  {m ▸} M1  {s ✓ 7 accepted}', '{m 24–30d}'));
  return { frame: frame(r, H, foot('', '↑↓ move  ⏎ open  t to try  esc back  ? help'), 'today progress'), title: 'Progress page', note: [
    '<b>Today.</b> What you owe (to try) is under History, behind a filter key. Counts, summary, Now with wrapped sentences, Next and History each have their own header.'] };
}
export const today = [todayHome(), todayHub(), todayProgress()];

// Options are appended below.
export const options = [];
export { dec, H, S, row, lr, blank, sec, cut, fit, tabs, crumb, foot, bar, meter, frame, askCard, rl, card, job, stem, slice, wait, sel, M3, WAIT, SUMMARY, ASK, HOME_HINTS, PROJ_HINTS, PAGE_HINTS, done3, nameRow, INK, GL };
