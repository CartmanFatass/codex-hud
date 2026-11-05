/** Optional, read-only panel composition. The only external mutation is an explicit, guarded pane focus. */
import { isAbsolute, join } from 'node:path';
import { canonicalJson } from '../../core/canonical.js';
import { openPanelLedgerReader, panelLedgerPin } from './panel-ledger.js';
import type { DelegationViewModel } from '../../core/link/view-model.js';
import type { LinkTreeNode } from '../../core/link/types.js';
import type { HostLocator } from '../../core/types/capabilities.js';
import type { LifecycleStatus } from '../../core/types/lifecycle.js';
import type { ProcessStamp } from '../../core/types/supervision.js';
import { RunArtifacts } from '../../core/run/artifacts.js';
import { readProcess, processState } from '../../core/run/process.js';
import { isRunTerminal } from '../../core/execution.js';
import { interactionPolicy } from '../../core/lifecycle.js';
import { mergeStatus, STATUS_RULE_VERSION } from '../../core/status/merge.js';
import { HerdrClient } from './client.js';
import { HerdrHost } from './host.js';
import { HerdrRegistry, sameProcess } from './registry.js';
import { CliHerdrTransport, type HerdrTransport } from './transport.js';

export interface PanelHostTarget {
  ledgerId: string;
  key: string;
  identity: LinkTreeNode['identity'];
  run: NonNullable<LinkTreeNode['currentRun']>;
}
export interface PanelHostAvailability {
  target: string;
  available: boolean;
  reason: string;
  checkedAt: number;
}
export const PANEL_HOST_FRESH_MS = 3000;
export function freshPanelHostAvailability(snapshot: PanelHostAvailability | null, now = Date.now()): boolean {
  return !!snapshot && now >= snapshot.checkedAt && now - snapshot.checkedAt < PANEL_HOST_FRESH_MS;
}
export const panelHostStamp = (target: PanelHostTarget): string =>
  canonicalJson({
    ledger: target.ledgerId,
    key: target.key,
    identity: target.identity,
    mode: target.run.mode,
    run: target.run.runId,
    link: target.run.linkId,
    sequence: target.run.runSeq,
    generation: target.run.expectedGeneration ?? null,
    locator: target.run.locator ?? null,
    state: target.run.state,
    supervisor: target.run.supervisor ?? null,
    source: target.run.sourceId ?? null,
    harness: target.run.harness ?? null,
  });
export function panelHostTarget(
  vm: DelegationViewModel | null,
  key: string | null | undefined
): PanelHostTarget | null {
  const node = vm?.tree.nodes.find((n) => n.key === key);
  if (!node?.currentRun || !vm?.tree.ledger.ledgerId || node.currentRun.mode !== 'visible') return null;
  return { ledgerId: vm.tree.ledger.ledgerId, key: node.key, identity: node.identity, run: node.currentRun };
}
function stamp(value: unknown): value is ProcessStamp {
  if (!value || typeof value !== 'object') return false;
  const v = value as ProcessStamp;
  return (
    Object.keys(v).sort().join(',') === 'boot_id,pid,pid_domain,proc_start' &&
    Number.isSafeInteger(v.pid) &&
    v.pid > 0 &&
    typeof v.proc_start === 'string' &&
    /^\d+$/.test(v.proc_start) &&
    typeof v.boot_id === 'string' &&
    !!v.boot_id &&
    v.boot_id.length <= 128 &&
    typeof v.pid_domain === 'string' &&
    !!v.pid_domain &&
    v.pid_domain.length <= 128
  );
}
/** This is a candidate, never proof. The entire transport instance must match afterward. */
export function serverStampCandidate(server: unknown): ProcessStamp | null {
  if (typeof server !== 'string' || server.length > 1024) return null;
  const match = /^herdr:(\{[^\n]*\}):([0-9]+):([0-9]+):([0-9]+)$/.exec(server);
  if (!match) return null;
  try {
    const value: unknown = JSON.parse(match[1]);
    return stamp(value) && canonicalJson(value) === match[1] ? value : null;
  } catch {
    return null;
  }
}
function locatorOf(target: PanelHostTarget): Extract<HostLocator, { kind: 'herdr' }> | null {
  const value = target.run.locator;
  if (
    !value ||
    value.kind !== 'herdr' ||
    value.runId !== target.run.runId ||
    value.bindingGeneration !== target.run.expectedGeneration ||
    !stamp(value.process) ||
    !['server', 'workspace', 'tab', 'pane'].every(
      (key) =>
        typeof value[key] === 'string' &&
        !!value[key] &&
        String(value[key]).length <= 1024 &&
        !/[\x00-\x1f\x7f]/.test(String(value[key]))
    )
  )
    return null;
  return value as unknown as Extract<HostLocator, { kind: 'herdr' }>;
}

