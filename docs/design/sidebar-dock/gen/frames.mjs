// Cell-grid screens for the sidebar + dock sample. Synthetic data only. Run `node gen.mjs` to rebuild index.html.
//
// A screen is a W × H grid of one-cell glyphs. Text is `{ink text}` markup (`ink*` bold, `ink/bg` a surface); writing
// past the given room throws, so no row can silently overflow or be clipped. Geometry follows the herdr fork:
// agent_sidebar.rs (two-line agent rows, tree, collapsed rail), tabs.rs (tab bar), dock.rs (the pane keeps at least
// 41 columns beside the dock) and mobile.rs (64 columns or fewer). The Execution tab copies the rows the panel draws
// today (src/render/execution-view.ts, execution-metro.ts) for the same synthetic run.
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
// herdr's agent states (left side):
const STATE_INK = { '◐': 'working', '×': 'blocked*', '✓': 'done', '○': 'idle' };
const st = (glyph) => `{${STATE_INK[glyph]} ${glyph}}`;
// HUD's step states (right rail, narrow header). Only what waits for the owner is filled.
const STEP_INK = { '✓': 'done', '◐': 'working', '×': 'blocked*', '?': 'chip*', '○': 'o1' };
const step = (glyph) => `{${STEP_INK[glyph]} ${glyph}}`;
/** Most urgent first: the order of the project blocks, and the shape a folded line or count shows. */
const URGENCY = ['?', '×', '◐', '○', '✓'];
const worst = (states) => URGENCY.find((s) => states.includes(s));
const stateOf = (run) => worst(run.waves.flat().map((n) => n.s));
const rule = (n, ch = '─', ink = 'dim') => `{${ink} ${ch.repeat(n)}}`;
const cut = (text, n) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

// ------------------------------------------------------------------------------------------- synthetic scenarios
// A run is its project and its graph as waves, top to bottom; the steps of one wave run in parallel.
const ticket = (s, id) => ({ s, id });
const named = (s, word, short = word) => ({ s, word, short });
const queue = (project, ...waves) => ({ project, waves: [...waves, [named('○', 'review', 'rev')], [named('○', 'accept', 'acc')]] });
const single = (project, s, word) => ({ project, waves: [[named(s, word)]] });

export const calm = {
  requests: 0,
  runs: [],
  spaces: [['harbor-api', '✓', 'main ↑1'], ['lantern-web', '✓']],
  main: '○',
  workers: [['⚒', 'dock-ux/03', '✓'], ['⚖', 'dock-ux/review', '✓']],
  folded: ['lantern-web', ['✓', '○']],
  pane: [
    '{o1 >} check the dock after the merge',
    '',
    '{acc ●} Both sides toggle from a cold start.',
    '{acc ●} All checks pass. Nothing waits on you.',
  ],
  bar: ' {s harbor-api} {o1 main · ctx 18%}',
};
export const running = {
  requests: 0,
  runs: [queue('harbor-api', [ticket('✓', '01'), ticket('◐', '02'), ticket('◐', '03')]), single('lantern-web', '◐', 'audit')],
  spaces: [['harbor-api', '◐', 'main ↑1'], ['lantern-web', '◐']],
  main: '○',
  workers: [['⚒', 'dock-ux/02', '◐'], ['⚒', 'dock-ux/03', '◐']],
  folded: ['lantern-web', ['◐']],
  pane: [
    '{o1 >} run the dock-ux queue',
    '',
    '{acc ●} Queue dock-ux is running: 3 tickets.',
    '{acc ●} 01 landed. 02 and 03 are working.',
  ],
  bar: ' {s harbor-api} {o1 main · ctx 31%}',
};
export const attention = {
  requests: 1,
  runs: [queue('harbor-api', [ticket('✓', '01'), ticket('×', '02'), ticket('?', '03')]), single('lantern-web', '◐', 'audit')],
  spaces: [['harbor-api', '×', 'main ↑1'], ['lantern-web', '◐']],
  main: '○',
  workers: [['⚒', 'dock-ux/01', '✓'], ['⚒', 'dock-ux/03', '×']],
  folded: ['lantern-web', ['◐']],
  pane: [
    '{o1 >} how is the queue doing?',
    '',
    '{acc ●} 01 landed. 02 failed at the gate.',
    '{acc ●} 03 asks which dock default to keep.',
    '  The question is waiting for you.',
  ],
  bar: ' {s harbor-api} {o1 main · ctx 42% ·} {pa ?1}',
};
/** Rail close-ups: a graph taller than the rail, and more projects than a short window holds. */
export const tall = {
  requests: 1,
  runs: [
    queue('harbor-api', [ticket('✓', '01')], [ticket('✓', '02')], [ticket('✓', '03')], [ticket('✓', '04'), ticket('✓', '05'), ticket('✓', '06')],
      [ticket('◐', '07'), ticket('×', '08'), ticket('○', '09'), ticket('○', '10'), ticket('○', '11')],
      ...['12', '13', '14', '15', '16', '17', '18', '19'].map((id) => [ticket('○', id)])),
    single('lantern-web', '◐', 'audit'),
  ],
};
export const crowded = {
  requests: 1,
  runs: [
    attention.runs[0],
    single('lantern-web', '◐', 'audit'),
    queue('orchard', [ticket('◐', '04')]),
    queue('tide-lab', [ticket('◐', '02')]),
    single('kiln', '◐', 'build'),
  ],
};

