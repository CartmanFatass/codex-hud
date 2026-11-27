// Builds ../index.html from frames.mjs. No dependencies, no network; the page has no script.
// Usage: node docs/design/sidebar-dock/gen/gen.mjs
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  attention, calm, crowded, running, tall, desktop, leftOnly, narrow, narrowTop, railOnly, tabBarEnd,
  NARROW, ROWS, WIDTHS,
} from './frames.mjs';

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Box drawing is painted with CSS so lines join between rows, as a terminal draws them; the character stays in the text.
// Straight glyphs list the arms they have (up, down, left, right); a rounded corner is a quarter of a bordered box.
const ARMS = {
  '│': 'ud', '─': 'lr', '┈': 'lr', '╌': 'lr', '├': 'udr', '┤': 'udl', '┬': 'lrd', '┴': 'lru', '┼': 'udlr',
  '┌': 'dr', '┐': 'dl', '└': 'ur', '┘': 'ul',
};
const ROUND = { '╭': ['top', 'left'], '╮': ['top', 'right'], '╰': ['bottom', 'left'], '╯': ['bottom', 'right'] };
const DASH = { '┈': [2, 4], '╌': [4, 6] };
const boxClass = (ch) => `x-${ch.codePointAt(0).toString(16)}`;
const boxCss = Object.entries(ARMS).map(([ch, arms]) => {
  const layers = [], half = 'calc(50% + .5px)';
  const ink = 'linear-gradient(currentColor,currentColor)';
  const dash = DASH[ch] && `repeating-linear-gradient(90deg,currentColor 0 ${DASH[ch][0]}px,transparent ${DASH[ch][0]}px ${DASH[ch][1]}px)`;
  const u = arms.includes('u'), d = arms.includes('d'), l = arms.includes('l'), r = arms.includes('r');
  if (u || d) layers.push([ink, `1px ${u && d ? '100%' : half}`, `50% ${u ? '0' : '100%'}`]);
  if (l || r) layers.push([dash || ink, `${l && r ? '100%' : half} 1px`, `${l ? '0' : '100%'} 50%`]);
  const list = (i) => layers.map((layer) => layer[i]).join(',');
  return `.${boxClass(ch)}{background-image:${list(0)};background-size:${list(1)};background-position:${list(2)}}`;
}).concat(Object.entries(ROUND).map(([ch, [v, h]]) => {
  const near = 'calc(50% - .5px)';
  return `.${boxClass(ch)}::after{content:'';position:absolute;left:${h === 'left' ? near : '0'};right:${h === 'left' ? '0' : near};`
    + `top:${v === 'top' ? near : '0'};bottom:${v === 'top' ? '0' : near};border-${v}:1px solid;border-${h}:1px solid;border-${v}-${h}-radius:5px}`;
})).join('\n');

// Printable ASCII flows as text (the monospace face keeps it on the grid); every other glyph gets a cell of its own,
// except a horizontal rule, which is one element so that sub-pixel cell widths don't add up along the row.
function glyphs(text) {
  return text.replace(/─+|┈+|╌+|[^ -~]|[ -~]+/gu, (run) => {
    if (run[0] >= ' ' && run[0] <= '~') return esc(run);
    const box = ARMS[run[0]] || ROUND[run[0]], n = run.length > 1 ? ` style="width:${run.length}ch"` : '';
    return box ? `<i class="x ${boxClass(run[0])}"${n}>${run}</i>` : `<i>${run}</i>`;
  });
}
const cls = ({ ink, bg }) => `c-${ink.replace('*', '')}${ink.endsWith('*') ? ' bd' : ''}${bg ? ' b-' + bg : ''}`;
function term({ w, cells }) {
  const rows = cells.map((row, y) => {
    if (row.length !== w) throw new Error(`row ${y} is ${row.length} cells, not ${w}`);
    const spans = [];
    for (const cell of row) {
      const last = spans.at(-1), key = cls(cell);
      if (last?.key === key) last.text += cell.ch;
      else spans.push({ key, text: cell.ch });
    }
    return `<div class="r">${spans.map((s) => `<span class="${s.key}">${glyphs(s.text)}</span>`).join('')}</div>`;
  }).join('\n');
  return `<div class="term" data-w="${w}" style="--w:${w}">\n${rows}\n</div>`;
}

