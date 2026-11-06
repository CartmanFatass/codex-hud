// Fixed synthetic world. All authority and capability evidence here is lab-only.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { openLedger } from '../../dist/ledger/ledger.js';
import { insertRecord } from '../../dist/ledger/records.js';
import { scopeSnapshot } from '../../dist/ledger/call-context.js';
import { makeSourceId, makeProcessKey, sessionRefKey } from '../../dist/core/identity.js';
import { deriveProcessDomain } from '../../dist/core/process-domain.js';
import { DelegationService } from '../../packages/hud-mcp/dist/packages/hud-mcp/src/delegation.js';
import { launchPreparedRun } from '../../packages/hud-mcp/dist/src/core/launch/supervisor.js';
import { openLinkLedgerReader } from '../../dist/core/link-ledger-read.js';
import { LinkTickCollector } from '../../dist/core/link/tick.js';
import { loadLimits } from '../../dist/core/link/limits.js';
import { createRunFactPort } from '../../dist/core/run/ledger-port.js';
import { HeadlessRunControl } from '../../dist/core/run/control.js';
import { PrivateLedgerGate } from '../../dist/ledger/local-manager.js';
import { readProcess, processState } from '../../dist/core/run/process.js';
import { sameProcessStamp } from '../../dist/core/supervision.js';
import { mergeStatus, STATUS_RULE_VERSION } from '../../dist/core/status/merge.js';
import { PiAdapter } from '../../dist/harness/pi/index.js';
import { DurableJevLab, SimulatedJevReader } from '../../dist-test/tests/fakes/jev-durable.js';
import { makeLabPiPreparer } from './pi-preparer.mjs';
import { digest } from '../../packages/hud-mcp/dist/src/core/canonical.js';
import { launchProfileDigest } from '../../packages/hud-mcp/dist/src/core/capabilities.js';
const hash = (s) => createHash('sha256').update(s).digest('hex');

