import { defaultSettings, type HudSettings } from '../settings.js';
import { applyCardPreset, identifyCardPreset, CARD_PRESETS, CARD_PRESET_KEYS, type CardPreset } from '../card-presets.js';
import type { WorkbenchInput } from '../utils/workbench-input.js';
import type { HudHealthState } from '../types.js';
import { truncateAnsi, colors, theme, visualLength } from './colors.js';
import { t, language } from './i18n.js';
import { flowLines } from './monitor-text.js';
import { age, TIMELINE_STYLES, TIMELINE_HOURS, type MonitorControl } from './monitor.js';
import { PREFIX_KEYS, prefixName } from '../utils/panel-command.js';
import { PANEL_WIDTHS } from '../utils/pane-width.js';
import { LOOKS, type IconMode, type LookName } from './hud-config.js';
import type { ModelProbeState } from '../collectors/model-probe.js';
import { monitorText } from './monitor-text.js';

type SettingValue = string | number | boolean;
const PROBE_FAILURES: Record<string,string> = {auth:'Authentication failed','model-not-found':'Model not found',
  'rate-limit':'Rate limited',timeout:'Request timed out',network:'Connection failed',server:'Service unavailable',
  'invalid-response':'Invalid response','output-limit':'Output limit reached','hourly-cap':'Call cap reached','runtime-unavailable':'Budget store unavailable'};
export type SettingKey = keyof HudSettings | 'cardPreset';
export type SettingGroup = 'Display' | 'Panel' | 'Agents' | 'Cards' | 'LLM' | 'Status bar' | 'Input';
export type SettingsAction = 'back' | 'save' | 'reset' | 'reset-all' | 'test-api' | 'diagnostics';

export interface SettingRow {
  /** A real field, or a virtual row whose get/set must read/write only real fields. */
  key: SettingKey;
  /** The section the row sits under. */
  group: SettingGroup;
  label: string;
  /** The label below 24 columns. */
  short: string;
  values: readonly SettingValue[];
  /** What the setting does, shown while it is selected; short enough for a 28-column panel. */
  help: string;
  /** How a value reads, when the stored value would not say it. */
  format?: (value: SettingValue) => string;
  /** The value is a name, said as it is, never translated. */
  literal?: boolean;
  /** A row over several settings: its value, read from them. */
  get?: (settings: HudSettings) => SettingValue;
  /** And the settings a value stands for. */
  set?: (value: SettingValue, settings: HudSettings) => Partial<HudSettings>;
}

const seconds = (value: SettingValue) => `${Number(value) / 1000}s`;
const minutes = (value: SettingValue) => Number(value) === 0 ? 'never' : `${Number(value) / 60_000}m`;
/** Each look's name as the page says it. */
const LOOK_WORDS: Record<LookName,string> = {tab:'Tab row',band:'Status band',tile:'Emoji tiles',frame:'Frame',pill:'Pills'};
/** The icons each look was drawn with: picking a look puts them on, and Icons can change them after. */
export const LOOK_ICONS: Record<LookName,IconMode> = {tab:'unicode',band:'unicode',tile:'emoji',frame:'unicode',pill:'nerd'};
const ICON_WORDS: Record<IconMode,string> = {unicode:'Unicode',nerd:'Nerd Font',emoji:'Emoji',text:'text'};

/** The brief's paces: how soon on news that matters, and how often at most on routine news. */
const PACES = ['60000/300000','120000/600000','300000/900000','600000/1800000'] as const;
const pace = (value: SettingValue) => String(value).split('/').map(Number);
const NAME_WORDS: Record<string,string> = {name:'as name',line:'under name',off:'off'};
const NOTIFY_WORDS: Record<string,string> = {off:'off',tmux:'tmux',desktop:'tmux + desktop'};

