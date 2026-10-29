/**
 * Synthetic terminal-cell baselines, not pixel/font screenshots. No collectors,
 * disk reads, clocks or model calls: even request/progress state is a literal.
 * Renderers receive one pinned time; all ambient display knobs are restored.
 */
import { applyCardPreset, type CardPreset } from '../../src/card-presets.js';
import type { AgentLogEntry } from '../../src/collectors/agent-log.js';
import type { ProgressContext, ProgressState } from '../../src/collectors/progress-summary.js';
import type { SubagentTreeNode } from '../../src/types.js';
import { defaultSettings, type HudSettings } from '../../src/settings.js';
import { setDisplayConfig, LOOKS, type LookName } from '../../src/render/hud-config.js';
import { setLanguage, type Language } from '../../src/render/i18n.js';
import { stripAnsi } from '../../src/render/colors.js';
import { controlBar } from '../../src/render/control-bar.js';
import { initialMonitorState, monitorSettings, renderMonitor, type MonitorState } from '../../src/render/monitor.js';
import { renderSettingsPage, SETTING_ROWS, LOOK_ICONS, type SettingsPageState } from '../../src/render/settings-page.js';
import { statusCard, sessionState } from '../../src/render/status-block.js';
import { renderSettingsConfirmation, type SettingsConfirmationState } from '../../src/render/settings-confirmation.js';
import { FIXED_NOW, at, makeContextUsage, makeHudData, node, treeOf } from './hud-data.js';
import { quietOverviewSettings } from '../../src/settings-runtime.js';
import { initialUsagePageState, renderUsagePage, type UsageTab } from '../../src/render/usage-page.js';
import { usageSnapshot } from './usage-data.js';

export const VISUAL_NOW = FIXED_NOW.getTime();
export const VISUAL_WIDTHS = [32, 40, 48, 56, 80] as const;
export const VISUAL_LANGUAGES = ['en', 'zh'] as const;
export const VISUAL_PRESETS = ['minimal', 'progress', 'monitor'] as const;
export const PANEL_HEIGHT = 32;
export const MENU_HEIGHT = 24;
export const VISUAL_IDS = { active: 'visual-active', idle: 'visual-idle', running: 'visual-running-child', failed: 'visual-failed-child' };

export interface VisualCase {
  name: string;
  language: Language;
  look: LookName;
  width: number;
  height: number;
  kind: 'panel' | 'settings' | 'saved-width' | 'confirmation' | 'inspector' | 'usage';
  usageTab?:UsageTab;
  usageStatus?:'partial'|'unavailable';
  preset: CardPreset;
  progressPhase?: 'queued' | 'running' | 'off' | 'paused';
  saveError?: boolean;
}
export interface VisualGolden { width: number; height: number; lines: string[] }
export interface VisualBaseline { version: 1; frames: Record<string, VisualGolden> }

export function visualSettings(scene: Pick<VisualCase, 'language' | 'look' | 'preset' | 'width'>): HudSettings {
  const settings:HudSettings=applyCardPreset<HudSettings>({ ...defaultSettings(), language: scene.language, look: scene.look,
    icons: LOOK_ICONS[scene.look], glyphs: 'text', theme: 'terminal', motion: 'reduced',
    treeWidth: scene.width, panelStyle: 'rich', finishedLingerMs: 0, statusCard: 'full',
    briefing: 'api', briefMain: true, importantRoles: 'implementer,scout' }, scene.preset);
  return scene.look==='quiet'?quietOverviewSettings(settings):settings;
}

export function withVisualDisplay<T>(scene: Pick<VisualCase, 'language' | 'look'>, draw: () => T): T {
  const oldLanguage = setLanguage(scene.language);
  const previous = setDisplayConfig({ density: 'balanced', theme: 'terminal', glyphs: 'text',
    icons: LOOK_ICONS[scene.look], look: scene.look, motion: 'reduced', context: 'used' });
  try { return draw(); } finally { setDisplayConfig(previous); setLanguage(oldLanguage); }
}

