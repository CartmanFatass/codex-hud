import type { HudSettings } from '../settings.js';
import type { WorkbenchInput } from '../utils/workbench-input.js';
import { truncateAnsi, colors, theme, visualLength } from './colors.js';
import { t, language } from './i18n.js';

type SettingValue = string | number | boolean;

export interface SettingRow {
  key: keyof HudSettings;
  /** The section the row sits under. */
  group: string;
  label: string;
  /** The label below 24 columns. */
  short: string;
  values: readonly SettingValue[];
  /** What the setting does, shown while it is selected; short enough for a 28-column panel. */
  help: string;
  /** How a value reads, when the stored value would not say it. */
  format?: (value: SettingValue) => string;
}

const seconds = (value: SettingValue) => `${Number(value) / 1000}s`;
const minutes = (value: SettingValue) => Number(value) === 0 ? 'never' : `${Number(value) / 60_000}m`;
const PANE_HELP = 'Open, folded, or closed';

export const SETTING_ROWS: readonly SettingRow[] = [
  {key:'density',group:'Status bar',label:'Density',short:'Density',values:['focus','balanced','full'],help:'How much the bar shows'},
  {key:'theme',group:'Status bar',label:'Theme',short:'Theme',values:['terminal','mocha','latte','none'],help:'Colours of bar and panel'},
  {key:'glyphs',group:'Status bar',label:'Model label',short:'Model',values:['glyph','text','both'],help:'Model as glyph, text, both'},
  {key:'motion',group:'Status bar',label:'Motion',short:'Motion',values:['full','reduced'],help:'Reduced keeps spinners still'},
  {key:'context',group:'Status bar',label:'Context',short:'Ctx',values:['used','remaining'],help:'Meter counts used or left'},
  {key:'statusline',group:'Status bar',label:'Bar on launch',short:'Bar',values:[true,false],help:'Next launch: one-line bar'},
  {key:'sort',group:'Agents',label:'Order',short:'Order',values:['active','created'],help:'Running first, or by age'},
  {key:'finishedLingerMs',group:'Agents',label:'Hide finished',short:'Hide',values:[60_000,180_000,600_000,1_800_000,0],
    help:'Done agents hide after this',format:minutes},
  {key:'briefing',group:'Agents',label:'Brief',short:'Brief',values:['off','omp','agy','api'],help:'Model brief under the tree'},
  {key:'briefingMs',group:'Agents',label:'Brief every',short:'Every',values:[60_000,120_000,300_000,600_000],
    help:'At most this often, on change',format:minutes},
  {key:'language',group:'Panel',label:'Language',short:'Lang',values:['auto','en','zh'],help:'Panel and brief language'},
  {key:'worktreesPane',group:'Panel',label:'2 Worktrees',short:'2 Trees',values:['open','folded','closed'],help:PANE_HELP},
  {key:'changesPane',group:'Panel',label:'3 Changes',short:'3 Files',values:['open','folded','closed'],help:PANE_HELP},
  {key:'detailsPane',group:'Panel',label:'4 Inspector',short:'4 Info',values:['open','folded','closed'],help:PANE_HELP},
  {key:'treeWidth',group:'Panel',label:'Width',short:'Width',values:[32,56],help:'Panel columns',
    format:value => ({32:'narrow',56:'wide'} as Record<number,string>)[Number(value)] ?? String(value)},
  {key:'art',group:'Panel',label:'Decoration',short:'Art',values:['off','dots','color','ascii'],help:'Picture in empty space; codex-hud-art sets it'},
  {key:'mouse',group:'Panel',label:'Mouse',short:'Mouse',values:[true,false],help:'Click and scroll the panel'},
  {key:'refreshMs',group:'Panel',label:'Refresh',short:'Refresh',values:[500,1000,2000,5000],help:'How often the panel reads',format:seconds},
];

/** Values that need a shorter word below 24 columns. */
const NARROW_VALUES: Record<string,string> = {remaining:'left',balanced:'bal',terminal:'term',reduced:'less',created:'age'};

