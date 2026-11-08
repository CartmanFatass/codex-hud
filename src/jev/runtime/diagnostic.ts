// Diagnostics are structured, not reflected messages. Even a single code-looking
// word can be page text, so retain only a finite vocabulary and CDP method list.
import { isPublicIpcCode } from './ipc.js';

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
  'CdpTimeoutError',
  'CdpError',
  'CdpClosed',
  'BrowserUnavailable',
  'StalePage',
  'AbortError',
  'TimeoutError',
]);
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
