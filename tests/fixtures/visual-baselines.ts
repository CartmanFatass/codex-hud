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
import { stripAnsi, visualLength } from '../../src/render/colors.js';
import { controlBar } from '../../src/render/control-bar.js';
import { initialMonitorState, monitorSettings, renderMonitor, type MonitorState } from '../../src/render/monitor.js';
import {
  renderSettingsPage,
  SETTING_ROWS,
  LOOK_ICONS,
  type SettingsPageState,
} from '../../src/render/settings-page.js';
import { statusCard, sessionState } from '../../src/render/status-block.js';
import { renderSettingsConfirmation, type SettingsConfirmationState } from '../../src/render/settings-confirmation.js';
import { projectDelegation, ProjectionCache } from '../../src/render/delegation/projection.js';
import { renderRows } from '../../src/render/delegation/rows.js';
import { joinFirstLine, statuslineDelegation } from '../../src/render/delegation/statusline.js';
import { panelSay, plainSay } from '../../src/render/delegation/style.js';
import { fit as fitDelegationBar, sessionData as delegationSession } from './b10b-bar.js';
import {
  situationA,
  situationB,
  situationC,
  situationD,
  situationE,
  situationG,
  situationH,
  situationParent,
  type Built,
} from './b10b-delegation.js';
import { delegationAgentsRows } from '../../src/render/delegation/panel.js';
import { FIXED_NOW, at, makeContextUsage, makeHudData, node, treeOf } from './hud-data.js';

export const VISUAL_NOW = FIXED_NOW.getTime();
export const VISUAL_WIDTHS = [32, 40, 48, 56, 80] as const;
export const VISUAL_LANGUAGES = ['en', 'zh'] as const;
export const VISUAL_PRESETS = ['minimal', 'progress', 'monitor'] as const;
export const PANEL_HEIGHT = 32;
export const MENU_HEIGHT = 24;
export const VISUAL_IDS = {
  active: 'visual-active',
  idle: 'visual-idle',
  running: 'visual-running-child',
  failed: 'visual-failed-child',
};

export interface VisualCase {
  name: string;
  language: Language;
  look: LookName;
  width: number;
  height: number;
  kind:
    | 'panel'
    | 'settings'
    | 'saved-width'
    | 'confirmation'
    | 'inspector'
    | 'delegation-rows'
    | 'delegation-bar'
    | 'delegation-statusline'
    | 'delegation-panel'
    | 'delegation-view';
  preset: CardPreset;
  progressPhase?: 'queued' | 'running' | 'off' | 'paused';
  saveError?: boolean;
  /** The delegation scenes (B10b): which synthetic situation, and how it is drawn. */
  delegation?: {
    situation: 'c' | 'd' | 'e' | 'g' | 'h' | 'a' | 'b' | 'c-kinds' | 'parent' | 'parent-unconfirmed' | 'parent-cancel';
    /** The panel scenes (B10B-s2): the layout, and the rows the agents pane is given (rich folds to it). */
    style?: 'rich' | 'compact';
    viewport?: number;
    ascii?: boolean;
    /** `a`: finished rows stay on the list. */
    history?: boolean;
    /** The bar's density, and how long after the situation's clock the bar is drawn. */
    density?: 'focus' | 'balanced' | 'full';
    tickMs?: number;
    selected?: string;
  };
}
export interface VisualGolden {
  width: number;
  height: number;
  lines: string[];
}
export interface VisualBaseline {
  version: 1;
  frames: Record<string, VisualGolden>;
}

export function visualSettings(scene: Pick<VisualCase, 'language' | 'look' | 'preset' | 'width'>): HudSettings {
  return applyCardPreset(
    {
      ...defaultSettings(),
      language: scene.language,
      look: scene.look,
      icons: LOOK_ICONS[scene.look],
      glyphs: 'text',
      theme: 'terminal',
      motion: 'reduced',
      treeWidth: scene.width,
      panelStyle: 'rich',
      finishedLingerMs: 0,
      statusCard: 'full',
      briefing: 'api',
      briefMain: true,
      importantRoles: 'implementer,scout',
    },
    scene.preset
  );
}

