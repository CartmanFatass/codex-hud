// Diagnostics are structured, not reflected messages. Even a single code-looking
// word can be page text, so retain only a finite vocabulary and CDP method list.
import { isPublicIpcCode } from './ipc.js';
import type { Answer, RefusedDecision, ResolvedDecision } from '../decide.js';
import { OPENAI_NONE_CHOICE, type PageState } from '../model.js';

export interface FailureDiagnostic {
  phase: string;
  errorClass: string;
  code: string;
  method?: string;
}
const METHODS = new Set([
  'Runtime.evaluate',
  'Page.captureScreenshot',
  'Page.navigate',
  'Target.createTarget',
  'Target.attachToTarget',
  'Target.getTargets',
  'Target.closeTarget',
  'Target.detachFromTarget',
  'Input.insertText',
  'Input.dispatchKeyEvent',
  'Input.dispatchMouseEvent',
]);
const INTERNAL_CODES = new Set([
  'answer_integrity',
  'operation_binding_mismatch',
  'jev_snapshot_asset_missing',
  'judge_unavailable',
  'cdp_closed',
  'cdp_detached',
  'cdp_navigate_failed',
  'ENOENT',
  'EACCES',
  'EPERM',
  'ENOSPC',
  'EIO',
]);
const PHASES = new Set(['execute', 'prepare', 'click', 'reconcile', 'confirm', 'wait', 'collect', 'start', 'stop']);
const CLASSES = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ReferenceError',
  'URIError',
  'JevFailure',
  'JevRuntimeError',
  'DecisionRefused',
  'DecisionInvalid',
  'DecisionProviderError',
  'JevCredentialsMissing',
  'CdpTimeoutError',
  'CdpError',
  'CdpClosed',
  'BrowserUnavailable',
  'StalePage',
  'AbortError',
  'TimeoutError',
]);
export interface ActionDecisionDiagnostic {
  phase: 'mode' | 'fill' | 'send';
  attempt: number;
  operation: string;
  targetIndex?: number;
  targetNode?: number;
  targetRole?: string;
  code:
    | 'selected'
    | 'operation_refusal'
    | 'target_refusal'
    | 'no_target'
    | 'decision_refused'
    | 'decision_invalid'
    | 'decision_provider_error'
    | 'unclassified';
}
const OPERATIONS = new Set([
  'CLICK',
  'TYPE_TEXT',
  'SELECT',
  'DONE',
  'BLOCKED',
  'WAIT',
  'SCROLL_UP',
  'SCROLL_DOWN',
  'BACK',
]);
const ROLES = new Set([
  'button',
  'textbox',
  'combobox',
  'menuitem',
  'menuitemradio',
  'slider',
  'option',
  'link',
  'checkbox',
  'radio',
  'switch',
]);

/** Even code-looking page/action labels must not enter lifecycle diagnostics. */
export function actionDecisionDiagnostic(
  phase: ActionDecisionDiagnostic['phase'],
  attempt: number,
  page: PageState,
  answers: Answer[],
  decision?: ResolvedDecision | RefusedDecision,
  error?: unknown
): ActionDecisionDiagnostic {
  const selected = answers.find((a) => a.name === 'operation');
  const operation = selected?.kind === 'choice' && OPERATIONS.has(selected.choice) ? selected.choice : 'unclassified';
  const target = answers.find((a) => a.name === `${operation.toLowerCase()}_target`);
  const action = decision && !('refused' in decision) ? page.actions.find((a) => a.id === decision.choice) : undefined;
  const index = target?.kind === 'choice' && /^\d{1,6}$/.test(target.choice) ? Number(target.choice) : undefined;
  const node = action?.node;
  let code: ActionDecisionDiagnostic['code'] = 'selected';
  if (error) {
    const failure = (error as { code?: unknown }).code;
    code = failure === 'decision_invalid' || failure === 'decision_provider_error' ? failure : 'unclassified';
  } else if (decision && 'refused' in decision) {
    code =
      selected?.kind === 'refusal'
        ? 'operation_refusal'
        : target?.kind === 'refusal'
          ? 'target_refusal'
          : target?.kind === 'choice' && target.choice === OPENAI_NONE_CHOICE
            ? 'no_target'
            : 'decision_refused';
  }
  return {
    phase,
    attempt: Number.isInteger(attempt) && attempt > 0 && attempt <= 14 ? attempt : 0,
    operation,
    code,
    ...(index !== undefined ? { targetIndex: index } : {}),
    ...(typeof node === 'number' && Number.isInteger(node) && node >= 0 && node <= 1_000_000
      ? { targetNode: node }
      : {}),
    ...(action?.role && ROLES.has(action.role) ? { targetRole: action.role } : {}),
  };
}

export function failureDiagnostic(error: unknown, phase: string): FailureDiagnostic {
  const value = error as {
    name?: unknown;
    code?: unknown;
    message?: unknown;
    cdpMethod?: unknown;
    details?: { method?: unknown };
  };
  const name = error instanceof Error ? error.name : 'NonError';
  const message = typeof value?.message === 'string' ? value.message : '';
  const code = typeof value?.code === 'string' ? value.code : '';
  const timeoutMethod = message.startsWith('cdp_timeout:') ? message.slice('cdp_timeout:'.length) : '';
  const method =
    typeof value?.cdpMethod === 'string'
      ? value.cdpMethod
      : typeof value?.details?.method === 'string'
        ? value.details.method
        : timeoutMethod;
  return {
    phase: PHASES.has(phase) ? phase : 'execute',
    errorClass: CLASSES.has(name) ? name : error instanceof Error ? 'Error' : 'NonError',
    code:
      isPublicIpcCode(code) || INTERNAL_CODES.has(code) ? code : INTERNAL_CODES.has(message) ? message : 'unclassified',
    ...(METHODS.has(method) ? { method } : {}),
  };
}
