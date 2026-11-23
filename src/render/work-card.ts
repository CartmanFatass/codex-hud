/** Legacy expanded and collapsed cards, built from the shared job heading and detail rows. */
import type { WorkCard } from '../collectors/work-card.js';
import { targetKey } from '../collectors/workboard-types.js';
import type { MonitorState } from './monitor.js';
import { theme } from './colors.js';
import { jobDetailRows } from './work-job-detail.js';
import { renderJobRow } from './work-job-row.js';

export { ageText } from './workboard-rows.js';
export { cardMarks, failed, workStateGlyph, workStateInk, workStateWord } from './work-job-row.js';
export {
  cardSentence, flowLine, flowStepDetail, flowSummary, identifiers, jobSentenceLine, jobSentenceRows,
  labelSummary, milestoneLine, paintSentence, phaseChain, pulseLine, questionOriginalRows,
  quietDecisionSummary, requestLines, sparkline, stemLines, workJobDetail as workCardDetail,
  workPhaseText, workRequestDetail,
} from './work-job-detail.js';

export const cardExpanded = (state: MonitorState, key: string) =>
  state.home.expanded?.has(key) || (state.home.newestCard === key && !state.home.toggled?.has(key));

export interface RenderCardOptions {
  /** Active sonic children count folded onto this parent row as `⚡N`. */
  sonic?: number;
  /** Secondary workers (routine running, queued, read settled) pack into one row until Enter expands. */
  compact?: boolean;
}
/** Rows a collapsed card's sentence may use; the sentence prompt's length limit is sized for it. */
export const SENTENCE_ROWS = 2;
export function renderWorkCard(
  card: WorkCard,
  state: MonitorState,
  width: number,
  sentence = '',
  badge = '',
  opts: RenderCardOptions = {}
): readonly string[] {
  const open = cardExpanded(state, targetKey({ kind: 'worker', laneId: card.worker.laneId, workerId: card.worker.id }));
  const title = renderJobRow(card, width, badge, opts.sonic);
  if (opts.compact && !open) return [title];
  const bodyMax = open ? Infinity : card.worker.flow ? SENTENCE_ROWS - 1 : SENTENCE_ROWS;
  return [theme.board.title(title), ...jobDetailRows(card, width, bodyMax, sentence)];
}
