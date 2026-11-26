/** Scoped pinned owner-request area below tabs and strip. Pure: no I/O. */
import { ownerRequestKey, type ProjectItem } from '../collectors/project-board.js';
import type { MonitorRow, MonitorState } from './monitor.js';
import { theme, truncateAnsi, visualLength as cells } from './colors.js';
import { cutSentence, fit, monitorText, pair } from './monitor-text.js';
import { compactAge, mark, stateMark } from './workboard-rows.js';
import { t } from './i18n.js';

export const REQUEST_CAP = 4;
export const REQUEST_FOLD = 'waiting:more';
export const HOME_REQUEST_MORE = 'home:wait:more';
export const PROJECT_REQUEST_MORE = `project:fold:${REQUEST_FOLD}`;

export const isRequestMoreItem = (item?: string): boolean =>
  item === HOME_REQUEST_MORE || item === PROJECT_REQUEST_MORE;

/** Home's cross-project requests use Home's fold flag; Project and Objective/Feature sub-pages use Project's. */
export const usesHomeRequestsFold = (state: Pick<MonitorState, 'activeTab' | 'subpage'>): boolean =>
  !state.subpage && state.activeTab === 'home';

export const requestsAreaExpanded = (
  state: Pick<MonitorState, 'activeTab' | 'subpage' | 'home' | 'project'>,
): boolean =>
  usesHomeRequestsFold(state)
    ? Boolean(state.home.requestsExpanded)
    : state.project.folded.has(REQUEST_FOLD);

export interface ScopedRequest {
  root: string;
  projectName: string;
  item: ProjectItem;
  index: number;
  files?: string[];
}

export interface RequestAreaOptions {
  /** Home shows `project › Objective`; Project and its sub-pages omit the project name. */
  showProject: boolean;
  width: number;
  now: number;
  expanded: boolean;
}

const SENTENCE_INLINE_MIN = 24;
const askMark = () => theme.board.attention(stateMark.asking());
const nameCap = (width: number) => (width < 50 ? 14 : width < 80 ? 18 : 24);

function singleRequestRows(req: ScopedRequest, { showProject, width, now }: RequestAreaOptions): MonitorRow[] {
  const ink = theme.board;
  const { root, projectName, item, index, files } = req;
  const name = showProject ? monitorText(projectName) : '';
  const id = monitorText(item.objective ?? '');
  const lead = `${askMark()} `;
  const divider = name && id ? ` ${ink.muted(mark('›', '>'))} ` : '';
  const hasLabel = Boolean(name || id);
  const fixed = cells(lead) + cells(divider);
  const minName = Math.min(cells(name), 8);
  const minId = Math.min(cells(id), 8);

  // Drop the `work waits` flag before cutting a project/objective name below 8 cells; age always stays.
  const age = compactAge(item.at, now);
  const agePart = age ? ink.muted(age) : '';
  const flag = item.waitedOn ? ink.attention(t('work waits')) : '';
  const rightBudget = hasLabel ? width - fixed - minName - minId - 1 : width - cells(lead) - 1;
  const both = flag && agePart ? `${flag} ${agePart}` : '';
  let right = '';
  if (both && cells(both) <= rightBudget) right = both;
  else if (agePart && cells(agePart) <= width - cells(lead) - 1) right = agePart;
  else if (flag && cells(flag) <= rightBudget) right = flag;

  const labelRoom = Math.max(0, width - fixed - (right ? cells(right) + 1 : 0));
  let nameWidth = Math.min(cells(name), nameCap(width));
  let idWidth = Math.min(cells(id), showProject ? 14 : 18);
  while (nameWidth + idWidth > labelRoom && (nameWidth > minName || idWidth > minId)) {
    if (nameWidth > minName && (nameWidth >= idWidth || idWidth <= minId)) nameWidth--;
    else idWidth--;
  }
  while (nameWidth + idWidth > labelRoom && (nameWidth > 0 || idWidth > 0)) {
    if (nameWidth >= idWidth && nameWidth > 0) nameWidth--;
    else if (idWidth > 0) idWidth--;
  }

  const nameText = nameWidth > 0 ? ink.text(truncateAnsi(name, nameWidth)) : '';
  const idText = idWidth > 0 ? ink.text(truncateAnsi(id, idWidth)) : '';
  const head = nameText && idText
    ? `${lead}${nameText}${divider}${idText}`
    : `${lead}${nameText || idText}`;

  const prose = monitorText((item.sentence ?? item.value).replace(/\s+/g, ' ').trim());
  const gap = hasLabel ? 2 : 0;
  const rightSpan = right ? cells(right) + 1 : 0;
  const sentenceRoom = width - cells(head) - gap - rightSpan;

  const itemId = showProject
    ? `home:wait:${root}:${item.request ?? index}`
    : `project:wait:${index}`;
  const fileList = files ?? (item.path ? [item.path] : undefined);
  const target: Partial<MonitorRow> = showProject
    ? files
      ? { item: itemId, files }
      : { item: itemId, homeTarget: { root, index, request: ownerRequestKey(item) }, ...(fileList ? { files: fileList } : {}) }
    : { item: itemId, waitingTarget: { index, request: ownerRequestKey(item), root }, ...(fileList ? { files: fileList } : {}) };

  if (!prose) {
    return [{ text: fit(pair(head, right, width), width), ...target }];
  }
  if (sentenceRoom >= SENTENCE_INLINE_MIN || (!hasLabel && !right)) {
    const snippet = cutSentence(prose, Math.max(0, sentenceRoom));
    const left = hasLabel ? `${head}  ${ink.muted(snippet)}` : `${head}${ink.text(snippet)}`;
    return [{ text: fit(pair(left, right, width), width), ...target }];
  }
  const second = `  ${ink.text(cutSentence(prose, Math.max(0, width - 2)))}`;
  return [
    { text: fit(pair(head, right, width), width), ...target },
    { text: fit(second, width), ...target },
  ];
}

/**
 * Render pinned owner requests for the current scope.
 * Empty scope yields zero rows (no heading, no placeholder).
 * Shows at most four requests when collapsed, followed by an inline expand/fold row.
 */
export function requestAreaRows(
  requests: readonly ScopedRequest[],
  options: RequestAreaOptions,
): MonitorRow[] {
  if (!requests.length || options.width < 1) return [];
  const { showProject, width, expanded } = options;
  const shown = expanded ? requests : requests.slice(0, REQUEST_CAP);
  const rows = shown.flatMap((req) => singleRequestRows(req, options));
  const more = requests.length - REQUEST_CAP;
  if (more > 0) {
    const foldItem = showProject ? HOME_REQUEST_MORE : PROJECT_REQUEST_MORE;
    const label = expanded
      ? `${mark('▾', 'v')} ${t('fewer')}`
      : `${mark('▸', '>')} ${t(more === 1 ? '{n} more request' : '{n} more requests', { n: more })}`;
    rows.push({ item: foldItem, text: fit(`  ${theme.board.muted(label)}`, width) });
  }
  return rows;
}