export function withVisualDisplay<T>(scene: Pick<VisualCase, 'language' | 'look'>, draw: () => T): T {
  const oldLanguage = setLanguage(scene.language);
  const previous = setDisplayConfig({
    density: 'balanced',
    theme: 'terminal',
    glyphs: 'text',
    icons: LOOK_ICONS[scene.look],
    look: scene.look,
    motion: 'reduced',
    context: 'used',
  });
  try {
    return draw();
  } finally {
    setDisplayConfig(previous);
    setLanguage(oldLanguage);
  }
}

export function visualMaterial(language: Language) {
  const zh = language === 'zh';
  const makeNode = (
    id: string,
    name: string,
    status: SubagentTreeNode['status'],
    extra: Partial<SubagentTreeNode>
  ): SubagentTreeNode => ({
    ...node(id, name, status),
    model: 'gpt-6.1-sol',
    effort: 'xhigh',
    lastEventAt: at(-4),
    ...extra,
  });
  const running = makeNode(VISUAL_IDS.running, 'running_子', 'running', {
    depth: 2,
    role: 'team-implementer',
    turnStartedAt: at(-60),
  });
  const failed = makeNode(VISUAL_IDS.failed, 'failed_子', 'error', {
    depth: 2,
    role: 'team-scout',
    statusAt: at(-90),
  });
  const active = makeNode(VISUAL_IDS.active, 'Parser', 'running', {
    label: zh ? '修复 Parser' : 'Parser 修复',
    taskKind: 'fix',
    agentPath: '/root/Parser',
    task: 'RAW_TASK_INSPECTOR_ONLY',
    charge: 'RAW_CHARGE_INSPECTOR_ONLY',
    turnStartedAt: at(-120),
    contextUsage: makeContextUsage(56),
    outputRate: { tokensPerSecond: 42, sampledAt: FIXED_NOW, sampleMs: 10_000 },
    action: { name: 'exec', text: 'npm test -- parser_中文', at: at(-4) },
    peers: { '/root/Reviewer': 1 },
    children: [running, failed],
  });
  const idle = makeNode(VISUAL_IDS.idle, 'Reviewer', 'completed', {
    label: zh ? '空闲审查' : 'Idle 审查',
    taskKind: 'review',
    agentPath: '/root/Reviewer',
    statusAt: at(-45),
    turnStartedAt: at(-180),
    contextUsage: makeContextUsage(24),
  });
  const tree = treeOf([active, idle], 'visual-root');
  const agentLog = new Map<string, AgentLogEntry[]>([
    [
      active.id,
      [
        {
          at: VISUAL_NOW - 10_000,
          kind: 'note',
          lang: language,
          text: zh
            ? '正在验证流式解析器的恢复边界，保留中文路径与完整模型总结，并逐项检查失败子任务的证据，确保窄面板换行后没有丢失最后的结论。'
            : 'Validating streaming parser recovery, preserving 中文 paths and the complete model summary while checking failed-child evidence so narrow panels wrap without losing the final conclusion.',
        },
      ],
    ],
    [
      idle.id,
      [
        {
          at: VISUAL_NOW - 20_000,
          kind: 'note',
          lang: language,
          text: zh ? '审查完成，等待下一轮任务。' : 'Review complete; waiting for the next task.',
        },
      ],
    ],
    [
      running.id,
      [
        {
          at: VISUAL_NOW - 12_000,
          kind: 'note',
          lang: language,
          text: zh ? '正在验证中文边界。' : 'Checking 中文 boundaries.',
        },
      ],
    ],
    [
      failed.id,
      [
        {
          at: VISUAL_NOW - 15_000,
          kind: 'cause',
          lang: language,
          text: zh
            ? '合成测试断言失败。附加证据只在检查器中显示。'
            : 'Synthetic assertion failed. Extra evidence stays in Inspector.',
        },
      ],
    ],
  ]);
  const data = makeHudData({
    subagentTree: tree,
    subagents: [],
    sessionTitle: zh ? '合成解析器项目' : 'Synthetic parser project',
    project: { ...makeHudData().project!, cwd: '/synthetic/parser-kit', projectName: 'parser-kit' },
    session: { ...makeHudData().session!, cwd: '/synthetic/parser-kit', rolloutPath: '/synthetic/not-read.jsonl' },
    git: { ...makeHudData().git!, branch: 'visual/中文', isDirty: true },
  });
  const recap = {
    at: VISUAL_NOW - 30_000,
    coveredUntil: VISUAL_NOW - 30_000,
    sessionId: 'visual-root',
    language,
    goal: zh ? '修复解析器并保留中文边界' : 'Repair parser and preserve 中文 boundaries',
    done: [zh ? '恢复路径已经完成' : 'Recovery path completed'],
    now: zh ? '等待合成测试结果' : 'Waiting for synthetic tests',
    needs: zh ? '确认失败断言' : 'Inspect failed assertion',
  };
  return {
    tree,
    agentLog,
    data,
    brief: { recap, overall: zh ? '解析与审查并行推进' : 'Parser and review moving together' },
  };
}

