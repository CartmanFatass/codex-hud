/** Shared package lanes on Home. */
import type { WorkboardSnapshot, WorkLane, OwnerWorker } from '../collectors/workboard-types.js';
import { targetKey } from '../collectors/workboard-types.js';
import { projectWorkCard, type WorkCard } from '../collectors/work-card.js';
import type { MonitorData, MonitorRow, MonitorState } from './monitor.js';
import { ageText, cardExpanded, failed, milestoneLine, pulseLine, renderWorkCard, workPhaseText, workStateGlyph, workStateInk } from './work-card.js';
import { boardRow, mark } from './workboard-rows.js';
import { pair, monitorText, fit } from './monitor-text.js';
import { theme, visualLength, stripAnsi } from './colors.js';
import { currentWorker, foldedWorker } from './work-visibility.js';
import { t } from './i18n.js';
export function workerPriority(w: OwnerWorker, now: number): number {
  if (w.homeRank !== undefined) return -w.homeRank;
  const card = projectWorkCard(w, now);
  return w.homeNeedsHuman
    ? 0
    : card.state === 'stalled'
      ? 1
      : w.work?.failed
        ? 2
        : card.state === 'awaiting-acceptance'
          ? 3
          : card.state === 'in-progress'
            ? 4
            : 5;
}
export function orderedLanes(board: WorkboardSnapshot, now: number): WorkLane[] {
  return [...board.lanes].sort(
    (a, b) =>
      Math.min(...a.workers.map((w) => workerPriority(w, now))) -
      Math.min(...b.workers.map((w) => workerPriority(w, now)))
  );
}
/**
 * A lane's right side: one glyph per job, oldest dispatch first (`✓` done, `◉` running, `?` asking, `✗` failed, `−`
 * stopped), then the role of the newest job running or asking. Older jobs that do not fit `room` are `+N`.
 */
