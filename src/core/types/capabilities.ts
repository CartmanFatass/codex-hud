import type { Harness } from './identity.js';
import type { OrphanPolicy, RunMode } from './execution.js';
import type { ProcessStamp } from './supervision.js';

export type HostKind = 'herdr' | 'tmux' | 'none';
export type HostLayout = 'tab' | 'split' | 'pane' | 'none';
export type CapabilitySupport = 'verified' | 'unverified' | 'unsupported';

export type CapabilityKey = {
  harness: Harness;
  profileDigest: string;
  hostKind: HostKind;
  layout: HostLayout;
  mode: RunMode;
} & ({ operation: 'launch' | 'spawn'; resumeFrom?: never } | { operation: 'resume'; resumeFrom: RunMode });

export interface CapabilityVersions {
  hudRevision: string;
  harness: string;
  host: string;
  shell: string;
  node: string;
  platform: string;
  kernel: string;
  mcpClient: string;
}

export interface CapabilityEvidence {
  script: string;
  report: string;
  reportSha256: string;
  artifactDigest: string;
  observedAt: number;
  reviewStatus: 'pending' | 'accepted' | 'rejected';
  scope: 'probe' | 'product';
}

export type CapabilityCheck = 'identity' | 'input' | 'scope' | 'receipt' | 'singleSubmission';

export interface CapabilityCell {
  key: CapabilityKey;
  support: CapabilitySupport;
  versions: CapabilityVersions | null;
  topology: string | null;
  sourceId: string | null;
  profileFingerprint: string | null;
  evidence: CapabilityEvidence | null;
  results: Partial<Record<CapabilityCheck, 'passed' | 'failed' | 'unverified'>>;
  incomplete: string[];
}

/** Consult 5 G04: the sole shipped manifest v1 shape; loading never promotes a cell. */
export type CapabilityManifestV1 =
  { version: 1; hudRevision: null; cells: [] } | { version: 1; hudRevision: string; cells: CapabilityCell[] };

/** Each template selects exactly one execution contract. */
export type LaunchCommand =
  { argv: string[]; shell?: never; shellPath?: never } | { shell: string; shellPath: string; argv?: never };

export interface DelegateRoleMapping {
  model: string;
  effort?: string;
}

export type DelegateRoles = Record<string, DelegateRoleMapping>;

export interface LaunchProfile {
  name: string;
  harness: Harness;
  source: { root: string; label: string };
  launch: LaunchCommand;
  headless: LaunchCommand | null;
  resume: LaunchCommand | null;
  resumeHeadless: LaunchCommand | null;
  host: { kind: HostKind; layout: HostLayout };
  env: Record<string, string>;
  mcpServerName: string;
  claimTransport: 'config_env' | 'launch_message';
  clientToolTimeoutMs: number | null;
  responseMarginMs: number;
  orphan_policy: OrphanPolicy;
  /** Configuration hint only; managed shell support still requires separate accepted capability evidence. */
  managedShellVerified: boolean;
  roles?: DelegateRoles;
  retire?: {
    afterReportMs?: number;
    reviewerAfterReportMs?: number;
    idleMs?: number;
    blockedWaitMs?: number;
    maxRunMs?: number;
  };
  /** Per-call host mechanism selection; configuration never verifies a capability. */
  callSource?: { kind: 'claude_pre_tool_use_v1' | 'pi_extension_v1' };
}

export type DelegateProfile = LaunchProfile;

export interface DelegateConfig {
  version: 1;
  profiles: DelegateProfile[];
  limits?: { maxActiveRuns?: number; maxActiveRunsPerOwner?: number };
  wake?: { recoveryMs?: number };
}

export interface HudLaunchEnv {
  HUD_CLAIM: string;
  HUD_RUN: string;
  HUD_LINK: string;
  HUD_HOME: string;
}

export interface CodexStdioServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  [key: string]: unknown;
}

export interface CodexConfig {
  mcp_servers: Record<string, CodexStdioServer>;
  [key: string]: unknown;
}

export type HostLocator = {
  runId: string;
  bindingGeneration: number;
  process: ProcessStamp | null;
} & (
  | { kind: 'herdr'; server: string; workspace: string; tab: string; pane: string }
  | { kind: 'tmux'; server: string; session: string; pane: string }
);

export interface LocatorCheck {
  state: 'valid' | 'stale' | 'unknown';
  occupantMatches: boolean | null;
  checkedAt: number;
  evidence: string[];
  foregroundInteractive: boolean | null;
}

export type HostSelectionPlan =
  | { action: 'select'; profileDigest: string; hostKind: HostKind }
  | { action: 'replay'; profileDigest: string; result: unknown }
  | { action: 'reconcile'; runId: string }
  | { action: 'reject'; reason: string };
