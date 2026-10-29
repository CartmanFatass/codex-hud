/**
 * The panel's one control bar: its first row, two in the frame look. Every
 * button the panel draws is here, and nowhere else: not on the status card,
 * not on a pane's title (a click there zooms the pane, but draws nothing).
 *
 * The look (`look` in settings) draws it after omp; every look has the same
 * buttons:
 *
 *   tab    omp's settings tab row: the focused pane a filled tab with its
 *          word, the other panes their icons, Settings with its label,
 *          and the actions at the right end.
 *   band   omp's status line: a band of segments, the focused pane in the
 *          accent with its word, a rule in the accent across to the actions.
 *   tile   emoji tiles: the focused pane filled with its word, an open one
 *          on a chip, a closed one bare.
 *   frame  omp's settings frame round the panel: the main session is its
 *          title and the actions sit in its top edge; the tabs, drawn as
 *          `tab` draws them, are the row under it.
 *   pill   the focused pane a rounded pill with its word.
 *
 * An open pane's icon is in the text colour and a closed one's muted; the
 * actions are muted, the paused brief's resume in the accent. Without colour
 * the focused tab is in brackets and a closed pane has no tab. In the tabs
 * layout every pane has a tab, the one shown focused.
 *
 * Settings is a navigation tab (not a pane). It keeps its localized word
 * at widths of 24 or more, then a compact label; its icon gives way first.
 * While Settings is active none of the ordinary pane tabs is focused.
 * Other words come and go with the width as omp's tabs do: every tab's word where
 * they all fit, then the open tabs', then the focused tab's alone, then none.
 * The tabs close up from three columns apart to one on the way, but a word is
 * never a single column from the next tab, and the actions stay further from
 * the tabs than the tabs are from each other. Short of room after that, the
 * closed tabs go, then the older agents' button, then the brief's, then the
 * other tabs, then the focused one. Very wide, the actions take their words
 * too. With icons off the words stay, shortened where they must be.
 *
 * A click anywhere from the midpoint of the gap before a button to the
 * midpoint of the gap after it is that button's; a tab's click is `clickTab`
 * in monitor.ts; Settings retains its own `settings` control kind. No key
 * is written on the bar; the keys (the tmux prefix, then a letter) are in
 * the help alone. Pure.
 */
import type { MonitorControl, MonitorPane, MonitorState } from './monitor.js';
import { MONITOR_PANES } from './monitor.js';
import { theme, colors, visualLength, truncateAnsi } from './colors.js';
import { palette } from './palette.js';
import { iconSet, displayConfig, type LookName } from './hud-config.js';
import { t, language } from './i18n.js';

/** What the bar needs to know besides the panel's state. */
export interface BarInput {
  /** The brief, when one is configured. */
  brief?: { paused?: boolean };
  /** Agents the linger window put away; 0 hides the button. */
  expired: number;
  /** Settings is the active navigation tab while its modal is open. */
  settingsActive?: boolean;
}

type IconName = MonitorPane | 'main' | 'pause' | 'resume' | 'show' | 'hide' | 'settings' | 'help' | 'keys' | 'open';

/**
 * The Unicode icons: one column each, every one a glyph MesloLGS NF (the
 * font the panel needs, see README) draws itself, so none falls back to
 * another font at another size, and none a glyph the legend gives another
 * meaning (✓ ✗ ◈ ◎ ◷ ⌕ ≡ ▸ …).
 */
export const UNICODE_ICONS: Record<IconName, string> = {
  main: '⌂',
  agents: '▦',
  changes: '±',
  details: '◫',
  timeline: '≣',
  pause: 'ǁ',
  resume: '▶',
  show: '⊕',
  hide: '⊖',
  settings: '⚙',
  help: '?',
  keys: '⌨',
  open: '⇢',
};

/**
 * The Nerd Font icons, mostly Font Awesome's solid set for one look. Each
 * takes one cell but draws wider, so one is always followed by a space. The
 * robot is a Material Design icon past the BMP: a surrogate pair in a JS
 * string.
 */
export const ICONS: Record<IconName, string> = {
  main: '',
  agents: '\u{f06a9}',
  changes: '',
  details: '',
  timeline: '',
  pause: '',
  resume: '',
  show: '',
  hide: '',
  settings: '',
  help: '',
  keys: '\uf11c',
  open: '\uf090',
};