export interface PanelHostOptions {
  home: string | null;
  env?: NodeJS.ProcessEnv;
  /** Test seam; production always uses CliHerdrTransport with a verified instance. */
  transport?: (socket: string, server: ProcessStamp) => HerdrTransport;
  processInfo?: typeof readProcess;
}
/** Each composition is fixed to ONE run. No pane enumeration, focused-session inference or launch capability. */
export async function composePanelHost(target: PanelHostTarget, options: PanelHostOptions, isCurrent: () => boolean) {
  const env = options.env ?? process.env;
  const fixed = locatorOf(target);
  const server = serverStampCandidate(fixed?.server);
  const socket = env.HERDR_SOCKET_PATH;
  if (
    !options.home ||
    env.HUD_HERDR === '0' ||
    !fixed ||
    !server ||
    !socket ||
    !isAbsolute(socket) ||
    socket.includes('\0')
  )
    throw new Error('Open unavailable: exact host identity is missing.');
  const home = options.home;
  const ledger = join(home, 'ledger.sqlite');
  const info = panelLedgerPin(ledger);
  const artifacts = RunArtifacts.open(home, target.run.runId);
  const raw = options.transport?.(socket, server) ?? new CliHerdrTransport(socket, env, 'herdr', 500, server);
  const reader = openPanelLedgerReader(ledger, target.run.linkId, target.run.runId);
  const deadline = performance.now() + 3000;
  const bounded = async <T>(operation: () => Promise<T>): Promise<T> => {
    const remaining = deadline - performance.now();
    if (remaining <= 0 || !isCurrent()) throw new Error('host_timeout');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('host_timeout')), remaining);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const read = async () => {
    if (!isCurrent() || performance.now() >= deadline) throw new Error('selection_changed');
    panelLedgerPin(ledger, info);
    const s = await bounded(() => reader.read());
    if (!isCurrent() || performance.now() >= deadline || s.ledgerId !== target.ledgerId)
      throw new Error('ledger_changed');
    const { run, link, bindings } = s;
    const binding = bindings[0];
    const meta = artifacts.readMetaBounded();
    // Conservative failure for any conflict history; no speculative conflict resolution in the panel.
    if (
      !run ||
      !link ||
      !link.currentOwner ||
      run.runId !== target.run.runId ||
      panelHostStamp({ ...target, run }) !== panelHostStamp(target) ||
      target.identity.kind !== 'session' ||
      canonicalJson(binding?.sessionRef ?? null) !== canonicalJson(target.identity.ref) ||
      run.expectedGeneration !== target.run.expectedGeneration ||
      canonicalJson(run.locator) !== canonicalJson(fixed) ||
      run.mode !== 'visible' ||
      run.state !== 'running' ||
      isRunTerminal(run) ||
      !run.supervisor ||
      processState(run.supervisor) !== 'alive' ||
      bindings.length !== 1 ||
      binding.bindingGeneration !== run.expectedGeneration ||
      binding.sessionRef.harness !== run.harness ||
      binding.sessionRef.sourceId !== run.sourceId ||
      canonicalJson(binding.sessionRef) !== canonicalJson(link.childRef) ||
      s.conflict ||
      !meta ||
      meta.run_id !== run.runId ||
      meta.link_id !== run.linkId ||
      meta.source_id !== run.sourceId ||
      meta.binding_generation !== run.expectedGeneration ||
      !sameProcess(meta.supervisor, run.supervisor) ||
      !sameProcess(meta.harness, fixed.process)
    )
      throw new Error('run_changed');
    return { run, link, binding, meta, seq: s.asOfSeq };
  };
  let focusing = false;
  const transport: HerdrTransport = {
    instance: () => bounded(() => raw.instance()),
    request: (method, params) => {
      if (!['ping', 'pane.get', 'pane.process_info'].includes(method)) throw new Error('panel_read_only');
      return bounded(() => raw.request(method, params));
    },
    command: async (argv) => {
      const focus = argv.length === 3 && argv[0] === 'pane' && argv[1] === 'focus' && argv[2] === fixed.pane;
      if (!focus && !(argv.join(' ') === 'api schema --json' || argv.join(' ') === '--version'))
        throw new Error('panel_read_only');
      if (focus) {
        if (!focusing || !isCurrent() || (await bounded(() => raw.instance())) !== fixed.server)
          throw new Error('target_changed');
        const { run, meta } = await read();
        const processInfo = options.processInfo ?? readProcess;
        const supervisor = processInfo(run.supervisor!.pid);
        const harness = processInfo(meta.harness!.pid);
        if (
          !supervisor ||
          !harness ||
          !sameProcess(supervisor.stamp, run.supervisor) ||
          !sameProcess(harness.stamp, meta.harness) ||
          !supervisor.tty ||
          supervisor.pgid !== harness.pgid ||
          supervisor.sid !== harness.sid ||
          supervisor.tty !== harness.tty ||
          ['Z', 'X'].includes(supervisor.state) ||
          ['Z', 'X'].includes(harness.state)
        )
          throw new Error('process_changed');
        if (!isCurrent()) throw new Error('target_changed');
      }
      return bounded(() => raw.command(argv));
    },
  };
  try {
    if ((await bounded(() => raw.instance())) !== fixed.server) throw new Error('host_identity_unavailable');
    await read();
    const client = new HerdrClient(transport, { ...env, HERDR_ENV: '1' });
    const registry = new HerdrRegistry(
      client,
      async (observation) => {
        const { binding, meta } = await read();
        if (
          observation.locator.server !== fixed.server ||
          observation.locator.pane !== fixed.pane ||
          observation.locator.workspace !== fixed.workspace ||
          observation.locator.tab !== fixed.tab
        )
          return null;
        return { sessionRef: binding.sessionRef, harness: meta.harness! };
      },
      options.processInfo
    );
    const control = {
      status: async (): Promise<LifecycleStatus> => {
        const { run, link, binding, seq } = await read();
        const observed = await registry.observe(fixed.pane);
        const matches =
          sameProcess(fixed.process, observed.locator.process) &&
          observed.locator.server === fixed.server &&
          observed.locator.workspace === fixed.workspace &&
          observed.locator.tab === fixed.tab &&
          sameProcess(run.supervisor, observed.occupant.stamp);
        await read();
        const fullRun = { ...run, launchTokenHash: '', launchDigest: '' };
        return {
          link,
          currentRun: fullRun,
          terminalNote: null,
          runHandshake: { state: 'bound', reason: null },
          latestReportForRun: null,
          reconciliation: null,
          parentOffline: null,
          interaction: interactionPolicy({
            run: fullRun,
            unresolvedConflict: false,
            occupantMatches: matches,
            focusVerified: matches,
            inputVerified: false,
            foregroundInteractive: observed.agentReady,
            resumable: false,
          }),
          resumable: { resumable: false, reason: 'capability_unverified', subject: 'local_user' },
          asOfSeq: seq,
          observationStamp: null,
          statusProjection: mergeStatus(
            {
              target: {
                nodeIdentity: { kind: 'session', ref: binding.sessionRef },
                runId: run.runId,
                bindingGeneration: run.expectedGeneration,
                sourceGeneration: 0,
              },
              sources: [],
              asOfSeq: seq,
              observationStamp: null,
              history: { continuity: 'unknown' },
            },
            null,
            STATUS_RULE_VERSION,
            Date.now()
          ).projection,
        };
      },
    };
    const host = new HerdrHost(
      client,
      registry,
      { workspace: fixed.workspace },
      500,
      async () => {
        await read();
        return fixed;
      },
      control
    );
    return {
      async available(): Promise<boolean> {
        const locator = await host.locate(target.run.runId);
        if (!locator || !isCurrent()) return false;
        const status = await control.status();
        return isCurrent() && status.interaction.focus;
      },
      async focus(): Promise<void> {
        const locator = await host.locate(target.run.runId);
        if (!locator || !isCurrent()) throw new Error('target_changed');
        focusing = true;
        try {
          await host.focus(locator);
        } finally {
          focusing = false;
        }
      },
      close: () => reader.close(),
    };
  } catch (error) {
    await reader.close();
    throw error;
  }
}

