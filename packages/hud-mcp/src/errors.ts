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
