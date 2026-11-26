/**
 * The review board: one self-contained HTML page of a project's progress (spec §2.2), written on demand by `hud board`
 * and the panel's `w`. Pure: it takes collected facts and returns text. No script, font, image, link or fetch: the
 * Content-Security-Policy allows inline style and nothing else, and every dynamic string is escaped once, here.
 */
import { SETTLED_JOB_STATES, SLICE_STATES, type LedgerSlice, type ProjectSnapshot, type ProjectTicket, type SliceState, type TicketFeature } from '../collectors/project-board.js';
import { acceptanceTasks, type AcceptanceTask } from '../collectors/acceptance-tasks.js';
import { targetKey } from '../collectors/ticket-evidence.js';
import type { DiffStatSummary } from '../collectors/diff-stat.js';
import type { OwnerWorker, WorkboardSnapshot } from '../collectors/workboard-types.js';
import { age } from './monitor-labels.js';
import { language, setLanguage, t, type Language } from './i18n.js';

export interface BoardInput {
  projectName: string;
  root: string;
  project: ProjectSnapshot;
  workboard?: WorkboardSnapshot;
  reviewText?: string;
  generatedAt: number;
  lang?: Language;
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Control and bidi-override characters are dropped, the five HTML metacharacters escaped. */
export const escapeHtml = (value: unknown): string =>
  String(value ?? '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '').replace(/[&<>"']/g, (c) => ESC[c]);
const e = escapeHtml;
const count = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0);
const pct = (x: number) => `${Math.max(0, Math.min(100, x)).toFixed(1)}%`;

// The panel's own palettes: `terminal` (dark) and `latte` (light), from docs/design/panel-v8.
const LIGHT = { bg: '#eff1f5', card: '#f8f9fc', rule: '#ccd0da', text: '#3a3d55', mute: '#555870', working: '#1648c0', blocked: '#b30d30',
  trying: '#824800', accepted: '#26661a', todo: '#9ca0b0', ask: '#e9a83a', ident: '#6f27cf' };
const DARK = { bg: '#0e131b', card: '#141b26', rule: '#2a3342', text: '#d5dbe6', mute: '#9aa5b8', working: '#6fa8ff', blocked: '#f4727e',
  trying: '#efc15a', accepted: '#8fd073', todo: '#3b4556', ask: '#ffc13a', ident: '#b4a6df' };