export function visualMaterial(language: Language) {
  const zh = language === 'zh';
  const makeNode = (id: string, name: string, status: SubagentTreeNode['status'], extra: Partial<SubagentTreeNode>): SubagentTreeNode =>
    ({ ...node(id, name, status), model: 'gpt-6.1-sol', effort: 'xhigh', lastEventAt: at(-4), ...extra });
  const running = makeNode(VISUAL_IDS.running, 'running_子', 'running', {
    depth: 2, role: 'team-implementer', turnStartedAt: at(-60),
  });
  const failed = makeNode(VISUAL_IDS.failed, 'failed_子', 'error', {
    depth: 2, role: 'team-scout', statusAt: at(-90),
  });
  const active = makeNode(VISUAL_IDS.active, 'Parser', 'running', {
    label: zh ? '修复 Parser' : 'Parser 修复', taskKind: 'fix', agentPath: '/root/Parser',
    task: 'RAW_TASK_INSPECTOR_ONLY', charge: 'RAW_CHARGE_INSPECTOR_ONLY',
    turnStartedAt: at(-120), contextUsage: makeContextUsage(56),
    outputRate: { tokensPerSecond: 42, sampledAt: FIXED_NOW, sampleMs: 10_000 },
    action: { name: 'exec', text: 'npm test -- parser_中文', at: at(-4) },
    peers: { '/root/Reviewer': 1 }, children: [running, failed],
  });
  const idle = makeNode(VISUAL_IDS.idle, 'Reviewer', 'completed', {
    label: zh ? '空闲审查' : 'Idle 审查', taskKind: 'review', agentPath: '/root/Reviewer',
    statusAt: at(-45), turnStartedAt: at(-180), contextUsage: makeContextUsage(24),
  });
  const tree = treeOf([active, idle], 'visual-root');
  const agentLog = new Map<string, AgentLogEntry[]>([
    [active.id, [{ at: VISUAL_NOW - 10_000, kind: 'note', lang: language,
      text: zh ? '正在验证流式解析器的恢复边界，保留中文路径与完整模型总结，并逐项检查失败子任务的证据，确保窄面板换行后没有丢失最后的结论。'
        : 'Validating streaming parser recovery, preserving 中文 paths and the complete model summary while checking failed-child evidence so narrow panels wrap without losing the final conclusion.' }]],
    [idle.id, [{ at: VISUAL_NOW - 20_000, kind: 'note', lang: language,
      text: zh ? '审查完成，等待下一轮任务。' : 'Review complete; waiting for the next task.' }]],
    [running.id, [{ at: VISUAL_NOW - 12_000, kind: 'note', lang: language,
      text: zh ? '正在验证中文边界。' : 'Checking 中文 boundaries.' }]],
    [failed.id, [{ at: VISUAL_NOW - 15_000, kind: 'cause', lang: language,
      text: zh ? '合成测试断言失败。附加证据只在检查器中显示。' : 'Synthetic assertion failed. Extra evidence stays in Inspector.' }]],
  ]);
  const data = makeHudData({ subagentTree: tree, subagents: [], sessionTitle: zh ? '合成解析器项目' : 'Synthetic parser project',
    project: { ...makeHudData().project!, cwd: '/synthetic/parser-kit', projectName: 'parser-kit' },
    session: { ...makeHudData().session!, cwd: '/synthetic/parser-kit', rolloutPath: '/synthetic/not-read.jsonl' },
    git: { ...makeHudData().git!, branch: 'visual/中文', isDirty: true } });
  const recap = { at: VISUAL_NOW - 30_000, coveredUntil: VISUAL_NOW - 30_000,
    sessionId: 'visual-root', language,
    goal: zh ? '修复解析器并保留中文边界' : 'Repair parser and preserve 中文 boundaries',
    done: [zh ? '恢复路径已经完成' : 'Recovery path completed'],
    now: zh ? '等待合成测试结果' : 'Waiting for synthetic tests',
    needs: zh ? '确认失败断言' : 'Inspect failed assertion' };
  return { tree, agentLog, data, brief: { recap, overall: zh ? '解析与审查并行推进' : 'Parser and review moving together' } };
}