export function visualState(settings: HudSettings): MonitorState {
  const state = { ...initialMonitorState(), ...monitorSettings(settings) };
  state.tree = { ...state.tree, selectedId: VISUAL_IDS.active, showAll: true };
  return state;
}

/** Caller supplies display/language using withVisualDisplay; permits stateful reflow tests. */
export function renderVisualPanel(scene: VisualCase, state = visualState(visualSettings(scene))) {
  const material = visualMaterial(scene.language);
  return renderMonitor({
    ...material,
    state,
    width: scene.width,
    height: scene.height,
    nowMs: VISUAL_NOW,
    status: (now) => statusCard(material.data, now),
    session: (now) => sessionState(material.data, now),
    progress: new Map([[VISUAL_IDS.active, { phase: 'running', running: true }]]),
    progressContext: { backendOn: true, paused: false, enabled: true, targets: new Set([VISUAL_IDS.active]) },
  });
}

export function renderVisualMenu(scene: VisualCase, state?: SettingsPageState) {
  const draft = visualSettings(scene);
  // The selected child-role row captures Cards, its dependency/help, and the
  // value column; the saved-width variant captures Width and its new right edge.
  const selected = SETTING_ROWS.findIndex(
    (row) => row.key === (scene.kind === 'saved-width' ? 'treeWidth' : 'cardRoleCounts')
  );
  const page = state ?? { draft, original: { ...draft }, selected, offset: 0, message: '' };
  const nav = controlBar(
    visualState(draft),
    { expired: 0, settingsActive: true, brief: { paused: false } },
    scene.width
  );
  return renderSettingsPage(page, scene.width, scene.height, undefined, undefined, nav);
}

export function visualConfirmationState(scene: VisualCase): SettingsConfirmationState {
  return scene.saveError
    ? {
        choice: 'save',
        error:
          scene.language === 'zh'
            ? '保存失败：合成权限错误，请重试。'
            : 'Save failed: synthetic permission denied; try again.',
      }
    : { choice: 'cancel' };
}

export function renderVisualConfirmation(scene: VisualCase) {
  const base = renderVisualMenu(scene);
  return renderSettingsConfirmation(
    base.lines,
    visualConfirmationState(scene),
    scene.width,
    scene.height,
    base.headerY
  );
}