/**
 * Emoji for the panes, two columns each and in their own colours, as omp's
 * Unicode preset draws its tabs; the actions keep their Unicode glyphs, which
 * a colour can mark. Each is an emoji-presentation character, two columns in
 * tmux and the HUD alike, never one that needs a variation selector to be one.
 */
export const EMOJI_ICONS: Record<IconName, string> = {
  ...UNICODE_ICONS,
  agents: '🤖',
  changes: '📝',
  details: '🔍',
  timeline: '🕘',
};

/** The icon the panel draws for `name`, or '' with icons off. */
export function icon(name: IconName): string {
  switch (iconSet()) {
    case 'nerd': return ICONS[name];
    case 'unicode': return UNICODE_ICONS[name];
    case 'emoji': return EMOJI_ICONS[name];
    default: return '';
  }
}

/** Fewest columns the frame look draws its frame in; narrower, it draws as `tab` does. */
const FRAME_MIN = 20;

/** The look the panel is drawn in at `width`: the frame needs room for its sides. */
export function look(width = Infinity): LookName {
  const chosen = displayConfig().look ?? 'tab';
  return chosen === 'frame' && width < FRAME_MIN ? 'tab' : chosen;
}

/**
 * Each pane's names: `title` heads its frame, `tab` is its tab's word (the
 * title in Chinese, a shorter word in English), `short` the tab's word where
 * words do not fit and there are no icons.
 */
const PANE_NAMES: Record<MonitorPane, Record<'en' | 'zh', { title: string; tab: string; short: string }>> = {
  agents: { en: { title: 'Agents', tab: 'Agents', short: 'Ag' }, zh: { title: '卡片', tab: '卡片', short: '卡片' } },
  changes: { en: { title: 'Changes', tab: 'Changes', short: 'Ch' }, zh: { title: '改动', tab: '改动', short: '改动' } },
  details: {
    en: { title: 'Inspector', tab: 'Inspect', short: 'In' },
    zh: { title: '详情', tab: '详情', short: '详情' },
  },
  timeline: {
    en: { title: 'Timeline', tab: 'Timeline', short: 'Tl' },
    zh: { title: '时间线', tab: '时间线', short: '时间…' },
  },
};

function names(id: MonitorPane) {
  return PANE_NAMES[id][language() === 'zh' ? 'zh' : 'en'];
}

/** A pane's title as its frame draws it: its icon (painted by the caller) and its name. */
export function paneTitle(id: MonitorPane): { icon: string; name: string } {
  return { icon: icon(id), name: names(id).title };
}

/** A pill's rounded ends: Powerline glyphs, which MesloLGS NF draws. */
const CAP_LEFT = '';
const CAP_RIGHT = '';

type ChipState = 'focused' | 'open' | 'closed' | 'button';

/** One button: its icon, its word, the word where room is short and there is no icon, and its state. */
interface Spec {
  kind: MonitorControl['kind'];
  pane?: MonitorPane;
  glyph: string;
  word: string;
  short: string;
  state: ChipState;
  accent?: boolean;
}

interface Specs {
  main: Spec;
  tabs: Spec[];
  actions: Spec[];
}

/**
 * The buttons there are, keeping those `keep` lets stay: the closed tabs
 * (4), the older agents (3), the brief and Switch (2), the tabs but the focused one's
 * (1) and that one too (0), in the order the bar gives them up. Main,
 * Settings and Help outlast these optional controls.
 */
