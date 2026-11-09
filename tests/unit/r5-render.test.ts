/**
 * R5b-ui: facade jobs, helpers and registered external tasks in the existing rows and the Inspector. Every test
 * renders through `renderMonitor` (the call the panel makes) or the Inspector's own entry, with synthetic nodes
 * carrying the exact `JobDisplay` DTO, and asserts what is visible.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { initialMonitorState, monitorSettings, renderMonitor, type MonitorState } from '../../src/render/monitor.js';
import { inspectorRows } from '../../src/render/monitor-inspector.js';
import { visibleRows, countExpired, isExpired } from '../../src/render/panel-state.js';
import { setLanguage, type Language } from '../../src/render/i18n.js';
import { resolveDisplayConfig, setDisplayConfig } from '../../src/render/hud-config.js';
import { stripAnsi, visualLength } from '../../src/render/colors.js';
import type { DelegationView } from '../../src/render/delegation/panel.js';
import { composeJobTree } from '../../src/collectors/job-tree.js';
import { observedEntries, type AgentLogEntry } from '../../src/collectors/agent-log.js';
import { WorkbenchHistory } from '../../src/collectors/workbench-events.js';
import type { JobDisplay } from '../../src/collectors/job-display-types.js';
import type { SubagentTree, SubagentTreeNode } from '../../src/types.js';
import { visualSettings } from '../fixtures/visual-baselines.js';
import {
  R5R_NOW,
  ROOT,
  cliJob,
  externalJob,
  jobDto,
  jobNode,
  jobTree,
  judgeJob,
  oracleJob,
  piJob,
  request,
  stale,
  unavailable,
} from '../fixtures/r5-render-nodes.js';

const WIDTHS = [32, 40, 48, 56] as const;
const LANGUAGES: Language[] = ['en', 'zh'];
const THEMES = ['terminal', 'none'] as const;
const STYLES = ['compact', 'rich'] as const;

interface PanelOptions {
  width: number;
  height?: number;
  language?: Language;
  theme?: (typeof THEMES)[number];
  style?: (typeof STYLES)[number];
  preset?: 'minimal' | 'progress' | 'monitor';
  selected?: string | null;
  /** Open the Inspector alone, on the selected node. */
  inspect?: boolean;
  lingerMs?: number;
  /** Labels as names, the setting; the monitor's own default when left out. */
  labelAsName?: boolean;
  /** Show the tree whole (the default here) or let the linger window take what has settled. */
  showAll?: boolean;
  /** Open the Timeline alone, in this style, fed by the real history producer (`realTimeline`). */
  timeline?: 'rail' | 'indent' | 'lanes';
  /** Icons stand for words (the default) or the words stay. */
  icons?: 'unicode' | 'text';
  /** More of `MonitorData`: the progress context, say. */
  extra?: Partial<Parameters<typeof renderMonitor>[0]>;
}

/** Draw with the language and theme asked for, restoring both; returns the raw lines and their plain text. */
function draw(nodes: SubagentTreeNode[], o: PanelOptions) {
  const language = o.language ?? 'en';
  const oldLanguage = setLanguage(language);
  const oldDisplay = setDisplayConfig({
    ...resolveDisplayConfig({}),
    theme: o.theme ?? 'none',
    glyphs: 'text',
    icons: o.icons ?? 'unicode',
    look: 'tab',
    motion: 'reduced',
  });
  try {
    const settings = visualSettings({ language, look: 'tab', preset: o.preset ?? 'monitor', width: o.width });
    settings.panelStyle = o.style ?? 'compact';
    settings.finishedLingerMs = o.lingerMs ?? 0;
    const state: MonitorState = { ...initialMonitorState(), ...monitorSettings(settings) };
    state.tree = {
      ...state.tree,
      selectedId: o.selected === undefined ? (nodes[0]?.id ?? null) : o.selected,
      showAll: o.showAll ?? true,
    };
    if (o.labelAsName !== undefined) state.labelAsName = o.labelAsName;
    if (o.timeline) {
      state.focus = 'timeline';
      state.modes = { agents: 'closed', timeline: 'open', changes: 'closed', details: 'closed' };
      state.timelineStyle = o.timeline;
      state.timelineHours = 24;
    }
    if (o.inspect) {
      state.focus = 'details';
      state.modes = { agents: 'closed', timeline: 'closed', changes: 'closed', details: 'open' };
      state.preview = 'agent';
    }
    const height = o.height ?? (o.inspect ? 120 : 30);
    const tree = jobTree(nodes);
    const frame = renderMonitor({
      tree,
      state,
      width: o.width,
      height,
      nowMs: R5R_NOW,
      ...(o.timeline ? { timeline: realTimeline(tree) } : {}),
      ...o.extra,
    });
    return { frame, raw: frame.lines, text: frame.lines.map(stripAnsi), height };
  } finally {
    setDisplayConfig(oldDisplay);
    setLanguage(oldLanguage);
  }
}

/**
 * The events the panel's Timeline is drawn from, made by the producers the panel runs: each node's observed log
 * entries (`observedEntries`), then `WorkbenchHistory.timeline`.
 */
function realTimeline(tree: SubagentTree) {
  const logs = new Map<string, AgentLogEntry[]>();
  const walk = (nodes: SubagentTreeNode[]) => {
    for (const node of nodes) {
      logs.set(node.id, observedEntries(node));
      walk(node.children);
    }
  };
  walk(tree.nodes);
  return new WorkbenchHistory().timeline(tree, null, logs);
}

/** The Inspector's text with its frame and spacing taken out, for finding a value however it wrapped. */
const squash = (lines: readonly string[]) => lines.join('').replace(/[│\s]/g, '');

