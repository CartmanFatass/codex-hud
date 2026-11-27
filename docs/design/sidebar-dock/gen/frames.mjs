// Cell-grid screens for the sidebar + dock sample. Synthetic data only. Run `node gen.mjs` to rebuild index.html.
//
// A screen is a W × H grid of one-cell glyphs. Text is `{ink text}` markup (`ink*` bold, `ink/bg` a surface); writing
// past the given room throws, so no row can silently overflow or be clipped. Geometry follows the herdr fork:
// sidebar.rs (sidebar, rail), tabs.rs (tab bar), dock.rs (the pane keeps at least 41 columns beside the dock) and
// mobile.rs (64 columns or fewer).
const RE = /\{([a-z0-9]+\*?(?:\/[a-z]+)?) ([^}]*)\}/g;
function parse(markup) {
  const out = [];
  let last = 0, hit;
  RE.lastIndex = 0;
  while ((hit = RE.exec(markup))) {
    if (hit.index > last) out.push({ text: markup.slice(last, hit.index), ink: 't' });
    out.push({ text: hit[2], ink: hit[1] });
    last = RE.lastIndex;
  }
  if (last < markup.length) out.push({ text: markup.slice(last), ink: 't' });
  return out;
}
const len = (markup) => parse(markup).reduce((n, s) => n + [...s.text].length, 0);

function screen(w, h) {
  const cells = Array.from({ length: h }, () => Array.from({ length: w }, () => ({ ch: ' ', ink: 't', bg: '' })));
  const fill = (x, y, width, bg, height = 1) => {
    for (let row = y; row < y + height; row++) for (let col = x; col < x + width; col++) cells[row][col].bg = bg;
  };
  const put = (x, y, markup, room = w - x) => {
    if (len(markup) > room || x < 0 || x + len(markup) > w) throw new Error(`${len(markup)} cells at ${x},${y} > ${room}: ${markup}`);
    for (const { text, ink } of parse(markup)) {
      const [color, bg] = ink.split('/');
      for (const ch of text) {
        const cell = cells[y][x++];
        cell.ch = ch;
        cell.ink = color;
        if (bg) cell.bg = bg;
      }
    }
  };
  /** Text ending just before column `end`. */
  const right = (end, y, markup) => put(end - len(markup), y, markup);
  return { w, h, cells, fill, put, right };
}

// ------------------------------------------------------------------------------------------- shared vocabulary
// A state is a shape first; the ink repeats it. Role glyphs stay neutral, so colour only ever means state.
const STATE_INK = { '◐': 'working', '×': 'blocked*', '✓': 'done', '○': 'idle' };
const st = (glyph) => `{${STATE_INK[glyph]} ${glyph}}`;
const rule = (n, ch = '─', ink = 'dim') => `{${ink} ${ch.repeat(n)}}`;

export const calm = {
  requests: 0,
  spaces: [['harbor-api', '✓', 'main ↑1'], ['lantern-web', '○']],
  main: '○',
  workers: [['⚒', 'ui-slice', '✓'], ['⚖', 'gate-check', '✓']],
  folded: ['lantern-web', ['○', '○']],
  pane: [
    '{o1 >} check the dock after the merge',
    '',
    '{acc ●} Both sides toggle from a cold start.',
    '{acc ●} All checks pass. Nothing waits on you.',
  ],
  bar: ' {s harbor-api} {o1 main · ctx 18%}',
};
export const attention = {
  requests: 1,
  spaces: [['harbor-api', '×', 'main ↑1'], ['lantern-web', '✓']],
  main: '○',
  workers: [['⚒', 'ui-slice', '◐'], ['⚖', 'gate-check', '×']],
  folded: ['lantern-web', ['✓', '○']],
  pane: [
    '{o1 >} make both sides behave the same',
    '',
    '{acc ●} Read dock.rs and sidebar.rs.',
    '{acc ●} Push leaves the harness uncovered;',
    '  narrow screens open the dock zoomed.',
    '{acc ●} Asked you which default to keep.',
    '  Work waits for your answer.',
  ],
  bar: ' {s harbor-api} {o1 main · ctx 42% ·} {pa ?1}',
};
// herdr's order for the state a folded group or a workspace shows.
const strongest = (states) => ['×', '✓', '◐', '○'].find((s) => states.includes(s));

// ------------------------------------------------------------------------------------------- herdr: left side
export const SIDEBAR = 22, RAIL = 4;

