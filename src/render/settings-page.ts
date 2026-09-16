import type { HudSettings } from '../settings.js';
import type { WorkbenchInput } from '../utils/workbench-input.js';
import { truncateAnsi, colors, theme } from './colors.js';

export const SETTING_ROWS: {key:keyof HudSettings; label:string; values: readonly (string|number|boolean)[]}[] = [
  {key:'density',label:'HUD density',values:['focus','balanced','full']},
  {key:'theme',label:'Theme',values:['terminal','mocha','latte','none']},
  {key:'glyphs',label:'Model labels',values:['glyph','text','both']},
  {key:'motion',label:'Motion',values:['full','reduced']},
  {key:'sort',label:'Agent order',values:['active','created']},
  {key:'mouse',label:'Mouse interaction',values:[true,false]},
  {key:'details',label:'Agent / diff details',values:[true,false]},
  {key:'changes',label:'Git changes',values:[true,false]},
  {key:'activity',label:'Activity pane',values:[true,false]},
  {key:'tasks',label:'Tasks tab',values:[false,true]},
  {key:'refreshMs',label:'Refresh (ms)',values:[500,1000,2000,5000]},
  {key:'treeWidth',label:'Panel width',values:[16,0,45,70]},
];
export interface SettingsPageState { draft:HudSettings; selected:number; offset:number; message:string }
export interface SettingsFrame {lines:string[]; state:SettingsPageState; rowStart:number; rowCount:number; footerY:number}
export function renderSettingsPage(state:SettingsPageState,width:number,height:number):SettingsFrame {
  const count = Math.max(0,height-3);
  const selected = Math.min(SETTING_ROWS.length-1,Math.max(0,state.selected));
  let offset = Math.min(state.offset,Math.max(0,SETTING_ROWS.length-count));
  if (selected < offset) offset = selected;
  if (count && selected >= offset+count) offset = selected-count+1;
  const lines = [theme.accent('[Back] [Save] [Reset] Settings')];
  for (let i=0;i<count;i++) {
    const row = SETTING_ROWS[i+offset];
    if (!row) { lines.push(''); continue; }
    const value = state.draft[row.key];
    const label = typeof value === 'boolean' ? value ? 'on' : 'off' : row.key === 'treeWidth' ? ({16:'narrow',0:'default',45:'wide',70:'wider'}[Number(value)] ?? String(value)) : String(value);
    const text = `${i+offset === selected ? '›' : ' '} ${truncateAnsi(row.label,Math.max(0,width-label.length-4))}: ${label}`;
    lines.push(i+offset === selected ? theme.accent(text) : text);
  }
  if (height > 1) lines.push(colors.dim(state.message || 'Changes apply when saved'));
  if (height > 2) lines.push(colors.dim('↑↓ select  ←→ edit  s save  r reset  Esc back'));
  return {lines:lines.slice(0,height).map(line=>truncateAnsi(line,Math.max(0,width))),state:{...state,selected,offset},rowStart:1,rowCount:count,footerY:height-1};
}
export function handleSettingsInput(state:SettingsPageState,input:WorkbenchInput,frame:SettingsFrame):{state:SettingsPageState;action?:'save'|'back'|'reset'} {
  const next = {...state};
  let key = input.type === 'key' ? input.key : '';
  if (input.type === 'mouse') {
    if (input.button === 'left' && input.y === 0) {
      return {state:next,action:input.x<6?'back':input.x<13?'save':input.x<21?'reset':undefined};
    }
    if (input.button === 'left' && input.y >= frame.rowStart && input.y < frame.rowStart+frame.rowCount) {
      const index = frame.state.offset+input.y-frame.rowStart;
      if (index >= SETTING_ROWS.length) return {state:next};
      next.selected = index; key = 'right';
    } else if (input.button !== 'left') key = input.button === 'wheel-down' ? 'down' : 'up';
  }
  if (key === 'escape' || key === 'settings' || key === 'close') return {state:next,action:'back'};
  if (key === 'sort') return {state:next,action:'save'};
  if (key === 'reset') return {state:next,action:'reset'};
  if (key === 'down' || key === 'tab') next.selected = Math.min(SETTING_ROWS.length-1,next.selected+1);
  if (key === 'up' || key === 'shift-tab') next.selected = Math.max(0,next.selected-1);
  if (key === 'home') next.selected = 0;
  if (key === 'end') next.selected = SETTING_ROWS.length-1;
  if (key === 'enter' || key === 'left' || key === 'right') {
    const row = SETTING_ROWS[next.selected];
    const index = row.values.indexOf(next.draft[row.key]);
    const value = row.values[(index+(key === 'left' ? row.values.length-1 : 1))%row.values.length];
    next.draft = {...next.draft,[row.key]:value};
    next.message = 'Unsaved changes';
  }
  return {state:next};
}
