// Option 3, Timeline: what runs now, then everything that happened as one feed in time order. Project is one page that scrolls.
import { H, S, row, lr, blank, sec, cut, fit, tabs, crumb, foot, bar, meter, frame, askCard, rl, job, stem, slice, wait, sel, M3, WAIT, SUMMARY, ASK, HOME_HINTS, PROJ_HINTS, PAGE_HINTS, done3, nameRow } from './frames.mjs';

const slab = () => askCard({ title: ASK.title, right: ASK.right, lines: ASK.lines, options: ASK.options });
const sum1 = () => row(`  {t ${cut(SUMMARY, 38)}}`);
/** One feed row: age in a rail column, a mark, the thing. */
const ev = (age, g, ink, text, right = '', bg) => lr(`{m ${age.padStart(3)}} {${ink} ${g}} ${text}`, right ? `{${ink === 'a' || ink === 'd' ? ink : 'm'} ${right}}` : '', bg);
const rail = (ink, text) => row(`    {${ink} ┃} ${text}`, ink === 'd' ? 'fail' : null);
const now = (header = true, rows = 4) => [...(header ? [sec('Now', String(rows))] : []),
  job({ k: 'run', role: rl('imp'), title: 'SYNC-QUEUE retry on 429', right: '47m' }), job({ k: 'run', role: rl('reviewer'), title: 'AUTH-REFRESH rotation', right: '6m' }),
  job({ k: 'run', role: '{t Explore}', title: 'retryPolicy callers', right: '2m' }), job({ k: 'run', role: '{t Explore}', title: 'scan tests', right: '1m', ind: '  ' })];
const waiting = (head = true) => [...(head ? [sec('Waiting for you', '3 · 2 to try')] : []), wait(WAIT[0], '3h'), wait(WAIT[1], '1d'), wait(WAIT[2])];
const waitFold = () => lr('{a ?} {a 3 waiting for you · 2 to try}', '{m ▸}');
const progressBlock = () => [sec('Progress', 'Milestone M3'), sum1(), row(`  ${bar(M3, 36)}`), lr('  {s ✓ 3}  {i ◇ 2}  {b ◐ 2}  {a ◆ 1}  {m ○ 1}', '{m 3/9 accepted}')];
const feedTail = () => [ev('3h', '◇', 'i', 'AUDIT-LOG landed', 'to try'), ev('1d', '◇', 'i', 'EXPORT-CSV landed', 'to try'), ev('2d', '✓', 's', 'RATE-LIMIT accepted')];

function homeBusy() {
  const r = [tabs('home', 1, 3), blank(), ...slab(), blank(), waitFold(), blank(), ...now(), blank(), sec('Happened', 'newest first'),
    ev('2m', '✓', 's', `${rl('reviewer')}  SYNC-QUEUE tests`, 'report'), ev('4m', '✓', 's', '{t code-reviewer}  diff check'), ev('6m', '◆', 'a', '{a SYNC-QUEUE  Add jitter to the…}'),
    ev('9m', '✗', 'd', `${rl('sonic')}  EXPORT-CSV slow run`, 'failed'), rail('d', 'HTTP 429 on the second request;'), rail('d', 'no report was written.'),
    ev('14m', '◇', 'm', '{m AUTH-REFRESH  Keep the 15 min…}'), ...feedTail(), blank(), ...progressBlock()];
  return { frame: frame(r, H, foot(done3, HOME_HINTS), 'o3 home'), title: 'Home busy',
    note: ['<b>Answers first:</b> what needs me (the question, then one row counting what STATE has waiting), then what is running right now, then what happened since I last looked, newest first.',
      '<b>Why:</b> finished jobs, decisions made for you and landed slices were three blocks with three grammars; they are one feed, one row each, so the age column is the only thing to scan. Running jobs lose their sentence rows.'] };
}
function homeIdle() {
  const r = [tabs('home', 0, 3), blank(), ...waiting(), blank(), sec('Now', 'nothing running'), blank(), sec('Happened', 'newest first'),
    ev('8m', '✓', 's', `${rl('reviewer')}  SYNC-QUEUE tests`, 'report'), ev('12m', '✓', 's', `${rl('imp')}  SYNC-QUEUE retry on 429`), ev('28m', '◇', 'm', '{m SYNC-QUEUE  Cursor stays in…}'),
    ev('1h', '◆', 'a', '{a SYNC-QUEUE  Add jitter to the…}'), ...feedTail(), blank(), ...progressBlock()];
  return { frame: frame(r, H, foot(done3, HOME_HINTS), 'o3 idle'), title: 'Home idle',
    note: ['<b>Answers first:</b> is anything waiting for me? Three rows. Then Now says nothing runs and the feed says what just finished.',
      '<b>Why:</b> the idle Latest list and Decided for you are feed rows now, so idle Home is the busy one with Now emptied.'] };
}
function home24() {
  const r = [tabs('home', 1, 3), blank(), ...slab(), blank(), waitFold(), blank(), ...now(false), blank(),
    ev('2m', '✓', 's', `${rl('reviewer')}  SYNC-QUEUE tests`, 'report'), ev('6m', '◆', 'a', '{a SYNC-QUEUE  Add jitter to the…}'), ev('9m', '✗', 'd', `${rl('sonic')}  EXPORT-CSV slow run`, 'failed'),
    row('  {m +5 older · a}'), lr(`  ${bar(M3, 18)}`, '{m M3 3/9 · 2 to try}')];
  return { frame: frame(r, S, foot(done3, HOME_HINTS), 'o3 24'), title: 'Home busy, short',
    note: ['<b>Gives way:</b> from the bottom of the feed (older rows go to <code>+N older</code>), then headers, the failure\'s reason, the progress sentence and legend.',
      '<b>Never gives way:</b> the question, the waiting count and every running job; a failure stays in the feed until it is old.'] };
}
const fold = (open, name, facts, bg) => row(`{m ${open ? '▾' : '▸'}} {t ${fit(name, 13)}} ${facts}`, bg);
const CELL = { accepted: ['✓', 's'], try: ['◇', 'i'], working: ['◐', 'b'], blocked: ['◆', 'a'], todo: ['○', 'm'] };
/** A milestone as a row of cells, one per slice in ledger order: the shape of the project's history in four rows. */
const mapRow = (name, states, tail, current = false) =>
  lr(`{${current ? 'b*' : 'm'} ${fit(name, 3)}} ${states.map((x) => `{${CELL[x][1]} ${CELL[x][0]}}`).join('')}`, `{m ${tail}}`);