/** Settings in contiguous sections; display-only card switches stay separate from model generators. */
export const SETTING_ROWS: readonly SettingRow[] = [
  {key:'theme',group:'Display',label:'Theme',short:'Theme',values:['terminal','titanium','mocha','latte','none'],help:'Colours of bar and panel'},
  {key:'look',group:'Display',label:'Look',short:'Look',values:LOOKS,help:'Bar and pane titles; sets their icons',
    format:value => LOOK_WORDS[value as LookName] ?? String(value)},
  {key:'icons',group:'Display',label:'Icons',short:'Icons',values:['unicode','nerd','emoji','text'],help:'Icons, or words (text); Nerd Font needs it',
    format:value => ICON_WORDS[value as IconMode] ?? String(value)},
  {key:'glyphs',group:'Display',label:'Model label',short:'Model',values:['glyph','text','both'],help:'The model badge alone: glyph, name, both'},
  {key:'motion',group:'Display',label:'Motion',short:'Motion',values:['full','reduced'],help:'Reduced keeps spinners still'},
  {key:'language',group:'Panel',label:'Language',short:'Lang',values:['auto','en','zh'],help:'Panel and everything a model writes'},
  {key:'panelStyle',group:'Panel',label:'Layout',short:'Layout',values:['rich','compact'],help:'Agent cards, or the tree and log'},
  {key:'paneLayout',group:'Panel',label:'Panes',short:'Panes',values:['stack','tabs'],help:'Tabs: one pane at a time, from the bar',
    format:value => value === 'tabs' ? 'tabs' : 'stacked'},
  {key:'statusCard',group:'Panel',label:'Status card',short:'Card',values:['full','status','min'],help:'Foot card: brief, status, one line'},
  {key:'timelineStyle',group:'Panel',label:'Timeline style',short:'Style',values:TIMELINE_STYLES,help:'Main rail, indent, or lanes'},
  {key:'timelineHours',group:'Panel',label:'Timeline span',short:'Span',values:TIMELINE_HOURS,help:'Hours shown; more on demand',
    format:value => `${value}h`},
  // The widths the panel is laid out for, each a step in what fits: the meters, the model badge's words, the timeline's
  // lanes. Codex keeps 41 whatever is asked, and a width from the file or a dragged border steps from where it falls.
  {key:'treeWidth',group:'Panel',label:'Width',short:'Width',values:PANEL_WIDTHS,
    help:'Panel columns; Codex keeps 41',
    // 0, from an older settings file, is the panel's own choice.
    format:value => Number(value) === 0 ? 'auto' : t('{n} cols',{n:Number(value)})},
  {key:'art',group:'Panel',label:'Picture',short:'Art',values:['off','dots','color','ascii'],help:'Picture in empty space; codex-hud-art sets it'},
  {key:'sort',group:'Agents',label:'Order',short:'Order',values:['active','created'],help:'Running first, or by age'},
  {key:'finishedLingerMs',group:'Agents',label:'Hide finished',short:'Hide',values:[60_000,180_000,600_000,1_800_000,0],
    help:'Done agents hide after this',format:minutes},
  // The roles whose subtasks matter: none, a role this session's subtasks have (`rowValues`), or what is set, a list
  // from the settings file included.
  {key:'importantRoles',group:'Agents',label:'Key roles',short:'Key',values:[''],help:'Their subtasks are named',literal:true,
    // Clipped to keep the page's columns at 40 wide.
    format:value => value === '' ? 'none' : truncateAnsi(String(value),15)},
  {key:'agentLog',group:'Agents',label:'Agent log',short:'Log',values:[false,true],help:'Observed log in compact view and Inspector with no backend'},
  {key:'cardPreset',group:'Cards',label:'Card preset',short:'Preset',values:CARD_PRESETS,
    help:'Card contents only; keeps child scope, corners and model permissions',
    get:identifyCardPreset,set:(value,settings) => applyCardPreset(settings,value as CardPreset)},
  {key:'cardCorners',group:'Cards',label:'Card corners',short:'Corners',values:['square','round'],help:'Square or round'},
  {key:'cardLabel',group:'Cards',label:'Task label',short:'Label',values:[true,false],help:'Show the model-written task label; no generation'},
  {key:'cardOriginalName',group:'Cards',label:'Original name',short:'Orig name',values:[true,false],help:'Show Codex name when a label replaces it'},
  {key:'cardSummary',group:'Cards',label:'Agent summary',short:'Summary',values:[true,false],help:'Show the newest stored model summary, even when paused'},
  {key:'cardRelations',group:'Cards',label:'Relations',short:'Relations',values:[true,false],help:'Show who the agent works with'},
  {key:'cardAction',group:'Cards',label:'Current action',short:'Action',values:[true,false],help:'Show the current tool or action'},
  {key:'cardSubagents',group:'Cards',label:'Child agents',short:'Children',values:[true,false],help:'Show child agent lines'},
  {key:'cardSubagentSummary',group:'Cards',label:'Child sentence',short:'Child sum',values:[true,false],help:'Show one stored model sentence beside child agents'},
  {key:'cardRoleCounts',group:'Cards',label:'Child role counts',short:'Child counts',values:[true,false],help:'Footer counts; off keeps child lines and summaries (2 scout / 1 implementer)'},
  {key:'cardModel',group:'Cards',label:'Agent model',short:'Model',values:[true,false],help:'Show the agent model badge'},
  {key:'cardReviews',group:'Cards',label:'Review count',short:'Reviews',values:[true,false],help:'Show guardian review counts'},
  {key:'cardClock',group:'Cards',label:'Turn clock',short:'Clock',values:[true,false],help:'Show the current turn clock'},
  {key:'cardRate',group:'Cards',label:'Output rate',short:'Rate',values:[true,false],help:'Show output tokens per second'},
  {key:'cardContext',group:'Cards',label:'Context meter',short:'Context',values:[true,false],help:'Show the agent context meter'},
  {key:'cardSubagentScope',group:'Cards',label:'Child scope',short:'Scope',values:['live','important','all'],help:'Child agents: live only, live plus important, or all',
    format:value => value === 'important' ? 'live + important' : String(value)},
  // Everything that sends material to a model, in one place, each with its
  // own switch and a help line saying what it sends.
  {key:'briefing',group:'LLM',label:'Backend',short:'Model',values:['off','agy','api'],help:'Off sends nothing; enabled sends selected public material to AGY or API'},
  {key:'briefingPaused',group:'LLM',label:'Pause models',short:'Pause',values:[false,true],help:'Pause all model generation; keep stored text'},
  {key:'briefAgents',group:'LLM',label:'Periodic agent brief',short:'Agent brief',values:[true,false],help:'Sends agent tasks and public updates for periodic summaries'},
  {key:'briefMain',group:'LLM',label:'Main recap',short:'Recap',values:[false,true],help:'Sends your prompts and public replies for the main recap'},
  {key:'agentProgress',group:'LLM',label:'Card progress',short:'Progress',values:[true,false],help:'Sends public reports, intents and actions for visible card summaries'},
  {key:'briefingMs',group:'LLM',label:'Brief pace',short:'Pace',values:PACES,help:'At most: on change · routine news',
    format:value => pace(value).map(ms => minutes(ms)).join(' · '),
    get:settings => `${settings.briefingMs}/${settings.recapFloorMs}`,
    set:value => { const [briefingMs,recapFloorMs] = pace(value); return {briefingMs,recapFloorMs}; }},
  {key:'modelCallsPerHour',group:'LLM',label:'Call cap',short:'Cap',values:[30,60,120,240],help:'Model calls per hour, all items',
    format:value => `${value}/h`},
  {key:'resultDigest',group:'LLM',label:'Result digest',short:'Digest',values:[false,true],help:'Sends agents\' final and long stage answers'},
  // A model's name for what each agent is on, in place of Codex's name or under it, and the session's title: the brief
  // names the agents it writes about, and an agent's task, where Codex has not encrypted it, is sent for one before that.
  {key:'agentLabels',group:'LLM',label:'Agent names',short:'Names',values:['name','line','off'],
    help:'Sends agent tasks, first prompt; names, title',format:value => NAME_WORDS[String(value)] ?? String(value),
    get:settings => settings.agentLabels ? settings.labelAsName ? 'name' : 'line' : 'off',
    set:value => value === 'off' ? {agentLabels:false} : {agentLabels:true,labelAsName:value === 'name'}},
  {key:'failureCause',group:'LLM',label:'Failure cause',short:'Cause',values:[false,true],help:'Sends the tail of error output'},
  {key:'changeSummary',group:'LLM',label:'Change summary',short:'Diff',values:[false,true],help:'Sends diff stat and hunks'},
  {key:'approvalDescription',group:'LLM',label:'Approval words',short:'Approve',values:[false,true],help:'Sends the command to approve'},
  {key:'statusline',group:'Status bar',label:'Bar on launch',short:'Bar',values:[true,false],help:'Next launch: one-line bar'},
  {key:'density',group:'Status bar',label:'Density',short:'Density',values:['focus','balanced','full'],help:'How much the bar shows'},
  {key:'context',group:'Status bar',label:'Context',short:'Ctx',values:['used','remaining'],help:'Meter counts used or left'},
  {key:'notify',group:'Status bar',label:'Notifications',short:'Notify',values:['off','tmux','desktop'],help:'Approvals, failures: tmux, or desktop too',
    format:value => NOTIFY_WORDS[String(value)] ?? String(value),
    get:settings => settings.notify ? settings.notifyDesktop ? 'desktop' : 'tmux' : 'off',
    set:value => ({notify:value !== 'off',notifyDesktop:value === 'desktop'})},
  {key:'mouse',group:'Input',label:'Mouse',short:'Mouse',values:[true,false],help:'Click and scroll the panel'},
  {key:'prefixKey',group:'Input',label:'Prefix key',short:'Prefix',values:PREFIX_KEYS,help:'Then a key: a panel command; others go to Codex',
    format:value => prefixName(String(value))},
  {key:'refreshMs',group:'Input',label:'Refresh',short:'Refresh',values:[500,1000,2000,5000],help:'How often the panel reads',format:seconds},
];