export function visualState(settings: HudSettings): MonitorState {
  const state = { ...initialMonitorState(), ...monitorSettings(settings) };
  state.tree = { ...state.tree, selectedId: VISUAL_IDS.active, showAll: true };
  return state;
}

/** Caller supplies display/language using withVisualDisplay; permits stateful reflow tests. */
export function renderVisualPanel(scene: VisualCase, state = visualState(visualSettings(scene))) {
  const material = visualMaterial(scene.language);
  return renderMonitor({ ...material, state, width: scene.width, height: scene.height,
    nowMs: VISUAL_NOW, status: now => statusCard(material.data, now), session: now => sessionState(material.data, now),
    progress: new Map([[VISUAL_IDS.active, { phase: 'running', running: true }]]),
    progressContext: { backendOn: true, paused: false, enabled: true, targets: new Set([VISUAL_IDS.active]) } });
}

export function renderVisualMenu(scene: VisualCase, state?: SettingsPageState) {
  const draft = visualSettings(scene);
  // The selected child-role row captures Cards, its dependency/help, and the
  // value column; the saved-width variant captures Width and its new right edge.
  const selected = SETTING_ROWS.findIndex(row => row.key === (scene.kind === 'saved-width' ? 'treeWidth' : 'cardRoleCounts'));
  const page = state ?? { draft, original: { ...draft }, selected, offset: 0, message: '' };
  const nav = controlBar(visualState(draft), { expired: 0, settingsActive: true, brief: { paused: false } }, scene.width);
  return renderSettingsPage(page, scene.width, scene.height, undefined, undefined, nav);
}

export function visualConfirmationState(scene: VisualCase): SettingsConfirmationState {
  return scene.saveError ? { choice: 'save', error: scene.language === 'zh' ? '保存失败：合成权限错误，请重试。' : 'Save failed: synthetic permission denied; try again.' }
    : { choice: 'cancel' };
}

export function renderVisualConfirmation(scene: VisualCase) {
  const base = renderVisualMenu(scene);
  return renderSettingsConfirmation(base.lines, visualConfirmationState(scene), scene.width, scene.height, base.headerY);
}

export function renderVisualInspector(scene: VisualCase) {
  const material = visualMaterial(scene.language);
  const state = visualState(visualSettings(scene));
  state.focus = 'details';
  state.modes = { agents: 'closed', timeline: 'closed', changes: 'closed', details: 'open' };
  const legacy = scene.progressPhase === 'off';
  const note: AgentLogEntry = { at: VISUAL_NOW - 10_000, kind: 'note', lang: scene.language,
    text: scene.language === 'zh' ? '模型总结：正在验证中文恢复边界，已有文字在暂停模型或后端关闭后仍然保留。'
      : 'Model summary: validating 中文 recovery boundaries; stored words remain when models pause or the backend is off.',
    ...(!legacy ? { coverageAt: VISUAL_NOW - 10_000, generatedAt: VISUAL_NOW - 5_000 } : {}) };
  material.agentLog.set(VISUAL_IDS.active, [note]);
  const progress: ProgressState = { phase: scene.progressPhase === 'running' ? 'running' : 'queued',
    running: scene.progressPhase === 'running', coverageAt: VISUAL_NOW - 10_000 };
  const progressContext: ProgressContext = { backendOn: scene.progressPhase !== 'off',
    paused: scene.progressPhase === 'paused', enabled: true, targets: new Set([VISUAL_IDS.active]) };
  return renderMonitor({ ...material, state, width: scene.width, height: scene.height, nowMs: VISUAL_NOW,
    progress: new Map([[VISUAL_IDS.active, progress]]), progressContext });
}

