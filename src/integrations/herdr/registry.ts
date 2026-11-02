import { randomUUID, randomInt } from 'node:crypto';
import type { RegistryProvider, RegistryRecord } from '../../core/interfaces/registry-provider.js';
import type { SurfaceLocator } from '../../core/interfaces/session-binding.js';
import type { SessionRef } from '../../core/types/identity.js';
import type { ProcessStamp } from '../../core/types/supervision.js';
import { readProcess, sameStamp, type ProcRecord } from '../../core/run/process.js';
import { canonicalJson } from '../../core/canonical.js';
import { HerdrClient, HerdrFailure } from './client.js';
import { object, type ObjectValue } from './transport.js';

export interface PaneObservation {
  pane: ObjectValue;
  locator: Extract<SurfaceLocator, { kind: 'herdr' }>;
  shell: ProcRecord;
  occupant: ProcRecord;
  atPrompt: boolean;
  agentReady: boolean;
  resolved: { sessionRef: SessionRef; harness: ProcessStamp } | null;
}
/** Source resolution must independently verify an explicit harness source and complete ref.
 * Herdr native session ID/cwd/env alone cannot select a source. No managed binding is invented.
 */
export type HerdrSessionResolver = (
  observation: PaneObservation,
  signal: AbortSignal
) => Promise<{ sessionRef: SessionRef; harness: ProcessStamp } | null>;

