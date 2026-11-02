import { isAbsolute } from 'node:path';
import type { RunControl } from '../../core/interfaces/run-control.js';
import { isRunTerminal } from '../../core/execution.js';
import { processState } from '../../core/run/process.js';
import { canonicalJson } from '../../core/canonical.js';
import type { HostAdapter, SurfaceOptions } from '../../core/interfaces/host-adapter.js';
import type { SurfaceLocator } from '../../core/interfaces/session-binding.js';
import type { HostLayout, HostLocator, LaunchCommand, LocatorCheck } from '../../core/types/capabilities.js';
import type { Harness, SessionRef } from '../../core/types/identity.js';
import type { ProcessStamp } from '../../core/types/supervision.js';
import { HerdrClient, HerdrFailure } from './client.js';
import { HerdrRegistry, sameProcess, type PaneObservation } from './registry.js';
import { object } from './transport.js';

export interface SurfaceCloseProof {
  createdForRun: string;
  occupantGeneration: number;
  occupantStamp: ProcessStamp;
}
interface CreatedSurface {
  layout: 'tab' | 'split';
  managed: SurfaceOptions['managed'];
  shell: ProcessStamp;
  terminal: string;
  locator: SurfaceLocator;
  submitted: boolean;
}
function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
export function commandText(command: LaunchCommand): string {
  if (
    command.argv &&
    !('shell' in command) &&
    command.argv.length &&
    command.argv[0] &&
    command.argv.every((value) => typeof value === 'string' && !value.includes('\0'))
  )
    return command.argv.map(quote).join(' ');
  if (
    typeof command.shell === 'string' &&
    !('argv' in command) &&
    isAbsolute(command.shellPath) &&
    !command.shell.includes('\0') &&
    !command.shellPath.includes('\0')
  )
    return [command.shellPath, '-ic', command.shell].map(quote).join(' ');
  throw new HerdrFailure('herdr_invalid_command');
}