function specs(state: MonitorState, input: BarInput, keep: number, width: number): Specs {
  const zh = language() === 'zh';
  // With icons off the main session's button is an arrow and a word: a word alone would read as a tab.
  const arrow = iconSet() === 'text' ? '← ' : '';
  const main: Spec = { kind: 'main', glyph: icon('main'), word: `${arrow}${t('Main')}`, short: `${arrow}${zh ? '主' : 'Main'}`, state: 'button' };
  const tabs: Spec[] = [];
  for (const id of MONITOR_PANES) {
    // In the tabs layout every pane has a tab: none is closed.
    const mode = state.tabbed ? 'open' : state.modes[id];
    const focused = !input.settingsActive && id === state.focus && mode === 'open';
    // With no colour a tab cannot say closed; only the panes there are get one.
    if (mode === 'closed' && (keep < 4 || palette().name === 'none')) continue;
    if ((!focused && keep < 1) || keep < 0) continue;
    tabs.push({ kind: 'tab', pane: id, glyph: icon(id), word: names(id).tab, short: names(id).short, state: focused ? 'focused' : mode });
  }
  // Settings is navigation, not a pane and not a right-hand action. Its word
  // survives the pane tabs' fitting levels; even the narrow fallback is labelled.
  const settingsWord = t('Settings');
  const settingsLabel = width >= 24 ? settingsWord : truncateAnsi(settingsWord, zh ? 3 : 4).replace(/…$/u, '');
  tabs.push({ kind: 'settings', glyph: icon('settings'), word: settingsLabel, short: settingsLabel, state: input.settingsActive ? 'focused' : 'open' });
  const actions: Spec[] = [];
  // Keys held in the panel: nothing typed reaches Codex until Esc or a click
  // here hands them back, so the bar says so for as long as it lasts, and
  // never gives the chip up for room.
  if (state.keys) actions.push({ kind: 'keys', glyph: icon('keys'), word: t('Keys here'), short: t('Keys'), state: 'button', accent: true });
  // An agent selected, in its list or its Inspector: switching Codex to it, as `o` does, is a click away.
  const switchable = state.tree.selectedId && (state.focus === 'agents' || (state.focus === 'details' && state.preview === 'agent'));
  if (switchable && !input.settingsActive && keep >= 2) actions.push({ kind: 'open-session', glyph: icon('open'), word: t('Switch'), short: '⇢', state: 'button' });
  if (input.brief && keep >= 2) {
    const paused = Boolean(input.brief.paused);
    actions.push({
      kind: 'brief',
      glyph: icon(paused ? 'resume' : 'pause'),
      word: t(paused ? 'Resume models' : 'Pause models'),
      short: t(paused ? 'Resume' : 'Pause'),
      state: 'button',
      accent: paused,
    });
  }
  if (input.expired && keep >= 3) {
    const shown = state.tree.showAll;
    const n = input.expired;
    // The count is the button's own: nothing else on the panel says how many are put away.
    // With a word, the glyph's trailing count is dropped so it is not said twice.
    const textIcons = iconSet() === 'text';
    const glyph = textIcons ? '' : `${UNICODE_ICONS[shown ? 'hide' : 'show']}${n}`;
    const word = shown ? t('Hide') : textIcons ? t('+{n} older', { n }) : t('{n} finished', { n });
    actions.push({ kind: 'older', glyph, word, short: `${shown ? '−' : '+'}${n}`, state: 'button' });
  }
  actions.push({ kind: 'help', glyph: icon('help'), word: t('Help'), short: '?', state: 'button' });
  return { main, tabs, actions };
}

/**
 * How many words a row carries: every button's, every tab's, every tab's
 * with the icons of all but the focused one left off, the open tabs', the
 * focused tab's, none.
 */
type Level = 'every' | 'all' | 'named' | 'open' | 'focus' | 'none';

/**
 * Words before room, and room before columns between tabs; a word never a
 * column from the next tab. In the tabs layout a tab's word outlasts its
 * icon: a row a few columns short of every icon and word (a `+N older`
 * button beside them) keeps the words and drops the other tabs' icons,
 * rather than every word but the focused tab's. Stacked, the icons say which
 * panes are open, and the open panes' words outlast the closed ones'.
 */
const OPTIONS: ReadonlyArray<readonly [Level, number]> = [
  ['every', 2],
  ['all', 3],
  ['all', 2],
  ['named', 2],
  ['open', 3],
  ['open', 2],
  ['focus', 3],
  ['focus', 2],
  ['focus', 1],
  ['none', 2],
  ['none', 1],
];

function hasWord(level: Level, spec: Spec, olderWords = false): boolean {
  if (spec.kind === 'older') return olderWords;
  // The held keys' word outlasts the closed tabs' and the other actions', as an alert would.
  if (spec.kind === 'keys') return level !== 'focus' && level !== 'none';
  if (spec.kind === 'settings') return true;
  if (spec.kind !== 'tab') return level === 'every';
  if (level === 'every' || level === 'all' || level === 'named') return true;
  if (level === 'open') return spec.state !== 'closed';
  return level === 'focus' && spec.state === 'focused';
}

/** Whether a button keeps its icon at a level: every one but the tabs the `named` level gives a word alone. */
function hasIcon(level: Level, spec: Spec): boolean {
  // Settings gives up its icon before its label, including the last fitting level.
  if (spec.kind === 'settings' && (level === 'focus' || level === 'none')) return false;
  return level !== 'named' || (spec.kind !== 'tab' && spec.kind !== 'settings') || spec.state === 'focused';
}

