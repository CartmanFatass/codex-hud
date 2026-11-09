/** P1 transitional landing: stable lane/decision targets around today's existing cards.
 * P2 replaces this body; this is not the final compact-card/110-column peek design.
 */
import type { WorkboardSnapshot, WorkTarget } from '../collectors/workboard-types.js';
import { targetKey } from '../collectors/workboard-types.js';
import type { SubagentTreeNode } from '../types.js';
import type { MonitorData, MonitorFrame, MonitorRow, MonitorState } from './monitor.js';
import { agentCard, briefFields } from './cards.js';
import { homeRows } from './home-view.js';
import {
  boardRow,
  decisionRows,
  laneRow,
  mark,
  minuteAge,
  section,
  workerRow,
  workerColumns,
  decisionTitle,
} from './workboard-rows.js';
import { theme, visualLength } from './colors.js';
import { fit, monitorText, flowLines, pair } from './monitor-text.js';
import { t, language } from './i18n.js';
import { displayConfig } from './hud-config.js';
const ascii = (text: string) =>
  displayConfig().icons !== 'text'
    ? text
    : text.replace(
        /[┃│━─≠◷✓▸›·→↑↓…]/gu,
        (c) =>
          ({
            '┃': '|',
            '│': '|',
            '━': '-',
            '─': '-',
            '≠': '~',
            '◷': '@',
            '✓': '+',
            '▸': '>',
            '›': '>',
            '·': '.',
            '→': '>',
            '↑': '^',
            '↓': 'v',
            '…': '.',
          })[c]!
      );
// Snapshot-local row projection: scroll-only and quiet same-minute paints reuse the rows.
// Weak ownership drops removed board snapshots; renderer cache never grows with workflow history.
const targetCache = new WeakMap<WorkboardSnapshot, Map<string, WorkTarget>>();
const rowCache = new WeakMap<
  WorkboardSnapshot,
  {
    key: string;
    tree: MonitorData['tree'];
    brief: MonitorData['brief'];
    notes: MonitorData['notes'];
    folded: MonitorState['boardFolded'];
    expanded: MonitorState['boardExpanded'];
    rows: MonitorRow[];
  }