const vars = (p: Record<string, string>) => Object.entries(p).map(([k, v]) => `--${k}:${v}`).join(';');
const CSS = `*{box-sizing:border-box}body{margin:0;background:#eff1f5}
.page{${vars(LIGHT)};color-scheme:light;background:var(--bg);color:var(--text);min-height:100vh;font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
@media (prefers-color-scheme:dark){#t-auto:checked~.page{${vars(DARK)};color-scheme:dark}}
#t-dark:checked~.page{${vars(DARK)};color-scheme:dark}
.sw{position:absolute;opacity:0;pointer-events:none}
.wrap{max-width:1200px;margin:0 auto;padding-block:clamp(20px,4vw,44px);padding-inline:clamp(16px,4vw,40px)}
.top{display:flex;flex-wrap:wrap;gap:12px;justify-content:space-between;align-items:center}
.eyebrow,h2{font:600 12px/1.2 system-ui,sans-serif;letter-spacing:.14em;text-transform:uppercase;color:var(--mute)}
.theme{display:flex;gap:6px;align-items:center;font-size:12px;color:var(--mute)}
.theme label{cursor:pointer;border:1px solid var(--rule);border-radius:99px;padding:2px 12px}
#t-auto:checked~.page label[for=t-auto],#t-dark:checked~.page label[for=t-dark],#t-light:checked~.page label[for=t-light]{background:var(--text);color:var(--bg);border-color:var(--text)}
#t-auto:focus-visible~.page label[for=t-auto],#t-dark:focus-visible~.page label[for=t-dark],#t-light:focus-visible~.page label[for=t-light]{outline:2px solid var(--working);outline-offset:2px}
h1{font:600 clamp(28px,5vw,42px)/1.1 Georgia,"Iowan Old Style","Palatino Linotype",serif;letter-spacing:-.01em;margin:14px 0 4px;overflow-wrap:anywhere}
h2{display:flex;align-items:center;gap:12px;margin:44px 0 16px}h2::after{content:"";flex:1;height:1px;background:var(--rule)}
h2 .n{color:var(--text);border:1px solid var(--rule);border-radius:99px;padding:1px 9px;letter-spacing:0}
.root,.mono,code{font:12.5px/1.5 ui-monospace,"DejaVu Sans Mono","Cascadia Mono",Menlo,Consolas,monospace}
.root{color:var(--mute);margin:0 0 14px;overflow-wrap:anywhere}code{color:var(--ident)}
.badges{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 16px}
.chip{display:inline-block;max-width:100%;border:1px solid currentColor;border-radius:99px;padding:0 .7em;font:600 12px/1.8 system-ui,sans-serif;letter-spacing:.02em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:middle}
a.chip{text-decoration:none}.chip.plain,.chip.todo,.chip.ready,.chip.dropped,.plain{color:var(--mute)}.chip.working{color:var(--working)}.chip.blocked{color:var(--blocked)}.chip.try,.chip.dirty{color:var(--trying)}.chip.accepted,.chip.ok,.chip.done{color:var(--accepted)}
.lede{max-width:70ch;color:var(--mute);margin:0 0 20px}
.legend{display:flex;flex-wrap:wrap;gap:6px 18px;margin:10px 0 0;padding:0;list-style:none;font-size:13px;color:var(--mute)}
.legend i{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px}.legend b{color:var(--text)}
.grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr))}.grid.s{grid-template-columns:repeat(auto-fill,minmax(min(100%,300px),1fr))}
.card{background:var(--card);border:1px solid var(--rule);border-left:4px solid var(--accent,var(--rule));border-radius:8px;padding:14px 16px;min-width:0}
.card.try{--accent:var(--trying)}.card.working{--accent:var(--working)}.card.blocked{--accent:var(--blocked)}.card.ask{--accent:var(--ask)}
.card>header{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:baseline;margin-bottom:8px}.card .id{font-weight:700;overflow-wrap:anywhere}.card .meta{color:var(--mute);font-size:13px;margin-left:auto}
.card p{margin:0 0 8px;overflow-wrap:anywhere}.card .pre{white-space:pre-line}.card ol,.card ul{margin:0 0 8px;padding-left:1.4em}
.card h3{font:600 11px/1.2 system-ui,sans-serif;letter-spacing:.12em;text-transform:uppercase;color:var(--mute);margin:12px 0 6px}
.card details{margin:8px 0;color:var(--mute);font-size:13px}.card summary{cursor:pointer}
.diff ul{list-style:none;padding:0}.diff li{display:grid;grid-template-columns:minmax(0,1fr) auto 84px;gap:10px;align-items:center;font-size:13px;padding:2px 0}
.diff .p{overflow-wrap:anywhere}.diff .nums{white-space:nowrap}.add{color:var(--accepted)}.del{color:var(--blocked)}
.dbar{display:flex;height:6px;background:var(--rule);border-radius:3px;overflow:hidden}.dbar i{display:block}.dbar .a{background:var(--accepted)}.dbar .d{background:var(--blocked)}
.feat{margin:10px 0 0;padding-top:10px;border-top:1px dashed var(--rule)}.feat:first-child{margin-top:0;padding-top:0;border-top:0}.fh{display:flex;flex-wrap:wrap;gap:6px 12px;align-items:center;font-size:13px}
.meter{flex:1;min-width:80px;max-width:240px;height:6px;border-radius:3px;background:var(--rule);overflow:hidden}.meter i{display:block;height:100%;background:var(--accepted)}
.t{font-size:13px;margin:4px 0}.t summary{cursor:pointer;color:var(--text)}.t .num{font-family:ui-monospace,monospace;color:var(--mute);margin-right:6px}
.check{list-style:none;padding:0!important;margin:6px 0 4px 18px!important}.check li.d{color:var(--mute);text-decoration:line-through}.check li::before{content:"\\2610  "}.check li.d::before{content:"\\2611  "}
.review{background:var(--card);border:1px solid var(--rule);border-radius:8px;padding:16px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:70vh;overflow:auto;font:13px/1.6 ui-monospace,"DejaVu Sans Mono",monospace}.review b{color:var(--text);font-family:system-ui,sans-serif}
footer{margin-top:48px;color:var(--mute);font-size:12px}
@media (max-width:520px){.diff li{grid-template-columns:minmax(0,1fr) auto}.dbar{display:none}.card .meta{margin-left:0}}`;