/** A button's face: its icon, with its word where it has one; with no icon, its word or its short word. */
function face(spec: Spec, word: boolean, icon = true): string {
  if (spec.kind === 'older' && spec.glyph && word) return `${spec.glyph.replace(/\d+$/u, '')} ${spec.word}`;
  if (spec.glyph && icon) return word ? `${spec.glyph} ${spec.word}` : spec.glyph;
  return word ? spec.word : spec.short;
}

/**
 * A face painted for its state in the look. The focused tab is a filled tab
 * (a column of surface each side), the accent in the band, a pill in `pill`;
 * a tile's open tab sits on a chip, with side columns where `roomy`.
 */
function paint(look: LookName, text: string, state: ChipState, accent = false, roomy = false): string {
  const bare = palette().name === 'none';
  if (state === 'focused') {
    if (bare) return `[${text}]`;
    if (look === 'band') return theme.bold(theme.accent(text));
    if (look === 'pill') return `${theme.tabEdge(CAP_LEFT)}${theme.tab(theme.bold(text))}${theme.tabEdge(CAP_RIGHT)}`;
    return theme.tab(theme.bold(` ${text} `));
  }
  if (state === 'button') return accent ? theme.accent(text) : colors.dim(text);
  const shown = look === 'tile' && roomy ? ` ${text} ` : text;
  if (look === 'tile' && state === 'open' && !bare) return theme.chip(shown);
  return state === 'open' ? theme.value(shown) : colors.dim(shown);
}

type Bar = { lines: string[]; controls: MonitorControl[] };

/** A button on a row: its spec, painted text, and where its face starts. */
interface Placed {
  spec: Spec;
  text: string;
  x: number;
  width: number;
}

/**
 * The buttons' click spans on row `y`: from the midpoint of the gap before
 * each to the midpoint of the gap after it, the first from `from` and the
 * last to `to`.
 */
function spans(placed: Placed[], y: number, from: number, to: number): MonitorControl[] {
  return placed.map((p, i) => {
    const prev = placed[i - 1];
    const next = placed[i + 1];
    const start = prev ? Math.ceil((prev.x + prev.width + p.x) / 2) : from;
    const end = next ? Math.ceil((p.x + p.width + next.x) / 2) : to;
    return { kind: p.spec.kind, ...(p.spec.pane ? { pane: p.spec.pane } : {}), x: start, y, width: Math.max(1, end - start) };
  });
}

export function controlBar(state: MonitorState, input: BarInput, width: number): Bar {
  if (width <= 0) return { lines: [''], controls: [] };
  if (look(width) === 'quiet') return quietBar(state,input,width);
  return look(width) === 'frame' ? frameBar(state, input, width) : rowBar(state, input, width);
}

/** A reading order instead of competing icon chips: overview, detail, tools. */
function quietBar(state: MonitorState,input: BarInput,width: number): Bar {
  const lines:string[]=[],controls:MonitorControl[]=[];
  const fit=(line:string)=>{const cut=truncateAnsi(line,width);return cut+' '.repeat(Math.max(0,width-visualLength(cut)));};
  const tab=(pane:MonitorPane,label:string):Spec=>({kind:'tab',pane,glyph:'',word:t(label),short:t(label),
    state:!input.settingsActive && state.focus===pane?'focused':'open'});
  const button=(kind:Spec['kind'],label:string,active=false):Spec=>({kind,glyph:'',word:t(label),short:t(label),state:active?'focused':'button'});
  const groups=[
    [tab('agents','Overview'),button('usage','Usage'),button('activity-hub','Activity')],
    [tab('timeline','Timeline'),tab('changes','Changes'),tab('details','Inspector')],
    [button('main','Main'),button('settings','Settings',input.settingsActive),button('observability','Evidence'),button('help','Help')],
  ];
  const actions:Spec[]=[];
  if(state.tree.selectedId) actions.push(button('open-session','Switch'));
  if(input.brief) actions.push(button('brief',input.brief.paused?'Resume':'Pause'));
  if(input.expired) actions.push(button('older',state.tree.showAll?'Hide older':'Show older'));
  if(state.keys) actions.push(button('keys','Keys here'));
  if(actions.length)groups.push(actions);
  for(const group of groups) {
    let row='';
    for(const spec of group) {
      const label=truncateAnsi(spec.state==='focused'?`[${spec.word}]`:spec.word,width);
      if(row && visualLength(row)+2+visualLength(label)>width){lines.push(fit(row));row='';}
      if(row)row+='  ';
      controls.push({kind:spec.kind,...(spec.pane?{pane:spec.pane}:{}),x:visualLength(row),y:lines.length,width:visualLength(label)});
      row+=spec.state==='focused'?theme.accent(theme.bold(label)):spec.kind==='tab'?theme.value(label):colors.dim(label);
    }
    if(row)lines.push(fit(row));
  }
  const targets=controls.map((control,i)=>{
    const previous=controls[i-1],next=controls[i+1];
    const start=previous?.y===control.y?Math.ceil((previous.x+previous.width+control.x)/2):0;
    const end=next?.y===control.y?Math.ceil((control.x+control.width+next.x)/2):width;
    return {...control,x:start,width:end-start};
  });
  return {lines,controls:targets};
}

