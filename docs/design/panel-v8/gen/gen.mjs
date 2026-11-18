// Builds options.html from frames.mjs. No dependencies, no network; the page has no script.
// Usage: node docs/design/panel-v8/gen/gen.mjs
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { W } from './lib.mjs';
import { today } from './frames.mjs';
import { option1 } from './opt1.mjs';
import { option2 } from './opt2.mjs';
import { option3 } from './opt3.mjs';
const options = [option1, option2, option3];

// The default theme's board inks (`terminal` in BOARD_SPECS) and the light one (`latte`), from src/render/palette.ts.
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const toHex = (p) => '#' + p.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
const mix = (a, b, k) => toHex(hex(a).map((v, i) => v + (hex(b)[i] - v) * k));
const shade = (a, k) => toHex(hex(a).map((v) => v * k));
const DARK = {
  ground: '#0e131b', text: '#d5dbe6', m: '#9aa5b8', f: '#3b4556', a: '#efc15a', d: '#f4727e', s: '#8fd073', b: '#6fa8ff',
  o: '#f29958', i: '#b4a6df', title: '#1e2531', body: '#141b26', sel: '#303a4b', askbg: '#ffc13a',
  imp: '#4cc3ea', rev: '#e26fce', son: '#ff8f72', ora: '#a99df2',
};
DARK.slab = shade(DARK.askbg, 0.17);
DARK.fail = shade(DARK.d, 0.17);
const LIGHT = {
  ground: '#eff1f5', text: '#4c4f69', m: '#555870', f: '#9ca0b0', a: '#824800', d: '#b30d30', s: '#26661a', b: '#1648c0',
  o: '#963a04', i: '#6f27cf', title: '#e6e9ef', body: '#dce0e8', sel: '#ccd0da', askbg: '#e9a83a',
  imp: '#087f9c', rev: '#a63c91', son: '#a84329', ora: '#6556ae',
};
LIGHT.slab = mix(LIGHT.body, LIGHT.askbg, 0.3);
LIGHT.fail = mix(LIGHT.body, LIGHT.d, 0.12);
const vars = (p) => Object.entries(p).map(([k, v]) => `--${k}:${v}`).join(';');

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const cls = (k) => {
  const [ink, surface] = k.replace('*', '').split('/');
  return `c-${ink}${surface ? ' s-' + surface : ''}${k.includes('*') ? ' bd' : ''}`;
};
// Printable ASCII flows as text (the monospace face keeps it on the grid); every other glyph gets a cell of its own.
function cellsHtml(text) {
  let out = '', run = '';
  for (const ch of text) {
    if (ch >= ' ' && ch <= '~') run += ch;
    else { if (run) out += esc(run), run = ''; out += `<i>${esc(ch)}</i>`; }
  }
  return out + esc(run);
}
function frameHtml({ rows, h }) {
  const body = rows.map((r) => {
    const n = r.segs.reduce((a, s) => a + [...s.t].length, 0);
    if (n !== W) throw new Error(`row is ${n} cells: ${r.segs.map((s) => s.t).join('')}`);
    return `<div class="r${r.bg ? ' s-' + r.bg : ''}">${r.segs.map((s) => `<span class="${cls(s.k)}">${cellsHtml(s.t)}</span>`).join('')}</div>`;
  }).join('');
  return `<div class="term" style="--rows:${h}">${body}</div>`;
}
const screen = (s, size) => `<figure><div class="cap-top"><b>${esc(s.title)}</b> <span>${size ?? ''}${s.rows ? '' : ''}</span></div>${frameHtml(s.frame)}<figcaption>${s.note.map((l) => `<p>${l}</p>`).join('')}</figcaption></figure>`;

const section = (o) => `
<section id="${o.id}">
  <h2>${esc(o.name)}${o.recommended ? ' <em>recommended</em>' : ''}</h2>
  <div class="thesis">${o.thesis.map((l) => `<p>${l}</p>`).join('')}</div>
  <h3 class="grp">Home</h3>
  <div class="grid">${o.home.map((s) => screen(s, `${W} × ${s.frame.h}`)).join('')}</div>
  <h3 class="grp">Project</h3>
  <div class="grid">${o.project.map((s) => screen(s, `${W} × ${s.frame.h}`)).join('')}</div>
</section>`;