/** A row's value in `settings`: the setting's own, or for a row over several, what they make together. */
export function rowValue(row:SettingRow,settings:HudSettings):SettingValue {
  return row.get ? row.get(settings) : row.key === 'cardPreset' ? identifyCardPreset(settings) : settings[row.key] as SettingValue;
}

/** `settings` with the row set to `value`: the settings it stands for. */
export function withRowValue(settings:HudSettings,row:SettingRow,value:SettingValue):HudSettings {
  if (row.key === 'cardPreset') return applyCardPreset(settings,value as CardPreset);
  return {...settings,...(row.set ? row.set(value,settings) : {[row.key]:value})};
}

/** Values that need a shorter word below 24 columns. */
const NARROW_VALUES: Record<string,string> = {remaining:'left',balanced:'bal',terminal:'term',reduced:'less',created:'age',
  titanium:'ti','Tab row':'tab','Status band':'band','Emoji tiles':'tile',stacked:'stack'};

export interface SettingsPageState {
  draft:HudSettings; selected:number; offset:number; message:string; original?:HudSettings;
  /** The roles the session's subtasks have, the most used first: what Key roles offers. */
  roles?:readonly string[];
}

/** The current section for routing group reset; accepts either a state or a row. */
export function settingGroup(stateOrRow:Pick<SettingsPageState,'selected'>|SettingRow):SettingGroup {
  return 'group' in stateOrRow ? stateOrRow.group : SETTING_ROWS[Math.min(SETTING_ROWS.length-1,Math.max(0,stateOrRow.selected))].group;
}

