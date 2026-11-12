/** Pure Project rows, using the same kit as Home and the Inspector. */
import { SLICE_STATES, type SliceState, type ProjectSnapshot, type ProjectItem } from '../collectors/project-board.js';
import type { WorkboardSnapshot } from '../collectors/workboard-types.js';
import { projectWorkCard } from '../collectors/work-card.js';
import { jobSentenceLine, workCardDetail } from './work-card.js';
import type { MonitorRow, MonitorState } from './monitor.js';
import { basename } from 'node:path';
import { boardRow, itemRow, section, mark, minuteAge, kvRows } from './workboard-rows.js';
import { monitorText, fit, pair } from './monitor-text.js';
import { theme, visualLength } from './colors.js';
import { t } from './i18n.js';
const sliceInk = (state: SliceState) => ({ working: theme.board.active, blocked: theme.board.attention,
  try: theme.board.identifier, accepted: theme.board.success, todo: theme.board.muted, dropped: theme.board.frame })[state];
/** Cumulative rounding keeps the stacked bar cell-exact, including small nonzero segments. */
export function progressSegments(counts: ProjectSnapshot['counts'], width: number) {
  const total = SLICE_STATES.reduce((n, state) => n + counts[state], 0);
  let count = 0, edge = 0;
  return SLICE_STATES.map((state) => {
    count += counts[state];
    const end = total ? Math.round(count / total * width) : 0;
    const segment = { state, width: end - edge };
    edge = end;
    return segment;
  });
}
export function projectRows(
  data: ProjectSnapshot | undefined, state: MonitorState, width: number, now: number,
  board?: WorkboardSnapshot, modelEnabled = false
): MonitorRow[] {
  if (!data) return [];
  const rows: MonitorRow[] = [boardRow('')], folded = state.projectFolded ?? new Set(['control', 'agents']);
  const header = (id: string, label: string, right = '') => {
    rows.push({
      ...section(`${folded.has(id) ? mark('▸', '>') + ' ' : ''}${t(label)}`, width, right),
      item: `project:fold:${id}`,
    });
    return !folded.has(id);
  };
  const item = (r: ProjectItem, i: number, glyph = '') => {
    const left = `${r.label ? fit(t(r.label), 10) + ' ' : ''}${monitorText(r.value)}`;
    const right = width < 56 ? '' : r.at !== undefined ? minuteAge(r.at, now)
      : r.path ? monitorText(basename(r.path)) : '';
    rows.push({
      ...itemRow(glyph, left, right, width),
      ...(r.path ? { item: `project:file:${r.path}:${i}`, files: [r.path] } : {}),
    });
  };
  if (data.waiting.length) {
    if (header('waiting', 'Waiting for you', String(data.waiting.length)))
      data.waiting.forEach((r, i) => item(r, i, theme.board.attention('?')));
    rows.push(boardRow(''));
  }
  let updated = '';
  if (data.updatedAt !== undefined) {
    const at = new Date(data.updatedAt), today = new Date(now);
    const time = at.toDateString() === today.toDateString()
      ? `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
      : `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
    updated = t('updated {time}', { time });
  }
  const drift = data.slices.filter((r) => r.drift).length;
  if (header('progress', 'Progress', [updated, drift ? theme.board.attention(`! ${drift}`) : ''].filter(Boolean).join(' · '))) {
    const fileRow = (text: string, key: string, path = data.statePath) => rows.push({
      text: fit(text, width), ...(path ? { item: `project:file:${path}:${key}`, files: [path] } : {}),
    });
    if (data.summary) fileRow(`  ${monitorText(data.summary)}`, 'summary');
    const segments = progressSegments(data.counts, width);
    if (segments.some((s) => s.width)) rows.push(boardRow(segments.map(({ state, width: cells }) =>
      sliceInk(state)(mark(state === 'todo' || state === 'dropped' ? '░' : state === 'try' ? '▓' : '█', '#').repeat(cells))).join('')));
    const pack = (parts: string[], max = Infinity) => {
      const lines: string[] = [];
      let line = '';
      for (const part of parts) {
        if (line && visualLength(line + '  ' + part) > width) { lines.push(line); line = ''; }
        line += '  ' + part;
      }
      if (line) lines.push(line);
      return lines.slice(0, max);
    };
    for (const line of pack(SLICE_STATES.map((s) => sliceInk(s)(`${mark('●', '*')} ${t(s === 'try' ? 'landed, to try' : s)} ${data.counts[s]}`))))
      rows.push(boardRow(fit(line, width)));
    const { ids, current } = data.ladder, index = ids.indexOf(current ?? '');
    for (const [i, line] of pack(ids.map((id, i) => {
      const safe = monitorText(id);
      return index < 0 ? safe : i < index ? theme.board.success(`[${safe}]`)
        : i === index ? theme.board.title(`(${safe})`) : theme.board.muted(safe);
    }), 2).entries()) fileRow(line, `chips:${i}`);
    for (const [i, r] of data.slices.entries()) {
      const path = r.path ?? data.statePath;
      const reason = r.drift === 'ledger' ? t('ledger: {state}', { state: monitorText(t(r.ledgerState ?? '')) })
        : r.drift ? t(r.drift) : '';
      const glyph = r.drift ? theme.board.attention('!') : r.ledgerState === 'blocked'
        ? sliceInk('blocked')(mark('◆', '!')) : sliceInk('working')(mark('◐', '@'));
      fileRow(pair(`  ${glyph} ${monitorText(r.label)}${r.value ? '  ' + monitorText(r.value) : ''}`,
        reason ? theme.board.attention(reason) : '', width), `slice:${i}`, path);
      if (!r.jobId) continue;
      const worker = board?.workers.find((w) => w.evidence[0]?.sourceId === r.jobId);
      const asking = worker?.homeNeedsHuman ?? r.asking;
      const right = [monitorText(worker?.role ?? r.role ?? ''), asking ? `${t('asking')} ?`
        : minuteAge(r.at ?? null, now)].filter(Boolean).join(' ');
      const prefix = `    ${t('now:')} `, room = Math.max(1, width - visualLength(prefix) - visualLength(right) - 1);
      const sentence = worker ? modelEnabled && worker.modelSentence
        // Reuse Home's keyword painting and word cut, without its two-cell stem.
        ? jobSentenceLine(worker.modelSentence, room + 3, (s) => s).slice(2).trimEnd()
        : monitorText(workCardDetail(projectWorkCard(worker, now))) : '';
      fileRow(pair(prefix + sentence, right, width), `slice:${i}:now`, path);
    }
    data.next.slice(0, 4).forEach((r, i) => fileRow(
      `${i ? ' '.repeat(13) : `${mark('→', '>')} ${fit(t('next'), 10)} `}${monitorText(r.value)}`, `next:${i}`, r.path));
    if (data.next.length > 4) rows.push(boardRow(fit(`${' '.repeat(13)}+${data.next.length - 4}`, width)));
  }
  rows.push(boardRow(''));
  if (header('tree', 'Working tree')) {
    if (data.git) item({ label: 'branch', value: [
      data.git.branch, t('{n} changed', { n: data.git.changed }),
      data.git.ahead === null ? '' : `${data.git.ahead} ${t('ahead')}`,
      data.git.behind ? `${data.git.behind} ${t('behind')}` : '',
    ].filter(Boolean).join(' · ') }, 0);
    data.editing.forEach((r, i) => item(r, i, theme.board.active(mark('◉', '@'))));
    if (data.last) item({ label: 'last', value: data.last.text, at: data.last.at }, 0);
  }
  rows.push(boardRow(''));
  if (header('docs', 'Docs')) data.docs.forEach((r, i) => item(r, i));
  rows.push(boardRow(''));
  if (header('control', 'Control plane', `${data.roleCount} ${t('roles')} · ${data.agents.length} ${t('agents')}`)) {
    data.control.forEach((r, i) => item(r.label === 'convention'
      ? { ...r, value: t(r.value) + ' · ' + basename(r.path!) } : r, i));
    if (header('agents', 'agents', String(data.agents.length))) data.agents.forEach((r, i) => item(r, i));
    rows.push(...kvRows('keys', data.keys.map(([name, present]) =>
      `${name} ${mark(present ? '✓' : '−', present ? '+' : '-')}`).join('  '), width));
    item({ label: 'browser', value: mark(data.browser ? '✓' : '−', data.browser ? '+' : '-') }, 0);
  }
  return rows;
}