const k = (key) => `<kbd>${key}</kbd>`;
const g = (glyph) => `<code>${glyph}</code>`;
const legend = (shows, does) => `<dl><dt>Shows</dt><dd>${shows}</dd><dt>Click · key</dt><dd>${does}</dd></dl>`;
const figure = (title, scr, shows, does) => `<figure>
<h3>${title} <span>${scr.w} × ${scr.h}</span></h3>
<div class="scroll">${term(scr)}</div>
${legend(shows, does)}
</figure>`;
const section = (id, title, lede, body) => `<section id="${id}">
<h2>${title}</h2>
<p>${lede}</p>
${body}
</section>`;
const column = (title, scr) => `<div><h4>${title}</h4>${term(scr)}</div>`;

const STEPS = `${g('✓')} landed or done · ${g('◐')} running · ${g('×')} failed or blocked · ${g('?')} waits for you · ${g('○')} queued`;
const AGENTS = `${g('✓')} done · ${g('◐')} working · ${g('×')} blocked · ${g('○')} idle`;

// ------------------------------------------------------------------------------------------- the choice
const picks = [
  ['Running', running, ROWS, 'Two projects: three tickets in parallel then review and accept; one single step.'],
  ['Asked, one step failed', attention, ROWS, `${g('?1')} on top. The project that needs you comes first.`],
  ['Taller than the rail', tall, ROWS, `19 tickets. ${g('✓ +6')} landed and ${g('○ +8')} queued are folded; ${g('○+3')} are three more side by side.`],
  ['Short window, 5 projects', crowded, 13, `Least urgent projects shrink to one line, then ${g('+2')} counts the rest with their most urgent shape.`],
].map(([title, s, rows, note]) => `<div class="group"><h3>${title}</h3>
<div class="pairs">${WIDTHS.map((w) => column(`rail ${w}`, railOnly(s, w, rows))).join('')}</div>
<p>${note}</p></div>`).join('\n');

const pick = section('pick', 'Pick the rail width: 8 or 12', `Same rules, same data. Each takes one more column for its divider (9 or 13 from the pane). <b>8</b> shows shapes and cuts project names to 7 cells; a parallel step has no number. <b>12</b> adds full names up to 11 cells, ticket numbers and whole words.`, `<div class="groups">
${picks}
</div>
<ul>
<li>One block per project with an active run, most urgent first: ${g('?')}, ${g('×')}, ${g('◐')}. Top to bottom is run order; side by side is parallel; review and accept end the graph. Solid line: travelled. Dashed: ahead.</li>
<li>Too tall, in this order: landed steps fold, then queued tickets, then whole projects shrink to one line, then ${g('+N')}. ${g('+N')} always means “N not drawn”. The rail never scrolls.</li>
<li>Clicks: a step or a project name opens Execution there. A folded ${g('+N')} step line opens Execution on that run; the ${g('+N')} projects line opens Home, which lists them.</li>
<li>Rule not drawn here: a project with a second active run shows its most urgent graph, then a ${g('+1 run')} line.</li>
</ul>`);

// ------------------------------------------------------------------------------------------- frames
const RAIL_CLICK = `A step or a project name opens the dock on Execution at that step or run (target: the shape and its label; in rail 8, the shape and the cell after it). ${g('«')} (divider, top) or ${k('prefix+d')} opens the dock on its last tab; typing stays in the pane. ${g('»')} (left rail, bottom) or ${k('prefix+b')} expands the sidebar.`;