/** The main session's button alone, for a bar too narrow for anything else. */
function mainOnly(width: number): Bar {
  const text = truncateAnsi(` ${icon('main') || '←'}`, width);
  return { lines: [text + ' '.repeat(Math.max(0, width - visualLength(text)))], controls: [{ kind: 'main', x: 0, y: 0, width }] };
}

/** The one-row bar of the tab, band, tile and pill looks. */
function rowBar(state: MonitorState, input: BarInput, width: number): Bar {
  const style = look(width);
  for (let keep = 4; keep >= -1; keep--) {
    const set = specs(state, input, keep, width);
    for (const [level, gap] of OPTIONS) {
      // The actions' words come last and go first: never in place of a button.
      if (level === 'every' && keep < 4) continue;
      if (level === 'named' && !state.tabbed) continue;
      // The older button's words first. When they do not fit, the same row with the icon alone.
      const laid = layRow(style, set, level, gap, width, true) ?? (input.expired ? layRow(style, set, level, gap, width, false) : null);
      if (laid) return laid;
    }
  }
  return mainOnly(width);
}

/**
 * Lay a row out: a column, the main session's button, a column, the tabs
 * `gap` apart; the spare columns; the actions and a column. In the band the
 * two groups sit on the band and the spare columns are the accent's rule.
 * Null when it does not fit.
 */
function layRow(style: LookName, set: Specs, level: Level, gap: number, width: number, olderWords: boolean): Bar | null {
  // A tab with no surface of its own needs two columns to the next tab for its word to stand apart.
  if (style === 'band' && gap < 2 && level !== 'none' && palette().name !== 'none') return null;
  const roomy = gap >= 2;
  const make = (spec: Spec) => paint(style, face(spec, hasWord(level, spec, olderWords), hasIcon(level, spec)), spec.state, spec.accent, roomy);
  const band = style === 'band';
  const main = make(set.main);
  const tabs = set.tabs.map(make);
  const actions = set.actions.map(make);
  const between = level === 'every' ? 2 : 1;
  // The main session's button stands a column from the tabs, as far as they are apart once it has its word.
  const lead = level === 'every' ? gap : 1;
  const sum = (texts: string[], sep: number) => texts.reduce((n, text) => n + visualLength(text), 0) + sep * Math.max(0, texts.length - 1);
  const leftWidth = 1 + visualLength(main) + (tabs.length ? lead + sum(tabs, gap) : 0) + (band ? 1 : 0);
  const rightWidth = (band ? 1 : 0) + sum(actions, between) + 1;
  const spare = width - leftWidth - rightWidth;
  // The band's rule needs two columns to read as one; elsewhere the actions stand further off than a tab's gap.
  if (spare < (band ? 2 : gap + 1)) return null;

  const placed: Placed[] = [];
  let x = 1;
  const place = (spec: Spec, text: string) => {
    placed.push({ spec, text, x, width: visualLength(text) });
    x += visualLength(text);
  };
  let left = ' ';
  place(set.main, main);
  left += main;
  tabs.forEach((text, i) => {
    const sep = ' '.repeat(i ? gap : lead);
    left += sep;
    x += sep.length;
    place(set.tabs[i], text);
    left += text;
  });
  if (band) left += ' ';
  x = leftWidth + spare + (band ? 1 : 0);
  let right = band ? ' ' : '';
  actions.forEach((text, i) => {
    if (i) {
      right += ' '.repeat(between);
      x += between;
    }
    place(set.actions[i], text);
    right += text;
  });
  right += ' ';
  const line = band ? theme.band(left) + theme.accent('─'.repeat(spare)) + theme.band(right) : left + ' '.repeat(spare) + right;
  return { lines: [line], controls: spans(placed, 0, 0, width) };
}