export function renderVisualInspector(scene: VisualCase) {
  const material = visualMaterial(scene.language);
  const state = visualState(visualSettings(scene));
  state.focus = 'details';
  state.modes = { agents: 'closed', timeline: 'closed', changes: 'closed', details: 'open' };
  const legacy = scene.progressPhase === 'off';
  const note: AgentLogEntry = {
    at: VISUAL_NOW - 10_000,
    kind: 'note',
    lang: scene.language,
    text:
      scene.language === 'zh'
        ? '模型总结：正在验证中文恢复边界，已有文字在暂停模型或后端关闭后仍然保留。'
        : 'Model summary: validating 中文 recovery boundaries; stored words remain when models pause or the backend is off.',
    ...(!legacy ? { coverageAt: VISUAL_NOW - 10_000, generatedAt: VISUAL_NOW - 5_000 } : {}),
  };
  material.agentLog.set(VISUAL_IDS.active, [note]);
  const progress: ProgressState = {
    phase: scene.progressPhase === 'running' ? 'running' : 'queued',
    running: scene.progressPhase === 'running',
    coverageAt: VISUAL_NOW - 10_000,
  };
  const progressContext: ProgressContext = {
    backendOn: scene.progressPhase !== 'off',
    paused: scene.progressPhase === 'paused',
    enabled: true,
    targets: new Set([VISUAL_IDS.active]),
  };
  return renderMonitor({
    ...material,
    state,
    width: scene.width,
    height: scene.height,
    nowMs: VISUAL_NOW,
    progress: new Map([[VISUAL_IDS.active, progress]]),
    progressContext,
  });
}

const DELEGATION_SITUATIONS: Record<NonNullable<VisualCase['delegation']>['situation'], () => Built> = {
  c: situationC,
  d: situationD,
  e: situationE,
  g: situationG,
  h: situationH,
  a: situationA,
  b: situationB,
  'c-kinds': () => situationC({ reviewPass: true, nativeMeta: true }),
  parent: () => situationParent('offline'),
  'parent-unconfirmed': () => situationParent('unconfirmed'),
  'parent-cancel': () => situationParent('cancel'),
};

/** The text of a delegation frame, padded to the frame's exact size (`lines` is what a golden keeps). */
function padFrame(lines: readonly string[], scene: Pick<VisualCase, 'width' | 'height'>): string[] {
  const blank = ' '.repeat(scene.width);
  const out = lines.slice(0, scene.height);
  while (out.length < scene.height) out.push(blank);
  return out;
}

/** The delegation rows, bar and statusline at the pinned clock (design §3.4, §4.1, §4.12). */
export function renderVisualDelegation(scene: VisualCase): { lines: string[] } {
  const spec = scene.delegation!;
  const built = DELEGATION_SITUATIONS[spec.situation]();
  const ascii = spec.ascii === true;
  if (scene.kind === 'delegation-rows') {
    const proj = projectDelegation(built.vm, new ProjectionCache());
    const rows = renderRows(
      proj,
      { nowMs: VISUAL_NOW, showHistory: spec.history === true },
      { width: scene.width, ascii, say: panelSay, selectedKey: spec.selected ? built.keys[spec.selected] : null }
    );
    return { lines: padFrame(rows, scene) };
  }
  if (scene.kind === 'delegation-view') {
    // The agents view alone (B10B-s2): parent row, summary row, the tree or the cards, with a selection.
    const rows = delegationAgentsRows(built.vm, {
      width: scene.width,
      nowMs: VISUAL_NOW,
      style: spec.style ?? 'compact',
      selectedId: spec.selected ? built.keys[spec.selected] : null,
      showHistory: spec.history === true,
      ascii,
      say: panelSay,
      viewport: spec.viewport,
    });
    return {
      lines: padFrame(
        rows.map((row) => row.text),
        scene
      ),
    };
  }
  if (scene.kind === 'delegation-panel') {
    // The whole panel through `renderMonitor` with `hud.delegation` set: the hook, the pinned rows, the accordion.
    const settings = visualSettings(scene);
    const state = visualState(settings);
    state.style = spec.style ?? 'rich';
    state.tree = { ...state.tree, showAll: spec.history === true, selectedId: null };
    const material = visualMaterial(scene.language);
    return renderMonitor({
      ...material,
      tree: { ...material.tree, nodes: [] },
      hud: { ...material.data, delegation: built.vm },
      state,
      width: scene.width,
      height: scene.height,
      nowMs: VISUAL_NOW,
      status: (now) => statusCard(material.data, now),
      session: (now) => sessionState(material.data, now),
    });
  }
  if (scene.kind === 'delegation-bar') {
    const tick = VISUAL_NOW + (spec.tickMs ?? 0);
    const result = fitDelegationBar(delegationSession(built.vm, tick), scene.width, spec.density ?? 'balanced', {
      tickMs: tick,
      ascii,
    });
    return { lines: padFrame([result.line + ' '.repeat(Math.max(0, scene.width - visualLength(result.line)))], scene) };
  }
  // The statusline: the session's first line with the count at its end, then the second line.
  const wide = scene.width >= 100;
  const first = ascii
    ? 'fable-5.1 ===------ 41% | parser-kit | $1.24 | > Edit parser.ts'
    : wide
      ? 'fable-5.1 high ━━━━╸───── 112.3K/272K │ parser-kit main*↑2 │ $1.24 · 38 tok/s · 12m │ ▸ Edit src/parser.ts'
      : 'fable-5.1 ━━━━╸───── 41% │ parser-kit │ $1.24 │ ▸ Edit parser.ts';
  const parts = statuslineDelegation(built.vm, { width: scene.width, nowMs: VISUAL_NOW, ascii, say: panelSay });
  const lines = [joinFirstLine(first, parts.counts, scene.width, ascii)];
  if (parts.line2 !== null) lines.push(parts.line2);
  return {
    lines: padFrame(
      lines.map((line) => line + ' '.repeat(Math.max(0, scene.width - visualLength(line)))),
      scene
    ),
  };
}

