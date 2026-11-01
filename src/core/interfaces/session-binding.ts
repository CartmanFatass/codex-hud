import type { HostLocator } from '../types/capabilities.js';
import type { RunBinding } from '../types/identity.js';

/**
 * Concept §6.2/§6.3: ordinary observed sessions need no managed run identity.
 * 待 ARCH 裁决: additive A5 boundary authorized by the orchestrator, queued for Oracle.
 * managed is present only when an actual A4 run binding exists; it grants no new authority.
 */
export type SessionBinding = Omit<RunBinding, 'runId' | 'childBinding'> & {
  managed: RunBinding | null;
};

type WithoutRunId<T> = T extends HostLocator ? Omit<T, 'runId'> : never;

/**
 * Concept §6.10: a surface can host an ordinary session without hud-mcp or a ledger.
 * 待 ARCH 裁决: retain A4's discriminated host fields, process stamp and occupant generation,
 * while removing the managed run identity. Managed HostLocator remains unchanged.
 */
export type SurfaceLocator = WithoutRunId<HostLocator>;
