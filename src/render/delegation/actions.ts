/**
 * What the selected row can do (design §3.7; rulings B10B-s3 Q1, Q3, Q4): the words of the control bar's `⇢` and `↻`
 * buttons, whether each is live, and the typed action a key or a click on each yields. The panel executes nothing and
 * builds no command: the only command text is the descriptor's own `displayCommand`, handed on as given.
 *
 * One rule over all of it: a key acts exactly when its button is drawn, and does what a click on that button does.
 * `o` is Open and Switch only, `L` Log only, `R` the `↻` button. An action carries what the frame showed (the row's
 * key, the descriptor object as the view model held it) and is never looked up again.
 */

import type { ActionDescriptor } from '../../core/types/lifecycle.js';
import { t } from '../i18n.js';
import type { DelegationProjection, PNode } from './projection.js';
import type { PlannedRow, RowPlan } from './rows.js';

export type OpenWord = 'Open' | 'Switch' | 'Log';
export type RecoverWord = 'Reconcile' | 'Resume';

export interface RowActions {
  key: string;
  /** The `⇢` button: absent for a row that has none; `enabled` false is the greyed Open. */
  open: { word: OpenWord; enabled: boolean } | null;
  /** The `↻` button; a greyed Resume still answers with its diagnostic. */
  recover: { word: RecoverWord; enabled: boolean } | null;
  /** A Codex native's session id, what today's switch takes. */
  switchId: string | null;
  /** The view model's reconcile descriptor, as given. */
  descriptor: ActionDescriptor | null;
}

export type DelegationAction =
  | { type: 'switch'; id: string }
  | { type: 'delegation-open'; key: string }
  | { type: 'delegation-log'; key: string }
  | { type: 'delegation-copy'; key: string; descriptor: ActionDescriptor }
  | { type: 'delegation-diagnostic'; key: string; text: string };

/** The MVP's answer to Resume (design §3.7, §5.5): the local entry is not verified, so nothing is copied. */
export const RESUME_DIAGNOSTIC = 'resume not verified on this machine · ask the parent to delegate_resume';

/** The agents the legacy tree lists: a chain of native edges from the viewpoint root down to this node. */
function inRootNatives(pn: PNode): boolean {
  for (let at: PNode | null = pn; at; at = at.parent) {
    if (at.proj.isRoot) return true;
    if (!at.proj.isNative) return false;
  }
  return false;
}

/** Open's gate (design §3.7): a verified host state, and a run that is not uncertain. */
function openEnabled(pn: PNode, proj: DelegationProjection): boolean {
  const node = pn.node!;
  if (node.host?.currentState == null) return false;
  const stateKey = proj.vm.details[node.key]?.status?.stateKey;
  return !(typeof stateKey === 'string' && stateKey.startsWith('uncertain:'));
}

export function rowActions(row: PlannedRow, proj: DelegationProjection): RowActions {
  const none: RowActions = { key: row.key, open: null, recover: null, switchId: null, descriptor: null };
  const pn = row.kind === 'node' ? row.pn : null;
  // A `⊕N` row, and a conflict row of its own (no node, no details), have no buttons.
  if (!pn || !pn.node) return none;
  const node = pn.node;
  const detail = proj.vm.details[node.key];
  const descriptor = detail?.reconcile ?? null;
  const recover: RowActions['recover'] = descriptor
    ? { word: 'Reconcile', enabled: true }
    : // Ended, with a report of any status, and nothing to reconcile: the button is there, greyed, and says why not.
      pn.proj.detail.terminal && pn.proj.detail.reportStatus !== null
      ? { word: 'Resume', enabled: false }
      : null;
  const base: RowActions = { ...none, recover, descriptor };
  if (pn.proj.isRoot) return base;
  if (pn.proj.isNative) {
    const identity = node.identity;
    if (identity.kind === 'session' && identity.ref.harness === 'codex' && inRootNatives(pn))
      return { ...base, open: { word: 'Switch', enabled: true }, switchId: identity.ref.sessionId };
    return base;
  }
  if (!pn.proj.detail.managed) return base;
  const mode = node.currentRun?.mode;
  if (mode === 'headless') return { ...base, open: { word: 'Log', enabled: true } };
  if (mode === 'visible') return { ...base, open: { word: 'Open', enabled: openEnabled(pn, proj) } };
  return base;
}

/** A click on `⇢`: whatever its word says, when it is live. */
export function openButtonAction(a: RowActions): DelegationAction | null {
  if (!a.open || !a.open.enabled) return null;
  if (a.open.word === 'Switch') return a.switchId === null ? null : { type: 'switch', id: a.switchId };
  return a.open.word === 'Log' ? { type: 'delegation-log', key: a.key } : { type: 'delegation-open', key: a.key };
}

/** `o`: Open and Switch, never Log. */
export function openKeyAction(a: RowActions): DelegationAction | null {
  return a.open?.word === 'Log' ? null : openButtonAction(a);
}

/** `L`: Log, nothing else. */
export function logKeyAction(a: RowActions): DelegationAction | null {
  return a.open?.word === 'Log' ? openButtonAction(a) : null;
}

/** `R` and a click on `↻`: Reconcile copies the descriptor as given, Resume only answers with its diagnostic. */
export function recoverAction(a: RowActions): DelegationAction | null {
  if (!a.recover) return null;
  if (a.recover.word === 'Reconcile')
    return a.descriptor ? { type: 'delegation-copy', key: a.key, descriptor: a.descriptor } : null;
  return { type: 'delegation-diagnostic', key: a.key, text: t(RESUME_DIAGNOSTIC) };
}

/** The selected row's actions: null when the selection is not a row of this plan. */
export function selectedActions(
  plan: RowPlan,
  proj: DelegationProjection,
  selected: string | null | undefined
): RowActions | null {
  const at = selected ? plan.index.get(selected) : undefined;
  return at === undefined ? null : rowActions(plan.rows[at], proj);
}