const STATES: [SliceState, string][] = [['working', 'working'], ['blocked', 'blocked'], ['try', 'to try'], ['accepted', 'accepted'], ['todo', 'todo']];
const ago = (at: number | null | undefined, now: number) => (at ? t('{age} ago', { age: age(new Date(at), now) }) : '');
const chip = (cls: string, text: string) => `<span class="chip ${cls}">${e(text)}</span>`;
const section = (id: string, title: string, n: number | undefined, body: string) =>
  `<section id="${id}"><h2>${e(title)}${n === undefined ? '' : ` <span class="n">${count(n)}</span>`}</h2>${body}</section>`;

function diffBlock(diff: DiffStatSummary | undefined): string {
  if (!diff?.files.length) return '';
  const most = Math.max(1, ...diff.files.map((f) => (f.added ?? 0) + (f.deleted ?? 0)));
  const rows = diff.files.map((f) => {
    const a = f.added ?? 0, d = f.deleted ?? 0, total = Math.max(1, a + d);
    const right = f.added === null || f.deleted === null
      ? `<span class="nums plain">${e(t('bin'))}</span><span></span>`
      : `<span class="nums"><b class="add">+${count(a)}</b> <b class="del">-${count(d)}</b></span><span class="dbar"><i class="a" style="width:${pct(100 * (a + d) / most * a / total)}"></i><i class="d" style="width:${pct(100 * (a + d) / most * d / total)}"></i></span>`;
    return `<li><span class="p mono">${e(f.path)}</span>${right}</li>`;
  }).join('');
  const more = diff.totalFiles - diff.files.length;
  return `<div class="diff"><h3>+${count(diff.totalAdded)} -${count(diff.totalDeleted)} · ${e(t('{n} files', { n: diff.totalFiles }))}</h3><ul>${rows}${more > 0 ? `<li class="plain"><span>${e(t('+{n} more files', { n: more }))}</span></li>` : ''}</ul></div>`;
}

function ticketRow(ticket: ProjectTicket): string {
  const head = `<span class="num">${e(ticket.number)}</span>${e(ticket.title)} ${chip(ticket.state, t(ticket.state === 'try' ? 'to try' : ticket.state === 'queued' ? 'Queued' : ticket.state))}${ticket.total ? ` <span class="plain">${ticket.checked}/${ticket.total}</span>` : ''}`;
  const blockers = ticket.blockers.length ? `<p class="plain">${e(t('blocked by {ids}', { ids: ticket.blockers.join(', ') }))}</p>` : '';
  if (!ticket.items.length && !blockers) return `<div class="t">${head}</div>`;
  const items = ticket.items.slice(0, 12).map((i) => `<li class="${i.done ? 'd' : ''}">${e(i.text)}</li>`).join('');
  return `<details class="t"><summary>${head}</summary>${blockers}<ul class="check">${items}</ul></details>`;
}

/** A feature's meter and the tickets worth reading: the ones a slice names, else the unfinished ones (or all, when none is). */
function feature(f: TicketFeature, only: ReadonlySet<number> | undefined, limit: number): string {
  const live = f.tickets.filter((x) => x.state !== 'dropped'), done = live.filter((x) => x.state === 'done').length;
  const open = f.tickets.filter((x) => x.state !== 'done' && x.state !== 'dropped');
  const shown = (only?.size ? f.tickets.filter((x) => only.has(Number(x.number))) : open.length ? open : only ? f.tickets : []).slice(0, limit);
  return `<div class="feat"><div class="fh"><b>${e(f.slug)}</b><span class="plain">${done}/${live.length}</span><span class="meter"><i style="width:${pct(live.length ? 100 * done / live.length : 0)}"></i></span></div>${shown.map(ticketRow).join('')}</div>`;
}