/** Compare real fields, including coupled fields whose row currently hides them; virtual presets never count twice. */
export function settingsDirty(state:Pick<SettingsPageState,'draft'|'original'>):boolean {
  return !!state.original && (Object.keys(defaultSettings()) as Array<keyof HudSettings>)
    .some(key => state.draft[key] !== state.original![key]);
}

// Explicit ownership keeps new settings, assets and connection configuration out of resets by default.
// Composite rows own their hidden counterparts even when their current value does not expose them.
const RESET_FIELDS: Record<SettingGroup,readonly (keyof HudSettings)[]> = {
  Display:['theme','look','icons','glyphs','motion'],
  Panel:['language','panelStyle','paneLayout','statusCard','timelineStyle','timelineHours','treeWidth','art'],
  Agents:['sort','finishedLingerMs','importantRoles','agentLog'],
  Cards:[...CARD_PRESET_KEYS,'cardCorners','cardSubagentScope'],
  LLM:['briefingPaused','briefAgents','briefMain','agentProgress','briefingMs','recapFloorMs','resultDigest',
    'agentLabels','labelAsName','failureCause','changeSummary','approvalDescription'],
  'Status bar':['statusline','density','context','notify','notifyDesktop'],
  Input:['mouse','prefixKey','refreshMs'],
};
const GENERATION_PERMISSIONS = ['briefAgents','briefMain','agentProgress','resultDigest','agentLabels',
  'failureCause','changeSummary','approvalDescription'] as const;

/**
 * Return a new draft restoring just this group's explicit preference fields.
 * LLM reset is deliberately conservative: disable all generation and pause,
 * rather than restoring enabled defaults that could grant new permissions.
 * Backend, endpoint, credentials, model IDs/reasoning and call cap are never reset.
 * The caller owns confirmation/messages and persistence; these helpers perform no I/O.
 */
export function resetSettingsGroup(draft:HudSettings,group:string):HudSettings {
  // Unknown sections do not gain reset ownership by accident.
  if (!Object.hasOwn(RESET_FIELDS,group)) return draft;
  const defaults = defaultSettings();
  const patch:Partial<HudSettings> = {};
  for (const key of RESET_FIELDS[group as SettingGroup]) Object.assign(patch,{[key]:defaults[key]});
  if (group === 'LLM') {
    for (const key of GENERATION_PERMISSIONS) patch[key] = false;
    patch.briefingPaused = true;
  }
  return {...draft,...patch};
}

