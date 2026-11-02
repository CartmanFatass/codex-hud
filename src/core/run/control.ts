import { randomUUID } from 'node:crypto';
import { closeSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { RunControl } from '../interfaces/run-control.js';
import { digest } from '../canonical.js';
import { isRunTerminal } from '../execution.js';
import {
  HEARTBEAT_INTERVAL_MS,
  registeredSupervisor,
  sameProcessStamp,
  receiptEligibility,
  inspectReceipt,
  scopeUpdateAllowed,
} from '../supervision.js';
import type { ReconcileEvidence, ReconcileFact } from '../types/execution.js';
import type { FinalExitReceipt, ProcessStamp, RunLaunchInput, RunMeta } from '../types/supervision.js';
import type { LocalManager, RunFactPort, RunSnapshot, CancelIntent } from './port.js';
import { RunArtifacts } from './artifacts.js';
import { launchGroup, readProcess, processState, inspectGroup, proveGroupGone } from './process.js';

export interface StartOptions {
  input: RunLaunchInput;
  ticket: string;
  brief?: Buffer;
  env?: NodeJS.ProcessEnv;
  managedShellVerified?: boolean;
  parent?: { process: ProcessStamp; contextId: string; generation: number };
  /** B4 profile/source verifier; process names/first candidates are never sufficient. */
  identifyHarness?: (command: ProcessStamp) => Promise<ProcessStamp | null>;
  /** Existing supervisor's one bounded launch-workspace capture, never the MCP response path. */
  afterRegistered?: () => Promise<void>;
}
export function launchDigest(input: RunLaunchInput): string {
  return digest(input);
}
export function codexClaimArgs(
  server: string,
  env: { HUD_CLAIM: string; HUD_RUN: string; HUD_LINK: string; HUD_HOME: string }
): string[] {
  if (!/^[A-Za-z0-9_-]+$/.test(server)) throw new Error('invalid_mcp_server');
  return Object.entries(env).flatMap(([key, value]) => [
    '-c',
    `mcp_servers.${server}.env.${key}=${JSON.stringify(value)}`,
  ]);
}
function validateStart(options: StartOptions): string[] {
  const { input } = options,
    launch = input.launch;
  if (input.mode !== 'headless' || !['brief', 'closed'].includes(input.stdin))
    throw new Error('unsupported_headless_input');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.runId) || !isAbsolute(input.cwd)) throw new Error('invalid_launch');
  if ('argv' in launch && launch.argv && !('shell' in launch)) {
    if (!launch.argv.length || launch.argv.some((x) => typeof x !== 'string' || x.includes('\0')) || !launch.argv[0])
      throw new Error('invalid_argv');
    return [...launch.argv];
  }
  if (
    'shell' in launch &&
    typeof launch.shell === 'string' &&
    !('argv' in launch) &&
    isAbsolute(launch.shellPath) &&
    options.managedShellVerified
  )
    return [launch.shellPath, '-ic', launch.shell];
  throw new Error('unsupported_shell_profile');
}
function fact(snapshot: RunSnapshot, kind: ReconcileFact, at = Date.now()): ReconcileEvidence {
  return {
    evidenceId: randomUUID(),
    runId: snapshot.run.runId,
    sourceId: snapshot.run.sourceId,
    bindingGeneration: snapshot.run.expectedGeneration,
    supervisor: registeredSupervisor(snapshot.run, snapshot.events),
    validation: 'accepted',
    asOf: at,
    observedAt: Date.now(),
    fact: kind,
  };
}
function authoritative(snapshot: RunSnapshot): ProcessStamp | null {
  const registered = registeredSupervisor(snapshot.run, snapshot.events);
  return sameProcessStamp(registered, snapshot.run.supervisor) &&
    snapshot.claimSupervisor?.pid === registered?.pid &&
    snapshot.claimSupervisor?.proc_start === registered?.proc_start
    ? registered
    : null;
}
export class HeadlessRunControl implements RunControl {
  private active = new Map<string, () => void>();
  constructor(
    readonly port: RunFactPort,
    readonly hudHome: string,
    readonly actor: LocalManager
  ) {
    if (!isAbsolute(hudHome)) throw new Error('absolute_hud_home_required');
  }
  async status(runId: string) {
    return (await this.port.read(runId)).status;
  }
  async cancel(runId: string, grace = 10_000) {
    if (!Number.isInteger(grace) || grace < 0 || grace > 60_000) throw new Error('invalid_grace');
    await this.port.acceptCancel(runId, this.actor, grace);
    this.active.get(runId)?.();
    return this.status(runId);
  }
  async reconcile(runId: string) {
    await this.port.authorizeManager(runId, this.actor, 'reconcile');
    // Retry a bounded stale snapshot; never overwrite facts committed while probing.
    for (let attempt = 0; attempt < 3; attempt++) {
      const s = await this.port.read(runId),
        observations: ReconcileEvidence[] = [],
        supervisor = authoritative(s);
      if (supervisor) {
        const anomaly = s.events.find((e) => e.kind === 'clock.anomaly');
        if (anomaly)
          observations.push(
            fact(s, { kind: 'heartbeat', at: s.run.heartbeatAt ?? anomaly.at, clockAnomaly: true }, anomaly.at)
          );
        observations.push(fact(s, { kind: 'supervisor', state: processState(supervisor) }));
        if (s.run.heartbeatAt !== null)
          observations.push(fact(s, { kind: 'heartbeat', at: s.run.heartbeatAt }, s.run.heartbeatAt));
        const m = s.meta;
        if (
          m &&
          m.run_id === s.run.runId &&
          m.link_id === s.run.linkId &&
          m.source_id === s.run.sourceId &&
          m.binding_generation === s.run.expectedGeneration &&
          sameProcessStamp(m.supervisor, supervisor) &&
          s.run.scopeRef &&
          m.scope &&
          scopeUpdateAllowed(s.run.scopeRef, m.scope) &&
          m.harness
        ) {
          observations.push(
            fact(
              s,
              {
                kind: 'launch',
                childStarted: true,
                originalExecutorValid: true,
                observedAt: s.run.startedAt ?? s.run.createdAt,
              },
              s.run.startedAt ?? s.run.createdAt
            )
          );
          const currentHarness = readProcess(m.harness.pid);
          if (
            currentHarness &&
            sameProcessStamp(currentHarness.stamp, m.harness) &&
            processState(m.harness) === 'alive' &&
            (currentHarness.pgid !== m.scope.pgid || currentHarness.sid !== m.scope.sid)
          )
            observations.push(fact(s, { kind: 'conflict', cause: 'scope_conflict' }));
          const check = inspectGroup(m.scope);
          const gone = proveGroupGone(m.scope, m.harness, [
            m.scope.group_leader,
            ...(m.command_leader ? [m.command_leader] : []),
          ]);
          const harnessDead = processState(m.harness) === 'dead';
          const sealed =
            processState(m.scope.group_leader) === 'dead' &&
            m.command_leader !== null &&
            processState(m.command_leader) === 'dead';
          const state = gone ? 'gone' : check.result;
          observations.push(
            fact(s, { kind: 'scope', state, complete: gone, harnessTerminated: harnessDead, launchersSealed: sealed })
          );
          if (gone)
            observations.push(
              fact(s, {
                kind: 'scope_reconciled',
                complete: true,
                harnessTerminated: true,
                launchersSealed: true,
                nativeExit: null,
              })
            );
          // Final artifacts are imported only against committed startup authority.
          let receipt: FinalExitReceipt | null = null;
          try {
            receipt = RunArtifacts.open(this.hudHome, runId).readExit();
          } catch {
            /* absent/untrusted files do not grant authority */
          }
          if (receipt) {
            const accepted = inspectReceipt(
              { final: true, complete: true, fingerprint: digest(receipt), receipt },
              m,
              new Map()
            );
            if (accepted.decision === 'adopt')
              observations.push(
                fact(
                  s,
                  {
                    kind: 'receipt',
                    complete: true,
                    harnessTerminated: true,
                    launchersSealed: true,
                    nativeExit: receipt.native_exit
                      ? {
                          code: receipt.native_exit.exit_code,
                          signal: receipt.native_exit.signal,
                          source: receipt.native_exit.status_source,
                        }
                      : null,
                  },
                  receipt.ended_at
                )
              );
          }
        }
      } else observations.push(fact(s, { kind: 'supervisor', state: 'unknown' }));
      if (await this.port.reconcile(runId, s.revision, observations, Date.now())) return this.status(runId);
    }
    throw new Error('reconcile_snapshot_changed');
  }
  logs(runId: string, stream: 'stdout' | 'stderr', offset = 0, limit = 65_536) {
    return RunArtifacts.open(this.hudHome, runId).readLog(stream, offset, limit);
  }
  /** Exactly one invocation in the supervisor process; call only with a committed intent. */
  async start(options: StartOptions): Promise<void> {
    const argv = validateStart(options),
      { input } = options,
      id = input.runId;
    const before = await this.port.read(id);
    if (
      before.run.launchCwd !== input.cwd ||
      before.run.sourceId !== input.sourceId ||
      before.run.orphanPolicy !== input.orphanPolicy ||
      before.run.mode !== input.mode
    )
      throw new Error('frozen_launch_mismatch');
    const self = readProcess(process.pid)?.stamp;
    if (!self) throw new Error('supervisor_stamp_unavailable');
    await this.port.register(id, options.ticket, launchDigest(input), self);
    try {
      await options.afterRegistered?.();
    } catch {
      // A best-effort workspace capture cannot revoke an accepted execution
      // ticket or prevent its sole launch. A missing snapshot remains unknown.
    }
    const artifacts = RunArtifacts.create(this.hudHome, id),
      logs = artifacts.openLogs();
    const initial = await this.port.read(id),
      r = initial.run;
    let meta: RunMeta = {
      schema_version: 1,
      run_id: id,
      link_id: r.linkId,
      source_id: r.sourceId,
      binding_generation: r.expectedGeneration,
      mode: 'headless',
      supervision_strategy: 'headless',
      supervisor: self,
      command_leader: null,
      harness: null,
      scope: null,
      launch_digest: r.launchDigest,
      profile_digest: input.profileDigest,
      launch_call_id: r.launchCallId,
      launch_correlation_id: r.launchCorrelationId,
      created_at: r.createdAt,
      stdin_mode: input.stdin,
      capture: 'file',
      launch_cwd: r.launchCwd,
      project_origin: r.projectOrigin,
    };
    artifacts.writeMeta(meta);
    let seq = 1,
      stopping = false,
      heartbeatBusy = false,
      parentGone = false,
      writerLost = false,
      discoveryFinished = false,
      clockAnomalyRecorded = false,
      cancelTask: Promise<void> | null = null;
    let group: Awaited<ReturnType<typeof launchGroup>> | null = null;
    const startedMono = performance.now();
    let previousWall = Date.now(),
      previousMono = startedMono;
    const handleCancel = async (intent: CancelIntent) => {
      if (!group?.scope || !meta.scope || !meta.harness || meta.scope.scope_id !== group.scope.scope_id) {
        await this.port.raw(id, self, 'cancel.unconfirmed', { requestSeq: intent.seq, reason: 'scope_unknown' });
        return;
      }
      for (const [signal, delay] of [
        ['SIGINT', intent.graceMs],
        ['SIGTERM', 2000],
        ['SIGKILL', 0],
      ] as const) {
        if (stopping || isRunTerminal((await this.port.read(id)).run)) return;
        const currentHarness = readProcess(meta.harness.pid);
        if (
          currentHarness &&
          sameProcessStamp(currentHarness.stamp, meta.harness) &&
          processState(meta.harness) === 'alive' &&
          (currentHarness.pgid !== meta.scope.pgid || currentHarness.sid !== meta.scope.sid)
        ) {
          await this.port.raw(id, self, 'cancel.unconfirmed', {
            requestSeq: intent.seq,
            reason: 'escaped_original_harness',
          });
          await this.reconcile(id);
          return;
        }
        const ack = await group.signal(signal);
        await this.port.raw(id, self, 'cancel.step', { requestSeq: intent.seq, signal, ack });
        if (!ack && signal !== 'SIGKILL') {
          await this.port.raw(id, self, 'cancel.unconfirmed', { requestSeq: intent.seq });
          return;
        }
        if (signal === 'SIGINT' && ack && meta.harness && processState(meta.harness) === 'alive') {
          const s = await this.port.read(id);
          await this.port.reconcile(
            id,
            s.revision,
            [fact(s, { kind: 'cancel', chronology: 'before_exit' })],
            Date.now()
          );
        }
        if (delay)
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, delay);
            group!.exited.then(() => {
              clearTimeout(timer);
              resolve();
            });
          });
      }
    };
    const wake = () => {
      if (cancelTask || stopping || !discoveryFinished) return;
      cancelTask = (async () => {
        const s = await this.port.read(id);
        const e = s.events.find((e) => e.kind === 'cancel.accepted');
        if (e) await handleCancel({ seq: e.seq, at: e.at, graceMs: Number(e.payload.graceMs) });
        else cancelTask = null;
      })().catch(async (e) => {
        await this.port.raw(id, self, 'cancel.unconfirmed', { reason: String(e) });
      });
    };
    this.active.set(id, wake);
    const heartbeat = setInterval(() => {
      if (heartbeatBusy || stopping) return;
      heartbeatBusy = true;
      void this.port
        .heartbeat(id, self, seq, performance.now())
        .then(async (result) => {
          if (!result) {
            writerLost = true;
            stopping = true;
            clearInterval(heartbeat);
            return;
          }
          seq = result.seq;
          const wall = Date.now(),
            mono = performance.now();
          if (
            !clockAnomalyRecorded &&
            (wall < previousWall || Math.abs(wall - previousWall - (mono - previousMono)) > 1000)
          ) {
            clockAnomalyRecorded = true;
            await this.port.raw(id, self, 'clock.anomaly', {
              wallDeltaMs: wall - previousWall,
              monoDeltaMs: Math.round(mono - previousMono),
            });
            await this.reconcile(id);
          }
          previousWall = wall;
          previousMono = mono;
          if (result.cancel) wake();
          if (options.parent && !parentGone && processState(options.parent.process) === 'dead') {
            parentGone = true;
            void this.parentOffline(id, options.parent, self).catch(() => {});
          }
        })
        .catch(() => {
          writerLost = true;
          stopping = true;
          clearInterval(heartbeat);
        })
        .finally(() => {
          heartbeatBusy = false;
        });
    }, HEARTBEAT_INTERVAL_MS);
    try {
      await this.port.phase(id, self, 'submitting');
      group = await launchGroup({
        runId: id,
        argv,
        cwd: input.cwd,
        env: options.env,
        stdin: input.stdin === 'brief' ? (options.brief ?? Buffer.alloc(0)) : null,
        stdoutFd: logs.stdout,
        stderrFd: logs.stderr,
      });
      await this.port.phase(id, self, 'submitted');
      let harness: ProcessStamp | null = null;
      if (group.command) {
        harness = options.identifyHarness
          ? await options.identifyHarness(group.command)
          : 'argv' in input.launch
            ? group.command
            : null;
      }
      if (harness && group.scope) {
        const actual = readProcess(harness.pid);
        if (
          !actual ||
          !sameProcessStamp(actual.stamp, harness) ||
          actual.pgid !== group.scope.pgid ||
          actual.sid !== group.scope.sid
        )
          harness = null;
      }
      meta = { ...meta, command_leader: group.command, harness, scope: harness ? group.scope : null };
      await this.port.startup(id, self, meta);
      artifacts.writeMeta(meta);
      discoveryFinished = true;
      await this.port.raw(id, self, 'launch.sealed', {
        helper: group.helper,
        command: group.command,
        scope: meta.scope,
      });
      await this.reconcile(id);
      wake();
      const exited = await group.exited;
      if (writerLost) return;
      await this.port.raw(id, self, 'command.exited', {
        command: meta.command_leader,
        code: exited.code,
        signal: exited.signal,
        observedAt: exited.at,
      });
      stopping = true;
      clearInterval(heartbeat);
      if (
        meta.scope &&
        meta.harness &&
        proveGroupGone(meta.scope, meta.harness, [group.helper, ...(meta.command_leader ? [meta.command_leader] : [])])
      ) {
        const at = Date.now(),
          proof = randomUUID(),
          s = await this.port.read(id);
        const fenceSeq = await this.port.raw(id, self, 'submission.fenced', { proof_ids: [proof] });
        const native =
          'argv' in input.launch &&
          meta.command_leader &&
          sameProcessStamp(meta.harness, meta.command_leader) &&
          (exited.code !== null || exited.signal !== null)
            ? {
                process: meta.harness,
                subject: 'harness' as const,
                observed_at: exited.at,
                exit_code: exited.code,
                signal: exited.signal,
                status_source: 'wait_status' as const,
                evidence_id: randomUUID(),
              }
            : null;
        const receipt: FinalExitReceipt = {
          schema_version: 1,
          receipt_id: randomUUID(),
          run_id: id,
          link_id: r.linkId,
          source_id: r.sourceId,
          binding_generation: r.expectedGeneration,
          mode: 'headless',
          strategy: 'headless',
          supervisor: self,
          command_leader: meta.command_leader,
          harness: meta.harness,
          scope: meta.scope,
          coverage: 'scope',
          created_at: r.createdAt,
          started_at: s.run.startedAt,
          ended_at: at,
          recorded_at: at,
          duration_ms: Math.round(performance.now() - startedMono),
          native_exit: native,
          shell_exit:
            'shell' in input.launch && meta.command_leader && (exited.code !== null || exited.signal !== null)
              ? {
                  process: meta.command_leader,
                  subject: 'command_leader',
                  observed_at: exited.at,
                  exit_code: exited.code,
                  signal: exited.signal,
                  status_source: 'wait_status',
                  evidence_id: randomUUID(),
                }
              : null,
          reason: native?.signal
            ? 'signal_exit'
            : native?.exit_code === 0
              ? 'normal_exit'
              : native
                ? 'nonzero_exit'
                : 'scope_ended',
          scope_check: {
            scope_id: meta.scope.scope_id,
            checked_at: at,
            result: 'gone',
            visibility: 'complete',
            member_evidence_ids: [],
            zombie_evidence_ids: [],
            launcher_seal_evidence_ids: [proof],
            harness_termination_evidence_ids: [proof],
          },
          submission_fence: { event_seq: fenceSeq, at, proof_ids: [proof] },
          cancel_request_seq: s.events.find((e) => e.kind === 'cancel.accepted')?.seq ?? null,
          logs: { stdout: 'stdout.log', stderr: 'stderr.log', capture: 'file' },
        };
        const invalid = receiptEligibility(receipt);
        if (invalid) throw new Error(invalid);
        artifacts.commitExit(receipt);
        await this.port.receipt(id, self, receipt);
      }
      await this.reconcile(id);
    } finally {
      stopping = true;
      clearInterval(heartbeat);
      this.active.delete(id);
      group?.close();
      closeSync(logs.stdout);
      closeSync(logs.stderr);
    }
  }
  /** Trusted physical-parent exit/context closure notification; stale is not this event. */
  async parentOffline(
    runId: string,
    parent: { contextId: string; generation: number },
    supervisor: ProcessStamp
  ): Promise<void> {
    const s = await this.port.read(runId);
    await this.port.raw(runId, supervisor, 'parent.offline', {
      contextId: parent.contextId,
      generation: parent.generation,
      since: Date.now(),
      orphanPolicy: s.run.orphanPolicy,
    });
    if (s.run.orphanPolicy === 'stop') {
      await this.port.acceptCancel(runId, { kind: 'orphan_policy', supervisor }, 10_000);
      this.active.get(runId)?.();
    }
  }
}