export function laneStrip(lane: WorkLane, state: MonitorState, now: number, room: number): string {
  const cards = [...lane.workers]
    .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
    .map((w) => projectWorkCard(w, now, state.prefs.cardStallMinutes));
  const glyph = {
    done: theme.board.success(mark('✓', '+')),
    run: theme.board.active(mark('◉', '@')),
    ask: theme.board.attention('?'),
    fail: theme.board.danger(mark('✗', 'x')),
    stop: theme.board.muted(mark('−', '-')),
  };
  const kinds = cards.map((c) =>
    c.worker.state === 'stopped'
      ? 'stop'
      : failed(c)
        ? 'fail'
        : c.state === 'needs-you'
          ? 'ask'
          : c.state === 'in-progress' || c.state === 'stalled'
            ? 'run'
            : 'done'
  );
  const live = kinds.map((k) => k === 'run' || k === 'ask').lastIndexOf(true);
  const role = live < 0 ? '' : ' ' + theme.board.muted(monitorText(cards[live].role));
  let keep = cards.length;
  const width = (n: number) => 2 * n - 1 + (n < cards.length ? String(cards.length - n).length + 2 : 0);
  while (keep > 1 && width(keep) + visualLength(role) > room) keep--;
  const older = cards.length - keep ? theme.board.muted(`+${cards.length - keep}`) + ' ' : '';
  const glyphs = kinds.slice(-keep).map((k) => glyph[k]);
  return older + glyphs.join(' ') + role;
}
/** A sonic child under its parent card as one row: `├─ ⚡ sonic · short title  3m ◉`, the last child `└─`. */
function sonicBranch(card: WorkCard, last: boolean, width: number): string {
  const ink = workStateInk(card), role = monitorText(card.role);
  const left = `${theme.board.muted(mark(last ? '└─' : '├─', last ? '`-' : '|-'))} ${ink(`${mark('⚡', '*')} ${role}`)} ${theme.board.muted('·')} ${theme.board.body(monitorText(card.title))}`;
  return pair(left, `${theme.board.muted(ageText(card.elapsedMinutes ?? 0))} ${ink(workStateGlyph(card))}`, width);
}
export function laneRows(
  input: MonitorData,
  lane: WorkLane,
  state: MonitorState,
  width: number,
  now: number
): MonitorRow[] {
  const target = { kind: 'lane' as const, laneId: lane.id };
  if (lane.id.startsWith('thin-job:')) {
    const active = [...lane.workers]
      .filter((w) => w.settledAt === null)
      .sort((a, b) => workerPriority(a, now) - workerPriority(b, now))[0];
    const review = active?.work?.phases.filter((p) => p.startsWith('review')).at(-1);
    const phase = active
      ? review
        ? review.includes('accept')
          ? review
          : `${review.match(/^review r\d+/)?.[0] ?? 'review'} · fixing`
        : (active.phase ?? 'build')
      : 'done';
    lane = { ...lane, phase };
  }
  const label = `${monitorText(lane.identity.kind === 'native' ? lane.label.replace('this session', t('this session')) : lane.label)}${lane.phase ? '  ' + workPhaseText(lane.phase) : ''}`;
  const strip = laneStrip(lane, state, now, Math.max(Math.floor(width / 3), width - visualLength(label) - 1));
  const header = pair(label, strip, width);
  const rows = [
    boardRow(lane.workers.every((w) => !currentWorker(w, now, state.prefs)) ? theme.board.muted(stripAnsi(header)) : header, target),
  ];
  if (state.home.foldedLanes?.has(lane.id)) return rows;
  const workers =
    state.home.showAll || lane.identity.kind === 'native'
      ? lane.workers
      : [...lane.workers].sort((a, b) => workerPriority(a, now) - workerPriority(b, now));
  // Sonic children hang under their parent as one-line branches; one whose parent card is not in this list (Split's preview
  // leaves an asking parent to the slab above) follows the cards.
  const top = workers.filter((w) => !w.parentJobId), children = new Map<string, OwnerWorker[]>();
  for (const w of workers) if (w.parentJobId) children.set(w.parentJobId, [...(children.get(w.parentJobId) ?? []), w]);
  const branches = (kids: OwnerWorker[]) => kids.forEach((kid, i) => {
    const key = targetKey({ kind: 'worker', laneId: lane.id, workerId: kid.id });
    const branch = sonicBranch(projectWorkCard(kid, now, state.prefs.cardStallMinutes), i === kids.length - 1, width - 2);
    rows.push({ text: '  ' + (currentWorker(kid, now, state.prefs) ? branch : theme.board.muted(stripAnsi(branch))), item: key, key });
  });
  for (const worker of top) {
    const card = projectWorkCard(worker, now, state.prefs.cardStallMinutes);
    const sentence = card.reason ? t(card.reason) : '';
    const indent = worker.nativeDepth === 2 ? '  ' : '';
    const room = Math.max(1, width - indent.length);
    const key = targetKey({ kind: 'worker', laneId: lane.id, workerId: worker.id });
    // Past its fold time a settled card is its title row (muted once hidden, in show-all) until Enter opens it; its sonic
    // children fold into the title's `⚡ N sonic` while they run.
    const hidden = !currentWorker(worker, now, state.prefs);
    const expanded = cardExpanded(state, key);
    const folded = !expanded && (hidden || foldedWorker(worker, now, state.prefs));
    const kids = children.get(worker.id) ?? [];
    const running = kids.filter((k) => k.settledAt === null).length;
    const badge = folded && running ? `${mark('⚡', '*')} ${t('{n} sonic', { n: running })}` : '';
    // Home's asking card is a title-only pointer back to the complete slab.
    let lines =
      worker.homeNeedsHuman && !worker.modelSentence
        ? renderWorkCard(card, state, room, '', badge).slice(0, 1)
        : renderWorkCard(card, state, room, sentence, badge);
    if (folded) lines = [hidden ? theme.board.muted(stripAnsi(lines[0])) : lines[0]];
    if (expanded && worker.state === 'working' && !worker.homeNeedsHuman) {
      const milestone = milestoneLine(worker, room), pulse = pulseLine(worker, room);
      if (milestone) lines = [...lines, theme.board.body(milestone)];
      if (pulse) lines = [...lines, theme.board.body(pulse)];
    }
    rows.push(...lines.map((text) => ({ text: indent + text, item: key, key })));
    if (!folded) branches(kids);
  }
  branches([...children].filter(([parent]) => !top.some((w) => w.id === parent)).flatMap(([, kids]) => kids));
  rows.push(boardRow(''));
  return rows;
}
