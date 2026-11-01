import type { LifecycleStatus } from '../types/lifecycle.js';
import type { RunHandle } from '../types/supervision.js';

/** Contract 04 I-04-13: retain A4's fixed run/locator/generation handle. */
export type CoreRunHandle = RunHandle<LifecycleStatus, LifecycleStatus>;

export interface RunControl {
  /** Concept §6.10; contract 04 “写者与RunHandle”: read committed facts only, with no implicit reconcile. */
  status(runId: string): Promise<LifecycleStatus>;
  /** Concept §6.10; contract 04 “取消与父断连”: authenticate, accept intent and return without waiting for exit. */
  cancel(runId: string, grace?: number): Promise<LifecycleStatus>;
  /** Concept §6.10; contract 02 R-02: reconcile the original run, without retrying submission or forcing release. */
  reconcile(runId: string): Promise<LifecycleStatus>;
  /** Concept §6.10/§6.12; contract 04 I-04-13: optional input channel; recheck interaction.input and occupant. */
  sendInput?(runId: string, text: string): Promise<void>;
}
