import { nativeCallsOnly } from '../core/link/view-model.js';
/**
 * Each pane's rows: the agents (the compact tree, or the cards and their
 * summary), the repository summary, and the brief and
 * the agent log under the compact tree. The Inspector's are its own module's.
 */
import type { SubagentTreeNode } from '../types.js';
import type { AgentLogEntry } from '../collectors/agent-log.js';
import type { MonitorData, MonitorPane, MonitorRow, MonitorState } from './monitor.js';
import type { DelegationView } from './delegation/panel.js';
import type { CountsText } from './control-bar.js';
import { visibleRows, countExpired, guardianCount } from './panel-state.js';
import { agentCounts, eachThread, type StatusCounts } from '../collectors/subagent-tree.js';
import { theme, colors, visualLength, truncateAnsi, stripAnsi } from './colors.js';
import { fitModelEffortToken } from './model-glyphs.js';
import { displayConfig } from './hud-config.js';
import { t } from './i18n.js';
import { agentTitle, shownName } from './agent-title.js';
import { briefFields, taskLines, richRows, briefLine } from './cards.js';
import { monitorText, fit, pair, wrapped, flowLines, squeeze, helpLines } from './monitor-text.js';
import {
  nodeStatus,
  isQuiet,
  turnClock,
  finishedAt,
  FRESH_FINISH_MS,
  writtenAge,
  agentRate,
  rateText,
} from './monitor-labels.js';
import { contextLine, CONTEXT_METER_WIDTH } from './monitor-meter.js';
import {
  effectiveStatus,
  withEffectiveStatus,
  jobParts,
  fitParts,
  shownNode,
  badgeOf,
  needsInput,
} from './job-details.js';
import { inspectorRows, logEntryLines } from './monitor-inspector.js';
import { section, kvRows, itemRow } from './workboard-rows.js';
import { delegationAgentsRows, mixedAgentsRows, mixedOrdinaryNodes } from './delegation/panel.js';

/**
 * What the linger window put away from the list, counted whether or not it
 * is showing: in rich the L1s alone, the list's rows (their subtasks are on
 * their cards, and showing the rest brings none of them back as rows);
 * compact, every agent in the tree.
 */
export function putAwayCount(nodes: SubagentTreeNode[], state: MonitorState, now: number): number {
  if (state.style !== 'rich') return countExpired(nodes, { ...state.tree, showAll: false }, now);
  const listed = (showAll: boolean) =>
    visibleRows(nodes, { ...state.tree, collapsed: new Set(), showAll }, now).filter((row) => row.depth === 0).length;
  return listed(true) - listed(false);
}

/**
 * The agents' heading, in both layouts the counts every view gives
 * (`agentCounts`): the agents the main session started by how they stand,
 * one at work while a subtask of it is, the guardian reviews, and their
 * subtasks as one figure with how many of them failed. The switch for what
 * the linger window put away is on the control bar.
 */
export function summaryRow(input: Pick<MonitorData, 'tree'>, now?: number): { row: MonitorRow } {
  // A job counts as its row draws it: a stale running job is not "running" in the title either.
  const { agents, subtasks: subs, reviews } = agentCounts(withEffectiveStatus(input.tree.nodes));
  // How fast every running agent writes, subtasks and reviews too, together;
  // it gives way with the subtasks figure. The main session's own rate is the band's.
  let total: number | undefined;
  if (now !== undefined)
    eachThread(input.tree.nodes, (node) => {
      const rate = agentRate(node, now);
      if (rate !== undefined) total = (total ?? 0) + rate;
    });
  const speed = total !== undefined ? colors.dim(`· ${rateText(total)}`) : '';
  // "!1 失败  ▸1 运行  ✓5 完成": an icon and a count alone said nothing to a
  // reader without the legend, so each count carries its word where it fits.
  // The title row says as much as fits, each form whole (`paneHead`).
  const build: CountsText = (words, subtasks) => {
    const count = (icon: string, paint: (s: string) => string, n: number, word: string) =>
      `${paint(icon)}${n}${words ? colors.dim(` ${t(word)}`) : ''}`;
    // Only what is there: "▸0 run" beside thirty finished agents is noise.
    // A column in, under the entries' status icons; failures lead.
    const counts = [
      agents.failed ? count('!', theme.error, agents.failed, 'failed') : '',
      agents.completed ? count('✓', theme.success, agents.completed, 'done') : '',
      agents.active ? count('▸', theme.info, agents.active, 'run') : '',
      agents.unknown ? count('?', colors.dim, agents.unknown, 'unknown') : '',
      reviews.total ? `${reviewChip(reviews)}${words ? colors.dim(` ${t('reviews')}`) : ''}` : '',
    ]
      .filter(Boolean)
      .join(words ? '  ' : ' ');
    const tasks =
      subtasks && subs.total
        ? colors.dim(t('· {n} subtasks', { n: subs.total })) +
          (subs.failed ? theme.error(t(', {n} failed', { n: subs.failed })) : '')
        : '';
    return [counts, tasks, subtasks ? speed : ''].filter(Boolean).join('  ');
  };
  const text = build(true, true);
  return { row: { text: text && ' ' + text, counts: build } };
}