function tryCard(slice: LedgerSlice, project: ProjectSnapshot, now: number): string {
  const mentions = new Map<string, Set<number>>();
  const canonical = /^\.hud\/tickets\/([a-z0-9-]+)\.json$/.exec(slice.ticketPath ?? '');
  if (canonical) mentions.set(canonical[1], new Set([Number(targetKey(slice.id).split('/')[1])]));
  const sources = slice.ticketPath ? `${slice.text} ${slice.ticketPath}` : slice.text;
  for (const m of sources.matchAll(/\.scratch\/([\w.-]+)(?:\/issues\/(\d+)-)?/g)) {
    const set = mentions.get(m[1]) ?? new Set<number>();
    if (m[2]) set.add(Number(m[2]));
    mentions.set(m[1], set);
  }
  const tickets = [...mentions].flatMap(([slug, only]) => {
    const f = project.tickets.find((x) => x.slug === slug);
    return f ? [feature(f, only, 8)] : [];
  }).join('');
  const text = `<p>${e(slice.text)}</p>`;
  return `<article class="card try"><header><span class="id">${e(slice.id)}</span>${chip('try', slice.milestone)}<span class="meta">${slice.commit ? `<code>${e(slice.commit)}</code> · ` : ''}${e(ago(slice.at, now))}</span></header>${text}${diffBlock(slice.diff)}${tickets ? `<h3>${e(t('Tickets'))}</h3>${tickets}` : ''}</article>`;
}

function taskCard(task: AcceptanceTask, project: ProjectSnapshot, now: number): string {
  const name = task.key.startsWith('slice:') ? `— ${task.slices[0].id}` : task.milestone, n = task.slices.length;
  const summary = `<span class="id">${e(name)}</span> ${chip('try', t(n === 1 ? '{n} slice' : '{n} slices', { n }))} <span class="meta">${e(ago(task.oldest, now))}</span>`;
  return `<article class="card try"><details><summary>${summary}</summary>${task.slices.map((r) => tryCard(r, project, now)).join('')}</details></article>`;
}

const live = (w: OwnerWorker) => w.settledAt === null && !SETTLED_JOB_STATES.has(w.state) && w.state !== 'completed';

export function renderHtmlBoard(input: BoardInput): string {
  const previous = setLanguage(input.lang ?? language());
  try { return page(input); } finally { setLanguage(previous); }
}