/** Reset known page preferences only, with the same credential and privacy guarantees as a group reset. */
export function resetAllPreferences(draft:HudSettings):HudSettings {
  return (Object.keys(RESET_FIELDS) as SettingGroup[]).reduce(resetSettingsGroup,draft);
}

/**
 * The values ←/→ step through. Key roles offers none, each role the
 * session's subtasks have, and what is set and was saved, so a list from the
 * settings file stays one of them.
 */
export function rowValues(row:SettingRow,state:Pick<SettingsPageState,'draft'|'original'|'roles'>):readonly SettingValue[] {
  // Custom describes the current switches, not a selectable configuration: skip it so a no-op cannot trap cycling.
  if (row.key === 'cardPreset') return CARD_PRESETS.filter(preset => preset !== 'custom');
  if (row.key !== 'importantRoles') return row.values;
  return [...new Set(['',...state.roles ?? [],state.original?.importantRoles ?? '',state.draft.importantRoles])];
}
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
  /** The Back / Save / Reset row, below any main navigation. */
  headerY:number;
  /** Main navigation hit targets, routed by the caller, not settings input. */
  navigationControls:MonitorControl[];
  actions:Array<{action:Exclude<SettingsAction,'test-api'|'diagnostics'>;x:number;width:number}>;
  probeAction?: { y: number; width: number };
}

type DisplayLine = {group:string} | {index:number} | {note:string};

/** Why a selectable row currently has no effect, translated for the selected-row help. */
export function settingInactiveReason(rowOrKey:SettingRow|SettingKey,draft:HudSettings):string|null {
  const key = typeof rowOrKey === 'string' ? rowOrKey : rowOrKey.key;
  const row = typeof rowOrKey === 'string' ? SETTING_ROWS.find(entry => entry.key === key) : rowOrKey;
  if (row?.group === 'Cards') {
    if (draft.panelStyle !== 'rich') return t('Requires rich card layout');
    if ((key === 'cardSubagentSummary' || key === 'cardSubagentScope') && !draft.cardSubagents) return t('Requires child agent lines');
    if (key === 'cardOriginalName' && (!draft.cardLabel || !draft.agentLabels || !draft.labelAsName)) return t('Requires task label and names replacing Codex names');
    if (key === 'cardLabel' && !draft.agentLabels) return t('Requires agent names enabled');
  }
  // The pace configures periodic work only, not on-demand card progress.
  if (key === 'briefingMs' && !draft.briefAgents && !draft.briefMain && !draft.changeSummary) return t('Requires periodic agent brief, main recap or change summary');
  if (row?.group === 'LLM' && !['briefing','briefingMs','modelCallsPerHour'].includes(key)) {
    if (draft.briefing === 'off') return t('Model backend is off; nothing is sent');
    if (key !== 'briefingPaused' && draft.briefingPaused) return t('Model generation is paused; stored text remains');
    if (key === 'agentProgress') {
      if (draft.panelStyle !== 'rich') return t('Requires rich card layout');
      if (!draft.cardSummary && !(draft.cardSubagents && draft.cardSubagentSummary)) return t('Requires agent summary or child lines with summaries');
    }
  }
  if (key === 'agentLog' && draft.briefing !== 'off') return t('Log is always shown with a model backend');
  if (key === 'art' && !draft.artImage) return t('Requires a picture set with codex-hud-art');
  return null;
}

/**
 * Section headings interleaved with the rows they head, in reading order,
 * and under Backend, while it is off, the note saying why the rows below
 * it are dim.
 */
function displayLines(draft:HudSettings):DisplayLine[] {
  return SETTING_ROWS.flatMap((row,index):DisplayLine[] => [
    ...(index === 0 || SETTING_ROWS[index-1].group !== row.group ? [{group:row.group}] : []),
    {index},
    ...(row.key === 'briefing' && draft.briefing === 'off' ? [{note:'takes effect with a backend'}] : []),
  ]);
}

function valueText(row:SettingRow,value:SettingValue,narrow:boolean):string {
  const text = typeof value === 'boolean' ? value ? 'on' : 'off' : row.format ? row.format(value) : String(value);
  if (row.literal && value !== '') return text;
  // Chinese words are short already; the narrow English forms are for English.
  return narrow && language() === 'en' ? NARROW_VALUES[text] ?? text : t(text);
}

/**
 * Labels stay left and values use the actual pane's right edge. At wide
 * widths a fixed help column takes the final fifth; the remaining space
 * still grows with the pane rather than packing label and value together.
 */
