// Builds ../index.html from frames.mjs. No dependencies, no network; the only interaction is a CSS-only language switch.
// Usage: node docs/design/control-tab/gen/gen.mjs
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { W, cw } from './lib.mjs';
import { build } from './frames.mjs';

const zh = build('zh'), en = build('en');
if (zh.frames.length !== en.frames.length) throw new Error('the two languages draw different frame sets');

// The Catppuccin Mocha board inks (`mocha` in BOARD_SPECS, src/render/palette.ts) on the Mocha base.
const MOCHA = {
  ground: '#1e1e2e', text: '#cdd6f4', m: '#a6adc8', f: '#585b70', a: '#f9e2af', d: '#f38ba8', s: '#a6e3a1', b: '#89b4fa',
  o: '#fab387', i: '#cba6f7', n: '#89dceb', title: '#313244', body: '#181825', sel: '#45475a',
};
const vars = Object.entries(MOCHA).map(([k, v]) => `--${k}:${v}`).join(';');

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const cls = (k, sel) => {
  const [ink, surface] = k.replace('*', '').split('/');
  return `c-${ink}${surface && !sel ? ' s-' + surface : ''}${k.includes('*') ? ' bd' : ''}`;
};
// Printable ASCII flows as text (the monospace face keeps it on the grid); every other glyph gets a box of its own width,
// 1 cell or 2 (CJK), so the grid holds whatever font the browser falls back to.
function cellsHtml(text) {
  let out = '', run = '';
  for (const ch of text) {
    if (ch >= ' ' && ch <= '~') run += ch;
    else { if (run) out += esc(run), run = ''; out += `<i${cw(ch) === 2 ? ' class="w"' : ''}>${esc(ch)}</i>`; }
  }
  return out + esc(run);
}
function frameHtml({ rows, h }) {
  const body = rows.map((r) => {
    const n = r.segs.reduce((a, s) => a + [...s.t].reduce((m, ch) => m + cw(ch), 0), 0);
    if (n !== W) throw new Error(`row is ${n} cells: ${r.segs.map((s) => s.t).join('')}`);
    return `<div class="r${r.bg ? ' s-' + r.bg : ''}">${r.segs.map((s) => `<span class="${cls(s.k, r.bg === 'sel')}">${cellsHtml(s.t)}</span>`).join('')}</div>`;
  }).join('');
  return `<div class="term" style="--rows:${h}">${body}</div>`;
}
const code = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');
const figure = (lang, f, cap) => `<figure id="${lang}-${f.id}"><div class="cap-top"><b>${f.id}</b> ${esc(f.title)} <span class="tag ${f.layout === 'Classic' ? 'classic' : ''}">${f.layout}</span></div>${frameHtml(f.frame)}<figcaption>${code(cap)}</figcaption></figure>`;

const SECTIONS = [
  [1, 'Tab bar and Roles landing', 'Control is a tab of its own, between Project and EXP (EXP is only a label here). It names the project it follows, and opens on what needs you.'],
  [2, 'Roles: Healthy, one row per role', 'Healthy unfolds to one row per role, `role [preset] → where the next job runs`. Split shows the whole chain underneath; Classic expands it under the role.'],
  [3, 'The scenario: pi:xai off, then back', 'The owner turns one subscription off in Harnesses. The role file is untouched: imp [daily] now reads → agy, and the off place stays in its chain with its reason. Restoring puts it first again.'],
  [4, 'Presets: c, p, and a project role', 'One key on the role row switches presets. `p` lists every name plus Custom. A project role shows its lock instead of the edit keys.'],
  [5, 'A new preset from empty', '`I` asks for a name, opens a draft marked Not saved, and adds places one at a time in a single sheet. Nothing is written until `s`.'],
  [6, 'The pi model picker', 'Inside the sheet: one list of every model of the providers that are on, grouped by provider, filtered by typing. A pi target is simply `pi`; its model field spans providers.'],
  [7, 'Harnesses', 'What this machine may use, whatever the project. Off items fold into Off (N); `i` adds one back.'],
];
const sectionHtml = ([n, title, intro]) => {
  const ids = zh.frames.filter((f) => f.section === n);
  const grid = (lang, b) => `<div class="grid ${lang}">${ids.map((f) => figure(lang, b.frames.find((x) => x.id === f.id), f.cap)).join('')}</div>`;
  return `<section id="s${n}"><h2><span>${n}</span> ${esc(title)}</h2><p class="intro">${code(intro)}</p>${grid('zh', zh)}${grid('en', en)}</section>`;
};

