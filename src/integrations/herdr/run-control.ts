import type { HostLocator } from '../../core/types/capabilities.js';
import type { CoreRunHandle, RunControl } from '../../core/interfaces/run-control.js';
import type { SurfaceLocator } from '../../core/interfaces/session-binding.js';
import { isRunTerminal } from '../../core/execution.js';
import { processState } from '../../core/run/process.js';
import { sameProcess } from './registry.js';
import { HerdrFailure } from './client.js';
import { HerdrHost } from './host.js';

export interface InitialInputPermit {
  runId: string;
  bindingGeneration: number;
  locator: SurfaceLocator;
}
/** Core remains the authority for status/cancel/reconcile. No agent.stop, pane close or TTY cancel. */
export class HerdrRunControl implements RunControl {
  private readonly permits = new Map<string, { permit: InitialInputPermit; attempted: boolean }>();
  constructor(
    readonly core: RunControl,
    readonly host: HerdrHost,
    /** Trusted original-launch composition only; never reconstruct grants on recovery. */
    permits: readonly InitialInputPermit[] = []
  ) {
    for (const permit of permits) {
      if (this.permits.has(permit.runId)) throw new Error('herdr_duplicate_input_permit');
      this.permits.set(permit.runId, { permit: structuredClone(permit), attempted: false });
    }
  }
  handle(locator: HostLocator): CoreRunHandle {
    const fixed = structuredClone(locator);
    Object.freeze(fixed.process);
    Object.freeze(fixed);
    return Object.freeze({
      runId: fixed.runId,
      bindingGeneration: fixed.bindingGeneration,
      locator: fixed,
      status: () => this.status(fixed.runId),
      cancel: (grace?: number) => this.cancel(fixed.runId, grace),
      sendInput: (text: string) => this.sendInput(fixed.runId, text),
    });
  }
  status(runId: string) {
    return this.core.status(runId);
  }
  cancel(runId: string, grace?: number) {
    return this.core.cancel(runId, grace);
  }
  reconcile(runId: string) {
    return this.core.reconcile(runId);
  }
  async sendInput(runId: string, text: string): Promise<void> {
    const entry = this.permits.get(runId);
    if (
      !entry ||
      entry.attempted ||
      typeof text !== 'string' ||
      !text ||
      text.includes('\0') ||
      Buffer.byteLength(text) > 256 * 1024
    )
      throw new HerdrFailure('herdr_initial_input_only');
    const status = await this.core.status(runId);
    const run = status.currentRun;
    if (
      !run ||
      run.runId !== runId ||
      run.expectedGeneration !== entry.permit.bindingGeneration ||
      isRunTerminal(run) ||
      !status.interaction.input ||
      !run.supervisor ||
      processState(run.supervisor) !== 'alive'
    )
      throw new HerdrFailure('herdr_interaction_unavailable');
    const fixed = run.locator;
    const locator = entry.permit.locator;
    if (
      !fixed ||
      locator.kind !== 'herdr' ||
      fixed.kind !== 'herdr' ||
      fixed.runId !== runId ||
      fixed.bindingGeneration !== entry.permit.bindingGeneration ||
      fixed.server !== locator.server ||
      fixed.workspace !== locator.workspace ||
      fixed.tab !== locator.tab ||
      fixed.pane !== locator.pane ||
      !sameProcess(fixed.process as unknown as import('../../core/types/supervision.js').ProcessStamp, locator.process)
    )
      throw new HerdrFailure('herdr_run_surface_mismatch');
    const observation = await this.host.requireLocator(locator);
    if (!observation.agentReady || !sameProcess(run.supervisor, observation.occupant.stamp))
      throw new HerdrFailure('herdr_agent_not_ready');
    // No await between the winning check and reservation. Lost acknowledgement consumes the grant too.
    if (entry.attempted) throw new HerdrFailure('herdr_initial_input_only');
    entry.attempted = true;
    try {
      await this.host.client.transport.command(['agent', 'prompt', observation.locator.pane, text]);
    } catch {
      throw new HerdrFailure('herdr_prompt_unknown');
    }
  }
}