export function renderVisualCase(scene: VisualCase) {
  switch (scene.kind) {
    case 'delegation-rows':
    case 'delegation-bar':
    case 'delegation-statusline':
    case 'delegation-panel':
    case 'delegation-view':
      return renderVisualDelegation(scene);
    case 'panel':
      return renderVisualPanel(scene);
    case 'confirmation':
      return renderVisualConfirmation(scene);
    case 'inspector':
      return renderVisualInspector(scene);
    default:
      return renderVisualMenu(scene);
  }
}

export function visualCases(): VisualCase[] {
  const cases: VisualCase[] = [];
  for (const language of VISUAL_LANGUAGES)
    for (const look of LOOKS)
      for (const width of VISUAL_WIDTHS) {
        for (const preset of VISUAL_PRESETS)
          cases.push({
            name: `panel/${language}/${look}/${preset}/${width}x${PANEL_HEIGHT}`,
            kind: 'panel',
            language,
            look,
            preset,
            width,
            height: PANEL_HEIGHT,
          });
        cases.push({
          name: `settings/${language}/${look}/active-settings/${width}x${MENU_HEIGHT}`,
          kind: 'settings',
          language,
          look,
          preset: 'monitor',
          width,
          height: MENU_HEIGHT,
        });
      }
  // Pure post-Save layout: no settings file or real terminal resize is needed.
  for (const language of VISUAL_LANGUAGES)
    for (const look of LOOKS)
      cases.push({
        name: `settings/${language}/${look}/saved-width-40-to-56/56x${MENU_HEIGHT}`,
        kind: 'saved-width',
        language,
        look,
        preset: 'progress',
        width: 56,
        height: MENU_HEIGHT,
      });
  for (const language of VISUAL_LANGUAGES) {
    for (const width of [16, 24, 40, 56])
      cases.push({
        name: `confirmation/${language}/cancel/${width}x${MENU_HEIGHT}`,
        kind: 'confirmation',
        language,
        look: 'tab',
        preset: 'monitor',
        width,
        height: MENU_HEIGHT,
      });
    cases.push({
      name: `confirmation/${language}/save-error/48x${MENU_HEIGHT}`,
      kind: 'confirmation',
      saveError: true,
      language,
      look: 'tab',
      preset: 'monitor',
      width: 48,
      height: MENU_HEIGHT,
    });
    for (const progressPhase of ['queued', 'running', 'off'] as const)
      for (const width of [32, 48, 80])
        cases.push({
          name: `inspector/${language}/${progressPhase}${progressPhase === 'off' ? '-legacy-recorded' : '-explicit-coverage'}/${width}x32`,
          kind: 'inspector',
          progressPhase,
          language,
          look: 'tab',
          preset: 'monitor',
          width,
          height: 32,
        });
    cases.push({
      name: `inspector/${language}/paused-explicit-coverage/48x32`,
      kind: 'inspector',
      progressPhase: 'paused',
      language,
      look: 'tab',
      preset: 'monitor',
      width: 48,
      height: 32,
    });
  }
  // Delegation (B10b), appended after every earlier case so the existing frames keep their place.
  cases.push(...delegationCases());
  return cases;
}