// ------------------------------------------------------------------------------------------- herdr: left side
export const SIDEBAR = 22, RAIL = 4;
// herdr's order for the state a folded group shows, and the ink it gives that group's chevron and count.
const strongest = (states) => ['×', '✓', '◐', '○'].find((s) => states.includes(s));
const foldedInk = (states) => `${STATE_INK[strongest(states)].replace('*', '')}*`;

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
  // herdr's tree and its two-line rows: state icon and workspace, then the agent name from column 4. The one change
  // is the role glyph glued after the state shape; a main session has no role and keeps herdr's row as it is.
  const header = (y, prefix, mark, name, n, bold, ink = 'o0') => {
    scr.put(0, y, `{o0 ${prefix}}{${ink} ${mark}} {${bold ? 't*' : 's'} ${name}}`, inner - 3);
    scr.right(inner, y, `{${ink} ${n}}`);
  };
  const agent = (y, [first, second], state, role, space, name, ink = 's') => {
    scr.put(0, y, `{o0 ${first}}${st(state)}${role ? `{s* ${role}}` : ''} {${ink} ${space}}`, inner);
    scr.put(0, y + 1, `{o0 ${second}}{o1 ${name}}`, inner);
  };
  header(9, '', '▾', a[0], 3, true);
  scr.fill(0, 10, inner, 'row', 2);
  agent(10, ['├ ', '│   '], s.main, '', a[0], 'claude', 't*');
  header(12, '└─', '▾', 'dock-ux', s.workers.length, false);
  s.workers.forEach(([role, name, state], i) => {
    const last = i === s.workers.length - 1;
    agent(13 + i * 2, last ? ['  └ ', '    '] : ['  ├ ', '  │ '], state, role, a[0], name);
  });
  header(17, '', '▸', s.folded[0], s.folded[1].length, true, foldedInk(s.folded[1]));
  scr.put(inner - 1, H - 1, '{o1 «}');
}

