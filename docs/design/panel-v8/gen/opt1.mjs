// Option 1, Inbox: one list ranked by need; a job is one row. Project opens on what you owe and acts on it in place.
import { H, S, row, lr, blank, sec, cut, fit, tabs, crumb, foot, bar, meter, frame, askCard, rl, job, stem, slice, wait, sel, dec, M3, WAIT, SUMMARY, ASK, HOME_HINTS, PROJ_HINTS, PAGE_HINTS, done3, nameRow } from './frames.mjs';

const slab = () => askCard({ title: ASK.title, right: ASK.right, lines: ASK.lines, options: ASK.options });
const sum1 = () => row(`  {t ${cut(SUMMARY, 38)}}`);
const legend = () => lr('  {s ✓ 3}  {i ◇ 2}  {b ◐ 2}  {a ◆ 1}  {m ○ 1}', '{m 3/9 accepted}');
const progressBlock = () => [sec('Progress', 'Milestone M3'), sum1(), row(`  ${bar(M3, 36)}`), legend()];
const latest = () => [sec('Latest', 'newest first'), slice('try', 'AUDIT-LOG', 'read one audit row', 'to try 3h'), slice('try', 'EXPORT-CSV', 'header and quoting', 'to try 1d'), slice('accepted', 'RATE-LIMIT', 'per-key budget', 'accepted 2d')];
const waiting = (head = true) => [...(head ? [sec('Waiting for you', '3 · 2 to try')] : []), wait(WAIT[0], '3h'), wait(WAIT[1], '1d'), wait(WAIT[2])];
const waitFold = () => lr('{a ?} {a 3 waiting for you · 2 to try}', '{m ▸}');
const fail = (reason2 = true) => [job({ k: 'fail', role: rl('sonic'), title: 'EXPORT-CSV slow run', right: 'failed 9m', bg: 'title' }),
  stem('fail', 'HTTP 429 on the second request;'), ...(reason2 ? [stem('fail', 'no report was written.')] : [])];
const settled = (s = true) => [job({ k: 'done', role: rl('reviewer'), title: 'SYNC-QUEUE tests', right: 'report 2m' }), ...(s ? [stem('done', '{m tests pass; 2 minor items left}', '', null)] : [])];
const runImp = (s = true) => [job({ k: 'run', role: rl('imp'), title: 'SYNC-QUEUE retry on 429', right: '47m' }), ...(s ? [stem('run', '{m fixing the retry cap finding}', '', null)] : [])];
const runRev = (s = true) => [job({ k: 'run', role: rl('reviewer'), title: 'AUTH-REFRESH rotation', right: '6m' }), ...(s ? [stem('run', '{m comparing the rotation window}', '', null)] : [])];
const native = (header = true, s = true) => [...(header ? [sec('this session', '2 running · 1 done')] : []),
  job({ k: 'run', role: '{t Explore}', title: 'retryPolicy callers', right: '2m' }), ...(s ? [stem('run', '{m 4 callers found; reading the peek}', '', null)] : []),
  job({ k: 'run', role: '{t Explore}', title: 'scan tests', right: '1m', ind: '  ' }),
  ...(header ? [job({ k: 'done', role: '{t code-reviewer}', title: 'diff check', right: 'done 4m' })] : [])];

