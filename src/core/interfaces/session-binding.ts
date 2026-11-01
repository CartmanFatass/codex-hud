import type { HostLocator } from '../types/capabilities.js';
import type { RunBinding, SessionRef } from '../types/identity.js';

/**
 * Concept §6.2/§6.3: ordinary observed sessions need no managed run identity.
 * managed is present only when an actual A4 run binding exists; it grants no new authority.
 */
export type SessionBinding = Pick<RunBinding, 'harness' | 'occupantGeneration'> & {
  sessionRef: SessionRef;
  managed: RunBinding | null;
};

export type ToSurfaceLocator<T> = T extends HostLocator
  ? Omit<T, 'runId' | 'bindingGeneration'> & { occupantGeneration: number | null }
  : never;

/**
 * Concept §6.10: a surface can host an ordinary session without hud-mcp or a ledger.
 * Preserve host/process observations with an independent, nullable occupant generation.
 * Managed HostLocator remains unchanged.
 */
export type SurfaceLocator = ToSurfaceLocator<HostLocator>;
