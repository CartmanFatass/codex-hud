export { CAPABILITIES, ORACLE_PHASES, ROLES, SLOTS, SLOT_CONTRACTS, isSlot, slotContract } from './roles.js';
export type { Capability, OraclePhase, RoleName, Slot, SlotContract } from './roles.js';

export {
  DECISION_PROVIDERS,
  HERDR_HARNESSES,
  JEV_TARGETS,
  ROUTING_FILE,
  ROUTING_MAX_BYTES,
  ROUTING_SCHEMA,
  RoutingError,
  assertRoutingId,
  backendJson,
  bindingCompatible,
  idValue,
  knownPreset,
  loadRouting,
  parseRouting,
} from './routing.js';
export type {
  BackendProfile,
  DecisionProvider,
  HerdrHarness,
  JevDecision,
  JevTarget,
  RoutingErrorCode,
  RoutingFile,
  RoutingPreset,
  StructuredArgs,
} from './routing.js';

export {
  SELECTION_DIR,
  SELECTION_MAX_BYTES,
  formatRosterRoot,
  loadRosterSelection,
  parseRosterRoot,
  resolveRoster,
  rosterRootFromSessionRef,
  rosterSelectionKey,
  rosterSelectionPath,
  saveRosterSelection,
} from './selection.js';
export type {
  ResolveOptions,
  ResolvedRoster,
  ResolvedSlot,
  RosterRoot,
  RosterSelection,
  SaveOptions,
} from './selection.js';