const layouts = zh.frames.map((f) => `<tr><td>${f.id}</td><td>${esc(f.title)}</td><td>${f.layout}</td></tr>`).join('');
const OPEN = [
  ['Role groups.', 'At 40 columns the three group headers (Roles, Project roles, Browser tasks) are gone: a project role carries a <code>project</code> tag at the right of its row (frames 2a, 4d). Groups would cost three rows and, in Chinese, put 角色 under 角色.'],
  ['已耗尽 and 已停用.', 'Chinese keeps the shipped word 已耗尽 for exhausted; design.md’s example says 配额用尽. 已耗尽 and 已停用 differ by one character, so the marks (✗ and ⊘) and the colour carry the difference too. Pick 配额用尽 if the one-character gap worries you.'],
  ['A new mark.', 'Off is ⊘ (text-icon mode: <code>/</code>). The switch mark in Harnesses is ◉ for on, which is the Roles mark for “next job runs here”; they never share a screen, but say if that is too close.'],
  ['Tab row in English.', 'With the Project badge (<code>?2</code>) the four tabs fill the row, so <code>models on</code> goes; the tabs always win. Chinese keeps it.'],
  ['Footer at 40 columns.', 'Hints are whole and cut from the right, so <code>? help</code> and <code>h harnesses</code> are often not shown at this width; Help lists them. The order of the hints is the priority.'],
  ['Keys in the chain, the sheet and the picker.', 'As in today’s Split, the list shrinks to three rows while the keys are in the preview, so the sheet and the picker are drawn there. Classic would open the same sheet under the role (not drawn).'],
  ['Harnesses carries the project name row.', 'The Harnesses view is machine-wide but sits under the same name row as Roles; the line under the view row says “This machine · all projects”. Hide the name row there if it misleads.'],
  ['Needs attention for “no next place”.', 'A role whose every place is off or missing (flow) reads <code>−</code> and <code>→ none</code> and is an attention row; an off fallback behind a working place is not.'],
  ['Done in the sheet.', 'Done stays dim until Target and Model are filled; Thinking may stay Default. Choosing a target that would drop advanced launch options is refused with “o opens the file” (design.md §3, not drawn).'],
  ['Hidden presets.', 'imp has a fourth shipped preset, hydrogen, hidden by the owner’s <code>hidden_presets</code>; the lists show only visible names.'],
];