/** "◈5": reviews, red when one failed, in the info colour while one is running. Empty when there are none. */
function reviewChip(reviews: Pick<StatusCounts, 'total' | 'active' | 'failed'>): string {
  return reviews.total
    ? (reviews.failed ? theme.error : reviews.active ? theme.info : colors.dim)(`◈${reviews.total}`)
    : '';
}

/** "◈5": the guardian reviews among `nodes`, as `reviewChip` paints them. */
export function guardianChip(nodes: readonly SubagentTreeNode[]): string {
  const { count, running, failed } = guardianCount(nodes);
  return reviewChip({ total: count, active: running ? 1 : 0, failed });
}

/**
 * The one line an agents view has with nothing in it, and only when that is
 * a fact: the session is read and bound, and its tree, built for this root,
 * holds no thread at all (no agent, subtask or review, so no count and no
 * +N either). A dim sentence saying so, and where the help is. While the
 * session is unread, unbound or its tree not built, nothing: no guess.
 */
export function emptyAgentsRows(input: Pick<MonitorData, 'tree' | 'loading' | 'prefix'>, width: number): MonitorRow[] {
  if (input.loading || !input.tree.rootId || input.tree.nodes.length) return [];
  const room = Math.max(1, width - 1);
  return [t('No agents started in this session yet'), t('Help: {p} ?', { p: input.prefix ?? 'Ctrl+\\' })].flatMap(
    (text) => helpLines(text, room).map((line) => ({ text: ` ${colors.dim(line)}` }))
  );
}