function rail(scr, s) {
  const inner = RAIL - 1, H = scr.h, divider = Math.ceil(H / 2);
  for (let y = 0; y < H; y++) scr.put(inner, y, '{dim │}');
  scr.fill(0, 0, inner, 'row');
  s.spaces.forEach(([, state], i) => scr.put(0, i, `{${i ? 'o0' : 't'} ${i + 1}} ${st(state)}`, inner));
  scr.put(0, divider, rule(inner));
  const rows = [
    ` ${st(s.main)}`,
    rule(inner, '┈'),
    ...s.workers.map(([role, , state]) => ` ${st(state)}{s* ${role}}`),
    rule(inner),
    `{${foldedInk(s.folded[1])} ▸} ${st(strongest(s.folded[1]))}`,
  ];
  rows.forEach((row, i) => {
    if (i === 0) scr.fill(0, divider + 1, inner, 'row');
    scr.put(0, divider + 1 + i, row, inner);
  });
  scr.put(1, H - 1, '{o1 »}');
}

// ------------------------------------------------------------------------------------------- HUD: the right rail
/** Content widths the owner picks from; one more column is the divider that carries the `«` toggle. */
export const WIDTHS = [8, 12];
/** Where parallel steps sit. Rail 12 has room for a two-digit number behind each. */
const LANES = { 8: [1, 3, 5], 12: [1, 5, 9] };

/** The graph's rows-to-be: the landed prefix and the waiting tickets may each fold into one `+N` row. */
function folded(waves, { done = false, queued = false } = {}) {
  const items = waves.map((nodes) => ({ nodes }));
  const fold = (from, to, s) => {
    const n = items.slice(from, to).reduce((sum, item) => sum + item.nodes.length, 0);
    if (to - from > 0 && n > 1) items.splice(from, to - from, { fold: s, n });
  };
  const all = (item, s) => item?.nodes?.every((node) => node.s === s && !node.word);
  if (done) {
    let to = 0;
    while (all(items[to], '✓')) to++;
    fold(0, to, '✓');
  }
  if (queued) {
    const from = items.findIndex((item) => all(item, '○'));
    let to = from;
    while (from >= 0 && all(items[to], '○')) to++;
    if (from >= 0) fold(from, to, '○');
  }
  return items;
}

/** At most three side by side: the two most urgent keep a lane, the rest share a counted one. */
function lanes(nodes) {
  if (nodes.length <= 3) return nodes;
  const ranked = [...nodes].sort((a, b) => URGENCY.indexOf(a.s) - URGENCY.indexOf(b.s));
  const kept = nodes.filter((n) => ranked.slice(0, 2).includes(n));
  const rest = ranked.slice(2);
  return [...kept, { s: worst(rest.map((n) => n.s)), more: rest.length }];
}

/** The graph, top to bottom, as rows of `[column, markup]`. Solid lines are travelled, dashed ones are ahead. */
function graph(items, width) {
  const X = LANES[width], wide = width > 8, rows = [];
  const landed = (item) => (item.fold ? item.fold === '✓' : item.nodes.every((n) => n.s === '✓'));
  const joint = (count, first, mid, last, solid) => {
    let text = first;
    for (let i = 1; i < count; i++) text += (solid ? '─' : '╌').repeat(X[i] - X[i - 1] - 1) + (i === count - 1 ? last : mid);
    return [[X[0], `{${solid ? 'o1' : 'o0'} ${text}}`]];
  };
  items.forEach((item, i) => {
    if (item.fold) {
      const word = wide ? (item.fold === '✓' ? ' landed' : ' queued') : '';
      rows.push([[1, `${step(item.fold)} {o1 +${item.n}${word}}`]]);
    } else if (item.nodes.length === 1) {
      const n = item.nodes[0];
      const text = n.word ? ` ${wide ? n.word : n.short}` : `${wide ? '' : ' '}${n.id}`;
      rows.push([[1, `${step(n.s)}{s ${text}}`]]);
    } else {
      const shown = lanes(item.nodes);
      rows.push(joint(shown.length, i ? '├' : '╭', '┬', '╮', !i || landed(items[i - 1])));
      rows.push(shown.map((n, lane) => [X[lane], `${step(n.s)}${n.more ? `{o1 +${n.more}}` : wide ? `{s ${n.id}}` : ''}`]));
      rows.push(joint(shown.length, i < items.length - 1 ? '├' : '╰', '┴', '╯', landed(item)));
    }
  });
  return rows;
}