export function renderVisualCase(scene: VisualCase) {
  switch (scene.kind) {
    case 'usage': {
      const snapshot=usageSnapshot();
      if(scene.usageStatus)Object.assign(snapshot,{status:scene.usageStatus,daily:[],tasks:[],models:[],efforts:[],roles:[],
        totals:{input:null,cachedInput:null,output:null,reasoningOutput:null,total:null,events:0,threads:0}});
      return renderUsagePage({...initialUsagePageState(),tab:scene.usageTab??'overview'},snapshot,scene.width,scene.height);
    }
    case 'panel': return renderVisualPanel(scene);
    case 'confirmation': return renderVisualConfirmation(scene);
    case 'inspector': return renderVisualInspector(scene);
    default: return renderVisualMenu(scene);
  }
}

export function visualCases(): VisualCase[] {
  const cases: VisualCase[] = [];
  for (const language of VISUAL_LANGUAGES) for (const look of LOOKS) for (const width of VISUAL_WIDTHS) {
    for (const preset of VISUAL_PRESETS) cases.push({
      name: `panel/${language}/${look}/${preset}/${width}x${PANEL_HEIGHT}`,
      kind: 'panel', language, look, preset, width, height: PANEL_HEIGHT,
    });
    cases.push({ name: `settings/${language}/${look}/active-settings/${width}x${MENU_HEIGHT}`,
      kind: 'settings', language, look, preset: 'monitor', width, height: MENU_HEIGHT });
  }
  // Pure post-Save layout: no settings file or real terminal resize is needed.
  for (const language of VISUAL_LANGUAGES) for (const look of LOOKS) cases.push({
    name: `settings/${language}/${look}/saved-width-40-to-56/56x${MENU_HEIGHT}`,
    kind: 'saved-width', language, look, preset: 'progress', width: 56, height: MENU_HEIGHT,
  });
  for (const language of VISUAL_LANGUAGES) {
    for(const width of VISUAL_WIDTHS)for(const usageTab of ['overview','tasks','models','efforts','roles'] as const)cases.push({
      name:`usage/${language}/${usageTab}/${width}x${PANEL_HEIGHT}`,kind:'usage',usageTab,language,look:'quiet',preset:'minimal',width,height:PANEL_HEIGHT});
    for(const usageStatus of ['partial','unavailable'] as const)for(const usageTab of ['overview','tasks','models'] as const)cases.push({
      name:`usage/${language}/${usageStatus}-empty/${usageTab}/32x${PANEL_HEIGHT}`,kind:'usage',usageTab,usageStatus,language,look:'quiet',preset:'minimal',width:32,height:PANEL_HEIGHT});
    for (const width of [16, 24, 40, 56]) cases.push({
      name: `confirmation/${language}/cancel/${width}x${MENU_HEIGHT}`,
      kind: 'confirmation', language, look: 'tab', preset: 'monitor', width, height: MENU_HEIGHT,
    });
    cases.push({ name: `confirmation/${language}/save-error/48x${MENU_HEIGHT}`,
      kind: 'confirmation', saveError: true, language, look: 'tab', preset: 'monitor', width: 48, height: MENU_HEIGHT });
    for (const progressPhase of ['queued', 'running', 'off'] as const) for (const width of [32, 48, 80]) cases.push({
      name: `inspector/${language}/${progressPhase}${progressPhase === 'off' ? '-legacy-recorded' : '-explicit-coverage'}/${width}x32`,
      kind: 'inspector', progressPhase, language, look: 'tab', preset: 'monitor', width, height: 32,
    });
    cases.push({ name: `inspector/${language}/paused-explicit-coverage/48x32`,
      kind: 'inspector', progressPhase: 'paused', language, look: 'tab', preset: 'monitor', width: 48, height: 32 });
  }
  return cases;
}

/** Only ANSI is removed. In particular, trailing display cells are not trimmed. */
export function normalizeVisualLines(lines: readonly string[]): string[] {
  return lines.map(stripAnsi);
}

export function generateVisualBaseline(): VisualBaseline {
  const frames: VisualBaseline['frames'] = {};
  for (const scene of visualCases()) frames[scene.name] = withVisualDisplay(scene, () => ({
    width: scene.width, height: scene.height,
    lines: normalizeVisualLines(renderVisualCase(scene).lines),
  }));
  return { version: 1, frames };
}