/**
 * The frame look's two rows: the top edge of the panel's frame, the main
 * session its title and the actions in the edge at its right end, then the
 * tabs between the frame's sides.
 *
 *   ╭─ ⌂ 主会话 ───────────── ▶ ⊕31 ? ─╮
 *   │ ▦  ≣ 时间线  ±  ◫  ⚙ 设置       │
 */
function frameBar(state: MonitorState, input: BarInput, width: number): Bar {
  const rule = theme.frame;
  for (let keep = 4; keep >= -1; keep--) {
    const set = specs(state, input, keep, width);
    let top: Bar | null = null;
    // The title gives up its word, then (with icons off) all but its arrow.
    // The older button tries its words, then the icon alone when those do not fit.
    const titles = [...new Set([face(set.main, true), face(set.main, false), set.main.glyph || '←'])];
    for (const olderWords of [true, false]) {
      const actions = set.actions.map((spec) => paint('frame', face(spec, (spec.kind === 'older' || spec.kind === 'keys') && olderWords), spec.state, spec.accent));
      const actionsWidth = actions.reduce((n, text) => n + visualLength(text), 0) + Math.max(0, actions.length - 1);
      for (const name of titles) {
        const title = theme.bold(theme.accent(` ${name} `));
        const fill = width - 6 - visualLength(title) - actionsWidth;
        if (fill < 1) continue;
        const placed: Placed[] = [{ spec: set.main, text: title, x: 2, width: visualLength(title) }];
        let x = 2 + visualLength(title) + fill + 1;
        actions.forEach((text, i) => {
          placed.push({ spec: set.actions[i], text, x, width: visualLength(text) });
          x += visualLength(text) + 1;
        });
        const line = `${rule('╭─')}${title}${rule('─'.repeat(fill))} ${actions.join(' ')} ${rule('─╮')}`;
        top = { lines: [line], controls: spans(placed, 0, 0, width) };
        break;
      }
      if (top) break;
    }
    if (!top) continue;
    // The tabs, a column in from the frame's left side, ending a column short of its right.
    for (const [level, gap] of OPTIONS) {
      if (level === 'every' || (level === 'named' && !state.tabbed)) continue;
      const tabs = set.tabs.map((spec) => paint('frame', face(spec, hasWord(level, spec), hasIcon(level, spec)), spec.state));
      const used = tabs.reduce((n, text) => n + visualLength(text), 0) + gap * Math.max(0, tabs.length - 1);
      if (used > width - 4) continue;
      const placed: Placed[] = [];
      let x = 2;
      tabs.forEach((text, i) => {
        if (i) x += gap;
        placed.push({ spec: set.tabs[i], text, x, width: visualLength(text) });
        x += visualLength(text);
      });
      const row = `${rule('│')} ${tabs.join(' '.repeat(gap))}${' '.repeat(width - 3 - used)}${rule('│')}`;
      return { lines: [...top.lines, row], controls: [...top.controls, ...spans(placed, 1, 1, width - 1)] };
    }
  }
  return mainOnly(width);
}

/**
 * The agents' counts in the form asked for: each count with its word or
 * without, and with the subtasks figure or without it. Painted; '' with
 * nothing to count.
 */
export type CountsText = (words: boolean, figure: boolean) => string;

/** What a pane's title row says besides its name. */
export interface HeadOptions {
  /** Painted, after the title: the pane's counts, or the agents' in each of their forms. */
  info?: string | CountsText;
  /** Painted, at the right end: where the pane's rows are, or how many there are. */
  right?: string;
  focused: boolean;
  zoomed: boolean;
  /** False where the bar's tab above already names the pane (the tabs layout): the row keeps its counts and where its rows are. */
  named?: boolean;
}