function homeBusy() {
  const r = [tabs('home', 1, 3), blank(), ...slab(), blank(), waitFold(), blank(), sec('Jobs', '3 running · 1 failed'), ...fail(), ...settled(), ...runImp(), ...runRev(), blank(),
    ...native(), blank(), sec('Decided for you', '3 · 1 worth a look'), dec(true, 'SYNC-QUEUE', 'imp', 'q3', 'Add jitter to the backoff', '6m', null), row('  {m ▸ 2 as proposed}'), blank(), ...progressBlock()];
  return { frame: frame(r, H, foot(done3, HOME_HINTS), 'o1 home'), title: 'Home busy',
    note: ['<b>Answers first:</b> what needs me? The question, one row counting what STATE has waiting (Enter lists it), then the failure, all above anything that is only running.',
      '<b>Why:</b> the order is the priority, so no lane header is needed and a job costs one row (two when it runs or went wrong). The package is the title\'s first word. The waiting list and Latest come back in full when nothing runs.'] };
}
function homeIdle() {
  const r = [tabs('home', 0, 3), blank(), ...waiting(), blank(), sec('Jobs', 'nothing running'), ...settled(), job({ k: 'done', role: rl('imp'), title: 'SYNC-QUEUE retry on 429', right: 'done 12m' }), blank(),
    sec('Decided for you', '2 · 1 worth a look'), dec(true, 'SYNC-QUEUE', 'imp', 'q3', 'Add jitter to the backoff', '1h20m', null), row('  {m ▸ 1 as proposed}'), blank(), ...latest(), blank(), ...progressBlock()];
  return { frame: frame(r, H, foot(done3, HOME_HINTS), 'o1 idle'), title: 'Home idle',
    note: ['<b>Answers first:</b> is anything waiting for me? Three rows say so and what. Nothing runs, so Jobs is one header and two settled rows.',
      '<b>Why:</b> with no question there is no slab, and the lower half stays empty on purpose: calm looks calm.'] };
}
function home24() {
  const r = [tabs('home', 1, 3), blank(), ...slab(), blank(), waitFold(), blank(), ...fail(false), ...settled(false), ...runImp(true), ...runRev(false), ...native(false, false),
    row('{a ◆} {a 3 decided for you · 1 worth a look}  {m ▸}'), lr(`  ${bar(M3, 18)}`, '{m M3 3/9 · 2 to try}')];
  return { frame: frame(r, S, foot(done3, HOME_HINTS), 'o1 24'), title: 'Home busy, short',
    note: ['<b>Gives way, in this order:</b> section headers and blank rows, sentences (one is kept, for the job that runs longest), the failure\'s second line, Latest, the legend and summary, the native header.',
      '<b>Never gives way:</b> the question, the waiting count, the failure and every running job keep a row.'] };
}
function hub() {
  const r = [tabs('project', 1, 3), blank(), nameRow(), blank(), sec('Waiting for you', '3 · 2 to try'),
    sel(slice('try', 'AUDIT-LOG', 'read one audit row', '3h', { ind: '' })), slice('try', 'EXPORT-CSV', 'header and quoting', '1d', { ind: '' }), wait(WAIT[2]), blank(),
    sec('In flight', '3'), lr('{b ◐} SYNC-QUEUE', `${rl('imp')} {m 47m}`), lr('{b ◐} AUTH-REFRESH', `${rl('reviewer')} {m 6m}`), lr('{a ◆} SEARCH-INDEX', '{a blocked by SYNC-QUEUE}'), blank(),
    sec('Latest accepted', 'newest first'), slice('accepted', 'RATE-LIMIT', 'per-key budget', '2d', { ind: '' }), slice('accepted', 'CONFIG-LOAD', 'layered config', '4d', { ind: '' }), slice('accepted', 'LOG-FORMAT', 'structured lines', '6d', { ind: '' }), blank(),
    sec('Pages'),
    row(`{b ◐} {t Progress}      ${bar(M3, 14)} {m 3/9}`), row('{a ?} {t Tickets}       3/10 · {a 1 asks you}'), row('{m ○} {t Working tree}  5 changed · 1 ahead'),
    row('{m ○} {t Docs}          spec M3 · review 2d'), row('{a !} {t Control plane} {a imp at limit 42m}')];
  return { frame: frame(r, H, foot('', 'y accept  n flag  ⏎ open  ←→ tab  [ ] project'), 'o1 hub'), title: 'Project hub',
    note: ['<b>Answers first:</b> what do I owe? The two slices to try and the open choice are rows; <code>y</code> accepts and <code>n</code> flags a slice here, with no page and no filter.',
      '<b>Why:</b> to-try was in Waiting, in Latest and behind a filter key; now it is one place. The page rows lead with a mark, amber where the page needs you.'] };
}
function progress() {
  const r = [crumb('harbor-api › Progress', 'updated 14:02'), blank(), row(`  {t/title  M3 } ${bar(M3, 24)} {m 3/9}`), row('  {t M3 closing: retries and token rotation}'), row('  {t in flight; exports wait for your try}'),
    row('  {b 2 working}  {a 1 blocked}  {i 2 to try}  {m 1 todo}'), row('  {s ✓} {m 16 accepted in 2 earlier milestones}'), blank(),
    sec('To try', '2'), sel(slice('try', 'AUDIT-LOG', 'read one audit row', '3h', { ind: '' })), slice('try', 'EXPORT-CSV', 'header and quoting', '1d', { ind: '' }), blank(),
    sec('Now', '3'), lr('{b ◐} SYNC-QUEUE', `${rl('imp')} {m 47m}`), row('  {m fixing the retry cap finding}'), lr('{b ◐} AUTH-REFRESH', `${rl('reviewer')} {m 6m}`), row('  {m comparing the rotation window}'), lr('{a ◆} SEARCH-INDEX', '{a blocked}'), blank(),
    sec('Next', '3'), row('{m →} SEARCH-INDEX: build on write'), row('{m →} METRICS: request counts per route'), row('{m ▸ 1 more}'), blank(),
    sec('History', 'newest first'), slice('accepted', 'RATE-LIMIT', 'per-key budget', '2d', { ind: '' }), slice('accepted', 'CONFIG-LOAD', 'layered config', '4d', { ind: '' }), slice('accepted', 'LOG-FORMAT', 'structured lines', '6d', { ind: '' }),
    lr('{m ▸} M2  {s ✓ 9 accepted}', '{m 11–19d}'), lr('{m ▸} M1  {s ✓ 7 accepted}', '{m 24–30d}')];
  return { frame: frame(r, H, foot('', 'y accept  n flag  ⏎ open  esc back'), 'o1 progress'), title: 'Progress page',
    note: ['<b>Answers first:</b> where is M3, and what is mine to try? The bar and the to-try rows come before anything else.',
      '<b>Why:</b> the owner\'s action used to sit under History; the page now reads in the order you act: owe, moving, next, past.'] };
}
function tickets() {
  const r = [crumb('harbor-api › Tickets'), blank(), row(`  ${meter(3, 10, 16)} {m 3/10}`), row('  {m sq} sync-queue {m 2/6}   {m ec} export-csv {m 1/4}'), blank(),
    sec('For you', '{a 1}'), sel(lr('  {a ?} {m ec} 02 Quoting rules', '{a needs-info}')), row('      {m “Which quote style does it use?”}'), blank(),
    sec('Working', '1'), lr('  {b ◐} {m sq} 03 Retry cap', `${rl('imp')} {m 47m}  {m 1/3}`), blank(),
    sec('Ready', '3'), lr('  {b ●} {m sq} 04 Backoff docs', '{m 0/2}'), lr('  {b ●} {m sq} 05 Metrics hook', '{m 0/1}'), lr('  {b ●} {m ec} 03 Header row', '{m 1/2}'), blank(),
    sec('Blocked', '2'), lr('  {a ◆} {m sq} 06 Docs sweep', '{m ← 04} {b ●}'), lr('  {a ◆} {m ec} 04 Smoke run', '{m ← 03} {b ●}'), blank(),
    sec('▸ Done', '3')];
  return { frame: frame(r, H, foot('', PAGE_HINTS), 'o1 tickets'), title: 'Tickets page',
    note: ['<b>Answers first:</b> which ticket waits for me, and what did it ask (the latest comment sits under the row)?',
      '<b>Why:</b> the page is the same owe-first order as the hub, so one habit covers every page. Lanes by state, a code per feature, as built.'] };
}

export const option1 = {
  id: 'inbox', name: '1 · Inbox', recommended: true,
  thesis: ['<b>One list, ranked by how much each thing needs you.</b> Package lanes dissolve into the job\'s own title; a job is one row, and a second row only when it runs or went wrong. Decisions fold to a count unless one is worth a look; the progress block shrinks to a bar.',
    '<b>Project opens on what you owe</b> (tries, the choice, asks), acts on it in place with <code>y</code> / <code>n</code>, then shows what is moving, then five page rows that lead with a mark. The pages keep their drill-in and read in the same order: owe, moving, next, past.'],
  home: [homeBusy(), homeIdle(), home24()], project: [hub(), progress(), tickets()],
};