export interface SettingsPageState { draft:HudSettings; selected:number; offset:number; message:string; original?:HudSettings }
export interface SettingsFrame {
  lines:string[];
  state:SettingsPageState;
  rowStart:number;
  rowCount:number;
  /** The SETTING_ROWS index drawn on each screen line; null for headers and blanks. */
  rows:Array<number|null>;
  /** Where the selected row's "‹" sits, so a click on it steps back. */
  back?:{y:number;x:number};
  footerY:number;
  actions:Array<{action:'back'|'save'|'reset';x:number;width:number}>;
}

type DisplayLine = {group:string} | {index:number};

/** Section headings interleaved with the rows they head, in reading order. */
const DISPLAY: readonly DisplayLine[] = SETTING_ROWS.flatMap((row,index) =>
  index === 0 || SETTING_ROWS[index-1].group !== row.group ? [{group:row.group},{index}] : [{index}]);

function valueText(row:SettingRow,value:SettingValue,narrow:boolean):string {
  const text = typeof value === 'boolean' ? value ? 'on' : 'off' : row.format ? row.format(value) : String(value);
  // Chinese words are short already; the narrow English forms are for English.
  return narrow && language() === 'en' ? NARROW_VALUES[text] ?? text : t(text);
}

function rowLine(row:SettingRow,value:SettingValue,selected:boolean,dirty:boolean,width:number):{text:string;back?:number} {
  const narrow = width < 24;
  const gutter = `${selected ? '›' : ' '}${dirty ? '*' : ' '} `;
  const shown = valueText(row,value,narrow);
  const label = t(narrow ? row.short : row.label);
  const margin = narrow ? 0 : 1;
  // Widths are display columns, not string lengths: a Chinese label is two
  // columns a character.
  // The chevrons say ←→ changes this row; they go first when space runs out.
  const chevrons = selected && gutter.length+visualLength(label)+1+visualLength(shown)+4+margin <= width;
  const tail = chevrons ? `‹ ${shown} ›` : shown;
  const room = Math.max(0,width-margin-gutter.length-visualLength(tail)-1);
  const name = truncateAnsi(label,room);
  const pad = ' '.repeat(Math.max(1,width-margin-gutter.length-visualLength(name)-visualLength(tail)));
  const drawn = chevrons ? `${colors.dim('‹')} ${theme.strong(shown)} ${colors.dim('›')}` : theme.accent(shown);
  const text = `${selected ? theme.accent('›') : ' '}${dirty ? theme.warning('*') : ' '} ${name}${pad}${drawn}`;
  // The highlight spans the whole row, gaps included, like the agent list's.
  return {text:selected ? theme.selected(text) : text,back:chevrons ? gutter.length+visualLength(name)+pad.length : undefined};
}