function sidebar(scr, s) {
  const inner = SIDEBAR - 1, H = scr.h;
  for (let y = 0; y < H; y++) scr.put(inner, y, '{dim │}');
  scr.put(0, 0, '{o0*  spaces}');
  scr.fill(0, 2, inner, 'row', 2);
  const [a, b] = s.spaces;
  scr.put(0, 2, ` ${st(a[1])} {t* ${a[0]}}`, inner);
  scr.put(0, 3, `   {o0 ${a[2]}}`, inner);
  scr.put(0, 4, ` ${st(b[1])} {s ${b[0]}}`, inner);
  scr.put(0, 5, '{o0  new}');
  scr.right(inner, 5, '{o0 menu}');
  scr.put(0, 6, rule(inner));
  scr.put(0, 7, '{o0*  agents}');
  scr.right(inner, 7, '{o0* grouped}');
  // The tree: identity before the name, state in one straight column (19), counts just left of it (17).
  const STATE = 19, COUNT = 18;
  const header = (y, prefix, mark, name, n, state, bold) => {
    scr.put(0, y, `{o0 ${prefix}${mark}} {${bold ? 't*' : 's'} ${name}}`, COUNT - 2);
    scr.right(COUNT, y, `{o0 ${n}}`);
    if (state) scr.put(STATE, y, st(state));
  };
  const agent = (y, prefix, role, name, state, ink = 's') => {
    scr.put(0, y, `{o0 ${prefix}}{s* ${role}} {${ink} ${name}}`, STATE - 1);
    scr.put(STATE, y, st(state));
  };
  header(9, '', '▾', 'harbor-api', 3, '', true);
  scr.fill(0, 10, inner, 'row');
  agent(10, '├ ', 'c', 'claude · main', s.main, 't*');
  header(11, '└─', '▾', 'council', 2, '', false);
  s.workers.forEach(([role, name, state], i) => agent(12 + i, i === s.workers.length - 1 ? '  └ ' : '  ├ ', role, name, state));
  header(14, '', '▸', s.folded[0], s.folded[1].length, strongest(s.folded[1]), true);
  scr.put(inner - 1, H - 1, '{o1 «}');
}

function rail(scr, s) {
  const inner = RAIL - 1, H = scr.h, divider = Math.ceil(H / 2);
  for (let y = 0; y < H; y++) scr.put(inner, y, '{dim │}');
  scr.fill(0, 0, inner, 'row');
  s.spaces.forEach(([, state], i) => scr.put(0, i, `{${i ? 'o0' : 't'} ${i + 1}} ${st(state)}`, inner));
  scr.put(0, divider, rule(inner));
  // Same two columns as the workspaces above: who on the left, state on the right.
  const rows = [
    ['c', s.main],
    rule(inner, '┈'),
    ...s.workers.map(([role, , state]) => [role, state]),
    rule(inner),
    ['▸', strongest(s.folded[1])],
  ];
  rows.forEach((row, i) => {
    const y = divider + 1 + i;
    if (i === 0) scr.fill(0, y, inner, 'row');
    scr.put(0, y, typeof row === 'string' ? row : `{${row[0] === '▸' ? 'o0' : 's*'} ${row[0]}} ${st(row[1])}`, inner);
  });
  scr.put(1, H - 1, '{o1 »}');
}

// ------------------------------------------------------------------------------------------- herdr: tab bar and handle
/** Handle A: a dim `«`; an amber `?N` chip joins it only while the owner is asked something. `«` never moves. */
export const handle = (requests) => (requests ? `{chip*  ?${requests} }{o1  « }` : '{o0  « }');

function tabBar(scr, x, s, collapsed) {
  scr.put(x, 0, '{tabon*/tabon   claude  }');
  scr.put(x + 11, 0, '{o1/tab   tests  }');
  scr.put(x + 21, 0, '{o1  + }');
  let end = scr.w;
  if (collapsed) {
    const mark = handle(s.requests);
    scr.right(end, 0, mark);
    end -= len(mark) + 1;
  }
  scr.right(end, 0, '{o1 2 hidden}');
}

function pane(scr, x, y, width, height, s) {
  s.pane.forEach((line, i) => scr.put(x, y + i, line, width));
  scr.put(x, y + height - 4, rule(width));
  scr.put(x, y + height - 3, '{o1 >} {cursor  }', width);
  scr.put(x, y + height - 2, rule(width));
  scr.put(x, y + height - 1, s.bar, width);
}

// ------------------------------------------------------------------------------------------- the HUD panel (Home excerpt)
const lr = (left, right, width) => {
  const gap = width - len(left) - len(right);
  if (gap < 1) throw new Error(`no room for ${left} | ${right} in ${width}`);
  return `${left}${' '.repeat(gap)}${right}`;
};
const section = (left, right, width) => `${left} ${rule(width - len(left) - len(right) - 2, '─', 'pf')} ${right}`;

/** The panel's tab row: badges stay only while all four labels fit (work-view.ts). */
function tabs(width, requests, jobs) {
  const row = (counts) => {
    const home = counts && requests ? `{pa/ptitle  ?${requests}}` : '';
    const live = counts && jobs ? `{pb ·${jobs}}` : '';
    return `{pt*/ptitle  Home}${home}{pt/ptitle  }{pm  Project }{pm  Execution}${live}{pm  }{pm  Control }`;
  };
  return len(row(true)) <= width ? row(true) : row(false);
}

