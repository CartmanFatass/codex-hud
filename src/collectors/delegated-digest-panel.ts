/** One explicit request and one revocable in-memory result. No polling, writes, or legacy model authority. */
import { runDelegatedDigest, type DigestInput, type DigestDocument } from '../core/materials/delegated-digest.js';
import {
  prepareDelegatedDigestPlan,
  revalidateDelegatedDigestPlan,
  disposeDelegatedDigestPlan,
  type DigestPlanLifetime,
} from '../core/materials/delegated-digest-lifetime.js';
import type { MonitorContext, MonitorState } from '../render/monitor.js';
import type { WorkbenchInput } from '../utils/workbench-input.js';
import { handleMonitorInput, routeDigestInput } from '../render/monitor-input.js';
import {
  digestActionCurrent, digestModalInput, digestModalOwnsInput, type DigestModalFrame,
  digestTargetStamp,
  type DigestPanelTarget,
  type DigestPanelSnapshot,
  type DigestPanelReason,
} from '../render/delegated-digest.js';

type Prepared = Awaited<ReturnType<typeof prepareDelegatedDigestPlan>>;
type Plan = Prepared['plan'];
export interface DigestPanelServices {
  prepare: typeof prepareDelegatedDigestPlan;
  revalidate: typeof revalidateDelegatedDigestPlan;
  dispose: typeof disposeDelegatedDigestPlan;
  run: typeof runDelegatedDigest;
}
const services: DigestPanelServices = {
  prepare: prepareDelegatedDigestPlan,
  revalidate: revalidateDelegatedDigestPlan,
  dispose: disposeDelegatedDigestPlan,
  run: runDelegatedDigest,
};
function reason(error: unknown): DigestPanelReason {
  const code = typeof error === 'object' && error !== null && 'reason' in error ? error.reason : '';
  if (code === 'timeout') return 'timeout';
  if (['source_changed', 'target_changed', 'authorization_changed', 'plan_lifetime_invalid'].includes(String(code))) return 'changed';
  if (['backend_off', 'feature_disabled', 'feature_paused'].includes(String(code))) return 'paused';
  if (['source_configuration_invalid', 'credential_unavailable', 'recipient_unavailable'].includes(String(code)))
    return 'configuration';
  if (/scope|grant|authoriz|denied/.test(String(code))) return 'denied';
  return 'failed';
}
function endpointLabel(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    return url.origin + url.pathname;
  } catch {
    return '';
  }
}
function matches(plan: Plan, target: DigestPanelTarget): boolean {
  return digestTargetStamp({ key: target.key, ledgerId: plan.ledgerId, linkId: plan.linkId,
    runId: plan.runId, reportId: plan.reportId, ref: plan.ref }) === digestTargetStamp(target);
}
function documentMatches(document: DigestDocument, plan: Plan): boolean {
  return matches(plan, { key: '', ledgerId: document.ledgerId, linkId: document.linkId,
    runId: document.runId, reportId: document.reportId, ref: document.ref }) &&
    document.recipientId === plan.recipientId && document.model === plan.model && document.language === plan.language;
}
export class DelegatedDigestPanel {
  private epoch = 0;
  private binding = '';
  private abort: AbortController | undefined;
  private plan: Plan | undefined;
  private lifetime: DigestPlanLifetime | null = null;
  private input: DigestInput | undefined;
  private checking = false;
  private preparing = false;
  private value: DigestPanelSnapshot = { phase: 'idle', target: null };
  constructor(private readonly api: DigestPanelServices = services) {}
  get snapshot(): DigestPanelSnapshot { return this.value; }
  /** Called with collected/UI state only; safe on paints, never revalidates or opens files. */
  bind(target: DigestPanelTarget | null, scope: string): void {
    const binding = JSON.stringify([scope, digestTargetStamp(target)]);
    if (this.binding !== binding) { this.cancel(); this.binding = binding; }
  }
  cancel(): void {
    this.epoch++;
    this.abort?.abort();
    this.abort = undefined;
    if (this.lifetime) this.api.dispose(this.lifetime);
    this.lifetime = null;
    this.plan = undefined;
    this.input = undefined;
    this.checking = false;
    // A pending preparation retains its slot until it settles; it cannot be replaced or queued.
    this.value = { phase: 'idle', target: null };
  }
  private fail(epoch: number, why: DigestPanelReason): DigestPanelSnapshot | undefined {
    if (epoch !== this.epoch) return;
    const target = this.value.target;
    this.cancel();
    this.value = { phase: 'failed', target, reason: why };
    return this.value;
  }
  private async prepare(input: DigestInput, epoch: number): Promise<Prepared> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let expired = false;
    this.preparing = true;
    let operation: Promise<Prepared>;
    try { operation = this.api.prepare(input); }
    catch (error) { this.preparing = false; throw error; }
    const pending = operation.then((prepared) => {
      if (expired || epoch !== this.epoch) {
        if (prepared.lifetime) this.api.dispose(prepared.lifetime);
        return { plan: prepared.plan, lifetime: null };
      }
      // Own the live handle before releasing the preparation slot or yielding another continuation.
      this.lifetime = prepared.lifetime;
      return prepared;
    }).finally(() => { this.preparing = false; });
    try {
      return await Promise.race([pending, new Promise<never>((_, reject) => {
        timer = setTimeout(() => { expired = true; reject({ reason: 'timeout' }); }, 3000);
      })]);
    } finally { clearTimeout(timer); }
  }
  async activate(target: DigestPanelTarget, input: DigestInput): Promise<DigestPanelSnapshot | undefined> {
    if (this.preparing || ['planning', 'confirm', 'running', 'rechecking'].includes(this.value.phase)) return;
    this.cancel();
    const epoch = this.epoch;
    const fixed = { ...target, ref: { ...target.ref } };
    // Retain the actual env object: copying it would hide live selected-credential changes from core.
    this.input = { ...input, runId: fixed.runId, reportId: fixed.reportId, env: input.env };
    this.value = { phase: 'planning', target: fixed };
    try {
      const prepared = await this.prepare(this.input, epoch);
      if (epoch !== this.epoch) {
        // Cancellation can also land between the preparation's then and this await continuation.
        if (prepared.lifetime) this.api.dispose(prepared.lifetime);
        return;
      }
      this.lifetime = prepared.lifetime;
      const plan = prepared.plan;
      if (!matches(plan, fixed)) return this.fail(epoch, 'changed');
      this.plan = plan;
      this.value = { phase: 'confirm', target: fixed, confirmation: {
        target: fixed, endpoint: plan.endpoint ? endpointLabel(plan.endpoint) : '',
        account: plan.account ?? '', model: plan.model ?? '', language: plan.language ?? '',
        ready: plan.readiness.ready && !!plan.recipientId && !!this.lifetime,
        reason: reason({ reason: plan.readiness.reason }), modelFile: plan.configuration.model,
        outboundFile: plan.configuration.outbound,
      } };
      return this.value;
    } catch (error) { return this.fail(epoch, reason(error)); }
  }
  /** The exact settled snapshot is a receipt, not permission. No-op/canceled calls return nothing. */
  async confirm(): Promise<DigestPanelSnapshot | undefined> {
    const plan = this.plan;
    const input = this.input;
    const lifetime = this.lifetime;
    if (this.value.phase !== 'confirm' || !this.value.confirmation?.ready || !plan?.recipientId || !input || !lifetime)
      return;
    const epoch = this.epoch;
    // Consume UI confirmation before awaiting; core independently claims the opaque lifetime once.
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.value = { ...this.value, phase: 'running' };
    try {
      const document = await this.api.run({ ...input, expectedLedger: plan.ledgerId,
        expectedRecipient: plan.recipientId }, { signal, planLifetime: lifetime });
      if (epoch !== this.epoch) return;
      if (!documentMatches(document, plan)) return this.fail(epoch, 'changed');
      this.value = { phase: 'result', target: this.value.target, result: {
        generatedAt: document.generatedAt, model: document.model, cached: document.cached,
        conclusion: document.digest.conclusion, ...(document.digest.basis ? { basis: document.digest.basis } : {}),
        ...(document.digest.caveats ? { caveats: document.digest.caveats } : {}),
      } };
      return this.value;
    } catch (error) { return this.fail(epoch, reason(error)); }
  }
  /** Exactly one original-baseline check at an existing ordinary collection completion; no new cadence. */
  async collectionCompleted(): Promise<DigestPanelSnapshot | undefined> {
    const lifetime = this.lifetime;
    if (this.checking || !lifetime || this.value.phase !== 'result') return;
    const epoch = this.epoch;
    const retained = this.value;
    this.checking = true;
    this.value = { phase: 'rechecking', target: retained.target };
    // The caller paints the invalidated snapshot before this metadata-only I/O, outside rendering.
    await Promise.resolve();
    if (epoch !== this.epoch) return;
    try {
      if (!this.api.revalidate(lifetime)) return this.fail(epoch, 'changed');
      if (epoch === this.epoch) { this.value = retained; return retained; }
    } catch { return this.fail(epoch, 'changed'); }
    finally { if (epoch === this.epoch) this.checking = false; }
  }
}