const sections = [
  section('running', '1 · Both collapsed, runs active', 'Left rail 4, pane 87, divider and rail 8. The pane gives up the 9 columns, so nothing covers the harness. No tab-bar handle: the rail’s divider carries the toggle.', figure('Running, rail 8', desktop(running, { rail: 8 }),
    `Right: ${g('harbor…')} 01 ${g('✓')}, 02 and 03 ${g('◐')} side by side, ${g('rev')} and ${g('acc')} ${g('○')}; ${g('lanter…')} one step ${g('audit')} ${g('◐')}. Left: ${g('1')} ${g('2')} workspaces; ${g('○')} main session; ${g('◐⚒')} two imps working; ${g('▸ ◐')} folded group, strongest state.`,
    RAIL_CLICK)),
  section('asked', '2 · Left collapsed, rail with a request and a failed step', 'Left rail 4, pane 83, divider and rail 12.', figure('You are asked, rail 12', desktop(attention, { rail: 12 }),
    `${g('?1 for you')}: one open request. 01 ${g('✓')}, 02 ${g('×')} failed, 03 ${g('?')} waits for you; review and accept ${g('○')}. The left rail shows agents, so the failed 02, with no live pane, is visible only on the right: ${g('✓⚒')} 01’s imp done, ${g('×⚒')} 03’s imp blocked.`,
    `${g('?1')} opens the dock on Home at the request. ${g('×02')} opens Execution at that step (section 4). ${RAIL_CLICK}`)),
  section('calm', '3 · Both collapsed, no active run: handle only', 'Left rail 4, pane 96, dock 0. The rail is gone and handle A sits at the right end of the tab bar; it takes no pane column or row.', `${figure('Calm', desktop(calm),
    `Dim ${g('«')}: the dock is hidden, nothing runs, nothing is asked. Left rail: ${g('✓⚒')} imp and ${g('✓⚖')} reviewer done; ${g('▸ ✓')} folded group, strongest state done.`,
    `${g('«')} or ${k('prefix+d')}: the dock opens on its last tab and pushes the pane. ${g('»')} or ${k('prefix+b')}: the sidebar.`)}
<div class="scroll"><table>
<thead><tr><th>No active run</th><th>Tab bar, right end</th></tr></thead>
<tbody>
<tr><th>Nothing asked</th><td>${term(tabBarEnd(calm))}</td></tr>
<tr><th>One request for you</th><td>${term(tabBarEnd({ ...calm, requests: 1 }))}</td></tr>
</tbody></table></div>
<p>${g('?1')} opens Home at the request; ${g('«')} opens the last tab. They are separate targets.</p>`),
  section('open', '4 · Clicked ×02 in the rail: the dock opens on Execution', `Left rail 4, pane 55, divider and dock 40. The rail is replaced by the dock. The Execution tab is the panel’s own with its cursor on the clicked step; only the footer’s ${g('q hide')} is new (decided, not built).`, figure('Dock on Execution, step 02', desktop(attention, { dock: 40 }),
    `The map runs left to right: ${g('●')} 01 done, ${g('✗')} 02 failed (cursor), ${g('?')} 03, ${g('◇')} review, ${g('☆')} accept. The line under it names the cursor’s step. These marks are today’s panel marks, not the rail’s ${g('✓ × ○')}. Below: 03’s worker card with its question.`,
    `${k('⏎')} step details. ${k('←')} ${k('→')} move between steps. ${g('»')} (divider, top), ${k('prefix+d')} or ${k('q')} hide the dock; the rail returns and the panel keeps running.`)),
  section('narrow', `5 · Narrow, ${NARROW} columns: no rail, the run sits in the header`, 'At 64 columns or fewer herdr has a two-row header and no sidebar or tab bar. No column is taken for a rail. While a run is active, row 2 keeps the agent counts without their words and draws each graph on one line.', `${figure('You are asked, dock hidden', narrow(attention),
    `Row 1: workspace state, tabs, ${g('?1 «')}, and herdr’s ${g('×')} for a blocked agent. Row 2: ${g('×1 ✓1 ◐1 ○1')} agents; then ${g('harbor…')} with ${g('[✓×?]')} in parallel, review ${g('○')}, accept ${g('○')}; ${g('lanter…')} one step ${g('◐')}.`,
    `A project or a step in row 2 opens the dock zoomed on Execution there. ${g('?1')} opens it on Home at the request; ${g('«')} or ${k('prefix+d')} on the last tab. ${g('switch')} opens herdr’s menu.`)}
<div class="scroll"><table>
<thead><tr><th>State</th><th>Narrow header</th></tr></thead>
<tbody>
${[['No run', calm], ['No run, one request', { ...calm, requests: 1 }], ['Running', running], ['Asked, one step failed', attention], ['Long graph, folded', { ...attention, runs: tall.runs }], ['5 projects', { ...attention, runs: crowded.runs }]]
    .map(([label, s]) => `<tr><th>${label}</th><td>${term(narrowTop(s))}</td></tr>`).join('\n')}
</tbody></table></div>
<p>The same folds and ${g('+N')} as the rail. ${g('─')} joins steps in order; ${g('[ ]')} holds parallel ones.</p>`),
  section('left', '6 · Left sidebar', `herdr’s two-line agent rows, unchanged: state and workspace, then the agent’s name. The one change is the role glyph glued after the state shape. Agent states: ${AGENTS}. Roles: ${g('⚒')} imp, ${g('⚖')} reviewer; a main session has none.`, `<div class="groups">
${[['Running', running], ['Asked', attention], ['Calm', calm]].map(([title, s]) => `<div class="group"><h3>${title}</h3>
<div class="pairs">${column('open, 22', leftOnly(s, 'open'))}${column('rail, 4', leftOnly(s, 'rail'))}</div></div>`).join('\n')}
</div>
${legend(`Open: ${g('▾')} open group and ${g('▸')} folded group, each with its count at the right; a folded one’s mark and count take the colour of its strongest state, as today. Rail: workspaces on top; below, one row per agent (${g('◐⚒')}), ${g('┈')} and ${g('─')} group rules; the folded group shows its strongest state shape (${g('▸ ◐')}, ${g('▸ ✓')}) in place of the count.`,
    `${g('«')} / ${g('»')} (bottom) or ${k('prefix+b')} collapse and expand. Click an agent for its terminal, a group to fold or unfold it.`)}`),
];