function panel(width, height, s, { selected = false } = {}) {
  const asked = s.requests > 0;
  const request = asked ? [
    { m: lr('{pa ?} {pt harbor-api} {pm ›} {pt dock-ux}', '{pa work waits} {pm 2m}', width), bg: selected ? 'psel' : '' },
    { m: '  {pt Make push the default dock mode?}', bg: selected ? 'psel' : '' },
  ] : [];
  const rows = [
    { m: tabs(width, s.requests, asked ? 3 : 0) },
    ...request,
    ...[
      section('{pt Active today}', '{pm 2}', width),
      asked ? section('{pa ?} {pt harbor-api}', '{imp ⚒1} {rev ⚖1} {son ϟ1} {pm 2m}', width)
        : section('{pm ○} {pm harbor-api}', '{pm idle} {pm 4m}', width),
      '  {pb ▸} {pt dock-ux}  {pm Same chrome both sides}',
      asked ? lr('  {pg ✓} {pt Dock keeps width on reload}', '{pm 1h}', width)
        : lr('  {pg ✓} {pt Both sides toggle cold}', '{pm 4m}', width),
      section('{pm ○} {pm lantern-web}', '{pm idle} {pm 1h}', width),
      '  {pb ▸} {pt export-csv}  {pm Header and quoting}',
      lr('{pt ▸ 3 other projects}', '{pm a expand}', width),
    ].map((m) => ({ m })),
  ];
  while (rows.length < height - 1) rows.push({ m: '' });
  rows.push({ m: lr('', '{pm ⏎ open  v jobs  q hide  ? help}', width) });
  return rows;
}

function paintPanel(scr, x, y, width, height, s, options) {
  panel(width, height, s, options).forEach(({ m, bg }, i) => {
    if (bg) scr.fill(x, y + i, width, bg);
    scr.put(x, y + i, m, width);
  });
}

// ------------------------------------------------------------------------------------------- whole screens
export const ROWS = 16;
/** 100 columns. `left` is 'open' or 'rail'; `dock` is its inner width, 0 when collapsed. */
export function desktop(s, { left, dock }) {
  const scr = screen(100, ROWS), x = left === 'open' ? SIDEBAR : RAIL;
  const main = scr.w - x - (dock ? dock + 1 : 0);
  if (main < 41) throw new Error(`herdr keeps the pane at 41 columns or more, not ${main}`);
  (left === 'open' ? sidebar : rail)(scr, s);
  tabBar(scr, x, s, !dock);
  pane(scr, x, 1, main, ROWS - 1, s);
  if (dock) {
    const border = scr.w - dock - 1;
    for (let y = 1; y < ROWS; y++) scr.put(border, y, y === 1 ? '{o1 »}' : '{dim │}');
    paintPanel(scr, border + 1, 1, dock, ROWS - 1, s);
  }
  return scr;
}

export const NARROW = 60;
/** herdr's two-row mobile header; the handle sits where the tab bar's right end would be, left of `switch`. */
function mobileHeader(scr, s, open) {
  const button = NARROW - 10;
  scr.fill(button, 0, 10, 'tab', 2);
  scr.put(button, 0, '{dim │}');
  scr.put(button, 1, '{dim │}');
  scr.put(button + 2, 1, '{t* switch}');
  const states = [s.main, ...s.workers.map((w) => w[2]), ...s.folded[1]];
  if (states.includes('×')) scr.put(NARROW - 1, 0, st('×'));
  const mark = open ? '{o1  » }' : handle(s.requests);
  scr.right(button - 1, 0, mark);
  const tab = '{o1 tab claude · 1/2 · 2 hidden}', tabX = button - 2 - len(mark) - len(tab);
  scr.put(0, 0, ` ${st(s.spaces[0][1])} {t* ${s.spaces[0][0]}}`, tabX - 1);
  scr.put(tabX, 0, tab);
  const summary = [['×', 'blocked'], ['✓', 'done'], ['◐', 'working'], ['○', 'idle']]
    .map(([glyph, word]) => [glyph, word, states.filter((v) => v === glyph).length])
    .filter(([, , n]) => n)
    .map(([glyph, word, n], i) => `{${i ? 'o1' : STATE_INK[glyph]} ${glyph} ${n} ${word}}`);
  scr.put(0, 1, ` ${summary.join('{o0  · }')}`, button - 1);
}

/** 60 columns with the dock open: it is zoomed over the whole pane area, so there is no divider. */
export function narrow(s) {
  const scr = screen(NARROW, ROWS);
  mobileHeader(scr, s, true);
  paintPanel(scr, 0, 2, NARROW, ROWS - 2, s, { selected: s.requests > 0 });
  return scr;
}

// ------------------------------------------------------------------------------------------- handle close-ups
/** The right end of the tab bar, dock collapsed: 40 cells cut from the real 100-column screen. */
export function tabBarEnd(s) {
  const full = desktop(s, { left: 'rail', dock: 0 });
  return { w: 40, h: 1, cells: [full.cells[0].slice(-40)] };
}
/** The narrow header with the dock collapsed. */
export function narrowTop(s) {
  const scr = screen(NARROW, 2);
  mobileHeader(scr, s, false);
  return scr;
}
