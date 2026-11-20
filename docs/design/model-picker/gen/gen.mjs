// Builds ../index.html from frames.mjs. No dependencies, no network; the only interaction is a CSS-only language switch.
// Usage: node docs/design/model-picker/gen/gen.mjs
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cw } from './lib.mjs';
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
function frameHtml({ rows, h, W }) {
  const body = rows.map((r) => {
    const n = r.segs.reduce((a, s) => a + [...s.t].reduce((m, ch) => m + cw(ch), 0), 0);
    if (n !== W) throw new Error(`row is ${n} cells, not ${W}: ${r.segs.map((s) => s.t).join('')}`);
    return `<div class="r${r.bg ? ' s-' + r.bg : ''}">${r.segs.map((s) => `<span class="${cls(s.k, r.bg === 'sel')}">${cellsHtml(s.t)}</span>`).join('')}</div>`;
  }).join('');
  return `<div class="term" style="--rows:${h};--cols:${W}">${body}</div>`;
}
const code = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');
// A note is an annotation beside a frame (mouse affordances and the like); `row` is the frame row it points at.
const notesHtml = (f) => `<div class="notes" style="height:${f.frame.h * 18 + 16}px">${f.notes.map((n) =>
  `<div class="note" style="top:${8 + n.row * 18}px">${code(n.text)}</div>`).join('')}</div>`;
function figure(lang, f) {
  const ann = f.notes.length > 0;
  const term = frameHtml(f.frame);
  return `<figure id="${lang}-${f.id}" class="${ann ? 'ann' : ''}" style="--cols:${f.frame.W}"><div class="cap-top"><b>${f.id}</b> ${esc(f.title)} <span class="tag">${f.layout}</span></div>${ann ? `<div class="annrow">${term}${notesHtml(f)}</div>` : term}<figcaption>${code(f.cap)}</figcaption></figure>`;
}

const SECTIONS = [
  [1, 'Entry: a model field on every place', 'CONTROL-TAB-03 opens its picker with `m` on a place of the Control role chain. The sample changes only how a person finds it: every place row ends in a visible `[model ▾]` field that is also a mouse target, and `m model` is the first hint in the footer. Setting a model behaves as it does today.'],
  [2, 'The picker at 40 columns', 'The CONTROL-TAB-03 rules stay: one list grouped by provider with counts, a typed case-insensitive filter over the whole `provider/model`, query and match count pinned, current `◉` apart from the cursor `›`, middle ellipsis, discovery only when Control opens or on refresh. New here: a pinned section above the list, groups that start folded, a two-to-four-row strip that gives the whole ID and the columns `pi --list-models` prints, a state on the row itself, and the mouse (grey notes beside a frame are annotations, not terminal cells).'],
  [3, 'The zoomed picker', 'Opening the picker zooms the panel pane (herdr pane zoom) and closing restores it, so the panel gets about 120 by 36 cells: the grouped list on the left with pi\'s columns and the HUD\'s facts, the cursor model\'s detail on the right. It is still one list with one cursor; the right pane is text, not a second list.'],
];
const sectionHtml = ([n, title, intro]) => {
  const ids = zh.frames.filter((f) => f.section === n);
  const grid = (lang, b) => `<div class="grid ${lang}">${ids.map((f) => figure(lang, b.frames.find((x) => x.id === f.id))).join('')}</div>`;
  return `<section id="s${n}"><h2><span>${n}</span> ${esc(title)}</h2><p class="intro">${code(intro)}</p>${n === 2 ? KEYS : ''}${grid('zh', zh)}${grid('en', en)}</section>`;
};

const KEYS = `<table class="keys"><tr><th>Input</th><th>Does</th></tr>
<tr><td>type</td><td>filters over the whole <code>provider/model</code>, case-insensitive; Backspace edits; the pinned section steps aside while a filter is typed</td></tr>
<tr><td>↑ ↓ PgUp PgDn Home End</td><td>move the cursor over model rows (headers are skipped)</td></tr>
<tr><td>Enter</td><td>sets the cursor row's model on this place; the picker closes and the pane is restored</td></tr>
<tr><td>click a row</td><td>selects it: the cursor and the strip or detail follow, nothing is written</td></tr>
<tr><td>click the selected row again</td><td>sets it, same as Enter</td></tr>
<tr><td>wheel</td><td>scrolls the list; the query row and the strip or detail stay in place</td></tr>
<tr><td>click a provider header</td><td>folds or unfolds that group</td></tr>
<tr><td>Ctrl+R</td><td>refreshes the model lists (one bounded discovery run, coalesced); letters are filter text here, so <code>r</code> is not used</td></tr>
<tr><td>Esc</td><td>closes without setting and restores the pane</td></tr></table>`;