function agentRows(input: MonitorData, state: MonitorState, width: number, now: number): MonitorRow[] {
  // With agents to show but none listed, the view is empty: the summary's
  // counts, the bar's +N and the status card already say why, so no line
  // says it again. With none at all, one line says so (emptyAgentsRows).
  const { row: head } = summaryRow(input, now);
  const result: MonitorRow[] = [head, ...emptyAgentsRows(input, width)];
  for (const row of visibleRows(input.tree.nodes, state.tree, now)) {
    const node = row.node;
    const status = nodeStatus(node, now);
    const branch = visualLength(row.prefix) > Math.floor(width / 4) ? '… ' : row.prefix;
    const prefix = `${node.id === state.tree.selectedId ? theme.accent('›') : ' '}${colors.dim(branch)}${row.collapsed && row.hasChildren ? '+' : ''}${status.paint(status.icon)} `;
    // A finished parent kept only to show whose child a live agent is recedes,
    // and so does a finished row once the news of it finishing is a minute old.
    const finished =
      effectiveStatus(node) === 'completed' && now - (finishedAt(node)?.getTime() ?? 0) > FRESH_FINISH_MS;
    const dimName = row.context || finished;
    // Same celestial badges as the compact HUD. Narrow panes keep glyphs only.
    // The widest whole form that fits a quarter of the row; never a cut one.
    const bound = badgeOf(node);
    const badge =
      width < 10
        ? ''
        : fitModelEffortToken(
            bound.model ? monitorText(bound.model) : undefined,
            bound.effort ? monitorText(bound.effort) : undefined,
            Math.max(2, Math.floor(width / 4)),
            width < 40 && displayConfig().glyphs === 'both' ? 'glyph' : displayConfig().glyphs
          );
    // The agent's own context fill, where the row is wide enough to carry it
    // without pushing the badge off: 26 content columns is a 30-column pane,
    // the widest the default split makes, minus its borders. Absent data
    // shows nothing rather than an empty meter.
    // The meter and the clock keep their columns on every row, blank when
    // there is nothing to draw, so meters and clocks line up down the pane.
    // A job has no context to meter, so it keeps no blank column for one.
    const ctx =
      width < 26
        ? ''
        : node.contextUsage
          ? contextLine(node.contextUsage.percent, CONTEXT_METER_WIDTH)
          : node.job
            ? ''
            : ' '.repeat(CONTEXT_METER_WIDTH);
    const clock = width < 12 ? '' : turnClock(node, now) || ' ';
    // Codex's own name, as its /subagents picker prints it: what the agent
    // is doing is the log's to say, under the tree. A job's is its task label.
    const text = monitorText(shownName(shownNode(node), state.labelAsName));
    let right: string;
    if (node.job) {
      // The name keeps eight columns; then role and phase, a source not corroborated, model and effort, and
      // the attention mark are given what is left, in that order.
      const lead = guardianChip(node.children);
      const last = [ctx, clock].filter(Boolean).join(' ');
      const room =
        width -
        visualLength(prefix) -
        1 -
        Math.min(8, visualLength(text)) -
        (lead ? visualLength(lead) + 1 : 0) -
        (last ? visualLength(last) + 1 : 0);
      right = [lead, fitParts(jobParts(node, badge), room).join(' '), last].filter(Boolean).join(' ');
    } else right = [guardianChip(node.children), badge, ctx, clock].filter(Boolean).join(' ');
    const room = Math.max(1, width - visualLength(prefix) - (right ? visualLength(right) + 1 : 0));
    const squeezed = squeeze(text, room);
    const name = dimName ? colors.dim(squeezed) : squeezed;
    const selected = node.id === state.tree.selectedId;
    const line = pair(prefix + name, right, width);
    result.push({ text: selected ? theme.selectedBand(fit(line, width)) : line, item: node.id, key: `row:${node.id}` });
    // The selected row says how far its agent got, under its name; the rest
    // stay one line each, so the tree stays compact.
    const at = visualLength(prefix) + 1;
    const brief = selected && width > at + 4 ? briefLine(input.agentLog?.get(node.id) ?? []) : '';
    if (brief)
      result.push({
        text: ' '.repeat(at) + colors.dim(truncateAnsi(brief, width - at)),
        item: node.id,
        key: `row:${node.id}`,
      });
  }
  return result;
}

/** Repository facts only; no file rows, selection, preview or diff. */
export function changesRows(input: MonitorData, _state: MonitorState, width: number, now: number): MonitorRow[] {
  const snapshot = input.worktrees;
  const rows: MonitorRow[] = [];
  if (snapshot?.error) rows.push({ text: theme.warning(t('No readable repository')) });
  if (snapshot?.truncated) rows.push({ text: theme.warning(t('Worktree list limited')) });
  const current = snapshot?.entries
    .filter((entry) => snapshot.sourcePath === entry.path || snapshot.sourcePath?.startsWith(entry.path + '/'))
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (current) {
    rows.push(...kvRows('branch', current.branch ?? t(current.bare ? 'bare' : 'detached'), width));
    rows.push(...kvRows('HEAD', current.head ?? t('unknown'), width));
    if (current.status && now - (current.observedAt ?? 0) <= 30_000) {
      const status = current.status;
      for (const key of ['ahead', 'behind', 'staged', 'unstaged', 'untracked'] as const)
        rows.push(...kvRows(key, String(status[key] ?? '?'), width));
    } else rows.push({ text: theme.warning(t('Git incomplete')) });
  }
  rows.push({ text: '' }, section(t('Worktrees'), width, String(snapshot?.entries.length ?? 0)));
  for (const entry of snapshot?.entries ?? []) {
    const dirty = entry.status && now - (entry.observedAt ?? 0) <= 30_000 ? entry.status.changed > 0 : null;
    const label = `${monitorText(entry.branch ?? t(entry.bare ? 'bare' : 'detached'))} · ${t(dirty === null ? 'unknown' : dirty ? 'dirty' : 'clean')}`;
    rows.push(itemRow('', monitorText(entry.path), label, width));
  }
  return rows;
}

export function paneRows(
  id: MonitorPane,
  input: MonitorData,
  state: MonitorState,
  width: number,
  now: number,
  delegation?: DelegationView
): MonitorRow[] {
  if (id === 'agents') return agentRows(input, state, width, now);
  if (id === 'changes') return changesRows(input, state, width, now);
  return inspectorRows(input, state, width, now, delegation);
}