export class HerdrHost implements HostAdapter {
  readonly kind = 'herdr' as const;
  private readonly created = new Map<string, CreatedSurface>();
  private readonly runs = new Map<string, HostLocator>();
  private readonly openedRuns = new Set<string>();
  constructor(
    readonly client: HerdrClient,
    readonly registry: HerdrRegistry,
    private readonly context: { workspace: string; pane?: string },
    private readonly readinessMs = 3000,
    private readonly readLocator: (runId: string) => Promise<HostLocator | null> = async () => null,
    private readonly control?: Pick<RunControl, 'status'>
  ) {
    if (!context.workspace || !Number.isFinite(readinessMs) || readinessMs <= 0 || readinessMs > 30_000)
      throw new Error('herdr_invalid_context');
  }
  private key(locator: SurfaceLocator): string {
    return locator.kind === 'herdr' ? `${locator.server}:${locator.pane}` : '';
  }
  async openSurface(layout: Exclude<HostLayout, 'none'>, options: SurfaceOptions): Promise<SurfaceLocator> {
    if (options.managed && this.openedRuns.has(`${options.managed.runId}:${options.managed.bindingGeneration}`))
      throw new HerdrFailure('herdr_surface_already_dispatched');
    if (layout !== 'tab' && layout !== 'split') throw new HerdrFailure('herdr_layout_unsupported', true);
    if (
      !isAbsolute(options.cwd) ||
      options.cwd.includes('\0') ||
      Object.entries(options.env).some(
        ([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || value.includes('\0')
      )
    )
      throw new HerdrFailure('herdr_invalid_surface', true);
    // Selection/fallback happens here only. After the mutation is attempted all errors hold the original run.
    const preflight = await this.client.preflight();
    if (!preflight.ready) throw new HerdrFailure(preflight.diagnostic!, true);
    const server = await this.client.require(preflight.server!);
    const argv =
      layout === 'tab'
        ? ['tab', 'create', '--workspace', this.context.workspace, '--no-focus']
        : ['pane', 'split', '--pane', this.context.pane ?? '', '--direction', 'right', '--no-focus'];
    if (layout === 'split' && !this.context.pane) throw new HerdrFailure('herdr_split_target_required', true);
    argv.push('--cwd', options.cwd);
    for (const [key, value] of Object.entries(options.env)) argv.push('--env', `${key}=${value}`);
    if (options.managed) {
      const runKey = `${options.managed.runId}:${options.managed.bindingGeneration}`;
      if (this.openedRuns.has(runKey)) throw new HerdrFailure('herdr_surface_already_dispatched');
      this.openedRuns.add(runKey);
    }
    let paneId: string;
    try {
      const result = object(object(await this.client.transport.command(argv)).result);
      const pane = object(layout === 'tab' ? result.root_pane : result.pane);
      if (typeof pane.pane_id !== 'string' || pane.workspace_id !== this.context.workspace)
        throw new Error('invalid_create');
      paneId = pane.pane_id;
    } catch {
      throw new HerdrFailure('herdr_surface_dispatch_unknown');
    }
    const deadline = performance.now() + this.readinessMs;
    do {
      try {
        await this.client.require(server);
        const observed = await this.registry.observe(paneId);
        if (observed.atPrompt) {
          this.created.set(this.key(observed.locator), {
            layout,
            managed: structuredClone(options.managed),
            shell: observed.shell.stamp,
            terminal: String(observed.pane.terminal_id),
            locator: structuredClone(observed.locator),
            submitted: false,
          });
          return observed.locator;
        }
      } catch {
        /* bounded startup probe only; never retries creation */
      }
      const remaining = deadline - performance.now();
      if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(25, remaining)));
    } while (performance.now() < deadline);
    throw new HerdrFailure('herdr_readiness_timeout');
  }
  async runInSurface(locator: SurfaceLocator, command: LaunchCommand): Promise<void> {
    const text = commandText(command);
    const created = this.created.get(this.key(locator));
    if (!created || created.submitted) throw new HerdrFailure('herdr_submission_forbidden');
    const observed = await this.requireLocator(locator);
    if (!observed.atPrompt || !sameProcess(created.shell, observed.shell.stamp))
      throw new HerdrFailure('herdr_shell_not_ready');
    // Mark BEFORE the external call, including a lost acknowledgement. Never launch twice.
    if (created.submitted) throw new HerdrFailure('herdr_submission_forbidden');
    created.submitted = true;
    try {
      await this.client.transport.command(['pane', 'run', observed.locator.pane, text]);
    } catch {
      throw new HerdrFailure('herdr_launch_unknown');
    }
  }
  async checkLocator(locator: SurfaceLocator): Promise<LocatorCheck> {
    const base = {
      checkedAt: Date.now(),
      evidence: [] as string[],
      occupantMatches: null,
      foregroundInteractive: null,
    };
    if (locator.kind !== 'herdr') return { ...base, state: 'stale' };
    try {
      const observation = await this.registry.observe(locator.pane);
      const matches = this.registry.matches(locator, observation);
      return {
        ...base,
        state: matches ? 'valid' : 'stale',
        occupantMatches: matches,
        foregroundInteractive: matches && observation.agentReady,
        evidence: ['herdr_pane_process_observation'],
      };
    } catch {
      return { ...base, state: 'unknown' };
    }
  }
  async requireLocator(locator: SurfaceLocator): Promise<PaneObservation> {
    if (locator.kind !== 'herdr') throw new HerdrFailure('herdr_locator_stale');
    const observation = await this.registry.observe(locator.pane);
    if (!this.registry.matches(locator, observation)) throw new HerdrFailure('herdr_locator_stale');
    return observation;
  }
  async locate(target: SessionRef | string): Promise<SurfaceLocator | null> {
    if (typeof target === 'string') {
      const locator = this.runs.get(target) ?? (await this.readLocator(target));
      if (
        !locator ||
        locator.kind !== 'herdr' ||
        locator.runId !== target ||
        !Number.isSafeInteger(locator.bindingGeneration) ||
        locator.bindingGeneration < 1
      )
        return null;
      try {
        const observation = await this.registry.observe(locator.pane);
        if (
          !sameProcess(locator.process, observation.locator.process) ||
          locator.server !== observation.locator.server ||
          locator.workspace !== observation.locator.workspace ||
          locator.tab !== observation.locator.tab
        )
          return null;
        this.runs.set(target, structuredClone(locator));
        return observation.locator;
      } catch {
        return null;
      }
    }
    const matches = (await this.registry.list()).filter(
      (record) => canonicalJson(record.binding?.sessionRef ?? null) === canonicalJson(target)
    );
    return matches.length === 1 ? matches[0].locator : null;
  }
  /** H08: verified fixed-run handoff to recordRunLocator; env hints never enter this API. */
  async recordLocator(
    runId: string,
    bindingGeneration: number,
    locator: SurfaceLocator,
    supervisor: ProcessStamp,
    persist: (locator: HostLocator) => Promise<void>
  ): Promise<HostLocator> {
    const created = this.created.get(this.key(locator));
    if (
      !created?.submitted ||
      created.managed?.runId !== runId ||
      created.managed.bindingGeneration !== bindingGeneration
    )
      throw new HerdrFailure('herdr_run_surface_mismatch');
    const observation = await this.requireLocator(locator);
    if (
      !observation.resolved ||
      !sameProcess(supervisor, observation.occupant.stamp) ||
      !sameProcess(created.shell, observation.shell.stamp) ||
      String(observation.pane.terminal_id) !== created.terminal
    )
      throw new HerdrFailure('herdr_run_process_mismatch');
    const fixed: HostLocator = {
      kind: 'herdr',
      server: observation.locator.server,
      workspace: observation.locator.workspace,
      tab: observation.locator.tab,
      pane: observation.locator.pane,
      process: observation.locator.process,
      runId,
      bindingGeneration,
    };
    const previous = this.runs.get(runId);
    if (previous && canonicalJson(previous) !== canonicalJson(fixed)) throw new HerdrFailure('locator_conflict');
    await persist(fixed);
    this.runs.set(runId, structuredClone(fixed));
    return fixed;
  }
  private async interaction(locator: SurfaceLocator, operation: 'focus' | 'input'): Promise<ProcessStamp | null> {
    const managed =
      this.created.get(this.key(locator))?.managed ??
      [...this.runs.values()].find(
        (fixed) =>
          fixed.kind === 'herdr' &&
          locator.kind === 'herdr' &&
          fixed.server === locator.server &&
          fixed.pane === locator.pane
      );
    if (!managed) return null;
    if (!this.control) throw new HerdrFailure('herdr_interaction_unavailable');
    const status = await this.control.status(managed.runId);
    const run = status.currentRun;
    if (
      !run ||
      run.runId !== managed.runId ||
      run.expectedGeneration !== managed.bindingGeneration ||
      isRunTerminal(run) ||
      !run.supervisor ||
      processState(run.supervisor) !== 'alive' ||
      !status.interaction[operation]
    )
      throw new HerdrFailure('herdr_interaction_unavailable');
    const fixed = run.locator;
    if (
      !fixed ||
      locator.kind !== 'herdr' ||
      fixed.kind !== 'herdr' ||
      fixed.server !== locator.server ||
      fixed.workspace !== locator.workspace ||
      fixed.tab !== locator.tab ||
      fixed.pane !== locator.pane ||
      !sameProcess(fixed.process as unknown as ProcessStamp, locator.process)
    )
      throw new HerdrFailure('herdr_run_surface_mismatch');
    return run.supervisor;
  }
  async focus(locator: SurfaceLocator): Promise<void> {
    const supervisor = await this.interaction(locator, 'focus');
    const observed = await this.requireLocator(locator);
    if (supervisor && !sameProcess(supervisor, observed.occupant.stamp))
      throw new HerdrFailure('herdr_interaction_unavailable');
    if (!observed.agentReady) throw new HerdrFailure('herdr_interaction_unavailable');
    await this.client.transport.command(['pane', 'focus', observed.locator.pane]);
  }
  async sendKeys(locator: SurfaceLocator, keys: readonly string[]): Promise<void> {
    const supervisor = await this.interaction(locator, 'input');
    const observed = await this.requireLocator(locator);
    if (supervisor && !sameProcess(supervisor, observed.occupant.stamp))
      throw new HerdrFailure('herdr_interaction_unavailable');
    if (!observed.agentReady || keys.length === 0 || keys.some((key) => !key || key.includes('\0')))
      throw new HerdrFailure('herdr_interaction_unavailable');
    await this.client.transport.command(['agent', 'send-keys', observed.locator.pane, ...keys]);
  }
  async attachIdentity(_harness: Harness): Promise<void> {
    // Identity must be on the actual foreground attach/harness process (HERDR_AGENT), not a synthetic report.
    throw new HerdrFailure('herdr_identity_requires_launch_env');
  }
  async closeSurface(locator: SurfaceLocator, proof: SurfaceCloseProof): Promise<void> {
    const created = this.created.get(this.key(locator));
    if (!created || created.layout !== 'split') throw new HerdrFailure('herdr_close_tab_refused');
    if (
      created.managed?.runId !== proof.createdForRun ||
      proof.occupantGeneration !== locator.occupantGeneration ||
      !sameProcess(proof.occupantStamp, locator.process)
    )
      throw new HerdrFailure('herdr_close_ownership_unknown');
    const observed = await this.requireLocator(locator);
    if (
      !sameProcess(created.shell, observed.shell.stamp) ||
      String(observed.pane.terminal_id) !== created.terminal ||
      !observed.atPrompt
    )
      throw new HerdrFailure('herdr_close_foreground_refused');
    const layout = object(
      (await this.client.read('pane.layout', { pane_id: observed.locator.pane }, locator.server)).layout
    );
    if (!Array.isArray(layout.panes) || layout.panes.length < 2) throw new HerdrFailure('herdr_close_tab_refused');
    // Current schema has no expected-occupant conditional close primitive. Never close a replacement after a TOCTOU.
    throw new HerdrFailure('herdr_conditional_close_unavailable');
  }
}