/** The page's Digest-only orchestration. The ordinary dispatcher receives only unclaimed inputs. */
export interface DigestPageContext {
  state: MonitorState;
  monitor: MonitorContext;
  surfaces: {
    settingsPage: object | null;
    settingsLeave: object | null;
    activityHub: object | null;
    observability: object | null;
    logsOpen: boolean;
  };
  mainPane: boolean;
  mouse: boolean;
  closed: boolean;
  home: string | null;
  env: NodeJS.ProcessEnv;
  target: DigestPanelTarget | null;
  scope: string;
  frameRoot: string;
  currentRoot: string;
  frameEpoch: number;
  currentEpoch: number;
}
export interface DigestPagePorts {
  context(): DigestPageContext;
  sync(): void;
  modalFrame(): DigestModalFrame | undefined;
  setState(state: MonitorState): void;
  paint(): void;
  focusPanel(): void;
  focusMain(): void;
  pauseModels(): void;
  close(): void;
  forward(text: string): void;
  timeAsync(name: string, work: () => Promise<void>): Promise<void>;
}
function obscured(context: DigestPageContext): boolean {
  const surface = context.surfaces;
  return Boolean(surface.settingsPage || surface.settingsLeave || context.state.help ||
    surface.activityHub || surface.observability || surface.logsOpen);
}
export class DelegatedDigestPage {
  offset = 0;
  constructor(readonly panel: DelegatedDigestPanel, private readonly ports: DigestPagePorts) {}
  /** Bind only collected identity and visible UI. Paint may call this; it never checks source files. */
  synchronize(): void {
    const context = this.ports.context();
    this.panel.bind(context.target, context.scope);
    if ((context.closed || obscured(context)) && this.panel.snapshot.phase !== 'idle') this.panel.cancel();
  }
  shutdown(): void { this.panel.cancel(); }
  private current(receipt: DigestPanelSnapshot | undefined): receipt is DigestPanelSnapshot {
    if (!receipt) return false;
    this.ports.sync();
    return !this.ports.context().closed && this.panel.snapshot === receipt;
  }
  async confirm(): Promise<void> {
    this.ports.sync();
    const receipt = await this.panel.confirm();
    // Never inspect an unrelated current result: even the same report can be a newer invocation.
    if (!this.current(receipt)) return;
    if (receipt.phase === 'result') {
      const state = this.ports.context().state;
      this.ports.setState({ ...state, keys: true, focus: 'details', preview: 'agent',
        modes: { ...state.modes, details: 'open' }, scroll: { ...state.scroll, details: 0 } });
    }
    this.ports.paint();
  }
  private async activate(target: DigestPanelTarget, context: DigestPageContext): Promise<void> {
    if (!context.home || !digestActionCurrent(target, { ...context, currentTarget: context.target })) return;
    this.offset = 0;
    this.ports.focusPanel();
    const pending = this.panel.activate(target, { home: context.home, env: context.env,
      runId: target.runId, reportId: target.reportId });
    this.ports.paint();
    const receipt = await pending;
    if (this.current(receipt)) this.ports.paint();
  }
  /** The generator owns the WHOLE terminal read, including bytes remaining after a modal closes. */
  *inputs(inputs: readonly WorkbenchInput[]): Generator<WorkbenchInput> {
    let owned = digestModalOwnsInput(this.panel.snapshot);
    for (const input of inputs) {
      this.ports.sync();
      const context = this.ports.context();
      if (context.closed) break;
      if (input.type === 'mouse' && !context.mouse) continue;
      const modal = digestModalOwnsInput(this.panel.snapshot);
      if (owned && !modal) continue;
      if (modal) {
        owned = true;
        const outcome = digestModalInput(input, this.ports.modalFrame());
        if (outcome.offset !== undefined) this.offset = outcome.offset;
        if (outcome.action === 'close') { this.shutdown(); this.ports.close(); break; }
        if (outcome.action === 'cancel' || outcome.action === 'pause') {
          this.panel.cancel();
          if (!context.state.keys) this.ports.focusMain();
        }
        if (outcome.action === 'pause') this.ports.pauseModels();
        if (outcome.action === 'confirm') void this.confirm();
        this.ports.paint();
        continue;
      }
      const visible = !obscured(context);
      const route = routeDigestInput(input, { monitorVisible: visible,
        forwardToMain: context.mainPane && !context.state.keys });
      if (route === 'ignore') continue; // Before ANY ordinary dismissal or queued destination.
      if (route === 'forward') {
        if (input.type === 'key' && input.raw) this.ports.forward(input.raw);
        continue;
      }
      const hit = visible && input.type === 'mouse' && input.button === 'left' &&
        context.monitor.frame?.controls.some((control) => control.kind === 'delegation-digest' &&
          input.y === control.y && input.x >= control.x && input.x < control.x + control.width);
      if (route === 'panel' || hit) {
        const result = handleMonitorInput(context.state,
          input.type === 'command' ? { type: 'key', key: 'delegation-digest' } : input, context.monitor);
        if (result.action?.type === 'delegation-digest') {
          // Start synchronously so remaining bytes in THIS read cannot confirm the newly opened dialog.
          void this.activate(result.action.target, context);
          owned = digestModalOwnsInput(this.panel.snapshot);
        }
        continue;
      }
      yield input;
    }
  }
  /** Called only after the existing ordinary collection/afterPaint finishes, inside its outer timer. */
  async ordinaryCollectionCompleted(): Promise<void> {
    this.ports.sync();
    if (this.ports.context().closed || this.panel.snapshot.phase !== 'result') return;
    await this.ports.timeAsync('digest.revalidate', async () => {
      const pending = this.panel.collectionCompleted();
      this.ports.paint(); // Hidden before the lifetime's first metadata observation.
      const receipt = await pending;
      if (this.current(receipt)) this.ports.paint();
    });
  }
}