/**
 * Fits the project blocks into `room` rows, in this order: fold landed steps, fold waiting tickets, shrink projects
 * to one line from the least urgent up, then count the ones left out. The most urgent graph gives up its shape last.
 * Nothing scrolls.
 */
function plan(runs, room, width) {
  const blocks = runs.map((run) => ({ run, done: false, queued: false, line: false }))
    .sort((a, b) => URGENCY.indexOf(stateOf(a.run)) - URGENCY.indexOf(stateOf(b.run)));
  const hidden = [];
  const rows = (block) => graph(folded(block.run.waves, block), width);
  const gap = (i) => i > 0 && !(blocks[i].line && blocks[i - 1].line);
  const height = () => blocks.reduce((n, b, i) => n + (b.line ? 1 : 1 + rows(b).length) + (gap(i) ? 1 : 0), hidden.length ? 1 : 0);
  for (const key of ['done', 'queued']) {
    for (const block of [...blocks].sort((a, b) => rows(b).length - rows(a).length)) if (height() > room) block[key] = true;
  }
  for (let i = blocks.length - 1; i > 0 && height() > room; i--) blocks[i].line = true;
  while (blocks.length > 1 && height() > room) hidden.unshift(blocks.pop());
  if (height() > room) blocks[0].line = true;
  return { blocks, hidden, rows, gap };
}

/** The rail from row 1 down; `x` is its divider column. */
function rightRail(scr, x, s, width) {
  for (let y = 1; y < scr.h; y++) scr.put(x, y, y === 1 ? '{o1 «}' : '{dim │}');
  let y = 1;
  const put = (col, markup) => scr.put(x + 1 + col, y, markup, width - col);
  const line = (col, markup) => { put(col, markup); y++; };
  // Row 1 belongs to the toggle and the owner requests, so no project name ever sits beside the `«`.
  if (s.requests) {
    line(1, `{chip* ?${s.requests}}${width > 8 ? '{t  for you}' : ''}`);
    line(0, rule(width, '┈'));
  } else y++;
  const { blocks, hidden, rows, gap } = plan(s.runs, scr.h - y, width);
  blocks.forEach((block, i) => {
    if (gap(i)) line(0, rule(width, '┈'));
    if (block.line) return line(1, `${step(stateOf(block.run))} {t* ${cut(block.run.project, width - 3)}}`);
    line(1, `{t* ${cut(block.run.project, width - 1)}}`);
    for (const row of rows(block)) {
      for (const [col, markup] of row) put(col, markup);
      y++;
    }
  });
  if (hidden.length) line(1, `{t +${hidden.length}${width > 8 ? ' more' : ''}} ${step(worst(hidden.map((b) => stateOf(b.run))))}`);
}

// ------------------------------------------------------------------------------------------- herdr: tab bar and handle
/** Handle A: a dim `«`; an amber `?N` chip joins it only while the owner is asked something. `«` never moves. */
const handle = (requests) => (requests ? `{chip*  ?${requests} }{o1  « }` : '{o0  « }');