/** Every line is exactly `width` columns, carries no escape but a colour, and the frame has the height asked for. */
function assertWellFormed(d: ReturnType<typeof draw>, width: number, label: string) {
  assert.equal(d.raw.length, d.height, `${label}: height`);
  for (const [i, line] of d.raw.entries()) {
    assert.equal(
      visualLength(line),
      width,
      `${label}: row ${i} is ${visualLength(line)} wide: ${JSON.stringify(stripAnsi(line))}`
    );
    assert.doesNotMatch(line, /\x1b(?!\[[0-9;]*m)/, `${label}: row ${i} holds an escape that is not a colour`);
    assert.doesNotMatch(
      stripAnsi(line),
      /[\x00-\x08\x0a-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/,
      `${label}: row ${i} holds a control`
    );
  }
}

/** The five kinds of job, with the start of the name each must still show. */
function kinds() {
  return [
    { id: 'cli', node: jobNode(cliJob()), probe: 'Fix', role: 'imp' },
    { id: 'pi', node: jobNode(piJob({ name: '修复解析器恢复路径 port' })), probe: '修复', role: 'imp' },
    { id: 'oracle', node: jobNode(oracleJob()), probe: 'Com', role: 'oracle' },
    { id: 'judge', node: jobNode(judgeJob()), probe: 'Jud', role: 'jev' },
    { id: 'external', node: jobNode(externalJob()), probe: 'Man', role: 'herdr' },
  ];
}

// ---------------------------------------------------------------------------
// 1. The matrix
// ---------------------------------------------------------------------------

test('every kind of job fits every width, language, style and colour mode, and its name is cut, not dropped', () => {
  for (const language of LANGUAGES)
    for (const theme of THEMES)
      for (const style of STYLES)
        for (const width of WIDTHS)
          for (const kind of kinds()) {
            const label = `${language}/${theme}/${style}/${width}/${kind.id}`;
            const d = draw([kind.node], { width, language, theme, style });
            assertWellFormed(d, width, label);
            const text = d.text.join('\n');
            if (theme === 'terminal')
              // Below the control bar, whose look is the bar's own.
              assert.deepEqual(
                d.text.slice(2),
                draw([kind.node], { width, language, theme: 'none', style }).text.slice(2),
                `${label}: colour changes the paint, not a word or a column`
              );
            assert.ok(text.includes(kind.probe), `${label}: the name's start is on screen`);
            if (width >= 48) assert.ok(text.includes(kind.role), `${label}: role is named when there is room`);
          }
});

test('role and phase read whole or as the role alone, never cut', () => {
  const node = jobNode(oracleJob());
  for (const style of STYLES)
    for (const width of WIDTHS) {
      const text = draw([node], { width, style }).text.join('\n');
      assert.doesNotMatch(text, /oracle·p(?!ropose)/, `${style}/${width}: the phase is not cut`);
      if (width === 56) assert.match(text, /oracle·propose/, `${style}/${width}: role and phase when there is room`);
    }
});

test('an external task shows its label, "herdr" and its status, and no role, phase or report', () => {
  const node = jobNode(externalJob({ requests: null }));
  for (const style of STYLES) {
    const text = draw([node], { width: 48, style }).text.join('\n');
    assert.match(text, /Manual herdr agent/);
    assert.match(text, /herdr/);
    assert.match(text, /▸/, 'its status glyph');
    assert.doesNotMatch(text, /imp|oracle|reviewer|report/i);
  }
  const inspector = draw([node], { width: 48, inspect: true }).text.join('\n');
  assert.doesNotMatch(inspector, /Role:|Phase:|Preset:|Backend:|Report|Requests/);
});

test('helpers are the job’s children, in the tree and on its card', () => {
  const node = jobNode(piJob());
  const compact = draw([node], { width: 48, style: 'compact' }).text;
  const parent = compact.findIndex((line) => line.includes('Port the recovery path'));
  assert.ok(parent >= 0);
  assert.match(compact[parent + 1], /├─.*Review pass 1/, 'the first helper hangs under the job');
  assert.match(compact[parent + 2], /└─.*Review pass 2/, 'the last helper closes the branch');
  const rich = draw([node], { width: 48, style: 'rich' }).text;
  const top = rich.findIndex((line) => line.includes('Port the recovery path'));
  const helper = rich.findIndex((line) => line.includes('Review pass 1'));
  const bottom = rich.findIndex((line, i) => i > top && line.startsWith('└'));
  assert.ok(top >= 0 && helper > top && helper < bottom, 'the running helper is a line inside its parent’s card');
  assert.match(rich[helper], /reviewer/, 'its role follows its name');
});

test('the card presets keep a job’s name, status and words; a lighter preset sheds only what it hides', () => {
  const node = jobNode(cliJob({ requests: [request('q1')] }));
  for (const preset of ['minimal', 'progress', 'monitor'] as const) {
    const d = draw([node], { width: 48, style: 'rich', preset });
    assertWellFormed(d, 48, preset);
    const text = d.text.join('\n');
    assert.match(text, /▸ Fix parser recovery/, preset);
    assert.match(text, /! imp/, `${preset}: the header carries the role and the attention mark`);
  }
});

test('a job only the facade knows has no session to switch to; a native row it enriched keeps its link', () => {
  const facade = jobNode(cliJob());
  const native = jobNode(cliJob({ id: 'role-job:n1' }), {
    id: 'native-1',
    ref: { harness: 'codex', sourceId: 'a'.repeat(64), sessionId: 'native-1', threadId: null },
    rolloutPath: '/synthetic/rollout.jsonl',
  });
  const switches = (node: SubagentTreeNode) =>
    draw([node], { width: 48, style: 'rich' }).frame.controls.filter((control) => control.kind === 'switch');
  assert.equal(switches(facade).length, 0);
  assert.equal(switches(native).length, 1);
});

// ---------------------------------------------------------------------------
// 2. Freshness is honest
// ---------------------------------------------------------------------------

const CLOCK_FACES = /[◌◷◶◵◴◉]/;

test('a running job whose source is stale or unavailable is never drawn as running, with no live clock', () => {
  for (const freshness of [stale(), unavailable({ lastSuccessfulReadAt: ago(240) })])
    for (const style of STYLES)
      for (const language of LANGUAGES)
        for (const width of WIDTHS) {
          // The node still says "running": the row follows the job's own freshness.
          const node = jobNode(cliJob({ status: 'running', freshness }), { status: 'running' });
          const label = `${freshness.state}/${style}/${language}/${width}`;
          const d = draw([node], { width, style, language });
          const text = d.text.join('\n');
          assert.doesNotMatch(text, /▸/, `${label}: no running glyph anywhere, the title's count included`);
          assert.doesNotMatch(text, CLOCK_FACES, `${label}: no clock`);
          assert.doesNotMatch(text, /\d+m\d\ds/, `${label}: no counting timer`);
          assert.match(text, /\? Fix parser recovery|\? 修|\? Fix/, `${label}: the unknown glyph`);
          const word =
            freshness.state === 'stale'
              ? language === 'zh'
                ? '过期'
                : 'stale'
              : language === 'zh'
                ? '不可用'
                : 'unavailable';
          if (width >= 40) assert.ok(text.includes(word), `${label}: marked "${word}"`);
        }
});

test('a job source that is current keeps its running glyph and clock', () => {
  for (const style of STYLES) {
    const text = draw([jobNode(cliJob())], { width: 48, style }).text.join('\n');
    assert.match(text, /▸ Fix parser recovery/);
    assert.match(text, CLOCK_FACES);
  }
});

test('status unknown is never drawn as completed or failed', () => {
  const node = jobNode(cliJob({ status: 'unknown', lifecycle: 'open' }));
  for (const style of STYLES)
    for (const width of WIDTHS) {
      const text = draw([node], { width, style }).text.join('\n');
      assert.match(text, /\? Fix/, `${style}/${width}`);
      assert.doesNotMatch(text, /✓|!/, `${style}/${width}: neither done nor failed`);
    }
});

test('a settled outcome survives a stale source as history, still marked stale', () => {
  const done = jobNode(cliJob({ status: 'completed', outcome: 'completed', freshness: stale() }));
  const failed = jobNode(cliJob({ status: 'error', outcome: 'failed', freshness: stale(), id: 'role-job:f1' }));
  for (const style of STYLES) {
    const d = draw([done], { width: 56, style }).text.join('\n');
    assert.match(d, /✓ Fix parser recovery/);
    assert.match(d, /stale/);
    const f = draw([failed], { width: 56, style }).text.join('\n');
    assert.match(f, /! Fix parser recovery/);
    assert.match(f, /stale/);
  }
});

test('a card is redrawn when only the job’s freshness changed', () => {
  const live = jobNode(cliJob(), { status: 'running' });
  const gone = jobNode(cliJob({ freshness: stale() }), { status: 'running' });
  const first = draw([live], { width: 48, style: 'rich' }).text.join('\n');
  const second = draw([gone], { width: 48, style: 'rich' }).text.join('\n');
  assert.match(first, CLOCK_FACES);
  assert.doesNotMatch(second, CLOCK_FACES, 'the cached live card is not served for a stale job');
});

test('stale and unknown jobs are counted as unknown, in the title and the filter', () => {
  const nodes = [
    jobNode(cliJob({ freshness: stale() }), { status: 'running' }),
    jobNode(cliJob({ id: 'role-job:b', name: 'Second' }), { status: 'running' }),
  ];
  const text = draw(nodes, { width: 56, style: 'compact' }).text.join('\n');
  assert.match(text, /▸1/);
  assert.match(text, /\?1/);
  const rows = visibleRows(nodes, { ...initialMonitorState().tree, filter: 'active' }, R5R_NOW);
  assert.deepEqual(
    rows.map((row) => row.node.name),
    ['Second'],
    'the active filter leaves the stale job out'
  );
});

// ---------------------------------------------------------------------------
// 3. Requests
// ---------------------------------------------------------------------------

test('a request the job waits on marks its row; historical pointers do not', () => {
  const waiting = jobNode(cliJob({ requests: [request('q2'), request('q1', { current: false })] }));
  const history = jobNode(cliJob({ requests: [request('q1', { current: false }), request('q2', { current: false })] }));
  const answered = jobNode(
    cliJob({ requests: [request('q3', { current: true, state: 'written_consumption_unconfirmed' })] })
  );
  for (const style of STYLES)
    for (const width of [40, 48, 56]) {
      const label = `${style}/${width}`;
      assert.match(draw([waiting], { width, style }).text.join('\n'), /! imp|! 6\.1|! stale/, `${label}: marked`);
      const quiet = draw([history], { width, style }).text.join('\n');
      assert.doesNotMatch(quiet, /!/, `${label}: only historical requests leave no mark`);
      assert.match(
        draw([answered], { width, style }).text.join('\n'),
        /!/,
        `${label}: current is current, however it stands`
      );
    }
  // A card also says what it waits on, in the brief's own "needs" words.
  assert.match(draw([waiting], { width: 48, style: 'rich' }).text.join('\n'), /! answer q2/);
  assert.doesNotMatch(draw([history], { width: 48, style: 'rich' }).text.join('\n'), /answer/);
});

test('the Inspector lists every request: id, state in words, current or historical, path', () => {
  const node = jobNode(
    cliJob({
      requests: [
        request('q1', { current: false, state: 'written_consumption_unconfirmed' }),
        request('q2'),
        request('q3', { current: false }),
      ],
    })
  );
  const en = squash(draw([node], { width: 56, inspect: true }).text);
  for (const [id, state, when] of [
    ['q2', 'unanswered', 'current'],
    ['q1', 'answerwritten,consumptionunconfirmed', 'historical'],
    ['q3', 'unanswered', 'historical'],
  ])
    assert.ok(en.includes(`${id}·${state}·${when}`), `${id}: ${state}, ${when}`);
  for (const id of ['q1', 'q2', 'q3'])
    assert.ok(en.includes(`/synthetic/hud/jobs/j0000000000000001/qa/${id}.md`), `${id}: path`);
  assert.ok(en.indexOf('q2·unanswered·current') < en.indexOf('q1·'), 'the current request leads');
  const zh = squash(draw([node], { width: 56, inspect: true, language: 'zh' }).text);
  assert.ok(zh.includes('q2·未回答·当前'));
  assert.ok(zh.includes('q1·答案已写入，未确认被读取·历史'));
});

// ---------------------------------------------------------------------------
// 4. Judge verdicts
// ---------------------------------------------------------------------------

test('a judge job lists each verdict and never an aggregate success', () => {
  const node = jobNode(
    judgeJob({
      judgments: [
        { name: 'claim one', verdict: 'pass' },
        { name: 'claim two', verdict: 'deny' },
        { name: 'claim three', verdict: 'needs_human' },
      ],
    })
  );
  for (const style of STYLES) {
    const every = [
      ...draw([node], { width: 48, style }).text,
      ...draw([node], { width: 48, inspect: true }).text,
      ...draw([node], { width: 48, inspect: true, language: 'zh' }).text,
    ].join('\n');
    assert.doesNotMatch(every, /success|succeeded|all pass|成功|全部通过/i);
  }
  const en = squash(draw([node], { width: 48, inspect: true }).text);
  assert.ok(en.includes('claimone:pass') && en.includes('claimtwo:deny') && en.includes('claimthree:needshuman'));
  const zh = squash(draw([node], { width: 48, inspect: true, language: 'zh' }).text);
  assert.ok(zh.includes('claimone：通过') && zh.includes('claimtwo：拒绝'));
});

// ---------------------------------------------------------------------------
// 5. Text safety
// ---------------------------------------------------------------------------

const HOSTILE = 'Évil 汉字🙂 \x1b[2J\x07\u202eRTL\nsecond\x1b]0;title\x07 end';

test('hostile text in a name or any other field is escaped, width-correct, and never reaches the screen raw', () => {
  const hostile = jobDto({
    name: HOSTILE,
    role: 'imp\x1b[41m',
    outcome: 'done\x1b[31m',
    lifecycle: 'open\x07',
    runtimePhase: 'wait\u202e',
    preset: 'p\x1b[2J',
    freshness: { ...stale(), reason: 'reason\x1b[0m' },
    location: { tab_id: 't\x1b[2J', pane_id: 'p\x00', agent: 'a\x1b[1m', workspace_id: null },
    judgments: [{ name: 'n\x1b[1mame\u202e', verdict: 'pass' }],
    requests: [request('q\x1b[2J1', { path: '/synthetic/\x1b[2J/qa.md' })],
    report: { path: '/synthetic/\x1b[2J/report.md', available: true },
    diagnostics: ['bad\x1b]0;title\x07code'],
    decision: { id: 'typesafe', model: 'm\x1b[2Jodel' },
    helpers: [jobDto({ kind: 'helper', id: 'h1', name: HOSTILE, role: 'rev\x1b[2J', backend: null, preset: null })],
  });
  const node = jobNode(hostile);
  for (const language of LANGUAGES)
    for (const theme of THEMES)
      for (const width of WIDTHS) {
        for (const style of STYLES) {
          const d = draw([node], { width, style, language, theme });
          assertWellFormed(d, width, `${language}/${theme}/${style}/${width}`);
          assert.ok(d.text.join('\n').includes('Évil'), 'the name is there, escaped');
        }
        const inspector = draw([node], { width, inspect: true, language, theme });
        assertWellFormed(inspector, width, `inspector/${language}/${theme}/${width}`);
        const flat = squash(inspector.text);
        assert.ok(flat.includes('\\x1b[2J'), 'the escape is shown as text, not obeyed');
        assert.ok(flat.includes('\\u202e'), 'a bidi override is shown as text');
        for (const field of ['reason\\x1b[0m', 'bad\\x1b]0;title\\x07code', 'done\\x1b[31m', 'open\\x07'])
          assert.ok(flat.includes(field), `${field} is shown escaped`);
      }
});

test('a name of wide characters is cut by columns, not code units', () => {
  const node = jobNode(cliJob({ name: '解析器恢复路径解析器恢复路径解析器恢复路径🙂🙂🙂' }));
  for (const style of STYLES)
    for (const width of WIDTHS) assertWellFormed(draw([node], { width, style }), width, `${style}/${width}`);
});

// ---------------------------------------------------------------------------
// 6. Inspector completeness
// ---------------------------------------------------------------------------

function fullJob(): JobDisplay {
  return jobDto({
    kind: 'role',
    jobId: 'j00000000000000a1',
    id: 'role-job:j00000000000000a1',
    name: 'Full details job',
    role: 'oracle',
    phase: 'converge',
    preset: 'weekly-preset',
    backend: {
      id: 'backend-id',
      executor: 'jev',
      harness: 'harness-name',
      model: 'bound-model',
      effort: 'high',
      env_profile: 'profile-x',
      recipe: 'recipe-name',
    },
    decision: { id: 'openai', model: 'decision-model-y' },
    observedModel: 'observed-model-z',
    observedEffort: 'ultra',
    location: { tab_id: 'tab-9', pane_id: 'pane-9', agent: 'agent-nine', workspace_id: 'ws-nine' },
    lifecycle: 'closed',
    runtimePhase: 'collect',
    outcome: 'uncertain',
    judgments: [
      { name: 'first claim', verdict: 'pass' },
      { name: 'second claim', verdict: 'timeout' },
    ],
    status: 'unknown',
    freshness: {
      state: 'stale',
      observedAt: R5R_NOW - 2_000,
      lastSuccessfulReadAt: R5R_NOW - 125_000,
      evidenceAt: R5R_NOW - 3_700_000,
      liveDeadline: R5R_NOW - 30_000,
      reason: 'runtime_uncorroborated',
    },
    requests: [request('q7'), request('q5', { current: false, state: 'written_consumption_unconfirmed' })],
    report: { path: '/synthetic/hud/jobs/full/report.md', available: true },
    createdAt: R5R_NOW - 7_200_000,
    closedAt: R5R_NOW - 600_000,
    helpers: [
      jobDto({
        kind: 'helper',
        id: 'role-job:h1',
        name: 'helper-one',
        role: 'scout',
        status: 'completed',
        backend: null,
      }),
    ],
    diagnostics: ['qa_unreadable', 'report_unreadable'],
    summaryUnavailable: 'requires_authorization',
  });
}

test('the Inspector shows every field of a fully populated job, in English', () => {
  const flat = squash(draw([jobNode(fullJob())], { width: 56, inspect: true }).text);
  const expected = [
    'Kind:rolejob',
    'Role:oracle',
    'Phase:converge',
    'Preset:weekly-preset',
    'Backend:backend-id',
    'Executor:jev',
    'Harness:harness-name',
    'Model:bound-model·high',
    'Recipe:recipe-name',
    'Decision:openai·decision-model-y',
    'Observed:observed-model-z·ultra',
    'Location:tabtab-9·panepane-9·agentagent-nine·workspacews-nine',
    'Lifecycle:closed',
    'Runtimephase:collect',
    'Outcome:uncertain',
    'firstclaim:pass',
    'secondclaim:timeout',
    'q7·unanswered·current',
    'q5·answerwritten,consumptionunconfirmed·historical',
    '/synthetic/hud/jobs/j0000000000000001/qa/q7.md',
    '/synthetic/hud/jobs/full/report.md',
    'Availability:available',
    'State:stale',
    'Reason:runtime_uncorroborated',
    'Checked:2sago',
    'Lastread:2mago',
    'Evidence:1hago',
    'Livewindow:ended30sago',
    'helper-one·scout·completed',
    'qa_unreadable',
    'report_unreadable',
    'Modelsummariesunavailable·requiresauthorization',
    'Created:2hago',
    'Closed:10mago',
  ];
  for (const piece of expected) assert.ok(flat.includes(piece), `missing ${piece}`);
});

test('the Inspector shows every field of a fully populated job, in Chinese, with no English label left', () => {
  const d = draw([jobNode(fullJob())], { width: 56, inspect: true, language: 'zh' });
  const flat = squash(d.text);
  const expected = [
    '类型：角色任务',
    '角色：oracle',
    '阶段：converge',
    '预设：weekly-preset',
    '后端：backend-id',
    '执行器：jev',
    '宿主：harness-name',
    '模型：bound-model·high',
    '启动方式：recipe-name',
    '决策：openai·decision-model-y',
    '观测到：observed-model-z·ultra',
    '位置：标签页tab-9·窗格pane-9·代理agent-nine·工作区ws-nine',
    '生命周期：closed',
    '运行阶段：collect',
    '结果：uncertain',
    'firstclaim：通过',
    'secondclaim：超时',
    'q7·未回答·当前',
    'q5·答案已写入，未确认被读取·历史',
    '可读性：可读',
    '状态：过期',
    '原因：runtime_uncorroborated',
    '最近读取：2m前',
    '存活窗口：30s前已结束',
    'helper-one·scout·已完成',
    '模型摘要不可用·需要授权',
  ];
  for (const piece of expected) assert.ok(flat.includes(piece), `missing ${piece}`);
  const text = d.text.join('\n');
  assert.doesNotMatch(
    text,
    /\b(Kind|Role|Phase|Preset|Backend|Executor|Harness|Recipe|Decision|Location|Lifecycle|Outcome|Availability|Freshness|Reason|Evidence|Helpers|Diagnostics|Requests|Report):/,
    'every label is in Chinese'
  );
});

test('missing optional fields leave no placeholder behind', () => {
  const bare = jobNode(
    jobDto({
      kind: 'external',
      id: 'external-task:b1',
      jobId: 'b1',
      name: 'Bare task',
      role: null,
      phase: null,
      preset: null,
      backend: null,
      location: { tab_id: null, pane_id: null, agent: null, workspace_id: null },
      requests: null,
      report: null,
      createdAt: null,
      diagnostics: [],
      lifecycle: 'unknown',
    })
  );
  for (const language of LANGUAGES) {
    const text = draw([bare], { width: 48, inspect: true, language }).text.join('\n');
    assert.doesNotMatch(text, /null|undefined|NaN|\?\?|\bn\/a\b/i, language);
    assert.doesNotMatch(
      text,
      /Turn age|Last activity|回合|最近活动|Role:|Phase:|Preset:|Backend:|Decision|Observed:/,
      language
    );
    assert.doesNotMatch(text, /Location|位置|Outcome|Requests|Report|Helpers|Diagnostics|Judge/, language);
  }
});

test('a job only the facade knows has one Model summary section, and no progress reason beside it', () => {
  const node = jobNode(cliJob());
  const extra = { progressContext: { backendOn: false, paused: false, enabled: true, targets: new Set<string>() } };
  const text = draw([node], { width: 56, inspect: true, extra }).text.join('\n');
  assert.equal(text.match(/Model summary/g)?.length, 1);
  assert.doesNotMatch(text, /Progress:|~ Model summary/);
});

test('observed model and effort appear only where they differ from the binding', () => {
  const same = jobNode(cliJob({ observedModel: 'gpt-6.1-sol', observedEffort: 'high' }));
  assert.doesNotMatch(draw([same], { width: 56, inspect: true }).text.join('\n'), /Observed: (gpt|high)/);
  const modelOnly = jobNode(cliJob({ observedModel: 'other-model', observedEffort: 'high' }));
  const flat = squash(draw([modelOnly], { width: 56, inspect: true }).text);
  assert.ok(flat.includes('Observed:other-model'));
  assert.ok(!flat.includes('Observed:other-model·high'), 'the effort that matches is not repeated');
});

test('an uncertain job’s last known status is shown next to what the row draws', () => {
  const node = jobNode(cliJob({ status: 'running', freshness: stale() }));
  const flat = squash(draw([node], { width: 56, inspect: true }).text);
  assert.ok(flat.includes('Lastknown:running'));
  assert.ok(flat.includes('State:stale') && flat.includes('Reason:herdr_uncorroborated'));
});

test('a native row a job enriched keeps its own summaries and role, and the job’s sections', () => {
  const enriched = jobNode(
    cliJob({ native: { harness: 'codex', sourceId: 'a'.repeat(64), sessionId: 's', threadId: null } }),
    {
      rolloutPath: '/synthetic/rollout.jsonl',
      role: 'default',
    }
  );
  const flat = squash(draw([enriched], { width: 56, inspect: true }).text);
  assert.ok(flat.includes('Role:default'), 'the native role stays a fact');
  assert.ok(flat.includes('Role:imp'), 'and the job’s own is in its section');
  assert.ok(!flat.includes('Modelsummariesunavailable'), 'its native summaries are not claimed unavailable');
});

test('a destination with no projected node falls through to the ordinary Inspector', () => {
  const node = jobNode(cliJob({ requests: [request('q1')] }));
  const old = setLanguage('en');
  try {
    const settings = visualSettings({ language: 'en', look: 'tab', preset: 'monitor', width: 56 });
    const state: MonitorState = { ...initialMonitorState(), ...monitorSettings(settings) };
    state.tree = { ...state.tree, selectedId: node.id };
    const view = (key: string) => ({ dest: { rows: [{ key, kind: 'node', pn: null }] } }) as unknown as DelegationView;
    const input = { tree: jobTree([node]), state, width: 56, height: 60, nowMs: R5R_NOW };
    const rows = inspectorRows(input, state, 56, R5R_NOW, view(node.id));
    const flat = squash(rows.map((row) => stripAnsi(row.text)));
    assert.ok(
      flat.includes('Fixparserrecovery') && flat.includes('Kind:rolejob') && flat.includes('q1·unanswered·current')
    );
    // A key the tree does not hold is as unavailable as it was.
    const none = inspectorRows(input, state, 56, R5R_NOW, view('gone'));
    assert.ok(squash(none.map((row) => stripAnsi(row.text))).includes('Selectionunavailable'));
  } finally {
    setLanguage(old);
  }
});

// ---------------------------------------------------------------------------
// Panel state, and the real composition
// ---------------------------------------------------------------------------

test('lingering: a settled job expires on its evidence time, an open one with no outcome never does', () => {
  const state = { ...initialMonitorState().tree, lingerMs: 180_000 };
  const old = (patch: Partial<JobDisplay>) =>
    jobNode(
      jobDto({
        id: `role-job:${Math.random().toString(16).slice(2)}`,
        freshness: { ...jobDto().freshness, evidenceAt: R5R_NOW - 3_600_000 },
        ...patch,
      })
    );
  const doneLongAgo = old({
    status: 'completed',
    outcome: 'completed',
    lifecycle: 'closed',
    closedAt: R5R_NOW - 3_600_000,
  });
  const doneJustNow = old({
    status: 'completed',
    outcome: 'completed',
    freshness: { ...jobDto().freshness, evidenceAt: R5R_NOW - 10_000 },
  });
  const silentOpen = old({ status: 'unknown', freshness: stale() });
  const closedUnknown = old({ status: 'unknown', lifecycle: 'closed', closedAt: R5R_NOW - 3_600_000 });
  const waiting = old({ status: 'completed', requests: [request('q1')] });
  const names = (nodes: SubagentTreeNode[]) => visibleRows(nodes, state, R5R_NOW).map((row) => row.node.id);
  const all = [doneLongAgo, doneJustNow, silentOpen, closedUnknown, waiting];
  assert.deepEqual(
    names(all).sort(),
    [doneJustNow, silentOpen, waiting].map((n) => n.id).sort(),
    'only what is settled and old goes'
  );
  assert.equal(countExpired(all, state, R5R_NOW), 2);
});

test('composeJobTree’s own nodes render: helpers as children, a stale job as unknown', () => {
  const live = piJob();
  const gone = cliJob({
    id: 'role-job:j0000000000000009',
    jobId: 'j0000000000000009',
    name: 'Silent job',
    freshness: stale(),
    status: 'running',
  });
  const result = composeJobTree({
    tree: jobTree([]),
    snapshot: {
      generation: 1,
      root: ROOT,
      jobs: [live, gone],
      coverage: { entries: 2, files: 2, bytes: 100, incomplete: false, omitted: 0, diagnostics: [] },
    },
    root: ROOT,
    nowMs: R5R_NOW,
  });
  assert.equal(result.tree.nodes[0].children.length, 2, 'the helpers are the job’s children');
  for (const style of STYLES) {
    const d = draw(result.tree.nodes, { width: 48, style });
    assertWellFormed(d, 48, style);
    const text = d.text.join('\n');
    assert.match(text, /Port the recovery path/);
    assert.match(text, /Review pass 1/);
    assert.match(text, /\? Silent job/);
  }
});

// ---------------------------------------------------------------------------
// Round 2: the Timeline, name precedence, settling times and the badge of nodes a job enriched
// ---------------------------------------------------------------------------

const RIGHT_REF = {
  harness: 'codex' as const,
  sourceId: 'a'.repeat(64),
  sessionId: 'synthetic-native',
  threadId: null,
};
const SNAPSHOT_COVERAGE = { entries: 1, files: 1, bytes: 100, incomplete: false, omitted: 0, diagnostics: [] };

/** A native row (exact ref) with a model label, a task, a model and an effort of its own, enriched with `job`. */
function enrichedBy(job: JobDisplay, patch: Partial<SubagentTreeNode> = {}): SubagentTreeNode {
  const native: SubagentTreeNode = {
    id: 'native-1',
    ref: RIGHT_REF,
    name: 'codex native name',
    label: 'OLD MODEL LABEL',
    task: 'Native task text',
    status: 'running',
    rolloutPath: '/synthetic/rollout.jsonl',
    model: 'gpt-6.1-sol',
    effort: 'max',
    startedAt: new Date(ago(300)),
    depth: 1,
    children: [],
    ...patch,
  };
  const result = composeJobTree({
    tree: jobTree([native]),
    snapshot: { generation: 1, root: ROOT, jobs: [{ ...job, native: RIGHT_REF }], coverage: SNAPSHOT_COVERAGE },
    root: ROOT,
    nowMs: R5R_NOW,
  });
  const node = result.tree.nodes[0];
  assert.ok(node.job && node.id === 'native-1', 'the exact ref enriched the native row in place');
  return node;
}

test('timeline: a job whose source is not corroborated keeps its start but claims no running, clock or live flag', () => {
  const running = [
    { startedAt: new Date(ago(290)), status: 'running' as const, intent: 'I will rewrite the recovery.' },
  ];
  const cases: Array<[string, () => SubagentTreeNode]> = [
    ['stale, node still running', () => jobNode(cliJob({ freshness: stale() }), { status: 'running' })],
    ['stale, composed unknown', () => jobNode(cliJob({ freshness: stale() }), { status: 'unknown' })],
    ['unavailable', () => jobNode(cliJob({ status: 'unknown', freshness: unavailable() }), { status: 'unknown' })],
    ['status unknown, source current', () => jobNode(cliJob({ status: 'unknown' }), { status: 'unknown' })],
    ['stale with a native stage still running', () => jobNode(cliJob({ freshness: stale() }), { stages: running })],
  ];
  for (const [what, make] of cases)
    for (const timeline of ['rail', 'indent', 'lanes'] as const)
      for (const width of [40, 56])
        for (const language of LANGUAGES)
          for (const icons of ['unicode', 'text'] as const) {
            const label = `${what}/${timeline}/${width}/${language}/${icons}`;
            const d = draw([make()], { width, timeline, language, icons });
            const text = d.text.join('\n');
            const entry = d.text.filter((line) => line.includes('Fix parser recovery')).join('\n');
            assert.ok(entry, `${label}: the start it saw is kept, under the job’s name`);
            assert.doesNotMatch(entry, /▸/, `${label}: no running glyph on the entry`);
            assert.doesNotMatch(text, CLOCK_FACES, `${label}: no clock face`);
            assert.doesNotMatch(text, /rewrite the recovery/, `${label}: no intent offered as what it does now`);
            if (icons === 'unicode') assert.match(entry, /\? Fix parser recovery/, `${label}: the unknown mark`);
            else
              assert.match(
                entry,
                language === 'zh' ? /Fix parser recovery 开始/ : /Fix parser recovery started/,
                label
              );
          }
});

test('timeline: a job live with its source current keeps its running entry, glyph and clock', () => {
  for (const timeline of ['rail', 'indent', 'lanes'] as const) {
    const text = draw([jobNode(cliJob())], { width: 56, timeline }).text.join('\n');
    assert.match(text, /▸ Fix parser recovery/, timeline);
    assert.match(text, CLOCK_FACES, `${timeline}: the clock face`);
  }
});

test('timeline: a recorded outcome keeps its terminal entry under a stale source', () => {
  const done = jobNode(
    cliJob({ status: 'completed', outcome: 'completed', lifecycle: 'closed', closedAt: ago(100), freshness: stale() }),
    { status: 'completed', statusAt: new Date(ago(100)) }
  );
  const failed = jobNode(
    cliJob({ id: 'role-job:f1', status: 'error', outcome: 'failed', closedAt: ago(100), freshness: stale() }),
    { status: 'error', statusAt: new Date(ago(100)) }
  );
  const text = draw([done], { width: 56, timeline: 'rail' }).text.join('\n');
  assert.match(text, /✓ Fix parser recovery/);
  assert.doesNotMatch(text, /▸|\? Fix|[◌◷◶◵◴◉]/);
  assert.match(draw([failed], { width: 56, timeline: 'rail' }).text.join('\n'), /✗ Fix parser recovery/);
});

test('a job’s name heads rows, cards, the Timeline and the Inspector over a native name or model label', () => {
  const node = enrichedBy(cliJob());
  for (const labelAsName of [true, false]) {
    for (const style of STYLES)
      for (const width of [40, 56]) {
        const text = draw([node], { width, style, labelAsName }).text.join('\n');
        const label = `${style}/${width}/labelAsName=${labelAsName}`;
        assert.match(text, /Fix parser recovery/, `${label}: the job’s name`);
        assert.doesNotMatch(text, /OLD MODEL LABEL/, `${label}: the model label does not head it`);
      }
    const timeline = draw([node], { width: 56, timeline: 'rail', labelAsName }).text.join('\n');
    assert.match(timeline, /Fix parser recovery/, `timeline/${labelAsName}`);
    assert.doesNotMatch(timeline, /OLD MODEL LABEL/, `timeline/${labelAsName}`);
    for (const language of LANGUAGES) {
      const lines = draw([node], { width: 56, inspect: true, labelAsName, language }).text;
      const head = lines.findIndex((line) => line.includes('Fix parser recovery'));
      const label = lines.findIndex((line) => line.includes('OLD MODEL LABEL'));
      const native = lines.findIndex((line) => line.includes('codex native name'));
      assert.ok(head >= 0 && head < label && head < native, `inspector/${labelAsName}/${language}: the job heads it`);
      // The native name and the model’s label stay, as facts under the heading.
      assert.match(lines[label], language === 'zh' ? /标签 OLD MODEL LABEL|OLD MODEL LABEL/ : /label OLD MODEL LABEL/);
      assert.match(lines[native], language === 'zh' ? /codex native name/ : /name codex native name/);
    }
  }
  // Nothing changes for a node that is no job’s: its label still heads it with labels as names.
  const plain: SubagentTreeNode = {
    id: 'plain',
    name: 'codex native name',
    label: 'OLD MODEL LABEL',
    status: 'running',
    depth: 1,
    children: [],
  };
  assert.match(draw([plain], { width: 56, labelAsName: true }).text.join('\n'), /OLD MODEL LABEL/);
});

test('an enriched node settled by its job is dated by the job’s evidence, not an older native event', () => {
  const settled = cliJob({
    status: 'completed',
    outcome: 'completed',
    freshness: { ...jobDto().freshness, evidenceAt: ago(10) },
  });
  const old = new Date(ago(3600));
  const node = enrichedBy(settled, {
    status: 'completed',
    statusAt: old,
    lastEventAt: old,
    startedAt: new Date(ago(3700)),
  });
  const panel = { ...initialMonitorState().tree, lingerMs: 180_000 };
  assert.equal(isExpired(node, panel, R5R_NOW), false, 'ten seconds after its evidence it is not yet old');
  assert.equal(isExpired(node, panel, R5R_NOW + 200_000), true, 'and it goes once its own evidence is old');
  // A node with no job keeps today’s precedence: the native event dates it.
  const { job: _job, ...bare } = node;
  assert.equal(isExpired(bare, panel, R5R_NOW), true);
  for (const style of STYLES) {
    const text = draw([node], { width: 56, style, showAll: false, lingerMs: 180_000 }).text.join('\n');
    assert.match(text, /Fix parser recovery/, `${style}: the row is still there`);
    assert.doesNotMatch(text, /1 finished/, `${style}: nothing folded away`);
  }
  const lines = draw([node], { width: 56, inspect: true }).text.join('\n');
  assert.match(lines, /completed · 10s ago/, 'the Inspector dates it by the evidence');
  assert.doesNotMatch(lines, /1h ago/);
  const card = draw([node], { width: 56, style: 'rich' }).text.join('\n');
  assert.doesNotMatch(card, /\b1h\b/, 'the card’s age is the evidence’s too');
});

test('a job’s badge is its binding alone: a missing field stays absent and the observed one is the Inspector’s', () => {
  const none = enrichedBy(cliJob({ backend: { ...cliJob().backend!, model: null, effort: null } }));
  const partial = enrichedBy(cliJob({ backend: { ...cliJob().backend!, model: 'gpt-6.1-sol', effort: null } }));
  const full = enrichedBy(cliJob());
  for (const style of STYLES)
    for (const width of [40, 48, 56]) {
      const label = `${style}/${width}`;
      const bare = draw([none], { width, style }).text.join('\n');
      assert.doesNotMatch(bare, /6\.1sol|sol|max/, `${label}: no binding, no badge from the native row’s model`);
      const some = draw([partial], { width, style }).text.join('\n');
      assert.match(some, /6\.1sol/, `${label}: the model the binding has`);
      assert.doesNotMatch(some, /max/, `${label}: the effort it does not have is not borrowed`);
      // A full binding shows the model, and the effort too where the row has room for it.
      assert.match(
        draw([full], { width, style }).text.join('\n'),
        width >= 48 ? /6\.1sol·high/ : /6\.1sol/,
        `${label}: a full binding shows`
      );
    }
  // The Inspector: no binding in the heading; what the session was seen to run, under Observed.
  const heading = draw([none], { width: 56, inspect: true }).text;
  assert.ok(!heading.slice(0, 8).join('\n').includes('gpt-6.1-sol'), 'not in the heading');
  assert.ok(squash(heading).includes('Observed:gpt-6.1-sol·max'));
  const part = squash(draw([partial], { width: 56, inspect: true }).text);
  assert.ok(
    part.includes('Observed:max') && !part.includes('Observed:gpt'),
    'only the field that differs, and is seen'
  );
});

// ---------------------------------------------------------------------------
// Round 3: a native outcome is drawn under a job's name only where the job says the same
// ---------------------------------------------------------------------------

/** A job named for a new task on a native row whose previous turn ended an hour ago, as `outcome`. */
function afterOldTurn(job: Partial<JobDisplay>, outcome: 'completed' | 'error', patch: Partial<SubagentTreeNode> = {}) {
  const old = new Date(ago(3600));
  return enrichedBy(cliJob({ name: 'New recovery task', ...job }), {
    status: outcome,
    startedAt: new Date(ago(3700)),
    statusAt: old,
    lastEventAt: old,
    ...patch,
  });
}

/** What the Timeline says of the node, and of its Agents row, by the real producers and renderer. */
function bothPanes(node: SubagentTreeNode, width = 56) {
  const timeline = draw([node], { width, timeline: 'rail' }).text;
  const row = draw([node], { width, style: 'compact' }).text.join('\n');
  return {
    timeline: timeline.filter((line) => line.includes('New recovery task')).join('\n'),
    all: timeline.join('\n'),
    row,
  };
}

test('timeline: a native outcome under a job that has not ended, or ended otherwise, is not drawn under its name', () => {
  const live = {};
  const staleRunning = { freshness: stale() };
  const cases: Array<[string, SubagentTreeNode, 'live' | 'unknown' | 'none']> = [
    ['job running and stale, native completed', afterOldTurn(staleRunning, 'completed'), 'unknown'],
    ['job running and stale, native error', afterOldTurn(staleRunning, 'error'), 'unknown'],
    ['job running, native completed', afterOldTurn(live, 'completed'), 'live'],
    ['job running, native error', afterOldTurn(live, 'error'), 'live'],
    [
      'job unavailable, native completed',
      afterOldTurn({ status: 'unknown', freshness: unavailable() }, 'completed'),
      'unknown',
    ],
    ['job completed, native error', afterOldTurn({ status: 'completed', outcome: 'completed' }, 'error'), 'unknown'],
    ['job failed, native completed', afterOldTurn({ status: 'error', outcome: 'failed' }, 'completed'), 'unknown'],
    [
      'job running and stale, native stage done',
      afterOldTurn(staleRunning, 'completed', {
        stages: [
          { startedAt: new Date(ago(3700)), endedAt: new Date(ago(3600)), status: 'done', result: 'Native result.' },
        ],
      }),
      'none',
    ],
    [
      'job completed, native stage failed',
      afterOldTurn({ status: 'completed', outcome: 'completed' }, 'completed', {
        stages: [
          { startedAt: new Date(ago(3700)), endedAt: new Date(ago(3600)), status: 'failed', result: 'Native result.' },
        ],
      }),
      'none',
    ],
    [
      'job completed, native stage aborted',
      afterOldTurn({ status: 'completed', outcome: 'completed' }, 'completed', {
        stages: [{ startedAt: new Date(ago(3700)), endedAt: new Date(ago(3600)), status: 'aborted' }],
      }),
      'none',
    ],
  ];
  for (const [what, node, kind] of cases)
    for (const language of LANGUAGES)
      for (const width of [40, 56]) {
        const label = `${what}/${language}/${width}`;
        const d = draw([node], { width, timeline: 'rail', language });
        const entry = d.text.filter((line) => line.includes('New recovery task')).join('\n');
        assert.doesNotMatch(
          d.text.join('\n'),
          /✓|✗|Native result/,
          `${label}: no outcome of the old turn on the Timeline`
        );
        // A native stage replaces the log’s start and finish: with its end left out, the job has no entry of that stage.
        if (kind === 'none') assert.equal(entry, '', `${label}: nothing of the old stage is drawn`);
        else {
          assert.ok(entry, `${label}: the job still has its start`);
          // Its start stands as history unless the job is live with its source current.
          assert.match(entry, kind === 'live' ? /▸ New recovery task/ : /\? New recovery task/, label);
        }
      }
  // The same node’s Agents row says what the job says.
  assert.match(bothPanes(cases[0][1]).row, /\? New recovery task/);
  assert.match(bothPanes(cases[2][1]).row, /▸ New recovery task/);
  // The native facts are not lost: the Inspector still has what the rollout saw.
  const flat = squash(draw([cases[0][1]], { width: 56, inspect: true }).text);
  assert.ok(flat.includes('Lastactivity'), 'the native last activity stays a fact');
});

test('timeline: a native outcome the job agrees with is drawn, with the job’s name', () => {
  const done = afterOldTurn({ status: 'completed', outcome: 'completed' }, 'completed');
  const failed = afterOldTurn({ status: 'error', outcome: 'failed' }, 'error');
  const staged = afterOldTurn({ status: 'completed', outcome: 'completed' }, 'completed', {
    stages: [
      { startedAt: new Date(ago(3700)), endedAt: new Date(ago(3600)), status: 'done', result: 'Native result.' },
    ],
  });
  for (const language of LANGUAGES)
    for (const width of [40, 56]) {
      const label = `${language}/${width}`;
      const ok = draw([done], { width, timeline: 'rail', language }).text.join('\n');
      assert.match(ok, /✓ New recovery task/, `completed with finished: ${label}`);
      assert.doesNotMatch(ok, /✗|\? New|▸/, label);
      const bad = draw([failed], { width, timeline: 'rail', language }).text.join('\n');
      assert.match(bad, /✗ New recovery task/, `error with failed: ${label}`);
      assert.match(draw([staged], { width, timeline: 'rail', language }).text.join('\n'), /✓ New recovery task/, label);
    }
  assert.match(bothPanes(done).row, /✓ New recovery task/);
});

test('timeline: an outcome the job does not stand behind adds nothing to its parent’s subtask counts', () => {
  const helper = (job: Partial<JobDisplay>) =>
    jobNode(
      jobDto({ kind: 'helper', id: 'role-job:h1', jobId: 'h1', name: 'Review pass', role: 'reviewer', ...job }),
      {
        status: 'completed',
        startedAt: new Date(ago(200)),
        statusAt: new Date(ago(100)),
        lastEventAt: new Date(ago(100)),
      },
      2
    );
  const under = (kid: SubagentTreeNode) => {
    const parent = jobNode(cliJob());
    parent.children = [kid];
    const line = draw([parent], { width: 56, timeline: 'rail' }).text.filter((l) => l.includes('Fix parser recovery'));
    return line.join('\n');
  };
  assert.doesNotMatch(under(helper({ freshness: stale() })), /✓1/, 'a stale helper’s old finish is not counted');
  assert.doesNotMatch(
    under(helper({ status: 'error', outcome: 'failed' })),
    /✓1/,
    'a failed job’s native finish is not'
  );
  assert.match(under(helper({ status: 'completed', outcome: 'completed' })), /✓1/, 'a completed one is');
  // Control: a node without a job counts as it always did.
  const plain: SubagentTreeNode = {
    id: 'plain-kid',
    name: 'plain kid',
    status: 'completed',
    startedAt: new Date(ago(200)),
    statusAt: new Date(ago(100)),
    depth: 2,
    children: [],
  };
  assert.match(under(plain), /✓1/);
});

function ago(seconds: number): number {
  return R5R_NOW - seconds * 1000;
}
