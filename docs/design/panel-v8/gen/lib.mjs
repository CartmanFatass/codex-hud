// Cell-grid toolkit for the panel v8 mockups. Synthetic data only. Run `node gen.mjs` to rebuild options.html.
//
// A frame is a list of rows; a row is a list of segments {t: text, k: ink[/surface]}, padded to exactly W cells.
// Every glyph used is one cell wide in the panel (see src/render/palette.ts for the inks, work-card.ts for the grammar).
export const W = 40;

// {ink text}: ink names are the palette's own words (see CSS): t text, m muted, a attention, d danger, s success,
// b active (blue), o stalled (orange), i identifier, f frame (rules), imp/rev/son/ora role inks, ask dark ink on the ask
// header. `ink/surface` adds a surface; a trailing * is bold.
const RE = /\{([a-z0-9*/]+) ([^}]*)\}/g;
export function parse(markup) {
  const out = [];
  let last = 0, x;
  RE.lastIndex = 0;
  while ((x = RE.exec(markup))) {
    if (x.index > last) out.push({ t: markup.slice(last, x.index), k: 't' });
    out.push({ t: x[2], k: x[1] });
    last = RE.lastIndex;
  }
  if (last < markup.length) out.push({ t: markup.slice(last), k: 't' });
  return out;
}
const cells = (segs) => segs.reduce((n, s) => n + [...s.t].length, 0);
const fail = (what, markup, n) => { throw new Error(`${what} (${n} cells > ${W}): ${markup.replace(/\{[a-z0-9*/]+ ([^}]*)\}/g, '$1')}`); };

/** One row, padded to W. `bg` is the whole row's surface: title, sel, slab, askT, fail. */
export function row(markup = '', bg) {
  const segs = parse(markup), n = cells(segs);
  if (n > W) fail('row too wide', markup, n);
  if (n < W) segs.push({ t: ' '.repeat(W - n), k: 't' });
  return { segs, bg };
}
/** Left text and right text on one row. */
export function lr(left, right, bg) {
  const L = parse(left), R = parse(right), gap = W - cells(L) - cells(R);
  if (gap < 1) fail('lr too wide', left + ' | ' + right, cells(L) + cells(R) + 1);
  return { segs: [...L, { t: ' '.repeat(gap), k: 't' }, ...R], bg };
}
export const blank = () => row('');
/** `Title ───────── right`, the panel's section row (workboard-rows.ts `section`). */
export function sec(label, right = '', ink = 't') {
  const plain = (s) => cells(parse(s)), tail = right ? plain(right) : 0;
  const rule = Math.max(0, W - plain(label) - tail - (tail ? 2 : 1));
  const left = `{${ink} ${label}} {f ${'─'.repeat(rule)}}`;
  return right ? lr(left, right) : row(left);
}
/** Cut plain text to n cells with an ellipsis. */
export const cut = (s, n) => ([...s].length <= n ? s : [...s].slice(0, n - 1).join('') + '…');
export const fit = (s, n) => cut(s, n) + ' '.repeat(Math.max(0, n - [...cut(s, n)].length));

// The panel's tab row: ` Home 3 ` on the title band when it is the open tab, then ` Project 2 `, `models on` at the right.
export function tabs(open, homeN = 0, projN = 0) {
  const part = (name, n, on) => {
    const ink = on ? 't/title' : 'm';
    return `{${ink}  ${name}${n ? ' ' : ''}}${n ? `{${on ? 'a/title' : 'a'} ${n}}` : ''}{${ink}  }`;
  };
  return lr(part('Home', homeN, open === 'home') + part('Project', projN, open === 'project'), '{m models on}');
}
/** The crumb row of an open page: `‹ Project › Page` on the title band. */
export const crumb = (text, right = '') => lr(`{t/title ‹ ${text}}`, right ? `{t/title ${right}}` : '', 'title');
/** The footer: an optional left note, then key hints cut from the right until they fit (workboard-rows.ts `footHints`). */
export function foot(left, hints) {
  const room = W - cells(parse(left)) - (left ? 2 : 1), parts = hints.split('  ');
  while (parts.length && [...parts.join('  ')].length > room) parts.pop();
  return lr(left, `{m ${parts.join('  ')}}`);
}

// Slice bar, the panel's own: working █ blue, blocked █ amber, to try ▒ lavender, todo ░ muted, accepted █ green.
export function bar(counts, n) {
  const order = [['working', 'b', '█'], ['blocked', 'a', '█'], ['try', 'i', '▒'], ['todo', 'm', '░'], ['accepted', 's', '█']];
  const total = order.reduce((a, [s]) => a + (counts[s] || 0), 0);
  let sum = 0, edge = 0, out = '';
  for (const [s, ink, ch] of order) {
    sum += counts[s] || 0;
    const end = Math.round((sum / total) * n);
    if (end > edge) out += `{${ink} ${ch.repeat(end - edge)}}`;
    edge = end;
  }
  return out;
}
/** A done/total meter, as the panel's thin one. */
export function meter(done, total, n, ink = 's') {
  const filled = Math.min(n - (done < total ? 1 : 0), Math.max(done ? 1 : 0, Math.round((done / total) * n)));
  return `{${ink} ${'━'.repeat(filled)}}{f ${'─'.repeat(n - filled)}}`;
}

/** Pad rows to `h`, footer on the last one. */
export function frame(rows, h, footer, name) {
  const body = rows.filter(Boolean);
  if (body.length >= h) throw new Error(`${name}: ${body.length} rows + footer do not fit ${h}`);
  while (body.length < h - 1) body.push(blank());
  body.push(footer);
  return { rows: body, h, used: rows.filter(Boolean).length };
}

// The ask card (home-view.ts): amber header, slab body. `sel` marks which option is the default.
export function askCard({ title, right, lines, options = [], defaultKey = 'a', hint = '' }) {
  const out = [lr(`{ask ? ${title}}`, `{ask ${right}}`, 'askT')];
  for (const l of lines) out.push(row(`{a ┃} {a ${l}}`, 'slab'));
  for (const [k, text] of options) out.push(row(`{a ┃} ${k === defaultKey ? '{a* ●}' : '{m  }'} {a* ${k}}  {a ${text}}`, 'slab'));
  if (hint) out.push(lr(`{a ┃} {m ${hint[0]}}`, `{m ${hint[1]}}`, 'slab'));
  return out;
}
