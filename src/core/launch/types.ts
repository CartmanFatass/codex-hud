import type { StartOptions } from '../run/control.js';
import type { BriefSnapshot } from './brief.js';
import type { ManagedCapabilityRequest } from './capability.js';
import type { ExecutableIdentity } from './fingerprint.js';
import type { CodexConfig, LaunchProfile } from '../types/capabilities.js';
import type { RunMode } from '../types/execution.js';
import type { RunLaunchInput } from '../types/supervision.js';

export type PreparedStartPayload = Omit<StartOptions, 'ticket' | 'brief' | 'identifyHarness'> & {
  briefBase64: string;
};
export interface PreparedRunLaunch {
  readonly input: RunLaunchInput;
  readonly launchDigest: string;
  readonly payload: PreparedStartPayload;
  readonly deliveredSha256: string;
}
export interface ManagedRunValues {
  runId: string;
  linkId: string;
  claim: string;
  hudHome: string;
  parent?: StartOptions['parent'];
}
export interface ManagedLaunchPreparation {
  readonly harness: 'claude' | 'codex' | 'pi';
  readonly sourceRoot: string;
  readonly profileDigest: string;
  readonly sourceId: string;
  readonly cwd: string;
  readonly brief: BriefSnapshot;
  readonly promptHash: string;
  readonly role: string | null;
  readonly model: string | null;
  readonly effort: string | null;
  /** Named-server transport/settings hash, excluding overwritten per-run leaves. */
  readonly configFingerprint: string;
  /** Resolved command fingerprint before random run credentials; suitable for params_digest. */
  readonly commandFingerprint: string;
  capabilityRequest(resumeFrom?: RunMode): ManagedCapabilityRequest;
  /** Pure synchronous composition: safe to call while constructing the atomic intent. */
  forRun(values: ManagedRunValues): PreparedRunLaunch;
}

export interface PrepareManagedLaunchOptions {
  executableIdentity?: ExecutableIdentity;
  profile: LaunchProfile;
  operation: 'spawn' | 'resume';
  mode: RunMode;
  cwd: string;
  briefPath: string;
  prompt?: string;
  role?: string;
  /** Frozen wake recovery bound, supplied by the trusted config owner. */
  retireRecoveryMs?: number;
  model?: string;
  effort?: string;
  resumeSessionId?: string;
  env?: NodeJS.ProcessEnv;
  /** Optional already-read user configuration for exact stdio-server preflight; never modified. */
  codexConfig?: CodexConfig;
}

export type LaunchPreparer = (options: PrepareManagedLaunchOptions) => Promise<ManagedLaunchPreparation>;
