// Option 2, Split: a list on top, one preview below that follows the cursor. Nothing is hidden by folding and nothing jumps.
import { H, S, row, lr, blank, sec, cut, fit, tabs, crumb, foot, bar, meter, frame, askCard, rl, card, stem, slice, wait, sel, dec, M3, WAIT, SUMMARY, ASK, HOME_HINTS, PROJ_HINTS, done3, nameRow } from './frames.mjs';

const slab = () => askCard({ title: 'imp · dedupe sync queue', right: 'asking 4m', lines: ASK.lines, options: ASK.options });
/** A list row: mark, a name column, a muted middle, the right side. The cursor's item is the band (and its reason row). */
const item = (g, ink, name, mid, right, bg) => lr(`{${ink} ${g}} ${fit(name, 13)} {m ${mid}}`, right, bg);
const reason = (ink, text, bg) => row(`{${ink} ┃} {${ink} ${text}}`, bg);
const rule = (label, right = '') => sec(label, right, 't*');
const listHome = (cursor) => {
  const c = (n, rows) => (cursor === n ? rows.map((r) => ({ ...r, bg: 'sel' })) : rows);
  return [
    ...c('sync', [item('?', 'a', 'SYNC-QUEUE', 'review r1', '{a asking 4m}'), reason('a', 'Keep the v1 shim for one more release')]),
    ...c('export', [item('✗', 'd', 'EXPORT-CSV', 'build', '{d failed 9m}'), reason('d', 'HTTP 429, no report was written')]),
    ...c('auth', [item('◉', 'b', 'AUTH-REFRESH', 'build', `${rl('reviewer')} {m 6m}`)]),
    ...c('native', [item('◉', 'b', 'this session', 'native', '{m 2 running}')]),
    ...c('wait', [lr('{a ?} Waiting for you', '{m 3 · 2 to try}')]),
    ...c('dec', [lr('{a ◆} Decided for you', '{m 3 · 1 worth a look}')]),
    ...c('prog', [lr('{b ◐} Progress  {m M3}', `${bar(M3, 14)} {m 3/9}`)]),
  ];
};
function homeBusy() {
  const r = [tabs('home', 1, 3), blank(), ...listHome('sync'), blank(), rule('SYNC-QUEUE', 'review r1 · 3 jobs'), ...slab(), blank(),
    ...card({ k: 'run', role: rl('imp'), title: 'retry on HTTP 429', right: '47m', lines: ['fixing the retry cap finding: jitter', 'is now bounded at 30 s; the tests', 'cover 429 and 503.'] }),
    ...card({ k: 'done', role: rl('reviewer'), title: 'retry tests', right: 'report ready 2m', lines: ['tests pass; 2 minor items left'] })];
  return { frame: frame(r, H, foot(done3, '↑↓ move  ⏎ open  o open file  a all  ? help'), 'o2 home'), title: 'Home busy',
    note: ['<b>Answers first:</b> what needs me? The list is ranked by need, and the cursor starts on the first needy row, so the preview opens on the question.',
      '<b>Why:</b> the list is the same seven rows whatever runs; the cards (unchanged) show for the row under the cursor only, so the screen never jumps while a job writes a sentence. A failure keeps a reason row in the list.'] };
}
function homeIdle() {
  const r = [tabs('home', 0, 3), blank(),
    ...[lr('{a ?} Waiting for you', '{m 3 · 2 to try}'), item('✓', 's', 'SYNC-QUEUE', '2 done', '{m 8m}'), lr('{m ◇} Decided for you', '{m 2 · 1 worth a look}'), lr('{b ◐} Progress  {m M3}', `${bar(M3, 14)} {m 3/9}`)].map((x, i) => (i === 0 ? { ...x, bg: 'sel' } : x)),
    blank(), rule('Waiting for you', '3 · 2 to try'), wait(WAIT[0], '3h'), wait(WAIT[1], '1d'), wait(WAIT[2]), blank(),
    sec('Latest', 'newest first'), slice('try', 'AUDIT-LOG', 'read one audit row', 'to try 3h'), slice('try', 'EXPORT-CSV', 'header and quoting', 'to try 1d'), slice('accepted', 'RATE-LIMIT', 'per-key budget', 'accepted 2d')];
  return { frame: frame(r, H, foot(done3, '↑↓ move  ⏎ open  o open file  a all  ? help'), 'o2 idle'), title: 'Home idle',
    note: ['<b>Answers first:</b> is anything waiting for me? The first row says three, and its preview lists them with the newest landed slices.',
      '<b>Why:</b> with nothing running the list is four rows; one preview carries what the spare rows carry today.'] };
}
function home24() {
  const r = [tabs('home', 1, 3), blank(), ...listHome('sync'), blank(), rule('SYNC-QUEUE', 'review r1 · 3 jobs'), ...slab(), blank(),
    ...card({ k: 'run', role: rl('imp'), title: 'retry on HTTP 429', right: '47m', lines: ['fixing the retry cap finding: jitter'] })];
  return { frame: frame(r, S, foot(done3, '↑↓ move  ⏎ open  o open file'), 'o2 24'), title: 'Home busy, short',
    note: ['<b>Gives way:</b> the preview, from the bottom: it shows the question and the first card, and scrolls for the rest. Blank rows go.',
      '<b>Never gives way:</b> the list. Every lane, the question, the failure and its reason keep their rows, so nothing needing you is ever below the fold.'] };
}
const pageRow = (g, ink, name, facts, bg) => row(`{${ink} ${g}} {t ${fit(name, 13)}} ${facts}`, bg);
function hub() {
  const r = [tabs('project', 1, 3), blank(), nameRow(), blank(),
    lr('{a ?} {t Waiting for you}', '{m 3 · 2 to try}'), sel(pageRow('◐', 'b', 'Progress', '{m M3 · 3/9 · 2 to try}')), pageRow('?', 'a', 'Tickets', '{m 3/10 ·} {a 1 asks you}'),
    pageRow('○', 'm', 'Working tree', '{m 5 changed · 1 ahead}'), pageRow('○', 'm', 'Docs', '{m spec M3 · review 2d}'), pageRow('!', 'a', 'Control plane', '{a imp at limit 42m}'), blank(),
    rule('Progress', '⏎ open page'), row('  {t M3 closing: retries and token rotation}'), row('  {t in flight; exports wait for your try}'), row(`  ${bar(M3, 24)} {m 3/9}`), blank(),
    row('{m To try}   {m y accept  n flag}'), slice('try', 'AUDIT-LOG', 'read one audit row', '3h', { ind: '' }), slice('try', 'EXPORT-CSV', 'header and quoting', '1d', { ind: '' }), blank(),
    row('{m Now}'), lr('{b ◐} SYNC-QUEUE', `${rl('imp')} {m 47m}`), lr('{b ◐} AUTH-REFRESH', `${rl('reviewer')} {m 6m}`), lr('{a ◆} SEARCH-INDEX', '{a blocked}'), blank(),
    row('{m Latest accepted}'), slice('accepted', 'RATE-LIMIT', 'per-key budget', '2d', { ind: '' }), slice('accepted', 'CONFIG-LOAD', 'layered config', '4d', { ind: '' })];
  return { frame: frame(r, H, foot('', '↑↓ move  ⏎ open  y accept  n flag  [ ] project'), 'o2 hub'), title: 'Project hub',
    note: ['<b>Answers first:</b> where is the project? The page list is six rows; the page under the cursor (Progress, to start) shows its substance below, so the common question needs no Enter.',
      '<b>Why:</b> today each page is Enter, read, Esc. Here ↑↓ flips between pages and the preview changes; Enter opens the full page only when you need all of it.'] };
}
const list = (g, ink, id, mid, right, bg) => lr(`{${ink} ${g}} ${fit(id, 14)}{m ${mid}}`, right, bg);
function progress() {
  const r = [crumb('harbor-api › Progress', 'updated 14:02'), blank(), row(`  {t/title  M3 } ${bar(M3, 24)} {m 3/9}`), row('  {s M1 ✓}  {s M2 ✓}  {b* M3 ●}  {m M4 ○}  {m 16 before}'), blank(),
    sel(list('◐', 'b', 'SYNC-QUEUE', 'working', `${rl('imp')} {m 47m}`)), list('◐', 'b', 'AUTH-REFRESH', 'working', `${rl('reviewer')} {m 6m}`), list('◆', 'a', 'SEARCH-INDEX', 'blocked', '{a ← SYNC-QUEUE}'),
    list('◇', 'i', 'AUDIT-LOG', 'to try', '{m 3h}'), list('◇', 'i', 'EXPORT-CSV', 'to try', '{m 1d}'), list('○', 'm', 'METRICS', 'todo', ''), row('{s ✓} {m 3 accepted}  {m ▸}'), blank(),
    rule('SYNC-QUEUE', 'working · M3'), row('  {t retry on HTTP 429, capped backoff}'), row(`  {m now} ${rl('imp')} {m 47m}`), row('  fixing the retry cap finding: jitter'), row('  is now bounded at 30 s; the tests'), row('  cover 429 and 503.'),
    row('  {m worktree wt/sync-queue · 5 changed}'), row('  {m last commit f3a9c21 · 2h}'), blank(),
    sec('Next', '3'), row('{m →} SEARCH-INDEX: build on write'), row('{m →} METRICS: request counts per route'), row('{m ▸ 1 more}'), blank(),
    row('{m ▸} History  {m 5 landed in 7 days · 16 older}')];
  return { frame: frame(r, H, foot('', '↑↓ move  ⏎ open file  y accept  n flag  esc back'), 'o2 progress'), title: 'Progress page',
    note: ['<b>Answers first:</b> where is M3, and which slice is doing what? The ledger is the list, one row per slice, working first and to-try next; the cursor slice explains itself underneath.',
      '<b>Why:</b> Now, To try and the ledger were three blocks about the same slices. <code>y</code> / <code>n</code> work on any to-try row; History is one folded row that opens the dated feed.'] };
}
function control() {
  const r = [crumb('harbor-api › Control plane', '5 roles'), blank(), sec('Needs attention', '1'),
    sel(lr('{d ✗} {imp imp}   {m pi exhausted 42m}', '')), row('    {m next job →} {b ◉} agy hydrogen high'), blank(),
    sec('Roles', '5'), row('{d ✗} {imp imp}      {m agy · hydrogen · high}'), row('{b ◉} {rev reviewer} {m claude · opus-5.5 · high}'), row('{b ◉} {son sonic}    {m pi · haiku-5.5 · low}'), row('{b ◉} {ora oracle}   {m claude · fable-5.2 · high}'),
    row('{b ◉} {t pro}      {m bro · chatgpt · pro}'), blank(),
    rule('imp', '3 places · preset: pi first'), row('{d ✗} pi     deepseek-v4.1   high   {d 42m}'), row('{b ◉} agy    hydrogen        high   {b next}'), row('{m ○} grok   grok-4.7        high'), blank(),
    row('{m source}    default · imp.json'), row('{m convention} default · hud-convention.md'), blank(),
    row('{m ▸} Harnesses  {m pi ✓ agy ✓ claude ✓ grok ✓}'), row('{m ▸} Files  {m 8 · keys 3/4 · browser ✓}')];
  return { frame: frame(r, H, foot('', '↑↓ move  c C preset  p m e + - K J x'), 'o2 control'), title: 'Control plane page',
    note: ['<b>Answers first:</b> does any role have nowhere to run, and where will the next job go? Needs attention comes first, with <code>next job →</code> under it.',
      '<b>Why:</b> five roles are five rows; the cursor role opens its places underneath, which is where <code>p m e + - K J x</code> act. Healthy no longer needs its own fold, and the page loses about fifteen rows.'] };
}

export const option2 = {
  id: 'split', name: '2 · Split',
  thesis: ['<b>A list on top, a preview below that follows the cursor.</b> Home lists one row per package and per block (waiting, decided, progress); the cards, unchanged, show for the row under the cursor only. The list never changes height, so nothing moves while jobs write; what needs you is always a row.',
    '<b>Project is the same machine.</b> The hub is a page list with the page under the cursor previewed below it, so Progress answers the common question without Enter. The pages keep their full form behind Enter, built the same way: a list of rows, the cursor row explained underneath.'],
  home: [homeBusy(), homeIdle(), home24()], project: [hub(), progress(), control()],
};
