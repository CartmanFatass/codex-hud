// Shared failure for the jev-ask port. Codes are the wire values in jev-in-hud.md §2.1 and §4.5.

export class JevFailure extends Error {
  readonly details: Record<string, unknown>;

  constructor(
    readonly code: string,
    message: string,
    details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'JevFailure';
    this.details = details;
  }
}