export class HerdrRegistry implements RegistryProvider {
  private readonly epoch = randomUUID();
  private serial = randomInt(2 ** 48 - 1);
  private sourceGeneration = randomInt(2 ** 48 - 1);
  private occupants = new Map<string, { fingerprint: string; generation: number }>();
  private cache?: { at: number; records: readonly RegistryRecord[] };
  private pending?: Promise<readonly RegistryRecord[]>;
  constructor(
    readonly client: HerdrClient,
    private readonly resolveSession: HerdrSessionResolver = async () => null,
    private readonly processInfo = readProcess,
    private readonly now = Date.now
  ) {}
  private lost(paneId?: string): void {
    if (paneId === undefined) {
      this.occupants.clear();
      this.sourceGeneration++;
    } else for (const key of this.occupants.keys()) if (key.endsWith(`:${paneId}`)) this.occupants.delete(key);
    this.cache = undefined;
  }
  private async resolve(observation: PaneObservation): Promise<PaneObservation['resolved']> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.resolveSession(observation, controller.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new HerdrFailure('herdr_source_timeout'));
          }, 50);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
  async observe(paneId: string): Promise<PaneObservation> {
    try {
      const server = await this.client.require();
      const pane = object((await this.client.read('pane.get', { pane_id: paneId }, server)).pane);
      const info = object((await this.client.read('pane.process_info', { pane_id: paneId }, server)).process_info);
      if (
        pane.pane_id !== paneId ||
        info.pane_id !== paneId ||
        !['workspace_id', 'tab_id', 'terminal_id'].every((key) => typeof pane[key] === 'string' && pane[key])
      )
        throw new Error('herdr_pane_unknown');
      const shell = this.processInfo(Number(info.shell_pid));
      const foreground = Number(info.foreground_process_group_id);
      const occupant = this.processInfo(foreground);
      if (
        !shell ||
        !occupant ||
        !shell.tty ||
        shell.foregroundPgid !== foreground ||
        occupant.pgid !== foreground ||
        occupant.sid !== shell.sid ||
        occupant.tty !== shell.tty ||
        [shell.state, occupant.state].some((state) => state === 'Z' || state === 'X')
      )
        throw new Error('herdr_occupant_unknown');
      const locator: PaneObservation['locator'] = {
        kind: 'herdr',
        server,
        workspace: String(pane.workspace_id),
        tab: String(pane.tab_id),
        pane: paneId,
        process: { ...occupant.stamp },
        occupantGeneration: null,
      };
      const observation: PaneObservation = {
        pane,
        locator,
        shell,
        occupant,
        atPrompt: sameStamp(shell.stamp, occupant.stamp) && !pane.agent,
        agentReady: false,
        resolved: null,
      };
      if (pane.agent) {
        const resolved = await this.resolve(observation);
        if (!resolved) throw new Error('herdr_harness_unknown');
        const ref = resolved.sessionRef;
        const harness = this.processInfo(resolved.harness.pid);
        if (
          !harness ||
          !sameStamp(harness.stamp, resolved.harness) ||
          harness.pgid !== occupant.pgid ||
          harness.sid !== shell.sid ||
          harness.tty !== shell.tty ||
          ['Z', 'X'].includes(harness.state) ||
          !['codex', 'claude', 'pi'].includes(ref.harness) ||
          pane.agent !== ref.harness ||
          typeof ref.sourceId !== 'string' ||
          !ref.sourceId ||
          typeof ref.sessionId !== 'string' ||
          !ref.sessionId ||
          !(ref.threadId === null || typeof ref.threadId === 'string')
        )
          throw new Error('herdr_harness_unknown');
        const freshPane = object((await this.client.read('pane.get', { pane_id: paneId }, server)).pane);
        if (
          canonicalJson([pane.terminal_id, pane.agent, pane.agent_session ?? null, pane.workspace_id, pane.tab_id]) !==
          canonicalJson([
            freshPane.terminal_id,
            freshPane.agent,
            freshPane.agent_session ?? null,
            freshPane.workspace_id,
            freshPane.tab_id,
          ])
        )
          throw new Error('herdr_harness_unknown');
        observation.resolved = structuredClone(resolved);
        observation.locator.process = { ...resolved.harness };
        observation.agentReady = ['idle', 'done'].includes(String(freshPane.agent_status));
      }
      const checkedShell = this.processInfo(shell.stamp.pid);
      const checkedOccupant = this.processInfo(occupant.stamp.pid);
      if (
        !checkedShell ||
        !sameStamp(checkedShell.stamp, shell.stamp) ||
        checkedShell.foregroundPgid !== foreground ||
        ['Z', 'X'].includes(checkedShell.state) ||
        checkedShell.sid !== shell.sid ||
        checkedShell.tty !== shell.tty ||
        checkedShell.pgid !== shell.pgid ||
        !checkedOccupant ||
        !sameStamp(checkedOccupant.stamp, occupant.stamp) ||
        ['Z', 'X'].includes(checkedOccupant.state) ||
        checkedOccupant.pgid !== foreground ||
        checkedOccupant.sid !== shell.sid ||
        checkedOccupant.tty !== shell.tty
      )
        throw new Error('herdr_occupant_unknown');
      if (observation.resolved) {
        const checkedHarness = this.processInfo(observation.resolved.harness.pid);
        if (
          !checkedHarness ||
          !sameStamp(checkedHarness.stamp, observation.resolved.harness) ||
          checkedHarness.pgid !== foreground ||
          ['Z', 'X'].includes(checkedHarness.state) ||
          checkedHarness.sid !== shell.sid ||
          checkedHarness.tty !== shell.tty
        )
          throw new Error('herdr_harness_unknown');
      }
      const fingerprint = canonicalJson({
        epoch: this.epoch,
        server,
        terminal: pane.terminal_id,
        shell: shell.stamp,
        foreground: occupant.stamp,
        session: pane.agent_session ?? null,
        resolved: observation.resolved,
      });
      const key = `${server}:${paneId}`;
      const old = this.occupants.get(key);
      const generation = old?.fingerprint === fingerprint ? old.generation : ++this.serial;
      this.occupants.set(key, { fingerprint, generation });
      observation.locator.occupantGeneration = generation;
      return observation;
    } catch (error) {
      if (
        error instanceof HerdrFailure &&
        [
          'herdr_observation_unavailable',
          'herdr_instance_changed',
          'herdr_unavailable',
          'herdr_schema_mismatch',
          'herdr_disabled',
        ].includes(error.code)
      ) {
        this.lost();
        throw error;
      }
      this.lost(paneId);
      throw new HerdrFailure('herdr_occupant_unknown');
    }
  }
  matches(locator: SurfaceLocator, observation: PaneObservation): boolean {
    const current = observation.locator;
    return (
      locator.kind === 'herdr' &&
      !!locator.process &&
      locator.occupantGeneration !== null &&
      locator.server === current.server &&
      locator.workspace === current.workspace &&
      locator.tab === current.tab &&
      locator.pane === current.pane &&
      locator.occupantGeneration === current.occupantGeneration &&
      sameStamp(locator.process, current.process!)
    );
  }
  async list(): Promise<readonly RegistryRecord[]> {
    if (!this.client.enabled) return [];
    if (this.cache && this.now() - this.cache.at >= 0 && this.now() - this.cache.at < 3000)
      return structuredClone(this.cache.records);
    if (!this.pending)
      this.pending = this.collect().finally(() => {
        this.pending = undefined;
      });
    return structuredClone(await this.pending);
  }
  private async collect(): Promise<readonly RegistryRecord[]> {
    try {
      const snapshot = object((await this.client.read('session.snapshot', {})).snapshot);
      if (!Array.isArray(snapshot.panes) || snapshot.panes.length > 4096) throw new Error('herdr_invalid_snapshot');
      const records: RegistryRecord[] = [];
      for (const value of snapshot.panes) {
        const pane = object(value);
        if (typeof pane.pane_id !== 'string') continue;
        let observation: PaneObservation;
        try {
          observation = await this.observe(pane.pane_id);
        } catch (error) {
          if (error instanceof HerdrFailure && error.code === 'herdr_occupant_unknown') continue;
          throw error;
        }
        const resolved = observation.resolved;
        if (!resolved) continue;
        const ref = resolved.sessionRef;
        const at = this.now();
        const activity = observation.pane.agent_status;
        records.push({
          locator: observation.locator,
          binding: {
            sessionRef: ref,
            harness: resolved.harness,
            occupantGeneration: observation.locator.occupantGeneration,
            managed: null,
          },
          evidence: {
            origin: 'registry',
            ref,
            sourceGeneration: this.sourceGeneration,
            validity: 'current',
            eventAt: null,
            observedAt: at,
            lastSuccessfulReadAt: at,
            value: {
              server: observation.locator.server,
              occupant: ref,
              completionSeq: null,
              sourceClockAt: null,
              activity:
                activity === 'working'
                  ? 'working'
                  : activity === 'blocked'
                    ? 'waiting_input'
                    : activity === 'idle' || activity === 'done'
                      ? 'idle'
                      : 'unknown',
              pendingReason: 'none',
            },
          },
        });
      }
      this.cache = { at: this.now(), records };
      return records;
    } catch {
      this.lost();
      // Transport reads invalidate successful continuity themselves; preserve negative preflight TTLs.
      return [];
    }
  }
  async get(locator: SurfaceLocator): Promise<RegistryRecord | null> {
    if (locator.kind !== 'herdr') return null;
    try {
      const observed = await this.observe(locator.pane);
      if (!this.matches(locator, observed)) return null;
      return (await this.list()).find((record) => record.locator && this.matches(record.locator, observed)) ?? null;
    } catch {
      return null;
    }
  }
  async sessionOf(locator: SurfaceLocator): Promise<SessionRef | null> {
    return (await this.get(locator))?.binding?.sessionRef ?? null;
  }
}
export function sameProcess(a: ProcessStamp | null, b: ProcessStamp | null): boolean {
  return !!a && !!b && sameStamp(a, b);
}