/** Rows each situation draws, so a frame has exactly the height it needs (and a changed plan fails loudly). */
const DELEGATION_ROWS = { c: 6, d: 8, e: 7, g: 3, 'g-history': 8, h: 5 } as const;

function delegationCases(): VisualCase[] {
  type Spec = NonNullable<VisualCase['delegation']>;
  const cases: VisualCase[] = [];
  const add = (
    kind: Extract<VisualCase['kind'], `delegation-${string}`>,
    language: Language,
    label: string,
    width: number,
    height: number,
    delegation: Spec
  ) =>
    cases.push({
      name: `delegation/${kind.slice('delegation-'.length)}/${language}/${label}/${width}x${height}`,
      kind,
      language,
      look: 'tab',
      preset: 'monitor',
      width,
      height,
      delegation,
    });
  const rows = (
    language: Language,
    situation: keyof typeof DELEGATION_ROWS & Spec['situation'],
    widths: number[],
    extra: Partial<Spec> = {},
    label?: string
  ) => {
    const key = extra.history ? (`${situation}-history` as keyof typeof DELEGATION_ROWS) : situation;
    for (const width of widths)
      add(
        'delegation-rows',
        language,
        label ?? `${situation}${extra.ascii ? '-ascii' : ''}`,
        width,
        DELEGATION_ROWS[key],
        { situation, ...extra }
      );
  };
  rows('en', 'c', [80, 56, 48, 40, 32]);
  rows('en', 'c', [48], { selected: 'review-tests' }, 'c-selected');
  rows('en', 'd', [48, 32]);
  rows('en', 'e', [80, 48, 32]);
  rows('en', 'g', [48]);
  rows('en', 'g', [48], { history: true }, 'g-history');
  rows('en', 'h', [48, 32]);
  rows('zh', 'c', [48]);
  rows('zh', 'e', [48]);
  rows('zh', 'h', [32]);
  rows('en', 'c', [48], { ascii: true });
  rows('en', 'e', [32], { ascii: true });
  rows('en', 'd', [48], { ascii: true });

  // The bar, one line, at the width's usual density (the 80-column frames are `focus`, which keeps the agents'
  // counts when there is a tree). The approval has waited 100 s in the frames that show the alert alone;
  // `d-fresh` is drawn ten seconds after it began, so the notice sentence is up beside the badge's counts.
  const bar = (
    situation: Spec['situation'],
    label: string,
    width: number,
    density: NonNullable<Spec['density']>,
    extra: Partial<Spec> = {}
  ) => add('delegation-bar', 'en', label, width, 1, { situation, density, tickMs: 90_000, ...extra });
  bar('c', 'c', 200, 'full');
  bar('c', 'c', 120, 'balanced');
  bar('c', 'c', 80, 'focus');
  bar('d', 'd-fresh', 200, 'full', { tickMs: 0 });
  bar('c', 'c-ascii', 120, 'balanced', { ascii: true });
  bar('d', 'd', 200, 'full');
  bar('d', 'd', 80, 'focus');
  bar('e', 'e', 120, 'balanced');
  bar('e', 'e', 80, 'focus');
  bar('h', 'h', 120, 'balanced');
  bar('h', 'h', 80, 'focus');

  // The statusline: the first line with the count at its end, then the second line (2 rows).
  const line = (language: Language, situation: Spec['situation'], width: number, extra: Partial<Spec> = {}) =>
    add('delegation-statusline', language, `${situation}${extra.ascii ? '-ascii' : ''}`, width, 2, {
      situation,
      ...extra,
    });
  for (const width of [80, 120, 200]) line('en', 'c', width);
  for (const width of [80, 120]) line('en', 'd', width);
  line('en', 'e', 80);
  for (const width of [80, 120]) line('en', 'h', width);
  line('zh', 'c', 120);
  line('en', 'c', 80, { ascii: true });

  // The panel's delegation view (B10B-s2): scenarios (a)-(h) at their stated widths, the parent row, ZH and ASCII.
  const view = (language: Language, label: string, width: number, height: number, delegation: Spec) =>
    add('delegation-view', language, label, width, height, delegation);
  view('en', 'a-rich', 48, 3, { situation: 'a', style: 'rich' });
  view('en', 'b-rich', 48, 10, { situation: 'b', style: 'rich' });
  view('en', 'b-compact', 48, 6, { situation: 'b', style: 'compact' });
  view('en', 'c-rich', 48, 19, { situation: 'c-kinds', style: 'rich' });
  view('en', 'c-rich-selected', 80, 19, { situation: 'c-kinds', style: 'rich', selected: 'impl-parser' });
  view('en', 'c-compact-selected', 48, 10, { situation: 'c-kinds', style: 'compact', selected: 'review-tests' });
  view('en', 'c-compact-chip', 56, 8, { situation: 'c-kinds', style: 'compact' });
  view('en', 'c-compact-selected', 32, 10, { situation: 'c-kinds', style: 'compact', selected: 'review-tests' });
  view('en', 'd-compact', 48, 11, { situation: 'd', style: 'compact', selected: 't-11' });
  view('en', 'd-rich-accordion', 48, 16, { situation: 'd', style: 'rich', selected: 't-07', viewport: 16 });
  view('en', 'e-compact', 48, 10, { situation: 'e', style: 'compact', selected: 'impl-d' });
  view('en', 'e-rich', 48, 25, { situation: 'e', style: 'rich', selected: 'impl-b' });
  view('en', 'g-compact', 48, 4, { situation: 'g', style: 'compact' });
  view('en', 'g-history', 48, 11, { situation: 'g', style: 'compact', history: true, selected: 'soak' });
  view('en', 'h-rich', 48, 19, { situation: 'h', style: 'rich', selected: 'impl-parser' });
  view('en', 'h-compact', 48, 8, { situation: 'h', style: 'compact', selected: 'impl-parser' });
  view('en', 'h-compact', 32, 8, { situation: 'h', style: 'compact', selected: 'impl-parser' });
  view('en', 'parent-offline', 48, 4, { situation: 'parent', style: 'compact' });
  view('en', 'parent-unconfirmed', 32, 4, { situation: 'parent-unconfirmed', style: 'compact' });
  view('en', 'parent-cancel', 48, 6, { situation: 'parent-cancel', style: 'rich' });
  view('zh', 'c-rich', 48, 19, { situation: 'c-kinds', style: 'rich' });
  view('zh', 'h-compact', 48, 8, { situation: 'h', style: 'compact', selected: 'impl-parser' });
  view('en', 'c-compact-ascii', 48, 10, {
    situation: 'c-kinds',
    style: 'compact',
    ascii: true,
    selected: 'review-tests',
  });
  view('en', 'b-compact-ascii', 48, 6, { situation: 'b', style: 'compact', ascii: true });
  // The whole panel, through `renderMonitor`: control bar, pinned heading, the agents pane, the status card.
  add('delegation-panel', 'en', 'c-rich', 48, 32, { situation: 'c-kinds', style: 'rich' });
  add('delegation-panel', 'en', 'd-rich-accordion', 48, 24, { situation: 'd', style: 'rich' });
  add('delegation-panel', 'en', 'parent-compact', 48, 24, { situation: 'parent', style: 'compact' });
  return cases;
}

/** Only ANSI is removed. In particular, trailing display cells are not trimmed. */
export function normalizeVisualLines(lines: readonly string[]): string[] {
  return lines.map(stripAnsi);
}

export function generateVisualBaseline(): VisualBaseline {
  const frames: VisualBaseline['frames'] = {};
  for (const scene of visualCases())
    frames[scene.name] = withVisualDisplay(scene, () => ({
      width: scene.width,
      height: scene.height,
      lines: normalizeVisualLines(renderVisualCase(scene).lines),
    }));
  return { version: 1, frames };
}