/**
 * What the brief said besides its fields: a reply in another shape than the
 * JSON asked for, as the text it is, and a failed call. Model output is
 * sanitized like any other external string.
 */
export function briefSaid(input: MonitorData, width: number): string[] {
  const brief = input.brief;
  // A failure the panel itself names is in the reader's language; a backend's is as it came.
  const failure = brief?.error
    ? flowLines(monitorText(t(brief.error)), Math.max(1, width)).map((text) => theme.warning(text))
    : [];
  // A reply in another shape than the JSON asked for is shown as the text it is.
  const body =
    brief?.text && !brief.structured && !brief.items && !brief.overall
      ? brief.text
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .flatMap((line) => flowLines(monitorText(line), Math.max(1, width)))
      : [];
  // A line restored from an earlier panel has no reply text behind it: its failure is all there is.
  const spoke = Boolean(brief?.text || brief?.overall);
  return [...body, ...(spoke ? failure.slice(0, 1) : failure)];
}

/** The brief's rule as a row. Its switch is on the control bar. */
export function briefRuleRow(brief: NonNullable<MonitorData['brief']>, width: number): MonitorRow {
  return { text: briefRule(brief, width), key: 'brief' };
}

/**
 * Compact: the area under the agents: the Brief rule, then the main recap,
 * the whole-picture sentence, and the per-agent log. With no brief
 * configured but the log asked for, the rule names the log alone and carries
 * no switch. `spaced` puts a blank line between the parts.
 */
function briefRows(input: MonitorData, state: MonitorState, width: number, now: number, spaced: boolean): MonitorRow[] {
  const brief = input.brief;
  if (!brief && !input.agentLog) return [];
  const rule = brief
    ? briefRuleRow(brief, width)
    : { text: colors.dim(truncateAnsi(`${t('─ Agent log')} ${'─'.repeat(width)}`, width)), key: 'brief' };
  // The same fields as the status card's, a column in from the rule.
  const head: MonitorRow[] = brief?.recap
    ? [
        {
          text: colors.dim(truncateAnsi(` ${t('Main recap')} · ${writtenAge(brief.recap.at, now)}`, width)),
          key: 'recap',
        },
      ]
    : [];
  let top: MonitorRow[] = [
    ...head,
    ...briefFields(input, Math.max(1, width - 1)).flatMap((field) =>
      field.lines.map((line) => ({ text: ' ' + line, key: field.id === 'said' ? 'said' : 'recap' }))
    ),
  ];
  // Paused, the last brief stays for reference but steps back.
  if (brief?.paused) top = top.map((row) => ({ ...row, text: colors.dim(stripAnsi(row.text)) }));
  const gap = (on: unknown): MonitorRow[] => (on && spaced ? [{ text: '' }] : []);
  const log = input.agentLog ? logRows(input, state, width, now, spaced) : [];
  return [{ text: '' }, rule, ...top, ...gap(top.length && log.length), ...log];
}

/** Log entries shown per agent; the selected agent shows more, the Inspector all. */
const LOG_ENTRIES = 2;
const LOG_ENTRIES_SELECTED = 6;

/**
 * The per-agent log: a block per agent the tree shows, newest news first
 * (the selected agent leads, opened up), each headed by the agent as its
 * tree row shows it. What the tree hides, the log hides; a collapsed parent
 * gets one line counting the logs folded under it. Nothing is deleted by
 * hiding: showing the agent again shows all of it.
 */