function rowLine(row:SettingRow,value:SettingValue,selected:boolean,dirty:boolean,dim:boolean,width:number,hintAt:number):{text:string;back?:number} {
  const gutter = `${selected ? '›' : ' '}${dirty ? '*' : ' '} `;
  const shown = valueText(row,value,width < 24);
  const label = t(width < 24 ? row.short : row.label);
  const changed = rowValue(row,defaultSettings()) !== value;
  const paintValue = dim ? colors.dim : changed ? theme.accent : (s:string) => s;
  const edge = (hintAt ? hintAt-2 : width)-(width < 24 ? 0 : 1);
  const chevrons = selected && visualLength(gutter)+visualLength(label)+1+visualLength(shown)+4 <= edge;
  const fittedValue = truncateAnsi(shown,Math.max(0,edge-visualLength(gutter)-1-(chevrons ? 4 : 0)));
  const tailWidth = visualLength(fittedValue)+(chevrons ? 4 : 0);
  const name = truncateAnsi(label,Math.max(0,edge-visualLength(gutter)-tailWidth-1));
  const pad = ' '.repeat(Math.max(1,edge-visualLength(gutter)-visualLength(name)-tailWidth));
  const drawn = chevrons ? `${colors.dim('‹')} ${dim ? colors.dim(fittedValue) : theme.strong(fittedValue)} ${colors.dim('›')}` : paintValue(fittedValue);
  const hint = hintAt ? ' '.repeat(width < 24 ? 2 : 3)+colors.dim(truncateAnsi(t(row.help),width-hintAt)) : '';
  const text = `${selected ? theme.accent('›') : ' '}${dirty ? theme.warning('*') : ' '} ${dim ? colors.dim(name) : name}${pad}${drawn}${hint}`;
  return {text:selected ? theme.selected(text) : text,back:chevrons ? visualLength(gutter)+visualLength(name)+visualLength(pad) : undefined};
}

/** Fit even CJK and ANSI navigation/preview lines to real terminal columns. */
function fitLine(line:string,width:number):string {
  const text = truncateAnsi(line,width);
  return text+' '.repeat(Math.max(0,width-visualLength(text)));
}

/** Where a failed read happened, in the words of the health row. */
const HEALTH_SOURCES: Record<string,string> = {
  session:'Session lookup',rollout:'Session read',tree:'Agent tree',status:'Status',git:'Git',worktrees:'Worktrees',
};

/**
 * The panel's own reads, in one row: "HUD read the session 2s ago", and the latest
 * failure when there has been one, so a quiet session and a HUD that cannot
 * read stop looking alike. A failure newer than the last good read is the
 * current state and is painted as a warning; an older one is history.
 */
export function healthLine(health:HudHealthState|undefined,nowMs:number):string|null {
  if (health?.sessionBound === false) return theme.warning(t('No Codex session bound'));
  if (!health?.lastReadAt && !health?.lastError) return null;
  const read = health.lastReadAt ? t('HUD read the session {age} ago',{age:age(health.lastReadAt,nowMs)}) : t('No read yet');
  const error = health.lastError;
  if (!error) return colors.dim(read);
  const failure = t('{source} failed {age} ago: {reason}',{source:t(HEALTH_SOURCES[error.source] ?? error.source),
    age:age(error.at,nowMs),reason:error.message});
  const current = !health.lastReadAt || error.at.getTime() >= health.lastReadAt.getTime();
  return current ? theme.warning(`${read} · ${failure}`) : colors.dim(`${read} · ${failure}`);
}

/** Model calls so far today and in the last hour, against the cap; null before the first call. */
export function modelCallsLine(usage:{today:number;lastHour:number;cap:number}|undefined):string|null {
  if (!usage || !usage.today) return null;
  const text = t('Model calls today: {n} · last hour {h}/{cap}',{n:usage.today,h:usage.lastHour,cap:usage.cap});
  return usage.lastHour >= usage.cap ? theme.warning(text) : colors.dim(text);
}

/** The rows whose value the panel's top shows: the bar and the pane titles. */
const PREVIEWED: ReadonlySet<SettingKey> = new Set<SettingKey>(['theme','paneLayout','look','icons']);
/** The fewest rows the list keeps when a preview takes some of the page. */
const LIST_MIN = 6;

/** A section's heading: its title on a dim rule across the page. */
function heading(title:string,width:number):string {
  const text = ` ${t(title)} `;
  return colors.dim(`──${text}${'─'.repeat(Math.max(0,width-2-visualLength(text)))}`);
}

