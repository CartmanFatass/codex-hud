/**
 * Fixed public roles for the delegation facade.
 *
 * Oracle is one role with two binding slots. Capabilities are the contract a
 * backend must meet; they are not a second set of roles.
 */

export const ROLES = ['oracle', 'imp', 'reviewer', 'sonic', 'jev'] as const;
export type RoleName = (typeof ROLES)[number];

export const ORACLE_PHASES = ['propose', 'converge'] as const;
export type OraclePhase = (typeof ORACLE_PHASES)[number];

/** Every preset binds all of these. Order is the display and validation order. */
export const SLOTS = ['oracle.propose', 'oracle.converge', 'imp', 'reviewer', 'sonic', 'jev'] as const;
export type Slot = (typeof SLOTS)[number];

export const CAPABILITIES = [
  'executor_herdr',
  'executor_jev',
  'workspace_read',
  'workspace_write',
  'interactive_or_continuable',
  'web_oracle',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export interface SlotContract {
  readonly role: RoleName;
  readonly phase: OraclePhase | null;
  /** The backend must have every one of these. */
  readonly requires: readonly Capability[];
  /** When non-empty, the backend must have at least one. */
  readonly requiresAny: readonly Capability[];
  /** A backend that has any of these cannot fill the slot. */
  readonly forbids: readonly Capability[];
}

/**
 * Imp needs a workspace writer that can continue. Reviewer needs the working
 * tree. Oracle may be a web oracle or a CLI backend. Jev needs the Jev executor.
 * Sonic's small patches use the same workspace bar as imp, so a web oracle cannot
 * fill it.
 */
export const SLOT_CONTRACTS: { readonly [S in Slot]: SlotContract } = {
  'oracle.propose': {
    role: 'oracle',
    phase: 'propose',
    requires: [],
    requiresAny: ['executor_herdr', 'web_oracle'],
    forbids: [],
  },
  'oracle.converge': {
    role: 'oracle',
    phase: 'converge',
    requires: [],
    requiresAny: ['executor_herdr', 'web_oracle'],
    forbids: [],
  },
  imp: {
    role: 'imp',
    phase: null,
    requires: ['workspace_write', 'interactive_or_continuable'],
    requiresAny: [],
    forbids: ['web_oracle'],
  },
  reviewer: {
    role: 'reviewer',
    phase: null,
    requires: ['workspace_read'],
    requiresAny: [],
    forbids: ['web_oracle'],
  },
  sonic: {
    role: 'sonic',
    phase: null,
    requires: ['workspace_write', 'interactive_or_continuable'],
    requiresAny: [],
    forbids: ['web_oracle'],
  },
  jev: {
    role: 'jev',
    phase: null,
    requires: ['executor_jev'],
    requiresAny: [],
    forbids: [],
  },
};

export function isSlot(value: string): value is Slot {
  return (SLOTS as readonly string[]).includes(value);
}

export function slotContract(slot: Slot): SlotContract {
  return SLOT_CONTRACTS[slot];
}
