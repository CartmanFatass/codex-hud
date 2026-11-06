/** Pure selected-report candidates, closed display DTOs and exclusive modal input. No material or I/O. */
import type { SessionRef } from '../core/types/identity.js';
import type { DelegationViewModel } from '../core/link/view-model.js';
import type { DelegationView } from './delegation/panel.js';
import type { WorkbenchInput } from '../utils/workbench-input.js';
import { monitorKey } from '../utils/panel-command.js';
import { fit, flowLines, monitorText } from './monitor-text.js';
import { truncateAnsi, visualLength } from './colors.js';
import { t } from './i18n.js';

export interface DigestPanelTarget {
  key: string;
  ledgerId: string;
  linkId: string;
  runId: string;
  reportId: string;
  ref: SessionRef;
}
export const digestTargetStamp = (target: DigestPanelTarget | null): string =>
  target ? JSON.stringify([target.key, target.ledgerId, target.linkId, target.runId, target.reportId,
    target.ref.harness, target.ref.sourceId, target.ref.sessionId, target.ref.threadId ?? null]) : '';

/** The page's final epoch/selection veto; this never upgrades a candidate into core authority. */
export function digestActionCurrent(target: DigestPanelTarget, context: {
  frameRoot: string; currentRoot: string; frameEpoch: number; currentEpoch: number;
  currentTarget: DigestPanelTarget | null;
}): boolean {
  return context.frameRoot === context.currentRoot && context.frameEpoch === context.currentEpoch &&
    digestTargetStamp(target) === digestTargetStamp(context.currentTarget);
}

/** A candidate only. The existing core must authenticate it before any material is read. */
export function digestPanelTarget(vm: DelegationViewModel | null | undefined, key: string | null): DigestPanelTarget | null {
  if (!vm || !key || vm.tree.ledger.state !== 'available' || !vm.tree.ledger.ledgerId) return null;
  const nodes = vm.tree.nodes.filter((node) => node.key === key);
  if (nodes.length !== 1) return null;
  const node = nodes[0];
  const run = node.currentRun;
  const report = vm.details[key]?.latestReportForRun;
  if (!node.loaded || node.edge !== 'delegated' || !node.parentKey || node.conflict ||
      node.identity.kind !== 'session' || !run || !report || report.status !== 'completed' ||
      report.runId !== run.runId || report.linkId !== run.linkId || !node.links.includes(run.linkId)) return null;
  return { key, ledgerId: vm.tree.ledger.ledgerId, linkId: run.linkId, runId: run.runId,
    reportId: report.reportId, ref: { ...node.identity.ref } };
}
export function digestFrameTarget(view: DelegationView | undefined, key: string | null): DigestPanelTarget | null {
  const rows = view?.dest.rows.filter((row) => row.key === key);
  if (!view || rows?.length !== 1 || !rows[0].pn?.node || rows[0].pn.proj.isRoot) return null;
  return digestPanelTarget(view.vm, key);
}

export type DigestPanelReason = 'unavailable' | 'changed' | 'configuration' | 'denied' | 'paused' | 'failed' | 'timeout';
export interface DigestConfirmation {
  target: DigestPanelTarget;
  endpoint: string;
  account: string;
  model: string;
  language: string;
  ready: boolean;
  reason: DigestPanelReason;
  modelFile: string;
  outboundFile: string;
}
export interface DigestPanelResult {
  generatedAt: number;
  model: string;
  cached: boolean;
  conclusion: string;
  basis?: string;
  caveats?: string;
}
export interface DigestPanelSnapshot {
  phase: 'idle' | 'planning' | 'confirm' | 'running' | 'rechecking' | 'result' | 'failed';
  target: DigestPanelTarget | null;
  confirmation?: DigestConfirmation;
  result?: DigestPanelResult;
  reason?: DigestPanelReason;
}
export const digestModalOwnsInput = (snapshot: DigestPanelSnapshot): boolean =>
  ['planning', 'confirm', 'running', 'failed'].includes(snapshot.phase);