const M3S = ['accepted', 'accepted', 'accepted', 'try', 'try', 'working', 'working', 'blocked', 'todo'];
const mapRows = () => [mapRow('M1', Array(7).fill('accepted'), '7/7   24d'), mapRow('M2', Array(9).fill('accepted'), '9/9   11d'), mapRow('M3', M3S, '3/9    3h', true), row('{m M4  not started}')];
function hub() {
  const r = [tabs('project', 1, 3), blank(), nameRow(), ...mapRows(), row('  {t M3 closing: retries and token rotation}'), row('  {t in flight; exports wait for your try}'), blank(),
    sec('Now', '{a 3 for you} {m · 3 live}'), sel(slice('try', 'AUDIT-LOG', 'read one audit row', '3h', { ind: '' })), slice('try', 'EXPORT-CSV', 'header and quoting', '1d', { ind: '' }), wait(WAIT[2]),
    lr('{b ◐} SYNC-QUEUE', `${rl('imp')} {m 47m}`), lr('{b ◐} AUTH-REFRESH', `${rl('reviewer')} {m 6m}`), lr('{a ◆} SEARCH-INDEX', '{a blocked}'), blank(),
    sec('Next', '3'), row('{m →} SEARCH-INDEX: build on write'), row('{m →} METRICS: request counts per route'), row('{m ▸ 1 more}'), blank(),
    sec('Last 7 days', 'newest first'), ev('3h', '◇', 'i', 'AUDIT-LOG  read one audit row'), ev('1d', '◇', 'i', 'EXPORT-CSV  header and quoting'), ev('2d', '✓', 's', 'RATE-LIMIT  per-key budget'), ev('4d', '✓', 's', 'CONFIG-LOAD  layered config'), ev('6d', '✓', 's', 'LOG-FORMAT  structured lines'), blank(),
    fold(false, 'Tickets', '{m 3/10 ·} {a 1 asks you}'), fold(false, 'Working tree', '{m 5 changed · 1 ahead}'), fold(false, 'Docs', '{m spec M3 · review 2d}'), fold(false, 'Control plane', '{a imp at limit 42m}')];
  return { frame: frame(r, H, foot('', 'y accept  n flag  ⏎ open  ←→ tab  [ ] project'), 'o3 hub'), title: 'Project hub (one page)',
    note: ['<b>Answers first:</b> where is the project in time? One row per milestone, a cell per slice, so the whole history is four rows. Then Now (what you owe and what runs), Next, and the last seven days.',
      '<b>Why:</b> the hub and the Progress page told one story twice. Here it is told once, and the four small pages are folds at the foot that open in place (no page, no Esc).'] };
}
function progress() {
  const day = (label, date) => lr(`{t* ${label}}`, `{m ${date}}`);
  const r = [crumb('harbor-api › Progress', 'updated 14:02'), blank(), ...mapRows(), blank(),
    day('Today', 'Tue 17'), sel(slice('try', 'AUDIT-LOG', 'read one audit row', '3h', { ind: '  ' })), day('Yesterday', 'Mon 16'), slice('try', 'EXPORT-CSV', 'header and quoting', '1d'),
    day('Sunday', 'Sun 15'), slice('accepted', 'RATE-LIMIT', 'per-key budget', '2d'), day('Friday', 'Fri 13'), slice('accepted', 'CONFIG-LOAD', 'layered config', '4d'),
    day('Wednesday', 'Wed 11'), slice('accepted', 'LOG-FORMAT', 'structured lines', '6d'), blank(),
    sec('Older', '16 accepted'), lr('{m ▾} M2  {s ✓ 9 accepted}', '{m 11–19d}'), slice('accepted', 'AUTH-BASE', 'login and sessions', '19d'), slice('accepted', 'DB-LAYER', 'connection pool', '17d'),
    slice('accepted', 'ROUTER', 'route table', '15d'), row('  {m ▸ 6 more}'), lr('{m ▸} M1  {s ✓ 7 accepted}', '{m 24–30d}')];
  return { frame: frame(r, H, foot('', 'y accept  n flag  ⏎ open  esc back'), 'o3 progress'), title: 'Progress (History opened)',
    note: ['<b>Answers first:</b> what landed, and when? Enter on the hub\'s “Last 7 days” opens every landed slice by day; older milestones are folds under it.',
      '<b>Why:</b> the dated feed is the whole page, and the map on top is the same four rows as the hub. <code>y</code> / <code>n</code> work on any to-try row.'] };
}
function more() {
  const r = [tabs('project', 1, 3), ev('6d', '✓', 's', 'LOG-FORMAT  structured lines'), blank(),
    lr(`{m ▾} {t Tickets} {f ${'─'.repeat(11)}}`, '{m 3/10 ·} {a 1 asks you}'),
    lr('  {a ?} {m ec} 02 Quoting rules', '{a needs-info}'), row('      {m “Which quote style does it use?”}'), lr('  {b ◐} {m sq} 03 Retry cap', `${rl('imp')} {m 47m}  {m 1/3}`),
    lr('  {b ●} {m sq} 04 Backoff docs', '{m 0/2}'), lr('  {b ●} {m sq} 05 Metrics hook', '{m 0/1}'), lr('  {b ●} {m ec} 03 Header row', '{m 1/2}'),
    lr('  {a ◆} {m sq} 06 Docs sweep', '{m ← 04} {b ●}'), lr('  {a ◆} {m ec} 04 Smoke run', '{m ← 03} {b ●}'), row('  {m ▸ Done  3}'), blank(),
    fold(false, 'Working tree', '{m 5 changed · 1 ahead}'), fold(false, 'Docs', '{m spec M3 · review 2d}'), blank(),
    lr(`{m ▾} {t Control plane} {f ${'─'.repeat(3)}}`, '{a imp at limit 42m}'), sel(lr('  {d ✗} {imp imp}  {m pi exhausted 42m}', '')), row('      {m next job →} {b ◉} agy hydrogen high'),
    row('  {m ▸ Healthy  4 roles}'), row('  {m ▸ Files  8 · keys 3/4 · browser ✓}')];
  return { frame: frame(r, H, foot('', '↑↓ move  ⏎ fold  o open file  c C preset'), 'o3 more'), title: 'Tickets and Control plane, open in place',
    note: ['<b>Answers first:</b> (the page scrolled to its foot) does a ticket wait for me, and has a role run out of places?',
      '<b>Why:</b> Enter on a fold opens it where it is; the others stay one row. The cursor role keeps the keys <code>p m e + - K J x</code>. Ticket lanes and the Control plane order are as drawn in Options 1 and 2, folded into the page.'] };
}

export const option3 = {
  id: 'timeline', name: '3 · Timeline',
  thesis: ['<b>Live things above, history below it, history sorted by time.</b> Home shows what runs now as one row per job, then one feed for everything that finished, was decided for you or landed. A sentence only appears where something went wrong.',
    '<b>Project is one page that scrolls</b>: a map of the milestones (a cell per slice), then now, next and the last seven days; the four small pages (tickets, working tree, docs, control plane) are folds at the foot that open in place. Progress as a page is the long feed behind Enter.'],
  home: [homeBusy(), homeIdle(), home24()], project: [hub(), progress(), more()],
};