function tabBar(scr, x, s, withHandle) {
  scr.put(x, 0, '{tabon*/tabon   claude  }');
  scr.put(x + 11, 0, '{o1/tab   tests  }');
  scr.put(x + 21, 0, '{o1  + }');
  let end = scr.w;
  if (withHandle) {
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

// ------------------------------------------------------------------------------------------- the HUD panel (Execution)
const lr = (left, right, width) => {
  const gap = width - len(left) - len(right);
  if (gap < 1) throw new Error(`no room for ${left} | ${right} in ${width}`);
  return `${left}${' '.repeat(gap)}${right}`;
};

/** The Execution tab at 40 columns for the `attention` run, its cursor on step 02: the station just clicked. */
function execution(width) {
  const section = (title, n) => `{pt ${title}} ${rule(width - title.length - String(n).length - 2, '─', 'pf')} {pm ${n}}`;
  const card = (text) => `{pf │} ${text}${' '.repeat(width - 3 - len(text))}{pf │}`;
  const rows = [
    '{pm  Home }{pa ?1}{pm  }{pm  Project }{pt/ptitle  Execution·1 }{pm  Control }',
    '',
    '  {pm 0 running}   {pa 1} {pm waiting}   {pm 0 queued}',
    '',
    section('Workflow', 1),
    lr('  {pb* ◉} {pm* Queue} {pt* dock-ux}', '{pm running 47m}', width),
    '  {pt ●}{pm ─────╮}',
    ' {pt/psel  }{pd*/psel ✗}{pf/psel ╌}{pf ╌╌╌╌}{pm ┼}{pf ╌}{pm ◇}{pf ╌╌╌╌╌╌╌}{pm ☆}',
    '  {chip* ?}{pf ╌╌╌╌╌╯}',
    lr('  {pd* ✗} {pt 02 Push dock}', '{pd ⚒ failed 6m}', width),
    '  {chip* ?} {pm asking}  {pd* ✗} {pm failed}  {pm ◇◈◆ review}',
    '  {pm ☆✪★ accept}',
    '',
    section('Workers', 1),
    '{pf ┌─} {pa ?} {imp imp} {pm ·} {pt opus} {pf ──────────} {pa asking} {pm 14m} {pf ─┐}',
    card('{pt dock-ux/03}'),
    card('{pa ? Keep push as the default?}'),
    '{pf └─} {pm from Claude a1b2c3d4} {pf ────} {pm j03aaaaa} {pf ─┘}',
  ];
  return [...rows, lr('', '{pm ⏎ details  ←→ station  q hide  ? help}', width)];
}

// ------------------------------------------------------------------------------------------- whole screens
export const ROWS = 20;
/** 100 columns. `left` is 'open' or 'rail'; `dock` is its inner width, 0 when hidden; `rail` the right rail's. */
export function desktop(s, { left = 'rail', dock = 0, rail: width = 8 } = {}) {
  const scr = screen(100, ROWS), x = left === 'open' ? SIDEBAR : RAIL;
  const railed = !dock && s.runs.length > 0;
  const side = dock ? dock + 1 : railed ? width + 1 : 0;
  const main = scr.w - x - side;
  if (main < 41) throw new Error(`herdr keeps the pane at 41 columns or more, not ${main}`);
  (left === 'open' ? sidebar : rail)(scr, s);
  tabBar(scr, x, s, !dock && !railed);
  pane(scr, x, 1, main, ROWS - 1, s);
  if (railed) rightRail(scr, scr.w - side, s, width);
  if (dock) {
    const border = scr.w - side;
    for (let y = 1; y < ROWS; y++) scr.put(border, y, y === 1 ? '{o1 »}' : '{dim │}');
    const rows = execution(dock);
    if (rows.length !== ROWS - 1) throw new Error(`the panel is ${rows.length} rows, not ${ROWS - 1}`);
    rows.forEach((markup, i) => scr.put(border + 1, 1 + i, markup, dock));
  }
  return scr;
}

export const NARROW = 60;
/** One run on one row: order left to right, parallel steps in brackets, the rail's folds and `+N`. */
function strip(run, folds) {
  const nodes = (list) => lanes(list).map((n) => `${step(n.s)}${n.more ? `{o1 +${n.more}}` : ''}`).join('');
  const parts = folded(run.waves, folds).map((item) => {
    if (item.fold) return `${step(item.fold)}{o1 +${item.n}}`;
    return item.nodes.length > 1 ? `{o1 [}${nodes(item.nodes)}{o1 ]}` : nodes(item.nodes);
  });
  return `{t* ${cut(run.project, 7)}} ${parts.join('{o0 ─}')}`;
}

/** The runs that fit `room` cells: folded first, then the least urgent counted. */
function strips(runs, room) {
  const ordered = [...runs].sort((a, b) => URGENCY.indexOf(stateOf(a)) - URGENCY.indexOf(stateOf(b)));
  for (let shown = ordered.length; shown >= 0; shown--) {
    const rest = ordered.slice(shown);
    const more = rest.length ? `  {t +${rest.length}} ${step(worst(rest.map(stateOf)))}` : '';
    for (const folds of [{}, { done: true }, { done: true, queued: true }]) {
      const row = ordered.slice(0, shown).map((run) => strip(run, folds)).join('  ') + more;
      if (len(row) <= room) return row;
    }
  }
  throw new Error(`no room for the runs in ${room}`);
}

/** herdr's two-row mobile header; the handle sits where the tab bar's right end would be, left of `switch`. */
function mobileHeader(scr, s) {
  const button = NARROW - 10;
  scr.fill(button, 0, 10, 'tab', 2);
  scr.put(button, 0, '{dim │}');
  scr.put(button, 1, '{dim │}');
  scr.put(button + 2, 1, '{t* switch}');
  const states = [s.main, ...s.workers.map((w) => w[2]), ...s.folded[1]];
  if (states.includes('×')) scr.put(NARROW - 1, 0, st('×'));
  const mark = handle(s.requests);
  scr.right(button - 1, 0, mark);
  const tab = '{o1 tab claude · 1/2 · 2 hidden}', tabX = button - 2 - len(mark) - len(tab);
  scr.put(0, 0, ` ${st(s.spaces[0][1])} {t* ${s.spaces[0][0]}}`, tabX - 1);
  scr.put(tabX, 0, tab);
  const counts = [['×', 'blocked'], ['✓', 'done'], ['◐', 'working'], ['○', 'idle']]
    .map(([glyph, word]) => [glyph, word, states.filter((v) => v === glyph).length])
    .filter(([, , n]) => n);
  if (!s.runs.length) {
    // No run: herdr's agent counts as they are today.
    const words = counts.map(([glyph, word, n], i) => `{${i ? 'o1' : STATE_INK[glyph]} ${glyph} ${n} ${word}}`);
    scr.put(0, 1, ` ${words.join('{o0  · }')}`, button - 1);
    return;
  }
  // A run: the counts drop their words, and the running graphs take the rest of the row.
  const short = ` ${counts.map(([glyph, , n]) => `{${STATE_INK[glyph]} ${glyph}}{o1 ${n}}`).join(' ')} {dim │} `;
  scr.put(0, 1, `${short}${strips(s.runs, button - 1 - len(short))}`, button - 1);
}

/** 60 columns, dock hidden: no sidebar, no tab bar and no rail. */
export function narrow(s) {
  const scr = screen(NARROW, ROWS);
  mobileHeader(scr, s);
  pane(scr, 0, 2, NARROW, ROWS - 2, s);
  return scr;
}

// ------------------------------------------------------------------------------------------- close-ups
const crop = (cells) => ({ w: cells[0].length, h: cells.length, cells });
/** The right rail alone, divider included, as it sits under the tab bar of a window `rows` high. */
export function railOnly(s, width, rows = ROWS) {
  const scr = screen(width + 1, rows);
  rightRail(scr, 0, s, width);
  return crop(scr.cells.slice(1));
}
/** The left side alone, cut from the real screen. */
export const leftOnly = (s, left) => crop(desktop(s, { left }).cells.map((row) => row.slice(0, left === 'open' ? SIDEBAR : RAIL)));
/** The right end of the tab bar, no run and dock hidden: 40 cells cut from the real screen. */
export const tabBarEnd = (s) => crop([desktop(s).cells[0].slice(-40)]);
/** The narrow header. */
export function narrowTop(s) {
  const scr = screen(NARROW, 2);
  mobileHeader(scr, s);
  return scr;
}