/**
 * The page. `preview`, given, draws the panel's top (its bar and a pane's
 * title) as a draft would: while a row it shows is selected, that goes at
 * the foot above the row's help, so a look, its icons or a theme can be
 * seen before it is saved.
 */
export function renderSettingsPage(state:SettingsPageState,width:number,height:number,
  health?:{state:HudHealthState|undefined;nowMs?:number;modelCalls?:{today:number;lastHour:number;cap:number};probe?:ModelProbeState},
  preview?:(draft:HudSettings,width:number)=>string[],
  navigation?:{lines:string[];controls:MonitorControl[]}):SettingsFrame {
  width = Math.max(0,Math.floor(width));
  height = Math.max(0,Math.floor(height));
  const navLines = navigation?.lines.slice(0,height) ?? [];
  const headerY = navLines.length;
  const available = Math.max(0,height-headerY);
  const healthRow = health && available > 3 ? healthLine(health.state,health.nowMs ?? Date.now()) : null;
  const callsRow = health && available > 4 ? modelCallsLine(health.modelCalls) : null;
  const selected = Math.min(SETTING_ROWS.length-1,Math.max(0,state.selected));
  const probe = health?.probe;
  const probeRows = probe && SETTING_ROWS[selected].group === 'LLM' && available > 8 ? [
    t(probe.running ? '[Cancel test]' : '[Test API]'),
    t('Synthetic messages only; counts toward call cap'),
    ...(probe.unavailable ? [t('Select API backend to test')] : probe.rows.map(row =>
      `${row.tier}: ${row.status === 'failed' ? t(PROBE_FAILURES[row.failure ?? ''] ?? 'Model request failed') : t(row.status)}${row.elapsedMs !== undefined ? ` ${row.elapsedMs}ms` : ''} · ${monitorText(row.model)}`)),
  ] : [];
  const reason = settingInactiveReason(SETTING_ROWS[selected],state.draft);
  const footerCount = Math.min(2,Math.max(0,available-1));
  const reasonLines = reason && available > 3 ? flowLines(reason,width).slice(0,Math.max(0,available-1-footerCount-(healthRow ? 1 : 0)-(callsRow ? 1 : 0))) : [];
  const rest = Math.max(0,available-1-footerCount-reasonLines.length-(healthRow ? 1 : 0)-(callsRow ? 1 : 0)-probeRows.length);
  const drawn = preview && PREVIEWED.has(SETTING_ROWS[selected].key) ? preview(state.draft,width) : [];
  const shown = drawn.length && rest-1-drawn.length >= LIST_MIN ? [heading('Preview',width),...drawn] : [];
  const count = Math.max(0,rest-shown.length);
  const DISPLAY = displayLines(state.draft);
  const hintAt = width >= 70 ? Math.max(60,Math.floor(width*0.8)) : 0;
  const at = DISPLAY.findIndex(line => 'index' in line && line.index === selected);
  // Scroll by screen line, keeping the selected row's heading in view with it.
  const top = at > 0 && 'group' in DISPLAY[at-1] ? at-1 : at;
  let offset = Math.min(Math.max(0,state.offset),Math.max(0,DISPLAY.length-count));
  if (top < offset) offset = top;
  if (count && at >= offset+count) offset = at-count+1;
  const original = state.original ?? {...state.draft};
  const dirty = settingsDirty({...state,original});

  const actions: SettingsFrame['actions'] = [];
  let header = '';
  let plainHeader = '';
  for (const [action,key] of [['back','[Back]'],['save','[Save]'],['reset','[Reset group]'],['reset-all','[Reset all]']] as const) {
    const label = t(key);
    const x = visualLength(plainHeader)+(plainHeader ? 1 : 0);
    if (!available || x+visualLength(label) > width) break;
    actions.push({action,x,width:visualLength(label)});
    // Save lights up while there is something to save.
    const paint = action === 'save' ? dirty ? theme.warning : theme.accent : colors.dim;
    header += (header ? ' ' : '')+paint(label);
    plainHeader += (plainHeader ? ' ' : '')+label;
  }
  if (!navigation && width-visualLength(plainHeader) >= 9) header += ` ${theme.strong(t('Settings'))}`;

  const lines = [...navLines,...(available ? [header] : [])];
  const rows: Array<number|null> = lines.map(()=>null);
  let back: SettingsFrame['back'];
  for (let i = 0; i < count; i++) {
    const line = DISPLAY[i+offset];
    if (!line) { lines.push(''); rows.push(null); continue; }
    if ('note' in line) {
      lines.push(colors.dim(truncateAnsi(`     ${t(line.note)}`,width)));
      rows.push(null);
      continue;
    }
    if ('group' in line) {
      lines.push(heading(line.group,width));
      rows.push(null);
      continue;
    }
    const row = SETTING_ROWS[line.index];
    const drawn = rowLine(row,rowValue(row,state.draft),line.index === selected,rowValue(row,original) !== rowValue(row,state.draft),settingInactiveReason(row,state.draft) !== null,width,hintAt);
    if (drawn.back !== undefined) back = {y:lines.length,x:drawn.back};
    lines.push(drawn.text);
    rows.push(line.index);
  }
  if (healthRow) lines.push(healthRow);
  if (callsRow) lines.push(callsRow);
  const probeAction = probeRows.length ? { y: lines.length, width: Math.min(width, visualLength(probeRows[0])) } : undefined;
  lines.push(...probeRows);
  lines.push(...shown);
  lines.push(...reasonLines.map(line => theme.warning(line)));
  if (footerCount > 0) {
    const row = SETTING_ROWS[selected];
    lines.push(state.message ? theme.accent(state.message) : colors.dim(t(row.help)));
  }
  if (footerCount > 1) {
    // Save, Reset and Back are the buttons on the top row; only the moves are left to say.
    lines.push(colors.dim(SETTING_ROWS[selected].group === 'LLM' && probe ? t('t: test/cancel API · d: diagnostics') : width < 30 ? '↑↓ ←→' : t('↑↓ select  ←→ change')));
  }
  return {
    lines:lines.slice(0,height).map(line => fitLine(line,width)),probeAction,
    state:{...state,original,selected,offset},
    rowStart:headerY+1,rowCount:count,rows:[...rows,...Array(Math.max(0,height-rows.length)).fill(null)].slice(0,height),back,footerY:height-1,actions,headerY,
    navigationControls:(navigation?.controls ?? []).flatMap(control => {
      if (control.y < 0 || control.y >= navLines.length || control.width <= 0) return [];
      const x = Math.max(0,control.x);
      const end = Math.min(width,control.x+control.width);
      return end > x ? [{...control,x,width:end-x}] : [];
    }),
  };
}

