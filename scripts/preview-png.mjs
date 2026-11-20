#!/usr/bin/env node
/**
 * Renders the panel's real frames in colour from the synthetic Split fixture and saves them as one PNG per frame
 * (plus an overview sheet) through headless Chrome. For design previews the owner looks at (docs/delegation.md).
 *
 *   npm run build && npm run build:test && node scripts/preview-png.mjs <out-dir> [--lang zh|en] [--width 40] [--theme mocha]
 *
 * Synthetic data only; temporary HOME and Chrome profile; no network.
 */
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

process.env.TZ = 'UTC';
process.env.COLORTERM = 'truecolor';
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const out = resolve(argv.find((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--')) ?? 'tmp/preview-png');
const lang = opt('lang', 'zh'), width = Number(opt('width', '40')), themeName = opt('theme', 'mocha');
const chrome = process.env.CHROME ?? '/usr/bin/google-chrome';

const root = process.cwd();
const load = (p) => import(new URL(`../${p}`, import.meta.url));
const { splitFixture, split } = await load('tests/fixtures/split-layout.mjs');
const { NOW, TREE } = await load('tests/fixtures/project-page.mjs');
const { renderMonitor, initialMonitorState } = await load('dist/render/monitor.js');
const { setDisplayConfig } = await load('dist/render/hud-config.js');
const { setLanguage } = await load('dist/render/i18n.js');
const { visualLength } = await load('dist/render/colors.js');

// ---- frames -------------------------------------------------------------------------------------------------------
const home = fs.mkdtempSync(join(tmpdir(), 'preview-png-'));
const BRIEF = lang === 'zh'
  ? { brief: '台账历史、进行中的任务和工单详情现在都能在进度页直接看到。其余页面不变。', steps: ['打开项目页，进入进度。', '选中 DATA-ONE，确认摘要、步骤和台账原文都在。', '按 Enter 展开台账原文。'] }
  : { brief: 'Ledger history, live jobs and ticket detail now show on the Progress page. Nothing else changes.', steps: ['Open the Project tab, then Progress.', 'Select DATA-ONE: the brief, steps and ledger line are there.', 'Press Enter to unfold the ledger line.'] };
let frames;
try {
  const busy = await splitFixture(join(home, 'busy'));
  const idle = await splitFixture(join(home, 'idle'), { idle: true });
  const briefed = (d) => ({ ...d, ledger: d.ledger.map((r) => (r.id === 'DATA-ONE' ? { ...r, brief: BRIEF } : r)) });
  const page = (p, extra) => split({ mainTab: 'project', projectPage: p, projectFolded: new Set(['agents', 'healthy', 'files']), ...extra });
  const render = (f, height, state, snapshot = f.data, extras = {}) => {
    const display = setDisplayConfig({ theme: themeName, icons: 'unicode' }), previous = setLanguage(lang);
    try {
      return renderMonitor({ tree: TREE, workboard: f.board, project: snapshot, projectName: 'demo-project', state, width, height, nowMs: NOW, modelEnabled: true, ...extras }).lines;
    } finally {
      setDisplayConfig(display);
      setLanguage(previous);
    }
  };
  frames = [
    ['home-busy', 'Home, busy', render(busy, 40, split())],
    ['home-idle', 'Home, all done', render(idle, 40, split())],
    ['hub', 'Project hub', render(busy, 40, page(undefined), briefed(busy.control))],
    ['progress', 'Progress, a briefed slice selected', render(busy, 40, page('progress', { projectCursor: 'project:slice:DATA-ONE' }), briefed(busy.rich))],
    ['progress-unfolded', 'Progress, ledger line unfolded', render(busy, 40, page('progress', { projectCursor: 'project:slice:DATA-ONE', projectFolded: new Set(['agents', 'healthy', 'files', 'ledger:DATA-ONE']) }), briefed(busy.rich))],
    ['control', 'Control plane', render(busy, 40, page('control'), { ...busy.control, radar: undefined })],
    ['tickets', 'Tickets', render(busy, 40, page('tickets'))],
    ['help', 'Help', render(busy, 56, { ...initialMonitorState(), panelLayout: 'split', help: true })],
  ];
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}

// ---- ANSI to HTML ---------------------------------------------------------------------------------------------------
const BASE = ['#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5', '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff'];
const xterm = (n) => {
  if (n < 16) return BASE[n];
  if (n >= 232) { const v = 8 + (n - 232) * 10; return `rgb(${v},${v},${v})`; }
  const i = n - 16, c = (x) => (x ? 55 + x * 40 : 0);
  return `rgb(${c(Math.floor(i / 36))},${c(Math.floor(i / 6) % 6)},${c(i % 6)})`;
};
const BG = '#1e1e2e', FG = '#cdd6f4';
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function lineHtml(line) {
  let st = {}, html = '', cells = 0;
  const parts = line.split(/(\x1b\[[0-9;]*m)/);
  for (const part of parts) {
    const m = /^\x1b\[([0-9;]*)m$/.exec(part);
    if (m) {
      const codes = m[1] === '' ? [0] : m[1].split(';').map(Number);
      for (let i = 0; i < codes.length; i++) {
        const c = codes[i];
        if (c === 0) st = {};
        else if (c === 1) st.bold = true;
        else if (c === 2) st.dim = true;
        else if (c === 3) st.italic = true;
        else if (c === 4) st.under = true;
        else if (c === 7) st.inv = true;
        else if (c === 22) st.bold = st.dim = false;
        else if (c === 23) st.italic = false;
        else if (c === 24) st.under = false;
        else if (c === 27) st.inv = false;
        else if (c === 39) delete st.fg;
        else if (c === 49) delete st.bg;
        else if (c >= 30 && c <= 37) st.fg = BASE[c - 30];
        else if (c >= 90 && c <= 97) st.fg = BASE[c - 82];
        else if (c >= 40 && c <= 47) st.bg = BASE[c - 40];
        else if (c >= 100 && c <= 107) st.bg = BASE[c - 92];
        else if ((c === 38 || c === 48) && codes[i + 1] === 5) { st[c === 38 ? 'fg' : 'bg'] = xterm(codes[i + 2]); i += 2; }
        else if ((c === 38 || c === 48) && codes[i + 1] === 2) { st[c === 38 ? 'fg' : 'bg'] = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`; i += 4; }
      }
      continue;
    }
    if (!part) continue;
    let fg = st.fg ?? FG, bg = st.bg;
    if (st.inv) [fg, bg] = [bg ?? BG, fg];
    const css = [`color:${fg}`, bg ? `background:${bg}` : '', st.bold ? 'font-weight:700' : '', st.dim ? 'opacity:.6' : '', st.italic ? 'font-style:italic' : '', st.under ? 'text-decoration:underline' : ''].filter(Boolean).join(';');
    let text = '';
    for (const ch of part) {
      const w = visualLength(ch);
      cells += w;
      text += w === 2 ? `<i>${esc(ch)}</i>` : ch.codePointAt(0) > 0x7e ? `<b>${esc(ch)}</b>` : esc(ch);
    }
    html += `<span style="${css}">${text}</span>`;
  }
  return html + ' '.repeat(Math.max(0, frameWidth - cells));
}
let frameWidth = width;
const frameHtml = (lines, w) => {
  frameWidth = w;
  return `<pre style="width:${w}ch">${lines.map(lineHtml).join('\n')}</pre>`;
};
const STYLE = `body{margin:0;padding:20px;background:#11111b;color:${FG};font:14px/1.35 'Noto Sans Mono','DejaVu Sans Mono',monospace}
pre{margin:0;padding:8px 10px;background:${BG};font:inherit;white-space:pre;border-radius:6px}
pre i{font-style:normal;display:inline-block;width:2ch;text-align:center;font-family:'Noto Sans Mono CJK SC','Droid Sans Fallback',sans-serif}
pre b{font-weight:inherit;display:inline-block;width:1ch;text-align:center;overflow:visible;white-space:pre}
h3{margin:0 0 8px;font:600 13px system-ui,sans-serif;color:#a6adc8}
.sheet{display:flex;flex-wrap:wrap;gap:24px;align-items:flex-start}`;
const page = (body) => `<!doctype html><meta charset="utf-8"><style>${STYLE}</style><body>${body}</body>`;

// ---- screenshots -----------------------------------------------------------------------------------------------------
fs.mkdirSync(out, { recursive: true });
const profile = fs.mkdtempSync(join(tmpdir(), 'preview-chrome-'));
const shoot = (html, file, w, h) => {
  const src = join(profile, 'page.html');
  fs.writeFileSync(src, html);
  execFileSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--password-store=basic', `--user-data-dir=${profile}`, '--force-device-scale-factor=2', `--window-size=${w},${h}`, `--screenshot=${file}`, `file://${src}`], { stdio: 'ignore' });
};
const px = (cols, rows) => [Math.ceil(cols * 8.6 + 70), Math.ceil(rows * 19 + 90)];
try {
  const blocks = [];
  for (const [name, title, lines] of frames) {
    const w = Math.max(...lines.map((l) => visualLength(l)), width);
    const block = `<div><h3>${esc(title)}</h3>${frameHtml(lines, w)}</div>`;
    blocks.push(block);
    shoot(page(block), join(out, `${name}-${lang}.png`), ...px(w, lines.length));
  }
  shoot(page(`<div class="sheet">${blocks.join('')}</div>`), join(out, `overview-${lang}.png`), 1800, 1850);
} finally {
  fs.rmSync(profile, { recursive: true, force: true });
}
console.log(`${frames.length} frames + overview → ${out}`);
