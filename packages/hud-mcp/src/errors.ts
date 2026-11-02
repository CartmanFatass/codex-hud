export type RefusalCode =
  | 'identity_source_missing'
  | 'identity_unverified'
  | 'unsupported'
  | 'stale_context'
  | 'configuration_invalid'
  | 'cwd_unavailable'
  | 'registration_unverified';

export class Refusal extends Error {
  constructor(readonly code: RefusalCode) {
    super(code);
  }
}
export type StubOutcome = { ok: false; code: 'not_implemented'; tool: string } | { ok: false; code: RefusalCode };

/** Only protocol-owned machine codes may cross the model-facing boundary. */
const outcomeCodes = new Set([
  'identity_source_missing',
  'identity_unverified',
  'unsupported',
  'stale_context',
  'configuration_invalid',
  'cwd_unavailable',
  'registration_unverified',
  'unauthorized',
  'owner_mismatch',
  'parent_unconfirmed',
  'stale_binding',
  'claim_invalid',
  'claim_not_armed',
  'claim_anchor_mismatch',
  'claim_conflict',
  'claim_missing',
  'delegation_cycle',
  'graph_budget',
  'identity_conflict',
  'slot_busy',
  'slot_missing',
  'capability_unverified',
  'unresolved_conflict',
  'not_current_owner',
  'task_mismatch',
  'expected_run_mismatch',
  'idempotency_conflict',
  'backend_not_found',
  'source_mismatch',
  'run_not_found',
  'link_not_found',
  'no_run',
  'invalid',
  'invalid_grace',
  'invalid_run_id',
  'invalid_event_cursor',
  'invalid_wait_timeout',
  'visible_layout_not_in_this_build',
  'local_entry_only',
  'local_resume_parameters_required',
  'brief_too_large',
  'brief_not_regular_file',
  'prepared_brief_changed',
  'prepared_launch_changed',
  'executable_identity_mismatch',
  'undeclared_launch_placeholder',
  'run_domain_unavailable',
  'request_cancelled',
  'server_shutdown',
  'busy',
  'internal_error',
]);
export function outcomeCode(error: unknown): string {
  if (error instanceof Error) {
    if ('code' in error && error.code === 'ledger_busy') return 'busy';
    if (outcomeCodes.has(error.message)) return error.message;
  }
  return 'internal_error';
}