/**
 * A pane's title row as the look draws it, `width` wide: its icon and name
 * (the accent where the focus is), `info` after it, `right` at the right end.
 *
 *   tab    " ⌥ 工作树                       3 个 "      no surface of its own
 *   band   the same on the band, zoomed on the tab surface
 *   tile   " ⌥ 工作树 ─────────────────── 3 个 "      the rule the accent where the focus is
 *   frame  "├─ ⌥ 工作树 ────────────────── 3 个 ─┤"    an edge of the panel's frame
 *   pill   " ( ⌥ 工作树 )                  3 个 "      the deep blue where the focus is
 *
 * Zoomed, the title is a filled tab, as the focused tab on the bar is.
 * Short of room, what matters least gives way first: the name, then the
 * counts' words, then where the rows are, then the subtasks figure. One that
 * gave way comes back where what it made room for does not fit anyway; at
 * the last the counts are cut. Unnamed (the tabs layout, its tab on the bar
 * above), the row is the counts and where the rows are alone, on the look's
 * rule or surface.
 */
export function paneHead(id: MonitorPane, width: number, o: HeadOptions): string {
  const style = look(width);
  const { icon: glyph, name } = paneTitle(id);
  const titles = o.named === false ? [''] : glyph ? [`${glyph} ${name}`, glyph] : [name];
  const info = o.info;
  const counts: CountsText = typeof info === 'function' ? info : () => info ?? '';
  const bare = { ...o, right: undefined };
  const both = [true, false];
  for (const figure of both) {
    for (const right of o.right ? both : [false]) {
      for (const words of both) {
        for (const title of titles) {
          const row = headRow(style, title, counts(words, figure), right ? o : bare, width, false);
          if (row !== null) return row;
        }
      }
    }
  }
  return headRow(style, titles.at(-1)!, counts(false, false), bare, width, true)!;
}

function headRow(style: LookName, title: string, counts: string, o: HeadOptions, width: number, cut: boolean): string | null {
  const bare = palette().name === 'none';
  const right = o.right ?? '';
  const strong = (text: string) => theme.bold(o.focused ? theme.accent(text) : theme.value(text));
  const filled = (text: string) => (bare ? `[${text}]` : theme.tab(theme.bold(` ${text} `)));
  let head: string;
  if (!title) head = '';
  else if (style === 'pill') {
    const on = o.focused || o.zoomed;
    head = bare
      ? `[${title}]`
      : on
        ? `${theme.tabEdge(CAP_LEFT)}${theme.tab(theme.bold(title))}${theme.tabEdge(CAP_RIGHT)}`
        : `${theme.chipEdge(CAP_LEFT)}${theme.chip(theme.bold(theme.value(title)))}${theme.chipEdge(CAP_RIGHT)}`;
  } else if (o.zoomed && style !== 'band') head = filled(title);
  else head = style === 'band' && o.zoomed ? theme.bold(title) : strong(title);
  // With no title and nothing after it, a rule runs on from the frame's edge (or the row's first column).
  const bareRow = !head && !counts;
  const lead = style === 'frame' ? bareRow ? theme.frame('├') : `${theme.frame('├─')} ` : bareRow && style === 'tile' ? '' : ' ';
  const info = counts ? `${head ? style === 'tab' || style === 'band' ? '  ' : ' ' : ''}${counts}` : '';
  // The rule's looks draw a rule across to the right end; the others leave the columns blank.
  const ruled = style === 'tile' || style === 'frame';
  const close = style === 'frame' ? theme.frame(right ? ' ─┤' : '─┤') : ' ';
  const tail = right ? ` ${right}${close}` : style === 'frame' ? close : ruled ? ' ' : '';
  const least = ruled || right ? 1 : 0;
  const gap = ruled && !bareRow ? 1 : 0;
  let left = `${lead}${head}${info}`;
  let fill = width - visualLength(left) - visualLength(tail) - gap;
  if (fill < least) {
    if (!cut) return null;
    // The last resort: the counts cut to what the title and where the rows are leave them.
    left = truncateAnsi(left, Math.max(0, width - visualLength(tail) - gap - least));
    fill = Math.max(0, width - visualLength(left) - visualLength(tail) - gap);
  }
  const rule = style === 'frame' ? theme.frame : o.focused ? theme.accent : theme.frame;
  let row = ruled ? `${left}${gap ? ' ' : ''}${rule('─'.repeat(fill))}${tail}` : `${left}${' '.repeat(fill)}${tail}`;
  row = truncateAnsi(row, width);
  row += ' '.repeat(Math.max(0, width - visualLength(row)));
  if (style === 'band') return o.zoomed ? theme.tab(row) : theme.band(row);
  return row;
}