// herdr's rose-pine inks (src/app/state.rs) for its chrome and the rail; the panel keeps its own default board inks.
const INKS = {
  t: '#e0def4', s: '#c8c5dc', o0: '#6e6a86', o1: '#908caa', dim: '#403d52', acc: '#c4a7e7',
  working: '#f6c177', blocked: '#eb6f92', done: '#9ccfd8', idle: '#4f93ad',
  pt: '#d5dbe6', pm: '#9aa5b8', pf: '#3b4556', pa: '#efc15a', pd: '#f4727e', pb: '#6fa8ff', imp: '#4cc3ea',
};
const SURFACES = { row: '#26233a', tab: '#1f1d2e', tabon: '#c4a7e7', ptitle: '#1e2531', psel: '#303a4b' };
const inkCss = Object.entries(INKS).map(([n, v]) => `.c-${n}{color:${v}}`).join('')
  + Object.entries(SURFACES).map(([n, v]) => `.b-${n}{background:${v}}`).join('')
  + '.c-tabon{color:#191724}.c-chip{color:#19150d;background:#ffc13a}.c-cursor{background:#e0def4}.bd{font-weight:700}';

const css = `
:root{--page:#f6f6f4;--pt:#1f2023;--pm:#55585f;--pr:#d6d6d0;--code:#e9e9e4}
@media (prefers-color-scheme:dark){:root{--page:#101114;--pt:#e6e7ea;--pm:#a2a7b0;--pr:#2c2f36;--code:#1f2228}}
*{box-sizing:border-box}
body{margin:0;padding:24px 28px 64px;background:var(--page);color:var(--pt);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
header,section>p,ul{max-width:860px}
h1{font-size:22px;margin:0 0 6px}
h2{font-size:17px;margin:34px 0 4px;padding-top:16px;border-top:1px solid var(--pr)}
h3{font-size:13px;margin:0 0 5px}h3 span{color:var(--pm);font-weight:400;margin-left:6px}
h4{font-size:12px;font-weight:400;color:var(--pm);margin:0 0 4px}
p{margin:0 0 8px;color:var(--pm)}p b{color:var(--pt)}
ul{padding-left:18px;margin:12px 0 0;color:var(--pm);font-size:13px}
nav{display:flex;gap:16px;flex-wrap:wrap;font-size:13px}nav a{color:inherit}
figure{margin:0 0 14px;width:fit-content;min-width:0;max-width:100%}
.scroll{overflow-x:auto;max-width:100%}
.groups{display:flex;flex-wrap:wrap;gap:20px 34px;align-items:flex-start}
.group{max-width:100%}.group p{font-size:12.5px;line-height:1.5;margin:7px 0 0;width:0;min-width:100%}
.pairs{display:flex;gap:10px;align-items:flex-start}
.term{--fs:13px;--lh:17px;font:var(--fs)/var(--lh) ui-monospace,"DejaVu Sans Mono","Cascadia Mono",Menlo,Consolas,monospace;font-variant-ligatures:none;width:calc(var(--w) * 1ch + 18px);padding:7px 8px;background:#191724;color:#e0def4;border:1px solid #403d52;border-radius:6px}
.r{height:var(--lh);width:calc(var(--w) * 1ch);white-space:pre}
.r span{display:inline-block;height:var(--lh);vertical-align:top}
.r i{display:inline-block;width:1ch;height:var(--lh);vertical-align:top;text-align:center;font-style:normal}
.r i.x{position:relative;-webkit-text-fill-color:transparent;background-repeat:no-repeat}
${boxCss}
dl{display:grid;grid-template-columns:max-content 1fr;gap:2px 10px;margin:7px 0 0;font-size:12.5px;line-height:1.55;width:0;min-width:100%;max-width:860px}
dt{color:var(--pm)}dd{margin:0}
code,kbd{font:12px ui-monospace,"DejaVu Sans Mono","Cascadia Mono",monospace;background:var(--code);padding:0 4px;border-radius:3px;white-space:pre}
kbd{border:1px solid var(--pr)}
table{border-collapse:collapse;font-size:12.5px;margin-bottom:8px}
th,td{text-align:left;padding:3px 14px 3px 0;vertical-align:middle;font-weight:400}
thead th{color:var(--pm)}tbody th{white-space:nowrap}
${inkCss}`;

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sidebar and dock: design sample</title><style>${css}</style></head><body>
<header>
<h1>Hidden dock: each project’s running workflow</h1>
<p><b>To pick: the rail’s width.</b> While a run is active, the hidden dock is a narrow rail with each project’s graph. With no run it is handle A, ${g('«')}. Nothing here is built. Synthetic data, drawn one glyph per terminal cell.</p>
<p>Steps: ${STEPS}.</p>
<nav><a href="#pick">Width</a><a href="#running">1 Running</a><a href="#asked">2 Asked</a><a href="#calm">3 Calm</a><a href="#open">4 Dock open</a><a href="#narrow">5 Narrow</a><a href="#left">6 Sidebar</a></nav>
</header>
${pick}
${sections.join('\n')}
</body></html>
`;
writeFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.html'), html);
console.log(`index.html ${(html.length / 1024).toFixed(0)} KB, desktop frames 100 × ${ROWS}, narrow ${NARROW} × ${ROWS}`);