export function digestReason(reason: DigestPanelReason): string {
  const words: Record<DigestPanelReason, string> = {
    unavailable: 'Digest unavailable: select one loaded completed delegated report',
    changed: 'Digest cleared: target, configuration or authorization changed',
    configuration: 'Digest unavailable: check per-source configuration',
    denied: 'Digest unavailable: per-source material scope and outbound grant required',
    paused: 'Digest unavailable: source models are off or paused',
    failed: 'Digest failed; no automatic retry',
    timeout: 'Digest timed out; no automatic retry',
  };
  return t(words[reason]);
}
const linesOf = (text: string, width: number): string[] => flowLines(monitorText(text), width);
export function digestInspectorLines(snapshot: DigestPanelSnapshot | undefined, target: DigestPanelTarget | null, width: number): string[] {
  if (!target) return linesOf(digestReason('unavailable'), width);
  if (!snapshot || digestTargetStamp(snapshot.target) !== digestTargetStamp(target)) return [];
  if (!snapshot.result) return snapshot.reason ? linesOf(digestReason(snapshot.reason), width) : [];
  const result = snapshot.result;
  const at = Number.isFinite(result.generatedAt) && Math.abs(result.generatedAt) <= 8.64e15
    ? new Date(result.generatedAt).toISOString() : t('unknown');
  return [t('Model summary · one completed report'), t('Generated: {time}', { time: at }),
    t('Digest model: {model} · {cache}', { model: result.model, cache: t(result.cached ? 'cached' : 'new request') }),
    t('Conclusion: {text}', { text: result.conclusion }),
    ...(result.basis ? [t('Basis: {text}', { text: result.basis })] : []),
    ...(result.caveats ? [t('Caveats: {text}', { text: result.caveats })] : []),
  ].flatMap((line) => linesOf(line, width));
}
export interface DigestModalFrame {
  lines: string[];
  offset: number;
  maxOffset: number;
  controls: Array<{ kind: 'confirm' | 'cancel'; x: number; y: number; width: number }>;
}
/** Full exact identifiers remain scrollable; there is no raw report, credential or absolute local path. */
export function renderDigestModal(snapshot: DigestPanelSnapshot, width: number, height: number, offset = 0): DigestModalFrame {
  width = Math.max(0, Math.floor(width));
  height = Math.max(0, Math.floor(height));
  const confirmation = snapshot.confirmation;
  const target = snapshot.target;
  const body = [t('Per-source digest configuration'), t('Coverage: one completed report summary'),
    ...(target ? [t('Session: {session}', { session: `${target.ref.harness} · ${target.ref.sessionId}` }),
      t('Source: {source}', { source: `${target.ref.sourceId.slice(0, 12)}…` }),
      t('Exact source: {source}', { source: target.ref.sourceId }),
      t('Thread: {thread}', { thread: target.ref.threadId ?? t('none') }),
      t('Ledger: {id}', { id: target.ledgerId }), t('Link: {id}', { id: target.linkId }),
      t('Run: {id}', { id: target.runId }), t('Report: {id}', { id: target.reportId })] : []),
    ...(confirmation ? [t('Endpoint: {endpoint}', { endpoint: confirmation.endpoint || t('unavailable') }),
      t('Account label: {account}', { account: confirmation.account || t('unavailable') }),
      t('Model: {model}', { model: confirmation.model || t('unavailable') }),
      t('Language: {language}', { language: confirmation.language || t('unavailable') }),
      t('Configuration: {file}', { file: confirmation.modelFile }),
      t('Outbound grants: {file}', { file: confirmation.outboundFile }),
      ...(!confirmation.ready ? [digestReason(confirmation.reason)] : [])] : []),
    ...(snapshot.reason ? [digestReason(snapshot.reason)] : []),
  ].flatMap((line) => linesOf(line, width));
  const title = t(snapshot.phase === 'planning' ? 'Planning digest…' : snapshot.phase === 'running'
    ? 'Generating digest…' : snapshot.phase === 'failed' ? 'Digest unavailable' : 'Confirm digest');
  const page = Math.max(0, height - 3);
  const maxOffset = Math.max(0, body.length - page);
  offset = Math.min(Math.max(0, offset), maxOffset);
  const lines = height ? [truncateAnsi(title, width)] : [];
  lines.push(...body.slice(offset, offset + page));
  while (lines.length < Math.max(0, height - 2)) lines.push('');
  if (height >= 2) lines.push(truncateAnsi(t('↑↓ scroll · Enter generate · Esc cancel'), width));
  const controls: DigestModalFrame['controls'] = [];
  if (height >= 3) {
    const canConfirm = height >= 4 && snapshot.phase === 'confirm' && confirmation?.ready;
    const generate = t('[Generate]');
    const cancel = t('[Cancel]');
    const label = canConfirm ? `${generate}  ${cancel}` : cancel;
    const shown = truncateAnsi(label, width);
    lines.push(shown);
    // A clipped button has no key or click power. Confirm and Cancel fit together or neither is active.
    if (shown === label) {
      if (canConfirm) controls.push({ kind: 'confirm', x: 0, y: height - 1, width: visualLength(generate) });
      controls.push({ kind: 'cancel', x: canConfirm ? visualLength(generate) + 2 : 0,
        y: height - 1, width: visualLength(cancel) });
    }
  }
  return { lines: lines.slice(0, height).map((line) => fit(line, width)), offset, maxOffset, controls };
}
export function digestModalInput(input: WorkbenchInput, frame: DigestModalFrame | undefined): {
  action?: 'confirm' | 'cancel' | 'close' | 'pause'; offset?: number;
} {
  const key = input.type === 'command' ? monitorKey(input.command) : input.type === 'key' ? input.key : '';
  if (key === 'close') return { action: 'close' };
  if (key === 'escape') return { action: 'cancel' };
  if (key === 'brief-toggle') return { action: 'pause' };
  // A different overlay cancels this private dialog; it never forwards that key to the harness.
  if (['settings', 'help', 'main', 'activity-hub', 'find-agent', 'observability'].includes(key)) return { action: 'cancel' };
  if (key === 'enter' && frame?.controls.some((control) => control.kind === 'confirm')) return { action: 'confirm' };
  if (input.type === 'mouse' && input.button === 'left') {
    const control = frame?.controls.find((control) => input.y === control.y && input.x >= control.x && input.x < control.x + control.width);
    return control ? { action: control.kind } : {};
  }
  const delta = key === 'up' || (input.type === 'mouse' && input.button === 'wheel-up') ? -1
    : key === 'down' || (input.type === 'mouse' && input.button === 'wheel-down') ? 1
    : key === 'page-down' ? 8 : key === 'page-up' ? -8 : 0;
  return delta && frame ? { offset: Math.min(frame.maxOffset, Math.max(0, frame.offset + delta)) } : {};
}
