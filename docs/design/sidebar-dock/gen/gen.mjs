// Builds ../index.html from frames.mjs. No dependencies, no network; the page has no script.
// Usage: node docs/design/sidebar-dock/gen/gen.mjs
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attention, calm, desktop, narrow, narrowTop, tabBarEnd, NARROW, ROWS } from './frames.mjs';

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Box drawing is painted with CSS so lines join between rows, as a terminal draws them; the character stays in the text.
const BOX = { '│': 'v', '─': 'h', '┈': 'd', '├': 't', '└': 'l' };
// Printable ASCII flows as text (the monospace face keeps it on the grid); every other glyph gets a cell of its own,
// except a horizontal rule, which is one element so that sub-pixel cell widths don't add up along the row.
function glyphs(text) {
  return text.replace(/─+|┈+|[^ -~]|[ -~]+/gu, (run) => {
    if (run[0] >= ' ' && run[0] <= '~') return esc(run);
    const box = BOX[run[0]], n = run.length > 1 ? ` style="width:${run.length}ch"` : '';
    return box ? `<i class="x x-${box}"${n}>${run}</i>` : `<i>${run}</i>`;
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
const figure = (title, scr, shows, does) => `<figure class="w${scr.w}">
<h3>${title} <span>${scr.w} × ${scr.h}</span></h3>
<div class="scroll">${term(scr)}</div>
<dl><dt>Shows</dt><dd>${shows}</dd><dt>Click · key</dt><dd>${does}</dd></dl>
</figure>`;
const section = (id, title, lede, figures) => `<section id="${id}">
<h2>${title}</h2>
<p>${lede}</p>
<div class="pair">
${figures.join('\n')}
</div>
</section>`;

const CALM = 'Calm', ASKED = 'You are asked';
const wide = (s, left, dock) => desktop(s, { left, dock });

const handles = [
  ['Nothing running', calm],
  ['Busy or blocked, no request', { ...attention, requests: 0 }],
  ['One request for you', attention],
].map(([label, s]) => `<tr><th>${label}</th><td>${term(tabBarEnd(s))}</td><td>${term(narrowTop(s))}</td></tr>`).join('\n');

const sections = [
  section('open', '1 · Both sides open', `Sidebar 22 (default 26), pane 41, dock 36. herdr keeps the pane at 41 columns or more beside the dock, so at 100 columns a dock set to 40 gets 36, and the panel drops its tab counts.`, [
    figure(CALM, wide(calm, 'open', 36),
      `Sidebar: state shapes in one column at its right edge, ${g('✓')} done, ${g('○')} idle. Before each name, who: ${g('c')} Claude main session, ${g('⚒')} imp, ${g('⚖')} reviewer. ${g('▾')} open group, ${g('▸')} folded (2 agents, strongest state). ${g('↑1')} one commit ahead. Dock: ${g('○')} idle project, ${g('▸')} Objective, ${g('✓')} latest result.`,
      `${k('prefix+b')} or ${g('«')} (sidebar, bottom) collapses the left. ${k('prefix+d')} or ${g('»')} (divider, top) collapses the dock. ${k('q')} in the panel hides it; it keeps running. Click an agent for its terminal, a group to fold it.`),
    figure(ASKED, wide(attention, 'open', 36),
      `${g('◐')} working, ${g('×')} blocked, ${g('○')} idle; the folded group's ${g('✓')} is its strongest state. Dock: ${g('?')} you are asked, listed first with ${g('work waits')} and age. ${g('⚒1 ⚖1 ϟ1')} counts jobs by role with no worker rows (${g('ϟ')} sonic is headless, so it has no sidebar row).`,
      `Click the request for its project. ${k('prefix+d')}, ${g('»')} or ${k('q')} hide the dock; ${g('?1 «')} then appears on the tab bar. ${k('prefix+b')} or ${g('«')} collapses the left.`),
  ]),
  section('rail', '2 · Left collapsed, dock open', 'Rail 4, pane 55, dock 40. The rail reads like its workspace rows: who on the left, state on the right.', [
    figure(CALM, wide(calm, 'rail', 40),
      `${g('1')} ${g('2')} workspaces; ${g('c')} main session; ${g('⚒')} ${g('⚖')} workers; ${g('┈')} subgroup rule, ${g('─')} project rule; ${g('▸')} folded group (its count shows when expanded). ${g('✓')} done, ${g('○')} idle. Dock marks as in section 1.`,
      `${k('prefix+b')} or ${g('»')} (rail, bottom) expands the sidebar. Click a row to switch or peek without expanding. ${k('prefix+d')}, ${g('»')} or ${k('q')} hide the dock.`),
    figure(ASKED, wide(attention, 'rail', 40),
      `${g('1 ×')} a workspace with a blocked agent; ${g('c ○')} main session idle; ${g('⚒ ◐')} imp working; ${g('⚖ ×')} reviewer blocked; ${g('▸ ✓')} folded group, strongest state done. Dock tabs, shown at 40 columns: ${g('?1')} requests for you, ${g('·3')} live jobs.`,
      `Click ${g('⚖ ×')}: that terminal opens beside the dock, never under it. Click the request for its project. ${k('prefix+d')}, ${g('»')} or ${k('q')} hide the dock.`),
  ]),
  section('closed', '3 · Both collapsed', 'Rail 4, pane 96, dock 0. The handle sits at the right end of the tab bar and takes no pane column or row.', [
    figure(CALM, wide(calm, 'rail', 0),
      `Dim ${g('«')}: the dock is hidden and nothing is asked of you. Rail marks as in section 2: ${g('✓')} done, ${g('○')} idle.`,
      `Click ${g('«')} or ${k('prefix+d')}: the dock opens on its last tab and pushes the pane; typing stays in the pane. ${k('prefix+b')} or ${g('»')} expands the sidebar.`),
    figure(ASKED, wide(attention, 'rail', 0),
      `Amber ${g('?1')} ${g('«')}: one open request for you. Running and blocked jobs add nothing here; the rail shows ${g('◐')} and ${g('×')}.`,
      `Click ${g('?1')}: the dock opens with focus on Home, at the request. Click ${g('«')} or ${k('prefix+d')}: last tab, focus unchanged. ${k('q')} in the panel hides it again.`),
  ]),
  section('narrow', `4 · Narrow, ${NARROW} columns: the dock opens zoomed`, 'At 64 columns or fewer herdr drops the sidebar and tab bar for a two-row header. The dock covers the whole pane area, so there is no split and no divider.', [
    figure(CALM, narrow(calm),
      `Header: workspace state and tabs, then agent counts, each with its state shape. ${g('»')}: the dock is open. Dock marks as in section 1.`,
      `Opened with ${k('prefix+d')} or the header's ${g('«')}, with focus. ${g('»')}, ${k('prefix+d')} or ${k('q')} return to the pane; the panel keeps running. ${g('switch')} opens herdr's menu.`),
    figure(ASKED, narrow(attention),
      `${g('×')} at the top right: an agent is blocked (herdr today). ${g('?')} the request, selected because the dock was opened from ${g('?1')}.`,
      `${k('⏎')} opens the request. ${g('»')}, ${k('prefix+d')} or ${k('q')} return to the pane; the header then shows ${g('?1 «')}.`),
  ]),
];

// herdr's rose-pine inks (src/app/state.rs) for its chrome; the panel keeps its own default board inks.
const INKS = {
  t: '#e0def4', s: '#c8c5dc', o0: '#6e6a86', o1: '#908caa', dim: '#403d52', acc: '#c4a7e7',
  working: '#f6c177', blocked: '#eb6f92', done: '#9ccfd8', idle: '#4f93ad',
  pt: '#d5dbe6', pm: '#9aa5b8', pf: '#3b4556', pa: '#efc15a', pg: '#8fd073', pb: '#6fa8ff', imp: '#4cc3ea', rev: '#e26fce', son: '#ff8f72',
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
header,section>p{max-width:860px}
h1{font-size:22px;margin:0 0 6px}
h2{font-size:17px;margin:34px 0 4px;padding-top:16px;border-top:1px solid var(--pr)}
h3{font-size:13px;margin:0 0 5px}h3 span{color:var(--pm);font-weight:400;margin-left:6px}
p{margin:0 0 8px;color:var(--pm)}p b{color:var(--pt)}
nav{display:flex;gap:16px;flex-wrap:wrap;font-size:13px}nav a{color:inherit}
.pair{display:flex;flex-wrap:wrap;gap:20px 22px;align-items:flex-start}
figure{margin:0;min-width:0;max-width:100%}
.scroll{overflow-x:auto;max-width:100%}
.term{--fs:13px;--lh:17px;font:var(--fs)/var(--lh) ui-monospace,"DejaVu Sans Mono","Cascadia Mono",Menlo,Consolas,monospace;font-variant-ligatures:none;width:calc(var(--w) * 1ch + 18px);padding:7px 8px;background:#191724;color:#e0def4;border:1px solid #403d52;border-radius:6px}
.r{height:var(--lh);width:calc(var(--w) * 1ch);white-space:pre}
.r span{display:inline-block;height:var(--lh);vertical-align:top}
.r i{display:inline-block;width:1ch;height:var(--lh);vertical-align:top;text-align:center;font-style:normal}
.r i.x{-webkit-text-fill-color:transparent;background-repeat:no-repeat}
.x-v{background-image:linear-gradient(currentColor,currentColor);background-size:1px 100%;background-position:50% 0}
.x-h{background-image:linear-gradient(currentColor,currentColor);background-size:100% 1px;background-position:0 50%}
.x-d{background-image:repeating-linear-gradient(90deg,currentColor 0 2px,transparent 2px 4px);background-size:100% 1px;background-position:0 50%}
.x-t{background-image:linear-gradient(currentColor,currentColor),linear-gradient(currentColor,currentColor);background-size:1px 100%,50% 1px;background-position:50% 0,100% 50%}
.x-l{background-image:linear-gradient(currentColor,currentColor),linear-gradient(currentColor,currentColor);background-size:1px calc(50% + .5px),50% 1px;background-position:50% 0,100% 50%}
dl{display:grid;grid-template-columns:max-content 1fr;gap:2px 10px;margin:7px 0 0;font-size:12.5px;line-height:1.55;width:0;min-width:100%}
dt{color:var(--pm)}dd{margin:0}
code,kbd{font:12px ui-monospace,"DejaVu Sans Mono","Cascadia Mono",monospace;background:var(--code);padding:0 4px;border-radius:3px;white-space:nowrap}
kbd{border:1px solid var(--pr)}
table{border-collapse:collapse;font-size:12.5px;margin-bottom:8px}
th,td{text-align:left;padding:3px 14px 3px 0;vertical-align:middle;font-weight:400}
thead th{color:var(--pm)}tbody th{white-space:nowrap}
@media (min-width:1440px){figure.w100 .term{--fs:11px;--lh:15px}}
@media (min-width:1720px){figure.w100 .term{--fs:13px;--lh:17px}}
${inkCss}`;

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sidebar and dock: design sample</title><style>${css}</style></head><body>
<header>
<h1>One frame: sidebar on the left, HUD dock on the right</h1>
<p><b>Handle A (owner's pick):</b> the hidden dock leaves a near-invisible ${g('«')} at the right end of the tab bar. ${g('?N «')} appears only while you are asked something.</p>
<p>New against today: each agent takes one sidebar row (herdr’s default is two) with its role glyph before the name and its state shape in a right-hand column; the hidden dock has a handle; ${k('prefix+d')} works before ${g('/hud')} has run; ${k('q')} hides the panel instead of quitting it; a narrow screen opens it zoomed. Nothing here is built. Synthetic data, drawn one glyph per terminal cell.</p>
<nav><a href="#handle">Handle</a><a href="#open">1 Both open</a><a href="#rail">2 Left collapsed</a><a href="#closed">3 Both collapsed</a><a href="#narrow">4 Narrow</a></nav>
</header>
<section id="handle">
<h2>The handle, dock hidden</h2>
<div class="scroll"><table>
<thead><tr><th>State</th><th>Tab bar, right end</th><th>Narrow header</th></tr></thead>
<tbody>
${handles}
</tbody></table></div>
<p>${g('N')} counts open requests for you in all projects. ${g('?1')} and ${g('«')} are separate click targets (see section 3).</p>
</section>
${sections.join('\n')}
</body></html>
`;
writeFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.html'), html);
console.log(`index.html ${(html.length / 1024).toFixed(0)} KB, desktop frames 100 × ${ROWS}, narrow ${NARROW} × ${ROWS}`);