export function renderSettingsPage(state:SettingsPageState,width:number,height:number):SettingsFrame {
  const count = Math.max(0,height-3);
  const selected = Math.min(SETTING_ROWS.length-1,Math.max(0,state.selected));
  const at = DISPLAY.findIndex(line => 'index' in line && line.index === selected);
  // Scroll by screen line, keeping the selected row's heading in view with it.
  const top = at > 0 && 'group' in DISPLAY[at-1] ? at-1 : at;
  let offset = Math.min(Math.max(0,state.offset),Math.max(0,DISPLAY.length-count));
  if (top < offset) offset = top;
  if (count && at >= offset+count) offset = at-count+1;
  const original = state.original ?? {...state.draft};
  const dirty = SETTING_ROWS.filter(row => original[row.key] !== state.draft[row.key]).length;

  const actions: SettingsFrame['actions'] = [];
  let header = '';
  let plainHeader = '';
  for (const [action,key] of [['back','[Back]'],['save','[Save]'],['reset','[Reset]']] as const) {
    const label = t(key);
    const x = visualLength(plainHeader)+(plainHeader ? 1 : 0);
    if (x+visualLength(label) > width) break;
    actions.push({action,x,width:visualLength(label)});
    // Save lights up while there is something to save.
    const paint = action === 'save' ? dirty ? theme.warning : theme.accent : colors.dim;
    header += (header ? ' ' : '')+paint(label);
    plainHeader += (plainHeader ? ' ' : '')+label;
  }
  if (width-visualLength(plainHeader) >= 9) header += ` ${theme.strong(t('Settings'))}`;

  const lines = [header];
  const rows: Array<number|null> = [null];
  let back: SettingsFrame['back'];
  for (let i = 0; i < count; i++) {
    const line = DISPLAY[i+offset];
    if (!line) { lines.push(''); rows.push(null); continue; }
    if ('group' in line) {
      const title = ` ${t(line.group)} `;
      lines.push(colors.dim(`──${title}${'─'.repeat(Math.max(0,width-2-visualLength(title)))}`));
      rows.push(null);
      continue;
    }
    const row = SETTING_ROWS[line.index];
    const drawn = rowLine(row,state.draft[row.key],line.index === selected,original[row.key] !== state.draft[row.key],width);
    if (drawn.back !== undefined) back = {y:lines.length,x:drawn.back};
    lines.push(drawn.text);
    rows.push(line.index);
  }
  if (height > 1) {
    const row = SETTING_ROWS[selected];
    lines.push(state.message ? theme.accent(state.message) : colors.dim(t(row.help)));
  }
  if (height > 2) {
    lines.push(colors.dim(width < 30 ? '↑↓ ←→ s r Esc' : t(width < 48 ? '↑↓ select ←→ change s save' : '↑↓ select  ←→ change  s save  r reset  Esc back')));
  }
  return {
    lines:lines.slice(0,height).map(line => truncateAnsi(line,Math.max(0,width))),
    state:{...state,original,selected,offset},
    rowStart:1,rowCount:count,rows:rows.slice(0,height),back,footerY:height-1,actions,
  };
}

export function handleSettingsInput(state:SettingsPageState,input:WorkbenchInput,frame:SettingsFrame):{state:SettingsPageState;action?:'save'|'back'|'reset'} {
  const next = {...state,original:state.original??frame.state.original};
  let key = input.type === 'key' ? input.key : '';
  if (input.type === 'mouse') {
    if (input.button === 'left' && input.y === 0) {
      return {state:next,action:frame.actions.find(action=>input.x>=action.x&&input.x<action.x+action.width)?.action};
    }
    if (input.button === 'left') {
      const index = frame.rows[input.y];
      if (index === null || index === undefined) return {state:next};
      // A click picks the row and moves its value on; the "‹" moves it back.
      const onBack = frame.back?.y === input.y && index === frame.state.selected && input.x >= frame.back.x && input.x <= frame.back.x+1;
      next.selected = index; key = onBack ? 'left' : 'right';
    } else key = input.button === 'wheel-down' ? 'down' : 'up';
  }
  if (key === 'escape' || key === 'settings' || key === 'close') return {state:next,action:'back'};
  if (key === 'sort') return {state:next,action:'save'};
  if (key === 'reset') return {state:next,action:'reset'};
  const moved = next.selected;
  if (key === 'down' || key === 'tab') next.selected = Math.min(SETTING_ROWS.length-1,next.selected+1);
  if (key === 'up' || key === 'shift-tab') next.selected = Math.max(0,next.selected-1);
  if (key === 'home') next.selected = 0;
  if (key === 'end') next.selected = SETTING_ROWS.length-1;
  // A status message gives way to the help of the next row looked at.
  if (next.selected !== moved) next.message = '';
  if (key === 'enter' || key === 'left' || key === 'right') {
    const row = SETTING_ROWS[next.selected];
    const index = row.values.indexOf(next.draft[row.key]);
    const value = row.values[(index+(key === 'left' ? row.values.length-1 : 1))%row.values.length];
    next.draft = {...next.draft,[row.key]:value};
    next.message = '';
  }
  return {state:next};
}