const css = `
*{box-sizing:border-box}
html{background:var(--page)}
body{margin:0;font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
.page{--page:#f6f6f4;--pt:#222;--pm:#666;--pr:#d8d8d2;${vars(LIGHT)};background:var(--page);color:var(--pt);min-height:100vh;padding:24px 28px 64px}
@media (prefers-color-scheme:dark){#t-auto:checked~.page{--page:#101214;--pt:#e4e6ea;--pm:#9aa0aa;--pr:#2a2e35;${vars(DARK)}}}
#t-dark:checked~.page{--page:#101214;--pt:#e4e6ea;--pm:#9aa0aa;--pr:#2a2e35;${vars(DARK)}}
.sw{position:absolute;opacity:0;pointer-events:none}
header{max-width:1100px}
h1{font-size:22px;margin:0 0 6px}
h2{font-size:19px;margin:44px 0 6px;padding-top:18px;border-top:1px solid var(--pr)}
h2 em{font-size:12px;font-style:normal;background:var(--a);color:var(--ground);padding:1px 8px;border-radius:10px;margin-left:8px;vertical-align:2px}
h3.grp{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:var(--pm);margin:22px 0 10px}
p{margin:0 0 6px}
.thesis{max-width:760px;color:var(--pt)}
.lede{max-width:820px;color:var(--pm)}
nav{margin:14px 0 4px;display:flex;gap:16px;flex-wrap:wrap;align-items:center}
nav a{color:inherit}
nav label{cursor:pointer;border:1px solid var(--pr);border-radius:14px;padding:2px 12px;font-size:12px;color:var(--pm)}
#t-auto:checked~.page label[for=t-auto],#t-dark:checked~.page label[for=t-dark],#t-light:checked~.page label[for=t-light]{background:var(--pt);color:var(--page);border-color:var(--pt)}
.grid{display:flex;flex-wrap:wrap;gap:22px 24px;align-items:flex-start}
figure{margin:0;width:calc(40ch + 18px)}
.cap-top{font-size:13px;margin-bottom:5px}.cap-top span{color:var(--pm);font-size:12px;margin-left:6px}
figcaption{font-size:12px;line-height:1.45;color:var(--pm);margin-top:7px}
figcaption p{margin:0 0 4px}
figcaption b{color:var(--pt)}
.term{font:13px/18px ui-monospace,"DejaVu Sans Mono","Cascadia Mono",Menlo,Consolas,monospace;width:calc(40ch + 18px);height:calc(var(--rows) * 18px + 14px);padding:7px 9px;background:var(--ground);color:var(--text);border:1px solid var(--pr);border-radius:6px;overflow:hidden;white-space:pre}
.r{height:18px;width:40ch;overflow:hidden}
.r i{font-style:normal;display:inline-block;width:1ch;text-align:center;overflow:hidden;vertical-align:top;height:18px}
.bd{font-weight:700}
.c-t{color:var(--text)}.c-m{color:var(--m)}.c-f{color:var(--f)}.c-a{color:var(--a)}.c-d{color:var(--d)}.c-s{color:var(--s)}.c-b{color:var(--b)}.c-o{color:var(--o)}.c-i{color:var(--i)}
.c-imp{color:var(--imp)}.c-rev{color:var(--rev)}.c-son{color:var(--son)}.c-ora{color:var(--ora)}.c-ask{color:#19150d}
.s-title{background:var(--title)}.s-sel{background:var(--sel)}.s-slab{background:var(--slab)}.s-fail{background:var(--fail)}.s-askT{background:var(--askbg)}.s-body{background:var(--body)}
table{border-collapse:collapse;font-size:13px;margin:8px 0 4px}
td,th{border:1px solid var(--pr);padding:4px 10px;text-align:left;vertical-align:top}
code{font:12px ui-monospace,"DejaVu Sans Mono",monospace;background:var(--body);padding:0 4px;border-radius:3px}
@media (max-width:640px){.page{padding:16px}figure{width:100%}.term{max-width:100%}}
`;

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Panel v8: Home and Project options</title><style>${css}</style></head><body>
<input class="sw" type="radio" name="theme" id="t-auto" checked><input class="sw" type="radio" name="theme" id="t-dark"><input class="sw" type="radio" name="theme" id="t-light">
<div class="page">
<header>
  <h1>Panel v8: three options for Home and Project</h1>
  <p class="lede">Every frame is a 40-column terminal grid, one glyph per cell, drawn with the default theme's inks (dark: <code>terminal</code>; light: <code>latte</code>, from <code>src/render/palette.ts</code>). One invented project; nothing from the real panel. Rows are checked to be exactly 40 cells when the page is built. Nothing here is built: pick one, then a later job builds it.</p>
  <nav><span>Theme:</span><label for="t-auto">system</label><label for="t-dark">dark</label><label for="t-light">light</label>
  <a href="#today">Today</a><a href="#inbox">1 Inbox</a><a href="#split">2 Split</a><a href="#timeline">3 Timeline</a></nav>
</header>
<section id="today">
  <h2>Today (reference, same data)</h2>
  <div class="thesis"><p>Reconstructed from the renderer's own grammar (<code>work-card.ts</code>, <code>project-view.ts</code>) on the same invented data, so the options compare like for like. Not a screenshot of the real panel.</p></div>
  <div class="grid">${today.map((s) => screen(s, `${W} × ${s.frame.h}`)).join('')}</div>
</section>
${options.map(section).join('')}
</div></body></html>`;
writeFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'options.html'), html);
console.log(`options.html ${(html.length / 1024).toFixed(0)} KB`);