const frameTable = zh.frames.map((f) => `<tr><td>${f.id}</td><td>${esc(f.title)}</td><td>${f.layout}</td></tr>`).join('');
const OPEN = [
  ['Zoom on open, or on a key.', 'Drawn: <code>m</code> zooms the panel\'s own pane at once (<code>herdr pane zoom --on</code>, the pane looked up at call time, nothing stored) and Esc or a set restores it, only if the picker did the zoom: a pane that was already zoomed stays zoomed. Below about 100 columns, outside herdr or when the zoom is refused, the 40-column picker (2a–2d) is used. The alternative is to open at 40 columns and zoom on a key; letters are filter text, so that key would have to be a non-printable one (F2, say).'],
  ['Which pinned sections.', 'Drawn: Current, This role (the pi models of the role\'s presets, tagged with the preset) and Recent. Current and This role need nothing new. Recent needs a small local record of what the picker set (for example <code>$HUD_HOME/display/recent-models.json</code>, written when a model is set, never on a tick); drop it if one more file is not worth it. Pinned rows also stay in their provider group so the counts stay true; the alternative takes them out of the group.'],
  ['Groups start folded.', 'Drawn: every group folded with its count (six rows for 88 models), typing opens the groups that match, a click folds or unfolds. No key folds, because headers are not on the cursor path (design.md §4). The alternative is open by default, which at 40 columns is a long scroll, or selectable headers so that a key can fold.'],
  ['Providers that are off.', 'Drawn: their models are not offered (spec: models of the providers that are on); one muted line names the off providers, and a current model whose provider is off stays pinned with <code>⊘</code> (frame 3e). The alternative is no line at all.'],
  ['The columns need a cache field.', 'Context, max-out, thinking and images come from the same <code>pi --list-models</code> call, but today the parser drops them and the cache (<code>display/model-lists.json</code>) keeps only <code>provider/model</code> strings (<code>src/roles/model-discovery.ts</code>). Showing them means the cache also keeps each model\'s four columns: one field added to the same file, <code>·</code> in the columns until the next discovery after an upgrade, no new command. If the owner would rather not touch the cache, the columns go and the strip keeps only the ID and the state.'],
  ['Price is not drawn.', '<code>pi --list-models</code> prints no price column. The only per-model rates the HUD sees (USD per million tokens, <code>src/harness/pi/exp-usage.ts</code>) come from inside a running pi, for the model it is using, to price EXP usage: observed for models in use, not for the 88 listed, and the picker\'s discovery cannot read them. The pi spend on the Usage fold is observed spend, not a price. So no local source covers a price column for the whole list, and nothing is guessed; if the owner wants one, name where it should come from (a bounded read of pi\'s own model definitions, say) as a separate decision.'],
  ['Ctrl+R and Esc.', 'Letters are filter text inside the picker, so refresh is <code>^R</code> there (outside it, <code>r</code> keeps its meaning). Esc always closes without setting. Say if Esc should first clear a typed filter.'],
  ['The strip at 40 columns.', 'Drawn: always shown, two to four rows (the whole ID, the columns, a state line). It costs those rows of a narrow panel; the alternative shows it only after the cursor has rested or been clicked.'],
  ['What the stop rule left out.', 'The design needed no second list. Not drawn, because the spec rules them out: a provider rail or column beside the list (a second list, and design.md drops provider-to-model drill-down), and a picker that edits a whole preset at once.'],
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
.lede,.intro{max-width:860px;color:#a6adc8}
.lede b{color:#cdd6f4;font-weight:600}
code{font:12px ui-monospace,"DejaVu Sans Mono",monospace;background:#181825;padding:0 5px;border-radius:3px;color:#cdd6f4}
a{color:#89b4fa}
nav{display:flex;flex-wrap:wrap;gap:6px 16px;align-items:center;margin:14px 0 4px}
nav label{cursor:pointer;border:1px solid #45475a;border-radius:14px;padding:2px 14px;font-size:13px;color:#a6adc8}
#l-zh:checked~.page label[for=l-zh],#l-en:checked~.page label[for=l-en]{background:#cdd6f4;color:#11111b;border-color:#cdd6f4}
#l-zh:checked~.page .en,#l-en:checked~.page .zh{display:none}
.grid{display:flex;flex-wrap:wrap;gap:24px 26px;align-items:flex-start;margin-top:14px}
figure{margin:0;width:calc(var(--cols) * 1ch + 20px);max-width:100%}
figure.ann{width:calc(var(--cols) * 1ch + 20px + 300px)}
.cap-top{font-size:13px;margin-bottom:6px;display:flex;align-items:baseline;gap:6px;flex-wrap:wrap}
.cap-top b{color:#89b4fa}
.tag{margin-left:auto;font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:#a6adc8;border:1px solid #45475a;border-radius:9px;padding:0 7px}
figcaption{font-size:12.5px;line-height:1.45;color:#a6adc8;margin-top:8px;max-width:calc(var(--cols) * 1ch + 20px)}
.annrow{display:flex;gap:0;align-items:flex-start}
.notes{position:relative;width:300px;flex:none}
.note{position:absolute;left:26px;right:0;font-size:12.5px;line-height:18px;color:#f9e2af}
.note::before{content:"";position:absolute;left:-24px;top:9px;width:22px;border-top:1px solid #6c6a4f}
.note::after{content:"";position:absolute;left:-26px;top:6px;width:6px;height:6px;border-radius:50%;background:#f9e2af}
.note code{color:#f9e2af;background:#2a2a3c}
.term{font:13px/18px ui-monospace,"DejaVu Sans Mono","Cascadia Mono",Menlo,Consolas,monospace;width:calc(var(--cols) * 1ch + 20px);height:calc(var(--rows) * 18px + 16px);padding:7px 10px;background:var(--ground);color:var(--text);border:1px solid #313244;border-radius:6px;overflow:hidden;white-space:pre;flex:none}
.r{height:18px;width:calc(var(--cols) * 1ch);overflow:hidden}
.r i{font-style:normal;display:inline-block;width:1ch;text-align:center;overflow:hidden;vertical-align:top;height:18px}
.r i.w{width:2ch}
.bd{font-weight:700}
.c-t{color:var(--text)}.c-m{color:var(--m)}.c-f{color:var(--f)}.c-a{color:var(--a)}.c-d{color:var(--d)}.c-s{color:var(--s)}.c-b{color:var(--b)}.c-o{color:var(--o)}.c-i{color:var(--i)}.c-n{color:var(--n)}
.s-title{background:var(--title)}.s-sel{background:var(--sel)}.s-body{background:var(--body)}
.legend{display:flex;flex-wrap:wrap;gap:6px 22px;margin:14px 0 0;font:13px ui-monospace,"DejaVu Sans Mono",monospace;color:#a6adc8}
.legend b{font-weight:400;color:#cdd6f4}
table{border-collapse:collapse;font-size:13px;margin:10px 0}
td,th{border:1px solid #313244;padding:3px 10px;text-align:left;vertical-align:top}
table.keys{max-width:860px}
ol.open{max-width:860px;padding-left:22px;color:#a6adc8}
ol.open li{margin:0 0 8px}
ol.open b{color:#cdd6f4;font-weight:600}
.scroll{overflow-x:auto}
@media (max-width:640px){.page{padding:16px}figure,figure.ann{width:100%}.annrow{flex-direction:column;gap:8px}.notes{width:100%;height:auto!important}.note{position:static;padding-left:14px;border-left:1px solid #6c6a4f;margin:0 0 4px}.note::before,.note::after{display:none}.term{max-width:100%;overflow-x:auto}}
`;

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Model picker design sample</title><style>${css}</style></head><body>
<input class="sw" type="radio" name="lang" id="l-zh" checked><input class="sw" type="radio" name="lang" id="l-en">
<div class="page">
<header>
  <h1>Model picker: one sample to settle</h1>
  <p class="lede"><b>${zh.frames.length} frames</b>, drawn cell by cell as the terminal paints them (CJK counts two cells; every row is checked to be exactly as wide as its frame when the page is built), in the owner’s setup (<b>Split</b> layout, <b>mocha</b> theme), in Chinese and again in English. The panel frames are 40 columns; the zoomed picker is 120 by 36. One invented project, <code>harbor-api</code>, and invented models; nothing here is real data and nothing is built. Baseline: CONTROL-TAB-03 (frames 6a–6c of <code>docs/design/control-tab/index.html</code>); this sample keeps its rules and everything stays inside the terminal panel, no web console. The generator is <code>gen/</code>, copied from the Control tab sample and made width-parameterized.</p>
  <nav><span>Language of the frames:</span><label for="l-zh">中文</label><label for="l-en">English</label>
  ${SECTIONS.map(([n, t]) => `<a href="#s${n}">${n} ${esc(t.split(':')[0])}</a>`).join('')}<a href="#frames">Frames</a><a href="#open">To settle</a></nav>
  <div class="legend"><span><b>◉</b> current model</span><span><b>›</b> cursor (banded row)</span><span><b>▾ ▸</b> group open / folded</span><span><b>[model ▾]</b> model field</span><span><b>✗ 42m</b> exhausted, resets in</span><span><b>⊘</b> provider off</span><span><b>?</b> provider unknown</span><span><b>✓ –</b> yes / no</span><span><b>▌</b> text cursor</span><span><b>^R</b> Ctrl+R</span></div>
</header>
${SECTIONS.map(sectionHtml).join('\n')}
<section id="frames"><h2><span>4</span> Frames</h2>
  <table><tr><th>Frame</th><th>Shows</th><th>Size</th></tr>${frameTable}</table></section>
<section id="open"><h2><span>?</span> To settle</h2>
  <p class="intro">The frames draw the best reading of each choice. These are the readings the owner may want to change.</p>
  <ol class="open">${OPEN.map(([a, b]) => `<li><b>${a}</b> ${b}</li>`).join('')}</ol></section>
</div></body></html>`;
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'index.html');
writeFileSync(out, html);
console.log(`index.html ${(html.length / 1024).toFixed(0)} KB, ${zh.frames.length} frames x 2 languages`);