const css = `
*{box-sizing:border-box}
html{background:#11111b;color-scheme:dark}
body{margin:0;background:#11111b;color:#cdd6f4;font:14px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
.sw{position:absolute;opacity:0;pointer-events:none}
.page{${vars};max-width:1180px;margin:0 auto;padding:28px 24px 72px}
h1{font-size:22px;margin:0 0 8px}
h2{font-size:18px;margin:46px 0 6px;padding-top:18px;border-top:1px solid #313244}
h2 span{display:inline-block;min-width:1.6em;color:#89b4fa}
p{margin:0 0 8px}
.lede,.intro{max-width:800px;color:#a6adc8}
.lede b{color:#cdd6f4;font-weight:600}
code{font:12px ui-monospace,"DejaVu Sans Mono",monospace;background:#181825;padding:0 5px;border-radius:3px;color:#cdd6f4}
a{color:#89b4fa}
nav{display:flex;flex-wrap:wrap;gap:6px 16px;align-items:center;margin:14px 0 4px}
nav label{cursor:pointer;border:1px solid #45475a;border-radius:14px;padding:2px 14px;font-size:13px;color:#a6adc8}
#l-zh:checked~.page label[for=l-zh],#l-en:checked~.page label[for=l-en]{background:#cdd6f4;color:#11111b;border-color:#cdd6f4}
#l-zh:checked~.page .en,#l-en:checked~.page .zh{display:none}
.grid{display:flex;flex-wrap:wrap;gap:24px 26px;align-items:flex-start;margin-top:14px}
figure{margin:0;width:calc(40ch + 20px)}
.cap-top{font-size:13px;margin-bottom:6px;display:flex;align-items:baseline;gap:6px;flex-wrap:wrap}
.cap-top b{color:#89b4fa}
.tag{margin-left:auto;font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:#a6adc8;border:1px solid #45475a;border-radius:9px;padding:0 7px}
.tag.classic{color:#f9e2af;border-color:#6c6a4f}
figcaption{font-size:12.5px;line-height:1.45;color:#a6adc8;margin-top:8px}
.term{font:13px/18px ui-monospace,"DejaVu Sans Mono","Cascadia Mono",Menlo,Consolas,monospace;width:calc(40ch + 20px);height:calc(var(--rows) * 18px + 14px);padding:7px 10px;background:var(--ground);color:var(--text);border:1px solid #313244;border-radius:6px;overflow:hidden;white-space:pre}
.r{height:18px;width:40ch;overflow:hidden}
.r i{font-style:normal;display:inline-block;width:1ch;text-align:center;overflow:hidden;vertical-align:top;height:18px}
.r i.w{width:2ch}
.bd{font-weight:700}
.c-t{color:var(--text)}.c-m{color:var(--m)}.c-f{color:var(--f)}.c-a{color:var(--a)}.c-d{color:var(--d)}.c-s{color:var(--s)}.c-b{color:var(--b)}.c-o{color:var(--o)}.c-i{color:var(--i)}.c-n{color:var(--n)}
.s-title{background:var(--title)}.s-sel{background:var(--sel)}.s-body{background:var(--body)}
.legend{display:flex;flex-wrap:wrap;gap:6px 22px;margin:14px 0 0;font:13px ui-monospace,"DejaVu Sans Mono",monospace;color:#a6adc8}
.legend b{font-weight:400;color:#cdd6f4}
table{border-collapse:collapse;font-size:13px;margin:10px 0}
td,th{border:1px solid #313244;padding:3px 10px;text-align:left;vertical-align:top}
ol.open{max-width:860px;padding-left:22px;color:#a6adc8}
ol.open li{margin:0 0 8px}
ol.open b{color:#cdd6f4;font-weight:600}
@media (max-width:640px){.page{padding:16px}figure{width:100%}.term{max-width:100%}}
`;

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Control tab design sample</title><style>${css}</style></head><body>
<input class="sw" type="radio" name="lang" id="l-zh" checked><input class="sw" type="radio" name="lang" id="l-en">
<div class="page">
<header>
  <h1>Control tab: one sample to settle</h1>
  <p class="lede"><b>${zh.frames.length} frames</b>, each a 40-column terminal grid (CJK counts two cells, every row is checked to be exactly 40 when the page is built), in the owner’s setup (<b>Split</b> layout, <b>mocha</b> theme) and again in English. One invented project, <code>harbor-api</code>; nothing here is real data and nothing is built. The screen spec is <code>docs/design/control-tab/design.md</code> §3–§4. Frames 2b and 2c are Classic; every other frame is Split. Each frame is cut to the rows it needs; the real panel pads the rest with blank rows.</p>
  <nav><span>Language of the frames:</span><label for="l-zh">中文</label><label for="l-en">English</label>
  ${SECTIONS.map(([n, t]) => `<a href="#s${n}">${n} ${esc(t.split(':')[0])}</a>`).join('')}<a href="#layouts">Layouts</a><a href="#open">To settle</a></nav>
  <div class="legend"><span><b>◉</b> next job runs here</span><span><b>○</b> standby</span><span><b>✗</b> quota mark</span><span><b>⊘</b> off</span><span><b>−</b> not installed / no place</span><span><b>!</b> invalid file</span><span><b>▸</b> folded</span><span><b>▌</b> text cursor</span><span>banded row = cursor</span></div>
</header>
${SECTIONS.map(sectionHtml).join('\n')}
<section id="layouts"><h2><span>8</span> Layouts</h2>
  <p class="intro">Split (a list over a preview) is drawn for roles, the scenario, presets, sheets and Harnesses; Classic only for the Roles landing and its expansion (2b, 2c).</p>
  <table><tr><th>Frame</th><th>Shows</th><th>Layout</th></tr>${layouts}</table></section>
<section id="open"><h2><span>?</span> To settle</h2>
  <p class="intro">Where design.md left a screen open, the frames draw the best reading. These are the readings the owner may want to change.</p>
  <ol class="open">${OPEN.map(([a, b]) => `<li><b>${a}</b> ${b}</li>`).join('')}</ol></section>
</div></body></html>`;
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'index.html');
writeFileSync(out, html);
console.log(`index.html ${(html.length / 1024).toFixed(0)} KB, ${zh.frames.length} frames x 2 languages`);
