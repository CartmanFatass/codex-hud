import type { RunControl } from '../../src/core/interfaces/run-control.js';
import type { LifecycleStatus } from '../../src/core/types/lifecycle.js';
import { Script } from './script.js';

export class FakeRunControl implements RunControl {
  readonly statusScript = new Script<[string], LifecycleStatus>();
  readonly cancelScript = new Script<[string, number?], LifecycleStatus>();
  readonly reconcileScript = new Script<[string], LifecycleStatus>();
  readonly sendInputScript = new Script<[string, string], void>();

  async status(runId: string): Promise<LifecycleStatus> {
    return this.statusScript.invoke(runId);
  }
  async cancel(runId: string, grace?: number): Promise<LifecycleStatus> {
    return this.cancelScript.invoke(runId, grace);
  }
  async reconcile(runId: string): Promise<LifecycleStatus> {
    return this.reconcileScript.invoke(runId);
  }
  async sendInput(runId: string, text: string): Promise<void> {
    return this.sendInputScript.invoke(runId, text);
  }
}