function page({ projectName, root, project, workboard, reviewText, generatedAt: now }: BoardInput): string {
  const lang = language(), git = project.git;
  const tries = project.ledger.filter((r) => r.state === 'try').reverse().sort((a, b) => (b.at ?? -1) - (a.at ?? -1));
  const tasks = acceptanceTasks(tries), pending = tasks.length;
  const displayCount = (s: SliceState) => s === 'try' ? pending : project.counts[s];
  const total = SLICE_STATES.filter((s) => s !== 'dropped').reduce((n, s) => n + project.counts[s], 0);
  const header = `<header><div class="top"><span class="eyebrow">${e(t('Review board'))}</span><div class="theme"><span>${e(t('Theme'))}</span><label for="t-auto">${e(t('Auto'))}</label><label for="t-dark">${e(t('Dark'))}</label><label for="t-light">${e(t('Light'))}</label></div></div>
<h1>${e(projectName)}</h1><p class="root">${e(root)}</p>
<div class="badges">${[
    git?.branch ? chip('plain', `${t('branch')} ${git.branch}`) : '',
    git && git.changed > 0 ? chip('dirty', t('{n} changed', { n: git.changed })) : git ? chip('ok', t('clean')) : '',
    git?.ahead ? chip('plain', `${git.ahead} ${t('ahead')}`) : '', git?.behind ? chip('plain', `${git.behind} ${t('behind')}`) : '',
    project.ladder.current ? chip('plain', `${t('Milestone')} ${project.ladder.current}`) : '',
    chip('plain', `${t('Generated')} ${new Date(now).toISOString().slice(0, 16).replace('T', ' ')} UTC`),
  ].join('')}</div>
${project.summary ? `<p class="lede">${e(project.summary)}</p>` : ''}
<ul class="legend">${STATES.map(([s, l]) => `<li><i style="background:var(--${s === 'try' ? 'trying' : s})"></i><b>${count(displayCount(s))}</b> ${e(t(l))}</li>`).join('')}<li>${count(total)} ${e(t('slices'))}</li></ul></header>`;

  const activeIds = new Set(project.active.map((job) => job.jobId));
  const workers = (workboard?.workers ?? []).filter((w) => live(w) && activeIds.has(w.evidence[0]?.sourceId));
  const needs = project.waiting.map((w) => `<article class="card ask"><header>${chip('try', 'STATE')}</header><p class="pre">${e((w.text ?? w.value).trim())}</p></article>`);

  const slices = project.slices.filter((s) => s.ledgerState === 'working' || s.ledgerState === 'blocked');
  const flight = [
    ...slices.map((s) => {
      const state = s.ledgerState === 'blocked' ? 'blocked' : 'working';
      return `<article class="card ${state}"><header><span class="id">${e(s.label)}</span>${chip(state, t(state))}${s.role ? chip('plain', s.role) : ''}<span class="meta">${e(ago(s.at, now))}</span></header><p>${e(s.value)}</p>${s.drift ? `<p class="plain">${e(t(s.drift))}</p>` : ''}</article>`;
    }),
    ...workers.map((w) => {
      // The reason can be the literal open question; that evidence belongs in Inspector.
      const summary = w.reportMeta?.summary || (!w.homeNeedsHuman && w.work?.reason);
      return `<article class="card working"><header><span class="id">${e(w.briefTitle ?? w.task)}</span>${chip('plain', [w.role, w.harness].filter(Boolean).join(' · ') || 'job')}<span class="meta">${e([w.model, w.effort, w.startedAt ? age(new Date(w.startedAt), now) : ''].filter(Boolean).join(' · '))}</span></header>${summary ? `<p>${e(summary)}</p>` : ''}</article>`;
    }),
    ...(workboard ? [] : project.active.map((j) => `<article class="card working"><header><span class="id">${e(j.title ?? j.jobId)}</span>${chip('plain', j.role || 'job')}<span class="meta">${e(ago(j.at, now))}</span></header></article>`)),
  ];

  const features = project.tickets.filter((f) => f.tickets.length);
  const review = project.docs.find((d) => d.label === 'review');
  const lines = (reviewText ?? '').slice(0, 65536).split(/\r?\n/).map((l) => (/^#{1,6}\s/.test(l) ? `<b>${e(l)}</b>` : e(l))).join('\n');
  const nav = [['needs', 'Needs you', needs.length], ['try', 'To try', pending], ['flight', 'In flight', flight.length], ['tickets', 'Tickets', features.length], ['review', 'Review', reviewText ? 1 : 0]] as const;

  return `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<meta name="color-scheme" content="light dark"><meta name="referrer" content="no-referrer">
<title>${e(projectName)} · ${e(t('Review board'))}</title><style>${CSS}</style></head><body>
<input class="sw" type="radio" name="theme" id="t-auto" checked aria-label="${e(t('Auto'))}"><input class="sw" type="radio" name="theme" id="t-dark" aria-label="${e(t('Dark'))}"><input class="sw" type="radio" name="theme" id="t-light" aria-label="${e(t('Light'))}">
<div class="page"><div class="wrap">${header}
<nav class="badges" style="margin-top:18px">${nav.filter(([, , n]) => n).map(([id, label, n]) => `<a class="chip plain" href="#${id}">${e(t(label))} ${n}</a>`).join('')}</nav>
${needs.length ? section('needs', t('Needs you'), needs.length, `<div class="grid">${needs.join('')}</div>`) : ''}
${pending ? section('try', t('To try'), pending, `<div class="grid">${tasks.map((task) => taskCard(task, project, now)).join('')}</div>`) : ''}
${flight.length ? section('flight', t('In flight'), flight.length, `<div class="grid s">${flight.join('')}</div>`) : ''}
${features.length ? section('tickets', t('Tickets'), features.length, `<div class="card">${features.map((f) => feature(f, undefined, 12)).join('')}</div>`) : ''}
${reviewText ? section('review', t('Latest milestone review'), undefined, `${review ? `<p class="root">${e(review.value)}</p>` : ''}<div class="review">${lines}</div>`) : ''}
<footer>${e(t('Static page written by hud board: no script, no network.'))}</footer></div></div></body></html>
`;
}
