/** Expanded Home cards, honest local facts and openable workflow files. No I/O. */
import type { OwnerWorker, WorkLane, WorkTarget } from '../collectors/workboard-types.js';
import { targetKey } from '../collectors/workboard-types.js';
import { projectWorkCard } from '../collectors/work-card.js';
import type { MonitorRow, MonitorState } from './monitor.js';
import { renderWorkCard, requestLines, stemLines, jobSentenceRows, workPhaseText, workStateGlyph, workStateInk, labelSummary } from './work-card.js';
import {
  kvRows,
  section,
  itemRow,
  mark,
  minuteAge,
  decisionTitle,
  decisionRows,
  boardRow,
  asciiBoard,
} from './workboard-rows.js';
import { theme } from './colors.js';
import { monitorText, fit } from './monitor-text.js';
import { providerMark } from './providers.js';
import { laneStrip } from './work-lanes.js';
import { t } from './i18n.js';
import { formatTokenCount } from './lines/activity-line.js';
export function localTime(at: number | null, now: number): string {
  if (at === null) return '';
  const date = new Date(at),
    today = new Date(now);
  return (
    (date.toDateString() === today.toDateString()
      ? ''
      : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ') + date.toTimeString().slice(0, 5)
  );
}
function facts(entries: [string, string][], width: number): MonitorRow[] {
  const parts = entries
    .filter(([, value]) => value)
    .map(([label, value]) => kvRows(label, value, width >= 80 ? Math.floor(width / 2) - 1 : width));
  if (width < 80) return parts.flat();
  const rows: MonitorRow[] = [],
    half = Math.floor(width / 2);
  for (let i = 0; i < parts.length; i += 2)
    for (let j = 0; j < Math.max(parts[i].length, parts[i + 1]?.length ?? 0); j++)
      rows.push(boardRow(fit(parts[i][j]?.text ?? '', half) + fit(parts[i + 1]?.[j]?.text ?? '', width - half)));
  return rows;
}
export function workInspectorRows(
  worker: OwnerWorker,
  state: MonitorState,
  width: number,
  now: number,
  _heading = true
): MonitorRow[] {
  const card = projectWorkCard(worker, now, state.cardStallMinutes),
    target: WorkTarget = { kind: 'worker', laneId: worker.laneId, workerId: worker.id };
  const expanded = { ...state, boardExpanded: new Set([targetKey(target)]) };
  const rows =
    card.state === 'needs-you'
      ? [
          boardRow(renderWorkCard(card, expanded, width)[0]),
          ...requestLines(card, true).flatMap((s) =>
            stemLines(s, width, theme.board.attention).map((text) => boardRow(theme.board.slab(text)))
          ),
        ]
      : renderWorkCard(card, expanded, width).map((text) => boardRow(text));
  const stamp = (at: number | null) =>
    at === null ? '' : `${localTime(at, now)} · ${t('{age} ago', { age: minuteAge(at, now) })}`;
  const model = worker.model?.replace(/^.*\//, '') ?? '',
    glyph = !asciiBoard() ? providerMark({ id: model, provider: worker.provider })?.glyph : '';
  rows.push(
    boardRow(''),
    ...facts(
      [
        ['role', [worker.role, worker.harness].filter(Boolean).join(' · ')],
        ['model', [model ? `${glyph ? glyph + ' ' : ''}${model}` : '', worker.effort].filter(Boolean).join(' · ')],
        [
          worker.nativeDepth !== undefined ? 'parent' : 'package',
          worker.nativeDepth !== undefined
            ? (worker.parentName ?? t('this session'))
            : worker.laneId.replace(/^thin-job:package:/, ''),
        ],
        ['state', [t(worker.state), worker.phase ? workPhaseText(worker.phase) : ''].filter(Boolean).join(' · ')],
        [
          'resources',
          [
            worker.resources?.context === undefined ? '' : `${worker.resources.context}%`,
            worker.resources?.rate ? `~${Math.round(worker.resources.rate.tokensPerSecond)} tok/s` : '',
            worker.resources?.spent
              ? `${formatTokenCount(worker.resources.spent.input + worker.resources.spent.output)} ${t('tokens spent')}`
              : '',
          ]
            .filter(Boolean)
            .join(' · '),
        ],
        ['outcome', worker.labels?.outcome ? `${t(worker.labels.outcome.value)} ${Math.round(worker.labels.outcome.confidence * 100)}%` : ''],
        ['kind', worker.labels?.kinds?.map((k) => t(k)).join(' · ') ?? ''],
        ['looping', worker.labels?.looping !== undefined ? `${Math.round(worker.labels.looping * 100)}%` : ''],
        ['category', t(worker.labels?.category ?? '')],
        ['findings', labelSummary({ severity: worker.labels?.severity })],
        ['started', stamp(worker.startedAt)],
        [
          worker.homeNeedsHuman ? 'asked' : worker.settledAt !== null ? 'ended' : 'activity',
          stamp(worker.homeNeedsHuman ? worker.humanEndedAt : (worker.settledAt ?? worker.work?.activityAt ?? null)),
        ],
      ],
      width
    )
  );
  const files = worker.files ?? [];
  if (files.length) rows.push(boardRow(''), section(t('Files'), width, String(files.length)));
  for (const file of files) {
    const decision = file.qid ? file.state : undefined;
    const glyph =
      decision === 'open'
        ? '?'
        : decision
          ? mark(decision === 'departure' ? '◆' : '◇', decision === 'departure' ? '*' : 'o')
          : '';
    const ink = decision === 'open' || decision === 'departure' ? theme.board.attention : theme.board.muted;
    const row = itemRow(
      ink(glyph),
      monitorText(file.qid ? `${file.qid}  ${file.title ?? ''}` : file.rel) +
        (file.verdict
          ? '  ' + (file.verdict === 'accept' ? theme.board.success : theme.board.attention)(monitorText(file.verdict))
          : ''),
      file.state === 'open' && worker.homeNeedsHuman
        ? `${t('asking')} ${minuteAge(file.at, now)}`
        : localTime(file.at, now),
      width
    );
    rows.push({ ...row, item: 'file:' + file.paths[0], files: file.paths });
  }
  return rows;
}
export function boardInspectorRows(
  lane: WorkLane | undefined,
  target: WorkTarget | undefined,
  state: MonitorState,
  width: number,
  now: number
): MonitorRow[] {
  if (!lane || !target) return [];
  if (target.kind === 'worker') {
    const worker = lane.workers.find((w) => w.id === target.workerId);
    return worker
      ? [
          boardRow(''),
          ...workInspectorRows(
            {
              ...worker,
              files: worker.files?.map((f) => ({
                ...f,
                title:
                  lane.decisions.find((d) =>
                    d.evidence.some((e) => e.sourceId === worker.evidence[0]?.sourceId && e.relativePath === f.rel)
                  )?.modelTitle ?? f.title,
              })),
            },
            state,
            width,
            now
          ),
        ]
      : [];
  }
  if (target.kind === 'lane')
    return [
      boardRow(''),
      boardRow(
        theme.board.title(
          itemRow(
            mark('▸', '>'),
            monitorText(lane.label) + '  ' + workPhaseText(lane.phase ?? ''),
            laneStrip(lane, state, now, Math.floor(width / 3)),
            width
          ).text
        )
      ),
      ...facts(
        [
          ['jobs', String(lane.workers.length)],
          ['decisions', String(lane.decisions.length)],
          ['started', localTime(lane.startedAt, now)],
        ],
        width
      ),
      boardRow(''),
      section(t('Jobs'), width),
      ...lane.workers.map((w) => ({
        ...itemRow(
          workStateInk(projectWorkCard(w, now))(workStateGlyph(projectWorkCard(w, now))),
          monitorText(`${w.role ?? ''}  ${w.task}`),
          minuteAge(w.startedAt, now),
          width
        ),
        item: 'file:' + w.id,
        files: w.files?.find((f) => f.kind === 'report')?.paths ?? w.files?.find((f) => f.kind === 'brief')?.paths,
      })),
    ];
  const d = lane.decisions.find((d) => d.id === target.decisionId);
  if (!d) return [];
  const rows = [
    boardRow(''),
    decisionRows(d, lane, { ...state, boardExpanded: new Set([targetKey(target)]) }, width, now)[0],
    ...(d.modelTitle ? jobSentenceRows(d.modelTitle, width, theme.board.muted, true) : stemLines(decisionTitle(d), width)).map((text) => boardRow(theme.board.body(text))),
    boardRow(''),
    ...[
      ['asked', d.modelQuestion ?? d.question],
      [d.verdict ? 'verdict' : 'answer', d.modelAnswer ?? d.verdict ?? d.option ?? (d.kind === 'answer' ? d.title : undefined)],
      ['instead of', d.modelInstead ?? d.instead],
      ['why', d.modelWhy ?? d.rationale ?? d.context],
    ].flatMap(([label, value]) =>
      value ? kvRows(label!, value, width, label === 'instead of' ? theme.board.attention : undefined) : []
    ),
  ];
  rows.push(boardRow(''), section(t('Files'), width, String(d.evidence.length)));
  for (const e of d.evidence) {
    const paths =
      lane.identity.kind === 'invocation' && /^j[0-9a-f]{16}$/.test(e.sourceId)
        ? [`${lane.identity.home}/jobs/${e.sourceId}/${e.relativePath}`]
        : undefined;
    rows.push({
      ...itemRow('', monitorText(e.relativePath), localTime(e.at, now), width),
      item: paths ? 'file:' + paths[0] : undefined,
      files: paths,
    });
  }
  return rows;
}