function logRows(input: MonitorData, state: MonitorState, width: number, now: number, spaced: boolean): MonitorRow[] {
  const logs = input.agentLog!;
  const shown = visibleRows(input.tree.nodes, state.tree, now);
  const blocks: Array<{ node: SubagentTreeNode; entries: readonly AgentLogEntry[]; folded: number; newest: number }> =
    [];
  for (const row of shown) {
    const entries = logs.get(row.node.id) ?? [];
    const folded =
      row.collapsed && row.hasChildren
        ? visibleRows(row.node.children, { ...state.tree, collapsed: new Set() }, now).filter(
            (child) => (logs.get(child.node.id)?.length ?? 0) > 0
          ).length
        : 0;
    if (!entries.length && !folded) continue;
    blocks.push({ node: row.node, entries, folded, newest: entries.at(-1)?.at ?? 0 });
  }
  const selected = state.tree.selectedId;
  blocks.sort((a, b) => Number(b.node.id === selected) - Number(a.node.id === selected) || b.newest - a.newest);
  const rows: MonitorRow[] = [];
  for (const [index, { node, entries, folded }] of blocks.entries()) {
    // A blank line between agents is what makes one block end and the next
    // begin at a glance.
    if (spaced && index) rows.push({ text: '' });
    // Each line of the block is a click target that selects its agent.
    const push = (text: string) =>
      rows.push({ text, key: `log:${node.id}`, controls: [{ kind: 'log', item: node.id, x: 0, width }] });
    const st = nodeStatus(node, now);
    // What the panel knows for itself is not left to the model: a failed or
    // quiet agent needs a look, and so does one the latest note flagged.
    const attention =
      effectiveStatus(node) === 'error' || needsInput(node) || isQuiet(node, now) || Boolean(entries.at(-1)?.attention);
    const title = agentTitle(shownNode(node), state.labelAsName);
    const head = `${attention ? theme.warning('!') : ' '}${st.paint(st.icon)} ${title.icon ? colors.dim(title.icon) + ' ' : ''}`;
    const name = squeeze(title.name, Math.max(1, width - visualLength(head)));
    push(head + (attention ? theme.warning(name) : theme.strong(name)));
    // Under the name that identifies it, what the agent is for.
    for (const line of taskLines(title, Math.max(1, width - 3)).lines)
      push('   ' + (title.renamed || title.original ? line : colors.dim(line)));
    const count = node.id === selected ? LOG_ENTRIES_SELECTED : LOG_ENTRIES;
    for (const entry of [...entries].reverse().slice(0, count))
      for (const line of logEntryLines(entry, width, now, 3)) push(line);
    if (folded) push(colors.dim(truncateAnsi(`   ${t('+{n} folded below', { n: folded })}`, width)));
  }
  return rows;
}

/**
 * "─ Brief · writing… ────────": the rule heading the brief and its state.
 * No age: a counter ticking up every second said nothing a reader acts on.
 * The switch that holds the model calls is the pause button on the control bar.
 */
export function briefRule(brief: NonNullable<MonitorData['brief']>, width: number): string {
  const status = brief.paused ? t('paused') : brief.running ? t('writing…') : brief.error ? t('failed') : '';
  const label = `${t('─ Brief')}${status ? ` · ${status}` : ''} `;
  return colors.dim(truncateAnsi(label + '─'.repeat(Math.max(0, width - visualLength(label))), width));
}

/**
 * The agents view's rows, its summary line first: in rich style a card per
 * agent (the main session's brief is in the status card at the foot); in
 * compact the tree, then the brief and log under it. One view, scrolled as one.
 */
export function agentsView(
  input: MonitorData,
  state: MonitorState,
  width: number,
  now: number,
  spaced: boolean,
  viewport?: number
): MonitorRow[] {
  // A delegation view model, whenever there is one, is the agents view (rulings B10B-s2 Q1).
  const delegation = input.hud?.delegation;
  if (nativeCallsOnly(delegation)) {
    const nativeRows =
      state.style === 'rich'
        ? richRows(input, state, width, now, spaced)
        : [...agentRows(input, state, width, now), ...briefRows(input, state, width, now, spaced)];
    const calls = delegationAgentsRows(delegation!, { width, nowMs: now, style: 'compact', showHistory: true }).map(
      (row) => ({ text: row.text, key: row.key, item: undefined })
    );
    return [...nativeRows, ...calls];
  }
  if (delegation) {
    const mixedInput = { ...input, tree: { ...input.tree, nodes: mixedOrdinaryNodes(input.tree.nodes, delegation) } };
    const ordinary =
      state.style === 'rich'
        ? richRows(mixedInput, state, width, now, spaced)
        : [...agentRows(mixedInput, state, width, now), ...briefRows(mixedInput, state, width, now, spaced)];
    return mixedAgentsRows(
      delegationAgentsRows(delegation, {
        width,
        nowMs: now,
        style: state.style === 'rich' ? 'rich' : 'compact',
        selectedId: state.tree.selectedId,
        collapsed: state.tree.collapsed,
        showHistory: state.tree.showAll,
        viewport,
        empty: () => emptyAgentsRows(input, width),
      }),
      ordinary
    );
  }
  if (state.style === 'rich') return richRows(input, state, width, now, spaced);
  return [...agentRows(input, state, width, now), ...briefRows(input, state, width, now, spaced)];
}