>();
const nodeAt = (nodes: readonly SubagentTreeNode[], id: string): SubagentTreeNode | undefined => {
  for (const node of nodes) {
    if (node.id === id) return node;
    const child = nodeAt(node.children, id);
    if (child) return child;
  }
  return undefined;
};
export function workRows(
  input: MonitorData,
  board: WorkboardSnapshot,
  state: MonitorState,
  width: number,
  now: number
): MonitorRow[] {
  const rows: MonitorRow[] = [];
  const columns = workerColumns(board.workers, width, now);
  for (const lane of board.lanes) {
    rows.push(laneRow(lane, width, now));
    if (state.boardFolded?.has(lane.id)) continue;
    for (const worker of lane.workers) {
      const target: WorkTarget = { kind: 'worker', laneId: lane.id, workerId: worker.id },
        key = targetKey(target);
      const node = worker.nodeId ? nodeAt(input.tree.nodes, worker.nodeId) : undefined;
      if (node) {
        const cardState = {
          ...state,
          tree: {
            ...state.tree,
            // The outer workflow viewport owns the one cursor; retained cards do not add another.
            selectedId: null,
          },
          cardVisibility: { ...state.cardVisibility, cardClock: false },
        };
        const card = agentCard(
          {
            node,
            depth: 0,
            prefix: '',
            hasChildren: !!node.children.length,
            collapsed: false,
            context: false,
            parentId: null,
          },
          input,
          cardState,
          width,
          now
        );
        // P1 retains card facts, but clocks on Home/Work are minute-valued.
        if (card[0]) card[0].text = pair(card[0].text, minuteAge(worker.startedAt, now), width);
        rows.push(...card.map((row) => ({ text: row.text, item: key, key })));
      } else {
        rows.push(workerRow(worker, width, now, columns));
        rows.push(boardRow(`  ${theme.dim(t(worker.state))}`, target));
      }
    }
    for (const record of lane.decisions) rows.push(...decisionRows(record, lane, state, width, now));
  }
  if (!rows.length) rows.push(boardRow(theme.dim(t('No observed work'))));
  return rows;
}
export function boardInspectorRows(
  input: MonitorData,
  board: WorkboardSnapshot,
  state: MonitorState,
  width: number
): MonitorRow[] {
  if (state.boardInspect === 'summary') {
    const fields = briefFields(input, width);
    return [{ text: t('Main summary') }, ...fields.flatMap((field) => field.lines.map((text) => ({ text })))];
  }
  const target = state.boardInspect;
  if (!target) return [];
  const lane = board.lanes.find((l) => l.id === target.laneId);
  if (!lane) return [{ text: t('Source no longer available') }];
  const rows: MonitorRow[] = [section(t('Source details'), width)];
  const add = (label: string, value: string) => {
    for (const text of flowLines(`${t(label)}: ${monitorText(value)}`, width)) rows.push({ text });
  };
  add(
    'Scope',
    lane.identity.kind === 'task-directory'
      ? lane.identity.workspace
      : lane.identity.kind === 'invocation'
        ? lane.identity.root
        : lane.identity.refKey
  );
  add('Source', lane.identity.kind);
  add('Title', lane.title);
  const decision = target.kind === 'decision' ? lane.decisions.find((d) => d.id === target.decisionId) : null;
  if (decision) {
    add(decision.kind === 'recommendation' ? 'recommendation' : 'answer', decisionTitle(decision));
    if (decision.instead) add('instead', decision.instead);
    if (decision.context) add('source context', decision.context);
    if (decision.rationale) add('why', decision.rationale);
    if (decision.oneWay) rows.push({ text: theme.error(t('one-way')) });
    for (const e of decision.evidence) {
      add('Source', e.relativePath);
      add('Time basis', e.timeBasis);
    }
  } else if (target.kind === 'worker') {
    const worker = lane.workers.find((w) => w.id === target.workerId);
    if (!worker) return [{ text: t('Source no longer available') }];
    rows.push(workerRow(worker, width, input.nowMs ?? 0));
    add('State', worker.state);
    if (worker.phase) add('Observed phase', worker.phase);
    rows.push({ text: theme.dim(t('Display only; no native session action')) });
  }
  for (const diagnostic of board.coverage.diagnostics) add('Coverage', diagnostic);
  return rows;
}
/** Pure retained-snapshot viewport. No package ID is ever put in tree.selectedId. */
export function renderWorkboardHelp(
  input: MonitorData,
  state: MonitorState,
  board: WorkboardSnapshot,
  now: number
): MonitorFrame {
  const frame = renderWorkboardFrame(input, state, board, now),
    width = Math.max(0, Math.floor(input.width));
  const words = [
    'Help — Shortcuts',
    '1 Home · 2 Work · 3 Changes · t Timeline · 4/v Inspector · S summary',
    'Display only · Enter opens Work; v inspects',
    '↑↓ move · → expand · Enter: Work · v inspect · ? help',
    'Esc: back · v: inspect · summary in Inspector',
  ];
  frame.lines = frame.lines.map((_, i) => fit(ascii(t(words[i] ?? '')), width));
  frame.controls = [];
  return frame;
}
export function renderWorkboardFrame(
  input: MonitorData,
  state: MonitorState,
  board: WorkboardSnapshot,
  now: number
): MonitorFrame {
  const width = Math.max(0, Math.floor(input.width)),
    height = Math.max(0, Math.floor(input.height));
  const frame: MonitorFrame = {
    state,
    lines: Array.from({ length: height }, () => fit('', width)),
    panes: [],
    controls: [],
  };
  if (!width || !height) return frame;
  const home = state.mainTab !== 'work',
    inspector = state.focus === 'details';
  const needs = board.workers.filter((w) => w.homeNeedsHuman).length;
  const labels = [t('Home') + (needs ? ` ?${needs}` : ''), t('Work')];
  let x = 0;
  const nav = labels
    .map((label, i) => {
      const text = ` ${i === (home ? 0 : 1) && !inspector ? '[' + label + ']' : label} `;
      frame.controls.push({ kind: i ? 'board-work' : 'board-home', x, y: 0, width: visualLength(text) });
      x += visualLength(text);
      return text;
    })
    .join('');
  // Fold secondary controls and the prefix hint into the tabs wherever they fit.
  // Compact labels are the existing keys, not hidden/unreachable controls.
  const secondary = [
    { text: t('Inspect'), compact: 'v', kind: 'board-inspect' as const },
    { text: t('Settings'), compact: ',', kind: 'settings' as const },
    { text: t('Help'), compact: '?', kind: 'help' as const },
    ...(inspector ? [{ text: t('Main summary'), compact: 'S', kind: 'board-summary' as const }] : []),
  ];
  let hint = t('Ctrl+\\ then key');
  const full = secondary.map((s) => ` ${s.text} `).join('');
  const compact = visualLength(nav + full) + 1 + visualLength(hint) > width;
  const buttons = secondary.map((s) => ` ${compact ? s.compact : s.text} `);
  if (visualLength(nav + buttons.join('')) + 1 + visualLength(hint) > width) hint = 'Ctrl+\\';
  const inline = visualLength(nav + buttons.join('')) + 1 + visualLength(hint) <= width;
  const headerRows = inline ? 1 : 2;
  let sx = inline ? visualLength(nav) : 0,
    second = '';
  for (let n = 0; n < secondary.length; n++) {
    const control = secondary[n],
      text = inline ? buttons[n] : ` ${control.text} `;
    if (sx + visualLength(text) > width) break;
    frame.controls.push({ kind: control.kind, x: sx, y: inline ? 0 : 1, width: visualLength(text) });
    second += text;
    sx += visualLength(text);
  }
  frame.lines[0] = pair(inline ? nav + second : nav, theme.dim(hint), width);
  if (!inline && height > 1) frame.lines[1] = fit(second, width);
  const bodyWidth = Math.max(0, width - 1);
  const cacheKey = JSON.stringify([
    bodyWidth,
    Math.floor(now / 60000),
    home,
    inspector,
    state.boardInspect,
    state.boardAnchor,
    state.homeTarget,
    state.workTarget,
    language(),
    displayConfig(),
    input.publicationNotice,
    input.error,
  ]);
  const cached = rowCache.get(board);
  let rows: MonitorRow[];
  if (
    cached &&
    cached.key === cacheKey &&
    cached.tree === input.tree &&
    cached.brief === input.brief &&
    cached.notes === input.notes &&
    cached.folded === state.boardFolded &&
    cached.expanded === state.boardExpanded
  )
    rows = cached.rows;
  else {
    rows = inspector
      ? boardInspectorRows(input, board, state, bodyWidth)
      : home
        ? homeRows(board, state, bodyWidth, now)
        : workRows(input, board, state, bodyWidth, now);
    if (input.publicationNotice) rows.unshift(boardRow(theme.warning(monitorText(input.publicationNotice))));
    if (input.error) rows.unshift(boardRow(theme.error(monitorText(input.error))));
    rowCache.set(board, {
      key: cacheKey,
      tree: input.tree,
      brief: input.brief,
      notes: input.notes,
      folded: state.boardFolded,
      expanded: state.boardExpanded,
      rows,
    });
  }
  let targets = targetCache.get(board);
  if (!targets) {
    targets = new Map<string, WorkTarget>();
    for (const lane of board.lanes) {
      const laneTarget: WorkTarget = { kind: 'lane', laneId: lane.id };
      targets.set(targetKey(laneTarget), laneTarget);
      for (const worker of lane.workers) {
        const target: WorkTarget = { kind: 'worker', laneId: lane.id, workerId: worker.id };
        targets.set(targetKey(target), target);
      }
      for (const decision of lane.decisions) {
        const target: WorkTarget = { kind: 'decision', laneId: lane.id, decisionId: decision.id };
        targets.set(targetKey(target), target);
      }
    }
    targetCache.set(board, targets);
  }
  let selected = home ? state.homeTarget : state.workTarget;
  if (!inspector && selected && !targets.has(targetKey(selected))) {
    const lane: WorkTarget = { kind: 'lane', laneId: selected.laneId };
    selected = targets.get(targetKey(lane));
    if (home) state.homeTarget = selected;
    else state.workTarget = selected;
  }
  if (!inspector && !selected) {
    selected = rows.flatMap((r) =>
      [r.item, ...(r.controls?.map((c) => c.item) ?? [])].flatMap((item) =>
        item && targets.has(item) ? [targets.get(item)!] : []
      )
    )[0];
    if (home) state.homeTarget = selected;
    else state.workTarget = selected;
  }
  if (state.boardAnchor && !rows.some((row) => row.item === state.boardAnchor)) state.boardAnchor = undefined;
  const key = state.boardAnchor ?? (selected ? targetKey(selected) : '');
  const cursorAt = rows.findIndex((row) => row.item === key || row.controls?.some((c) => c.item === key));
  const room = Math.max(0, height - headerRows - 1),
    max = Math.max(0, rows.length - room);
  let offset = inspector ? state.scroll.details : home ? (state.homeScroll ?? 0) : (state.workScroll ?? 0);
  offset = Math.max(0, Math.min(max, offset));
  if (!inspector && key && state.boardRevealed !== `${home}:${key}` && room) {
    const at = rows.findIndex((r) => r.item === key || r.controls?.some((c) => c.item === key));
    if (at >= 0) {
      if (at < offset) offset = at;
      else if (at >= offset + room) offset = at - room + 1;
    }
    state.boardRevealed = `${home}:${key}`;
  }
  offset = Math.max(0, Math.min(max, offset));
  if (inspector) state.scroll.details = offset;
  else if (home) state.homeScroll = offset;
  else state.workScroll = offset;
  for (let i = 0; i < room; i++) {
    const row = rows[offset + i];
    if (!row) continue;
    const highlighted = !inspector && row.item === key && offset + i === cursorAt;
    frame.lines[i + headerRows] = fit(
      ascii(highlighted ? theme.board.selected(`${mark('›', '>')}${row.text}`) : ` ${row.text}`),
      width
    );
    for (const control of row.controls ?? []) frame.controls.push({ ...control, x: control.x + 1, y: i + headerRows });
  }
  if (height > 2)
    frame.lines[height - 1] = fit(
      theme.dim(
        inspector
          ? t('Esc: back · v: inspect · summary in Inspector')
          : t('↑↓ move · → expand · Enter: Work · v inspect · ? help')
      ),
      width
    );
  frame.lines = frame.lines.map((line) => fit(ascii(line), width));
  frame.panes.push({
    id: inspector ? 'details' : 'agents',
    x: 0,
    y: headerRows,
    width,
    height: room,
    offset,
    contentLength: rows.length,
    rows,
    edge: 0,
    visible: room,
  });
  frame.workboard = { snapshot: board, targets, selected, rows };
  return frame;
}