/** Separate bounded selected-row snapshot. Paint only consumes the value; it never starts host I/O. */
export class PanelHostController {
  private snapshotValue: PanelHostAvailability | null = null;
  private busy = false;
  private serial = 0;
  private closed = false;
  constructor(
    private options: PanelHostOptions,
    private now = Date.now
  ) {}
  /** Expiry is a pure in-memory check so painting cannot keep stale Open evidence alive. */
  get snapshot(): PanelHostAvailability | null {
    return freshPanelHostAvailability(this.snapshotValue, this.now()) ? this.snapshotValue : null;
  }
  close(): void {
    this.closed = true;
    this.serial++;
    this.snapshotValue = null;
  }
  invalidate(): void {
    this.serial++;
    this.snapshotValue = null;
  }
  async refresh(target: PanelHostTarget | null, current: () => boolean): Promise<void> {
    if (!target) {
      this.invalidate();
      return;
    }
    const key = panelHostStamp(target),
      at = this.now();
    if (
      this.closed ||
      this.busy ||
      (this.snapshotValue?.target === key && freshPanelHostAvailability(this.snapshotValue, at))
    )
      return;
    this.busy = true;
    const token = ++this.serial;
    const valid = () => !this.closed && token === this.serial && current();
    let available = false;
    try {
      const host = await composePanelHost(target, this.options, valid);
      try {
        available = await host.available();
      } finally {
        await host.close();
      }
    } catch {
      /* Missing, mismatched and unproven are explicitly unavailable. */
    } finally {
      if (valid())
        this.snapshotValue = {
          target: key,
          available,
          reason: available ? '' : 'Open unavailable: exact host identity could not be verified.',
          checkedAt: this.now(),
        };
      this.busy = false;
    }
  }
  async open(target: PanelHostTarget, current: () => boolean): Promise<string> {
    const snapshot = this.snapshot;
    if (this.closed || this.busy || snapshot?.target !== panelHostStamp(target) || !snapshot.available)
      return 'Open unavailable: exact host identity could not be verified.';
    this.busy = true;
    const token = ++this.serial;
    const valid = () => !this.closed && token === this.serial && current();
    try {
      const host = await composePanelHost(target, this.options, valid);
      try {
        await host.focus();
        return 'Opened run.';
      } finally {
        await host.close();
      }
    } catch {
      return 'Open unavailable: target changed or focus was not confirmed.';
    } finally {
      this.busy = false;
      this.snapshotValue = null;
    }
  }
}

/** Never promote host evidence in the collector or another row. */
export function withPanelHostAvailability(
  vm: DelegationViewModel | null,
  snapshot: PanelHostAvailability | null,
  now = Date.now()
): DelegationViewModel | null {
  if (!vm) return null;
  return {
    ...vm,
    tree: {
      ...vm.tree,
      nodes: vm.tree.nodes.map((node) => {
        if (node.currentRun?.mode !== 'visible') return node;
        const target = panelHostTarget(vm, node.key);
        const available =
          !!target &&
          freshPanelHostAvailability(snapshot, now) &&
          snapshot?.target === panelHostStamp(target) &&
          snapshot.available;
        return {
          ...node,
          host: {
            locator: node.currentRun.locator,
            state: available ? 'valid' : 'unknown',
            occupantMatches: available ? true : null,
            checkedAt: available ? snapshot!.checkedAt : null,
            currentState: available ? { panelFocusVerified: true } : null,
          },
        };
      }),
    },
  };
}