export async function createUnifiedWorld() {
  if (Object.keys(process.env).some((k) => !['HOME', 'HUD_HOME', 'CODEX_HOME', 'PATH', 'LANG', 'TMPDIR'].includes(k)))
    throw Error('lab_environment_not_isolated');
  const root = mkdtempSync(join(tmpdir(), 'hud-unified-owned-'));
  Object.assign(process.env, { HOME: root, HUD_HOME: root, CODEX_HOME: root, TMPDIR: root });
  mkdirSync(join(root, 'pi-coding-agent'), { mode: 0o700 });
  writeFileSync(
    join(root, 'pi-coding-agent', 'pi-extension-context.mjs'),
    readFileSync(resolve('scripts/workbench/pi-extension-context.mjs')),
    { mode: 0o600 }
  );
  const codex = join(root, 'synthetic-codex'),
    pi = join(root, 'pi-coding-agent', 'synthetic-pi');
  for (const [file, harness] of [
    [codex, 'codex'],
    [pi, 'pi'],
  ])
    writeFileSync(
      file,
      `#!${process.execPath}\n${readFileSync(resolve(`scripts/workbench/synthetic-${harness}.mjs`), 'utf8')}`,
      { mode: 0o700 }
    );
  const brief = join(root, 'brief.txt'),
    hold = join(root, 'hold.txt');
  writeFileSync(brief, 'synthetic workbench brief\n', { mode: 0o600 });
  writeFileSync(hold, 'synthetic workbench brief: hold for cancellation\n', { mode: 0o600 });
  const db = await openLedger(join(root, 'ledger.sqlite'));
  const dispatches = [],
    pendingDispatches = [],
    accepted = new Map();
  let service, collector, port, jobLab, jobReader;
  try {
    const parentRoot = join(root, 'synthetic-claude');
    mkdirSync(parentRoot, { mode: 0o700 });
    const parentId = makeSourceId('claude', parentRoot),
      domain = deriveProcessDomain({
        machineId: 'synthetic-machine',
        bootId: 'synthetic-boot',
        pidNamespace: 'synthetic-pid-ns',
      });
    const pid = 990001,
      callerPid = 990002,
      start = '990001',
      now = Date.now();
    const processKey = makeProcessKey('claude', parentId, domain.pidDomain, pid, start);
    const ref = { harness: 'claude', sourceId: parentId, sessionId: 'synthetic-claude-parent', threadId: null };
    const source = { sourceId: parentId, harness: 'claude', rootPath: parentRoot, label: 'SIMULATED Claude parent' };
    const caller = {
      callerId: 'lab-parent',
      instanceKind: 'dedicated',
      harness: 'claude',
      sourceId: parentId,
      pid: callerPid,
      procStart: '990002',
      ppid: pid,
      parentProcStart: start,
      cwd: root,
      envPane: null,
      startedAt: now,
      lastSeenAt: now,
      retiredAt: null,
    };
    const scope = {
      processKey,
      generation: 1,
      harness: 'claude',
      sourceId: parentId,
      pidDomain: domain.pidDomain,
      harnessPid: pid,
      harnessProcStart: start,
      sessionRef: ref,
      boundBy: 'trusted_session',
      bindingEvidenceId: 'synthetic-parent-evidence',
      createdAt: now,
      closedAt: null,
    };
    const context = {
      contextId: 'lab-parent-context',
      generation: 1,
      callerId: caller.callerId,
      kind: 'dedicated',
      contextKey: 'stdio',
      harness: 'claude',
      sourceId: parentId,
      processKey,
      procGeneration: 1,
      sessionRef: ref,
      boundBy: 'trusted_session',
      bindingEvidenceId: 'synthetic-parent-evidence',
      selectionEvidenceId: 'synthetic-parent-evidence',
      createdAt: now,
      closedAt: null,
    };
    await db.transaction((tx) => {
      insertRecord(tx, 'sources', source);
      tx.run(
        'INSERT INTO sessions(session_ref,harness,source_id,session_id,thread_id) VALUES(?,?,?,?,?)',
        sessionRefKey(ref),
        'claude',
        parentId,
        ref.sessionId,
        ''
      );
      insertRecord(tx, 'evidence', {
        evidenceId: 'synthetic-parent-evidence',
        runId: null,
        linkId: null,
        kind: 'trusted_session',
        producer: 'reconciler',
        fingerprint: hash('synthetic-parent-evidence'),
        payload: { simulated: true },
        observedAt: now,
        validatedAt: now,
        validation: 'accepted',
      });
      insertRecord(tx, 'callers', caller);
      insertRecord(tx, 'caller_scopes', scope);
      insertRecord(tx, 'caller_contexts', context);
    });
    const processes = new Map([
      [pid, { pid, ppid: 1, procStart: start, argv: ['/synthetic/claude'], env: {}, pidNamespace: 'synthetic-pid-ns' }],
      [
        callerPid,
        {
          pid: callerPid,
          ppid: pid,
          procStart: '990002',
          argv: ['/synthetic/node'],
          env: {},
          pidNamespace: 'synthetic-pid-ns',
        },
      ],
    ]);
    const reader = {
      domain: () => domain,
      get: (id) => {
        const p = processes.get(id);
        if (!p) throw Error('process_missing');
        return structuredClone(p);
      },
    };
    const common = {
      host: { kind: 'none', layout: 'none' },
      mcpServerName: 'hud',
      claimTransport: 'config_env',
      clientToolTimeoutMs: 60000,
      responseMarginMs: 2000,
      orphan_policy: 'continue',
      managedShellVerified: false,
      roles: { implementer: { model: 'synthetic-model', effort: 'low' } },
    };
    const codexProfile = {
      ...common,
      name: 'synthetic-codex',
      harness: 'codex',
      source: { root, label: 'SIMULATED Codex' },
      launch: { argv: [codex] },
      headless: { argv: [codex] },
      resume: { argv: [codex, '{{sessionId}}'] },
      resumeHeadless: { argv: [codex, '{{sessionId}}'] },
      env: { CODEX_HOME: root, HUD_LAB_HELPER: resolve('scripts/workbench/synthetic-handshake.mjs') },
    };
    const piProfile = {
      ...common,
      name: 'synthetic-pi',
      harness: 'pi',
      source: { root, label: 'SIMULATED Pi' },
      launch: { argv: [pi] },
      headless: { argv: [pi, '--session-dir', root] },
      resume: null,
      resumeHeadless: null,
      env: {},
    };
    const registration = { caller, source, harnessPid: pid, harnessProcStart: start };
    const profiles = { codex: codexProfile, pi: piProfile },
      paths = { codex, pi };
    let dispatchCount = 0;
    service = new DelegationService({
      ledger: db,
      home: root,
      config: { version: 1, profiles: [codexProfile, piProfile] },
      registration,
      reader,
      env: { HOME: root, PATH: '/usr/bin:/bin', CODEX_HOME: root },
      codexConfig: { mcp_servers: { hud: { command: '/synthetic/node' } } },
      hudRunPath: resolve('bin/hud-run'),
      launchPreparers: { pi: makeLabPiPreparer(root, pi) },
      capability: {
        verify: (r) => {
          const h = r.key.harness,
            p = profiles[h];
          const valid =
            p &&
            r.executableIdentity.path === paths[h] &&
            r.sourceId === makeSourceId(h, root) &&
            r.key.mode === 'headless' &&
            r.key.operation === 'spawn' &&
            r.key.hostKind === 'none' &&
            r.key.layout === 'none' &&
            (h !== 'pi' ||
              (r.profileFingerprint === digest({ lab: 'fixed-synthetic-pi', root, executable: pi }) &&
                r.key.profileDigest === launchProfileDigest(piProfile) &&
                r.executableIdentity.version === 'synthetic-lab'));
          return valid ? { ok: true, reason: null } : { ok: false, reason: 'lab_scope_only' };
        },
      },
      launch: async (prepared, ticket, options) => {
        dispatchCount++;
        const pending = launchPreparedRun(prepared, ticket, options);
        pendingDispatches.push(pending);
        const result = await pending;
        dispatches.push(result);
        return result;
      },
    });
    const base = {
      ok: true,
      callId: 'synthetic-unified-call',
      sessionRef: ref,
      processKey,
      evidenceDigest: hash('synthetic-source'),
    };
    async function invoke(tool, args) {
      for (let i = 0; i < 12; i++) {
        try {
          return await service.invoke(
            { ...base, scopePremise: db.snapshot((tx) => scopeSnapshot(tx, db.ledgerId, processKey)) },
            tool,
            args
          );
        } catch (error) {
          if (error.code !== 'ledger_busy' || i === 11) throw error;
          await delay(25);
        }
      }
    }
    async function spawn(harness, key, name, file = brief) {
      const args = {
        backend: `synthetic-${harness}`,
        role: 'implementer',
        name,
        brief: file,
        cwd: root,
        mode: 'headless',
        request_key: key,
      };
      const result = await invoke('delegate_spawn', args);
      if (!result.ok) throw Error('synthetic_spawn_refused');
      accepted.set(result.runId, { ...result, harness, name, args });
      return result;
    }
    async function waitFor(id, predicate, label) {
      const deadline = Date.now() + 25000;
      while (Date.now() < deadline) {
        const state = db.snapshot((tx) => ({
          report: Boolean(tx.get('SELECT 1 FROM reports WHERE run_id=?', id)),
          state: tx.get('SELECT state FROM runs WHERE run_id=?', id)?.state,
        }));
        if (predicate(state)) return;
        if (['ended', 'failed', 'cancelled'].includes(state.state))
          throw Error(`synthetic_${label}_ended_before_ready`);
        await delay(40);
      }
      throw Error(`synthetic_${label}_not_ready`);
    }
    // Serialize only the finite bootstrap to avoid competing synthetic reporters.
    // No accepted or uncertain launch is ever replayed as a new dispatch.
    const codexRun = await spawn('codex', 'unified-codex', 'SIMULATED Codex');
    await waitFor(codexRun.runId, (s) => s.report, 'codex_report');
    await waitFor(codexRun.runId, (s) => ['ended', 'failed', 'cancelled'].includes(s.state), 'codex_end');
    const replay = await invoke('delegate_spawn', accepted.get(codexRun.runId).args);
    if (replay.runId !== codexRun.runId) throw Error('replay_mismatch');
    const piRun = await spawn('pi', 'unified-pi', 'SIMULATED Pi');
    await waitFor(piRun.runId, (s) => s.report, 'pi_report');
    await waitFor(piRun.runId, (s) => ['ended', 'failed', 'cancelled'].includes(s.state), 'pi_end');
    const holdRun = await spawn('pi', 'unified-hold', 'SIMULATED cancel target', hold);
    await waitFor(holdRun.runId, (s) => s.state === 'running', 'cancel_target');
    collector = new LinkTickCollector(await openLinkLedgerReader(join(root, 'ledger.sqlite')), root, loadLimits(root));
    port = await createRunFactPort(root);
    const control = new HeadlessRunControl(port, root, new PrivateLedgerGate(root).actor());
    const identity = { kind: 'session', ref };
    const statusProjection = mergeStatus(
      {
        target: { nodeIdentity: identity, sourceGeneration: 1 },
        sources: [],
        asOfSeq: null,
        observationStamp: null,
        history: { continuity: 'unknown' },
      },
      null,
      STATUS_RULE_VERSION,
      Date.now()
    ).projection;
    const unknown = { value: null, quality: 'unknown', source: 'synthetic:unavailable', asOf: Date.now() };
    const coverage = { state: 'complete', skipped: {}, gaps: [], loaded: true };
    const parentSession = {
      evidence: {
        ref,
        observation: {
          nodeIdentity: identity,
          statusProjection,
          conflict: null,
          spent: { tokens: unknown, costUsd: unknown },
          workspace: null,
          coverage,
          loaded: true,
          depth: 0,
          evidenceStamp: 'SIMULATED',
        },
        cwd: null,
        cwdSource: 'unknown',
        cwdAsOf: null,
        startedAt: now,
        version: null,
        model: unknown,
        context: unknown,
        reports: [],
        native: [],
        linkEvidence: [],
        caps: {},
      },
      sourceGeneration: 1,
      linkEvidenceCurrent: true,
      bytesRead: 0,
      recordsRead: 0,
      loaded: true,
      topology: { ref, sourceGeneration: 1, children: [], loaded: true, bytesRead: 0, recordsRead: 0, coverage },
    };
    const adapter = new PiAdapter();
    await adapter.resolveSource(piProfile, {});
    const piRef = {
      harness: 'pi',
      sourceId: makeSourceId('pi', root),
      sessionId: 'synthetic-pi-session',
      threadId: null,
    };
    const piReader = adapter.open(piRef);
    let lastPiObservation = null;
    async function view() {
      const observed = await piReader.read({ maxBytes: 65536, maxRecords: 128, budgetMs: 100 });
      lastPiObservation = {
        harness: 'pi',
        provenance: 'SIMULATED v3 file / PiAdapter, sample not committed',
        loaded: observed.observation.loaded,
        coverage: observed.observation.coverage.state,
        version: observed.evidence?.version ?? null,
      };
      const topology = await adapter.collectTopology(piRef, { maxBytes: 65536, maxRecords: 128, budgetMs: 100 });
      const sessions = [
        parentSession,
        {
          evidence: observed.evidence,
          sourceGeneration: 1,
          linkEvidenceCurrent: true,
          bytesRead: observed.stats?.bytesRead ?? 0,
          recordsRead: observed.stats?.recordsRead ?? 0,
          loaded: observed.observation.loaded,
          topology: { ref: piRef, sourceGeneration: 1, ...topology },
        },
      ];
      return collector.tick({ roots: [identity], sessions, simulationJobs: jobReader.snapshot(), nowMs: Date.now() });
    }
    const jobPath = join(root, 'simulation-jobs.sqlite'),
      owner = 'synthetic-owner';
    jobLab = DurableJevLab.create(jobPath);
    const jobRef = {
      kind: 'jev',
      provider: 'synthetic-provider',
      account: 'synthetic-account',
      key: 'synthetic-question',
    };
    const nextRef = { ...jobRef, account: 'synthetic-other-account', key: 'synthetic-followup' };
    for (const [index, target] of [jobRef, nextRef].entries())
      jobLab.enqueue({
        ref: target,
        owner,
        browser: 'synthetic-browser',
        requestId: `synthetic-request-${index}`,
        requestFingerprint: `synthetic-fingerprint-${index}`,
        label: `synthetic-holder-${index}`,
        parentContext: { ledgerId: db.ledgerId, ref },
      });
    const storeId = jobLab.snapshot().storeId;
    jobReader = new SimulatedJevReader(jobPath, storeId);
    const currentJob = (target) => jobLab.snapshot().jobs.find((job) => job.ref.key === target.key);
    const ticket = jobLab.consumeDispatch(owner, jobRef, currentJob(jobRef).revision);
    let jobStage = 0;
    const jobStages = [
      'reopened',
      'needs_human',
      'terminal_observed_held',
      'reconciled_released',
      'next_account_dispatch',
    ];
    function advanceJobs() {
      if (jobStage >= jobStages.length) return 'scenario_complete';
      if (jobStage === 0) {
        jobLab.close();
        jobLab = DurableJevLab.open(jobPath, storeId);
      } else if (jobStage === 1)
        jobLab.observe(owner, jobRef, ticket.generation, currentJob(jobRef).revision, 'needs_human');
      else if (jobStage === 2)
        jobLab.observe(owner, jobRef, ticket.generation, currentJob(jobRef).revision, 'answered', 'synthetic-evidence');
      else if (jobStage === 3)
        jobLab.reconcile(
          owner,
          jobRef,
          ticket.generation,
          currentJob(jobRef).revision,
          'answered',
          'synthetic-evidence',
          'synthetic-answer'
        );
      else jobLab.consumeDispatch(owner, nextRef, currentJob(nextRef).revision);
      return jobStages[jobStage++];
    }
    async function cancel(runId) {
      if (!accepted.has(runId)) throw Error('run_not_owned');
      return invoke('delegate_cancel', { runId, grace: 0 });
    }
    function logs(runId) {
      if (!accepted.has(runId)) throw Error('run_not_owned');
      const chunk = control.logs(runId, 'stdout', 0, 8192);
      return chunk.data.toString('utf8').replace(/[\x00-\x08\x0b-\x1f\x7f\x1b]/g, '?');
    }
    async function close() {
      await Promise.allSettled(pendingDispatches);
      for (const id of accepted.keys()) {
        const s = await port.read(id).catch(() => null);
        if (s && !['ended', 'failed', 'cancelled'].includes(s.run.state)) await cancel(id).catch(() => {});
      }
      await delay(500);
      for (const id of accepted.keys()) {
        const snap = await port.read(id).catch(() => null),
          meta = snap?.meta;
        if (
          meta?.scope &&
          meta.scope.pgid === meta.scope.group_leader.pid &&
          sameProcessStamp(readProcess(meta.scope.group_leader.pid)?.stamp ?? null, meta.scope.group_leader)
        ) {
          try {
            process.kill(-meta.scope.pgid, 'SIGKILL');
          } catch {}
        }
        for (const stamp of [meta?.harness, meta?.supervisor])
          if (
            stamp &&
            processState(stamp) === 'alive' &&
            sameProcessStamp(readProcess(stamp.pid)?.stamp ?? null, stamp)
          ) {
            try {
              process.kill(stamp.pid, 'SIGKILL');
            } catch {}
          }
      }
      await Promise.allSettled(dispatches.map((d) => d.completion));
      await port.close();
      collector.close();
      await service.close();
      jobReader?.close();
      jobLab?.close();
      await db.close();
      rmSync(root, { recursive: true, force: true });
    }
    return {
      view,
      advanceJobs,
      cancel,
      logs,
      close,
      ordinary: () => lastPiObservation,
      ownedRuns: [...accepted.keys()],
      codexRun: codexRun.runId,
      piRun: piRun.runId,
      holdRun: holdRun.runId,
      replayRun: replay.runId,
      dispatchCount: () => dispatchCount,
      root,
    };
  } catch (error) {
    await Promise.allSettled(pendingDispatches);
    if (!port) port = await createRunFactPort(root).catch(() => null);
    for (const id of accepted.keys()) {
      const meta = (await port?.read(id).catch(() => null))?.meta;
      if (
        meta?.scope &&
        meta.scope.pgid === meta.scope.group_leader.pid &&
        sameProcessStamp(readProcess(meta.scope.group_leader.pid)?.stamp ?? null, meta.scope.group_leader)
      ) {
        try {
          process.kill(-meta.scope.pgid, 'SIGKILL');
        } catch {}
      }
      for (const stamp of [meta?.harness, meta?.supervisor])
        if (
          stamp &&
          processState(stamp) === 'alive' &&
          sameProcessStamp(readProcess(stamp.pid)?.stamp ?? null, stamp)
        ) {
          try {
            process.kill(stamp.pid, 'SIGKILL');
          } catch {}
        }
    }
    await Promise.allSettled(dispatches.map((d) => d.completion));
    await port?.close();
    collector?.close();
    await service?.close();
    jobReader?.close();
    jobLab?.close();
    await db.close();
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