export function handleSettingsInput(state:SettingsPageState,input:WorkbenchInput,frame:SettingsFrame):{state:SettingsPageState;action?:SettingsAction} {
  const next = {...state,original:state.original??frame.state.original};
  let key = input.type === 'key' ? input.key : '';
  if (input.type === 'mouse') {
    if (input.button === 'left' && input.y === frame.probeAction?.y && input.x < frame.probeAction.width)
      return {state:next,action:'test-api'};
    if (input.button === 'left' && input.y === frame.headerY) {
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
  if (key === 'diagnostics') return {state:next,action:'diagnostics'};
  if (key === 'next-tab' && settingGroup(next) === 'LLM') return {state:next,action:'test-api'};
  const moved = next.selected;
  if (key === 'down' || key === 'tab') next.selected = Math.min(SETTING_ROWS.length-1,next.selected+1);
  if (key === 'up' || key === 'shift-tab') next.selected = Math.max(0,next.selected-1);
  if (key === 'home') next.selected = 0;
  if (key === 'end') next.selected = SETTING_ROWS.length-1;
  // A status message gives way to the help of the next row looked at.
  if (next.selected !== moved) next.message = '';
  if (key === 'enter' || key === 'left' || key === 'right') {
    const row = SETTING_ROWS[next.selected];
    const values = rowValues(row,next);
    const current = rowValue(row,next.draft);
    let index = values.indexOf(current);
    if (index < 0 && typeof current === 'number') {
      // A number between the steps (an odd width, a dragged border, the old presets): step from where it falls.
      const descending = Number(values[0]) > Number(values[1]);
      const beyond = values.findIndex(value => descending ? Number(value) < current : Number(value) > current);
      index = key === 'left' ? (beyond < 0 ? values.length : beyond) : (beyond < 0 ? values.length-1 : beyond-1);
    } else if (index < 0) {
      // Any other value not among the steps (a pair the file set by hand) steps to the first, or back to the last.
      index = key === 'left' ? 0 : -1;
    }
    const value = values[(index+(key === 'left' ? values.length-1 : 1)+values.length)%values.length];
    next.draft = withRowValue(next.draft,row,value);
    // A look comes with the icons it was drawn with.
    if (row.key === 'look') next.draft.icons = LOOK_ICONS[value as LookName];
    next.message = '';
  }
  return {state:next};
}
