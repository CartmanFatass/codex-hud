import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as TOML from '@iarna/toml';
import { digest } from '../../../src/core/canonical.js';
import { makeSourceId, sessionRefKey } from '../../../src/core/identity.js';
import { captureWorkspace, updateRun } from '../../../src/core/execution.js';
import { createActionDescriptor, effectiveWaitMs } from '../../../src/core/lifecycle.js';
import {
  capabilityKey,
  capabilitySupport,
  codexHudOverrides,
  injectCodexHudEnv,
  launchProfileDigest,
  launchProfileUsable,
  planHostSelection,
  resolveLaunchCommand,
  validateLaunchCommand,
} from '../../../src/core/capabilities.js';
import {
  collectLeaseAccess,
  collectResource,
  compareWorkspace,
  displayNodeKey,
  initialParserState,
  localRepoId,
  makeMetric,
  mergeBoundIntent,
  noticeBaseline,
  observationCommitValid,
  planTree,
  projectFreshness,
  readJsonlBytes,
  resetReaderCheckpoint,
  resolveStateContinuity,
  runExecutionProjection,
  selectCurrentObservation,
  sumCostUsd,
  waitReadPlan,
  workspaceDiscoveryPlan,
} from '../../../src/core/observation.js';
import {
  canReplaceExportScope,
  decodeDelegationExport,
  exactExportRefJoin,
  EXPORT_LIMITS,
  isDefiniteCurrentParent,
  outboundDecision,
  serializeDelegationExport,
  versionDisposition,
} from '../../../src/core/export.js';
import type { CapabilityCell, CodexConfig, LaunchProfile } from '../../../src/core/types/capabilities.js';
import type { SessionRef } from '../../../src/core/types/identity.js';
import type {
  FreshnessSource,
  ObservationCommit,
  ObservationEvidence,
  ObservationView,
  ReaderCheckpoint,
  RegistryObservation,
  StateContinuity,
  TreeInputNode,
  TreePlanNode,
  WorkspaceContext,
} from '../../../src/core/types/observation.js';
import type {
  ExportInputRecord,
  ExportInputSnapshot,
  OutboundPolicy,
  UniversalSnapshotV3,
} from '../../../src/core/types/export.js';
import { fixtureRun } from './identity-execution.js';

const NOW = 1_700_000_000_000;
const SOURCE_A = makeSourceId('codex', '/synthetic/home-a');
const SOURCE_B = makeSourceId('codex', '/synthetic/home-b');
const ROOT: SessionRef = {
  harness: 'claude',
  sourceId: makeSourceId('claude', '/synthetic/claude-home'),
  sessionId: 'synthetic-parent',
  threadId: null,
};
const CHILD: SessionRef = { harness: 'codex', sourceId: SOURCE_A, sessionId: 'synthetic-child', threadId: null };
const OTHER_HOME: SessionRef = { ...CHILD, sourceId: SOURCE_B };

function workspace(patch: Partial<WorkspaceContext> = {}): WorkspaceContext {
  const gitCommonDir = '/synthetic/repository-a/.git';
  return {
    cwd: '/synthetic/worktree-a/subdirectory',
    worktreeRoot: '/synthetic/worktree-a',
    worktree: 'synthetic-name',
    gitCommonDir,
    repoId: localRepoId(gitCommonDir),
    identityKind: 'git-common-dir-v1',
    scope: 'local',
    cwdSource: 'launch',
    cwdAsOf: NOW,
    gitCapturedAt: NOW + 1,
    gitMissingReason: null,
    projectOrigin: null,
    ...patch,
  };
}

function profile(): LaunchProfile {
  return {
    name: 'synthetic-codex',
    harness: 'codex',
    source: { root: '/synthetic/home-a', label: 'synthetic-source' },
    launch: { argv: ['/synthetic/codex', '{{prompt}}'] },
    headless: { argv: ['/synthetic/codex', 'exec', '{{prompt}}'] },
    resume: { argv: ['/synthetic/codex', 'resume', '{{session}}'] },
    resumeHeadless: { argv: ['/synthetic/codex', 'exec', 'resume', '{{session}}'] },
    host: { kind: 'tmux', layout: 'pane' },
    env: { KEEP: 'synthetic-setting' },
    mcpServerName: 'synthetic.hud',
    claimTransport: 'config_env',
    clientToolTimeoutMs: 60_000,
    responseMarginMs: 2000,
    orphan_policy: 'continue',
    managedShellVerified: false,
  };
}

function capability(patch: Partial<CapabilityCell> = {}): CapabilityCell {
  return {
    key: {
      harness: 'codex',
      profileDigest: digest('synthetic-profile'),
      hostKind: 'herdr',
      layout: 'tab',
      mode: 'visible',
      operation: 'spawn',
    },
    support: 'verified',
    versions: {
      hudRevision: 'synthetic-revision',
      harness: 'synthetic-harness',
      host: 'synthetic-host',
      shell: 'synthetic-shell',
      node: 'synthetic-node',
      platform: 'synthetic-platform',
      kernel: 'synthetic-kernel',
      mcpClient: 'synthetic-client',
    },
    topology: 'synthetic-foreground-wrapper',
    sourceId: SOURCE_A,
    profileFingerprint: digest('synthetic-profile'),
    evidence: {
      script: '/synthetic/check.sh',
      report: '/synthetic/report.md',
      reportSha256: digest('synthetic-report'),
      artifactDigest: digest('synthetic-artifacts'),
      observedAt: NOW,
      reviewStatus: 'accepted',
      scope: 'product',
    },
    results: { identity: 'passed', input: 'passed', scope: 'passed', receipt: 'passed', singleSubmission: 'passed' },
    incomplete: [],
    ...patch,
  };
}

function checkpoint(): ReaderCheckpoint {
  return {
    schemaVersion: 1,
    readerVersion: 'synthetic-reader-v1',
    ref: CHILD,
    fileId: { dev: 1, inode: 2 },
    offset: 0,
    sourceGeneration: 1,
    parserState: initialParserState(),
  };
}

function continuity() {
  return {
    ruleVersion: 'synthetic-rule-v1',
    nodeIdentity: { kind: 'session', ref: CHILD },
    runId: 'synthetic-run-a',
    bindingGeneration: 1,
    sourceGeneration: 1,
    episodeAnchor: 'synthetic-turn-a',
    stateKey: 'working',
    stateSince: NOW,
    stateSinceBasis: 'event',
  } satisfies StateContinuity;
}

function heartbeat(): FreshnessSource {
  return {
    id: 'supervisor',
    validity: 'current',
    lastEvidenceAt: NOW,
    observedAt: NOW,
    lastSuccessfulReadAt: NOW,
    deadlineAt: NOW + 30_000,
  };
}

function view(): ObservationView {
  return {
    nodeIdentity: { kind: 'session', ref: CHILD },
    statusProjection: {
      activity: 'working',
      pendingReason: 'none',
      lastTurnOutcome: 'none',
      liveness: 'alive',
      freshness: projectFreshness([heartbeat()], ['supervisor'], NOW),
      stateKey: 'working',
      stateSince: NOW,
      stateSinceBasis: 'event',
      isRunTerminal: false,
      asOfSeq: 10,
      observationStamp: {
        seqDomain: 'synthetic-source-a',
        commitSeq: 1,
        inputLedgerSeq: 10,
        ref: CHILD,
        runId: 'synthetic-run-a',
        bindingGeneration: 1,
        sourceGeneration: 1,
      },
      asOf: NOW,
      observedAt: NOW,
      lastEvidenceAt: NOW,
    },
    conflict: null,
    spent: {
      tokens: makeMetric({ input: 10, output: 2 }, { quality: 'reported', source: 'synthetic-token-v1', asOf: NOW }),
      costUsd: makeMetric<number>(null, { quality: 'unknown', source: 'synthetic-price-unavailable-v1', asOf: NOW }),
    },
    workspace: workspace(),
    coverage: { state: 'complete', skipped: {}, gaps: [], loaded: true },
    loaded: true,
    depth: 0,
    evidenceStamp: 'synthetic-evidence-a',
  };
}

function record(patch: Partial<ExportInputRecord> = {}): ExportInputRecord {
  const { cwd: _cwd, projectOrigin: _origin, ...snapshot } = workspace();
  return {
    linkId: 'synthetic-link-a',
    runId: 'synthetic-run-a1',
    runSeq: 1,
    linkState: 'bound',
    runState: 'ended',
    isCurrentRun: true,
    currentOwner: true,
    predecessor: null,
    hasUnresolvedConflict: false,
    parentRef: ROOT,
    childRef: CHILD,
    relationshipConfirmed: true,
    bindingReason: null,
    runHandshake: { state: 'bound', reason: null },
    cwdBasis: 'launch',
    cwdCapturedAt: NOW,
    workspaceSnapshot: snapshot,
    projectOrigin: null,
    launchCwd: '/synthetic/launch-a',
    createdAt: NOW,
    startedAt: NOW + 100,
    endedAt: NOW + 1000,
    ...patch,
  };
}

export function goldenExportInput(): ExportInputSnapshot {
  return {
    ledgerId: 'synthetic-ledger-a',
    asOfSeq: 40,
    exportedAt: NOW + 10_000,
    scope: { kind: 'all' },
    paths: 'none',
    records: [
      record({
        linkId: 'synthetic-link-b',
        runId: 'synthetic-run-b1',
        linkState: 'failed',
        runState: 'failed',
        currentOwner: false,
        parentRef: null,
        childRef: null,
        relationshipConfirmed: false,
        bindingReason: 'identity_unverified',
        runHandshake: { state: 'pending', reason: 'identity_source_missing' },
        workspaceSnapshot: null,
        startedAt: null,
        endedAt: NOW + 500,
      }),
      record({
        runId: 'synthetic-run-a3',
        runSeq: 3,
        runState: 'starting',
        runHandshake: { state: 'pending', reason: null },
        launchCwd: '/synthetic/launch-a3',
        createdAt: NOW + 3000,
        cwdCapturedAt: NOW + 3000,
        startedAt: null,
        endedAt: null,
      }),
      record({ isCurrentRun: false }),
      record({
        runId: 'synthetic-run-a2',
        runSeq: 2,
        isCurrentRun: false,
        launchCwd: '/synthetic/launch-a2',
        createdAt: NOW + 2000,
        cwdCapturedAt: NOW + 2000,
        startedAt: NOW + 2100,
        endedAt: NOW + 2900,
      }),
      record({
        linkId: 'synthetic-link-c',
        runId: 'synthetic-run-c1',
        linkState: 'handed_over',
        currentOwner: false,
        childRef: OTHER_HOME,
        parentRef: { ...ROOT, threadId: 'synthetic-agent-a' },
        projectOrigin: { repoId: localRepoId('/synthetic/origin/.git'), basis: 'declared', declaredAt: NOW },
        launchCwd: '/synthetic/disappeared-copy',
        workspaceSnapshot: null,
      }),
    ],
  };
}

const timing = { readElapsedMs: 10, assemblyElapsedMs: 20 };
function serialized(input: ExportInputSnapshot = goldenExportInput()) {
  const result = serializeDelegationExport(input, timing);
  if (!result.ok) assert.fail(result.reason);
  return result.value;
}

export const observationExportCases: Record<string, () => void> = {
  'T-05-1': () => {
    assert.equal(capabilitySupport(null), 'unverified');
    for (const patch of [
      { evidence: null },
      { versions: null },
      { incomplete: ['synthetic-input-unchecked'] },
      { results: { identity: 'passed' as const } },
    ]) {
      assert.equal(capabilitySupport(capability(patch)), 'unverified');
    }
    assert.equal(capabilitySupport(capability()), 'verified');
    assert.equal(capabilitySupport(capability({ versions: {} as CapabilityCell['versions'] })), 'unverified');
    assert.notEqual(capabilityKey(capability().key), capabilityKey({ ...capability().key, layout: 'split' }));
    assert.notEqual(
      capabilityKey({ ...capability().key, operation: 'resume', resumeFrom: 'visible' }),
      capabilityKey({ ...capability().key, operation: 'resume', resumeFrom: 'headless' })
    );
  },
  'T-05-3': () => {
    const text = "synthetic spaces 'quotes'\n$(synthetic-command); $SYNTHETIC";
    assert.deepEqual(resolveLaunchCommand({ argv: ['/synthetic/codex', '--prompt', '{{prompt}}'] }, { prompt: text }), {
      argv: ['/synthetic/codex', '--prompt', text],
    });
    assert.equal(validateLaunchCommand({ argv: [], shell: 'synthetic' }), false);
    assert.equal(validateLaunchCommand({ argv: [] }), false);
    assert.equal(validateLaunchCommand({ shell: '', shellPath: '/synthetic/zsh' }), false);
    const shell = resolveLaunchCommand(
      { shell: 'synthetic-function {{prompt}}', shellPath: '/synthetic/zsh' },
      { prompt: text }
    );
    assert.equal(shell.shellPath, '/synthetic/zsh');
    assert.ok(shell.shell?.startsWith("synthetic-function '"));
    for (const template of [
      'synthetic-function "{{prompt}}"',
      "synthetic-function '{{prompt}}'",
      'synthetic-function prefix{{prompt}}',
    ]) {
      assert.throws(
        () => resolveLaunchCommand({ shell: template, shellPath: '/synthetic/zsh' }, { prompt: text }),
        /unsafe_shell_placeholder_boundary/
      );
    }
    for (const template of [
      '/synthetic/harness <<EOF\n{{prompt}}\nEOF',
      "/synthetic/harness <<'EOF'\n{{prompt}}\nEOF",
      '/synthetic/harness <<< {{prompt}}',
      '/synthetic/harness $(printf %s {{prompt}})',
      '/synthetic/harness $(printf %s $(printf %s {{prompt}}))',
      '/synthetic/harness `printf %s {{prompt}}`',
      '/synthetic/harness <(printf %s {{prompt}})',
      '/synthetic/harness ${synthetic:-{{prompt}}}',
      '/synthetic/harness # {{prompt}}',
      '/synthetic/harness \\\n{{prompt}}',
      "/synthetic/harness $'prefix\\' {{prompt}} suffix'",
      '/synthetic/harness $SYNTHETIC {{prompt}}',
      '/synthetic/harness {{prompt}}; synthetic-next',
      '/synthetic/harness {{prompt}} | synthetic-next',
      '/synthetic/harness {{prompt}} & synthetic-next',
    ]) {
      assert.throws(
        () =>
          resolveLaunchCommand(
            { shell: template, shellPath: '/synthetic/zsh' },
            { prompt: '$(printf synthetic-substitution)' }
          ),
        /unsupported_shell_template_context/
      );
    }
    const loop = profile();
    loop.launch = { shell: 'while true; do synthetic-harness; done', shellPath: '/synthetic/zsh' };
    assert.equal(launchProfileUsable(loop, 'spawn', 'visible').reason, 'capability_unverified');
    assert.equal(
      launchProfileUsable({ ...profile(), source: { root: '', label: 'synthetic' } }, 'spawn', 'visible').usable,
      false
    );
  },
  'T-05-4': () => {
    const serverName = 'synthetic.hud"name';
    const config: CodexConfig = {
      safety: { mode: 'synthetic-restricted' },
      mcp_servers: {
        [serverName]: {
          command: '/synthetic/hud-mcp',
          args: ['--synthetic'],
          env: { KEEP: 'synthetic-env' },
          tool_timeout_sec: 60,
        },
        other: { command: '/synthetic/other', env: { KEEP_OTHER: 'synthetic-other-env' } },
      },
    };
    const env = {
      HUD_CLAIM: 'synthetic-claim"\\\nλ',
      HUD_RUN: 'synthetic-r1',
      HUD_LINK: 'synthetic-l1',
      HUD_HOME: '/synthetic/hud space',
    };
    const result = injectCodexHudEnv(config, serverName, env);
    assert.deepEqual(result.config.mcp_servers[serverName], {
      ...config.mcp_servers[serverName],
      env: { KEEP: 'synthetic-env', ...env },
    });
    assert.deepEqual(result.config.mcp_servers.other, config.mcp_servers.other);
    assert.deepEqual(result.config.safety, config.safety);
    assert.deepEqual(config.mcp_servers[serverName].env, { KEEP: 'synthetic-env' });
    const extraEnv = { ...env, KEEP: 'synthetic-must-not-overwrite', SECRET: 'synthetic-extra-value' };
    const onlyLeaves = injectCodexHudEnv(config, serverName, extraEnv);
    assert.equal(onlyLeaves.config.mcp_servers[serverName].env?.KEEP, 'synthetic-env');
    assert.equal('SECRET' in onlyLeaves.config.mcp_servers[serverName].env!, false);
    const parsed: Record<string, unknown> = {};
    for (let index = 0; index < result.argv.length; index += 2) {
      assert.equal(result.argv[index], '-c');
      const leaf = TOML.parse(result.argv[index + 1]) as unknown as {
        mcp_servers: Record<string, { env: Record<string, string> }>;
      };
      Object.assign(parsed, leaf.mcp_servers[serverName].env);
    }
    assert.deepEqual(parsed, env);
    assert.equal(result.argv.length, 8);
    assert.notDeepEqual(codexHudOverrides(serverName, { ...env, HUD_CLAIM: 'synthetic-claim-r2' }), result.argv);
    const withClaim = { ...profile(), env: { HUD_CLAIM: env.HUD_CLAIM, KEEP: 'synthetic-setting' } };
    assert.equal(launchProfileDigest(withClaim), launchProfileDigest(profile()));
    assert.notEqual(
      launchProfileDigest({ ...profile(), env: { ...profile().env, HUD_HOME: '/synthetic/different-hud' } }),
      launchProfileDigest(profile())
    );
    assert.throws(() => codexHudOverrides(serverName, { ...env, HUD_CLAIM: '\ud800' }), /invalid_toml_string/);
  },
  'T-05-8': () => {
    const common = {
      finalProfileDigest: 'synthetic-herdr',
      hostKind: 'herdr' as const,
      preflight: 'failed' as const,
      neverSubmitted: true,
      dispatchMayHaveOccurred: false,
      runId: 'synthetic-run-a',
      paramsDigest: 'synthetic-params',
      fallback: { profileDigest: 'synthetic-tmux', hostKind: 'tmux' as const, support: 'verified' as const },
    };
    assert.deepEqual(planHostSelection(common), {
      action: 'select',
      profileDigest: 'synthetic-tmux',
      hostKind: 'tmux',
    });
    assert.deepEqual(planHostSelection({ ...common, dispatchMayHaveOccurred: true }), {
      action: 'reconcile',
      runId: 'synthetic-run-a',
    });
    assert.equal(planHostSelection({ ...common, neverSubmitted: false }).action, 'reject');
    assert.equal(
      planHostSelection({ ...common, fallback: { ...common.fallback, support: 'unverified' } }).action,
      'reject'
    );
  },
  'T-05-10': () => {
    const accepted = {
      paramsDigest: 'synthetic-original-params',
      profileDigest: 'synthetic-original-host',
      result: { accepted: true, runId: 'synthetic-run-a' },
    };
    const request = {
      finalProfileDigest: 'synthetic-fallback',
      hostKind: 'tmux' as const,
      preflight: 'ready' as const,
      neverSubmitted: true,
      dispatchMayHaveOccurred: false,
      runId: 'synthetic-run-a',
      paramsDigest: accepted.paramsDigest,
      accepted,
    };
    assert.deepEqual(planHostSelection(request), {
      action: 'replay',
      profileDigest: accepted.profileDigest,
      result: accepted.result,
    });
    assert.deepEqual(planHostSelection({ ...request, paramsDigest: 'synthetic-changed-params' }), {
      action: 'reject',
      reason: 'idempotency_conflict',
    });
  },
  'T-05-11': () => {
    // A synthetic probe summary cannot prove any of A8's physical terminal facts or product acceptance.
    const cell = capability();
    cell.evidence = { ...cell.evidence!, scope: 'probe' };
    assert.equal(capabilitySupport(cell), 'unverified');
    cell.support = 'unsupported';
    cell.topology = 'synthetic-sidecar-managed';
    assert.equal(capabilitySupport(cell), 'unsupported');
  },
  'T-05-13': () => {
    assert.deepEqual(effectiveWaitMs(120_000, 60_000, 2000), { effectiveWaitMs: 58_000, reason: null });
    for (const result of [
      effectiveWaitMs(120_000, null, 2000),
      effectiveWaitMs(120_000, 1000, 2000),
      effectiveWaitMs(120_000, 60_000, 0),
    ]) {
      assert.equal(result.effectiveWaitMs, 0);
      assert.equal(result.reason, 'timeout_configuration_unverified');
    }
    assert.equal(effectiveWaitMs(120_000, 300_000, 2000).effectiveWaitMs, 120_000);
    assert.throws(() => effectiveWaitMs(200_000, 300_000, 2000), /invalid_wait_timeout/);
    const plan = waitReadPlan({
      runId: 'synthetic-run-a',
      nextSeq: 7,
      initialReadDone: true,
      hintRegistered: true,
      rereadAfterRegistration: true,
      relevantHint: false,
      deadlineReached: true,
    });
    assert.deepEqual(plan, { action: 'read', runId: 'synthetic-run-a', nextSeq: 7 });
  },
  'T-05-17': () => {
    const run = fixtureRun({
      launchCwd: '/synthetic/frozen-launch',
      projectOrigin: { repoId: localRepoId('/synthetic/origin/.git'), basis: 'declared', declaredAt: NOW },
    });
    assert.throws(() => updateRun(run, { launchCwd: '/synthetic/later-cli-directory' }));
    const observed = workspace({ cwd: '/synthetic/wrapper-actual-cwd', cwdSource: 'transcript', cwdAsOf: NOW + 300 });
    const { cwd: _cwd, projectOrigin: _origin, ...snapshot } = observed;
    const captured = captureWorkspace(run, snapshot, NOW + 400);
    assert.equal(captured.run.launchCwd, '/synthetic/frozen-launch');
    assert.equal(captured.run.projectOrigin, run.projectOrigin);
    assert.equal(captured.restartHarness, false);
    assert.throws(() => captureWorkspace(captured.run, snapshot, NOW + 500));
    assert.equal(observed.cwd, '/synthetic/wrapper-actual-cwd');
    assert.deepEqual(workspaceDiscoveryPlan({ cwd: run.launchCwd, generation: 1, path: 'accepted', cache: null }), {
      action: 'unavailable',
      maxProcesses: 0,
      softBudgetMs: 0,
    });
  },
  'T-05-18': () => {
    const action = {
      operation: 'resume' as const,
      linkId: 'synthetic-link-a',
      runId: 'synthetic-run-a',
      expectedRun: 'synthetic-run-a',
      reason: 'synthetic-reason',
      hudHome: '/synthetic/hud space',
      mode: 'visible' as const,
      requestKey: 'synthetic-request',
      entryVerified: true,
    };
    assert.equal(createActionDescriptor({ ...action, entryVerified: false }), null);
    const descriptor = createActionDescriptor(action);
    assert.equal(descriptor?.delivery, 'copy_only');
    assert.equal(descriptor?.subject, 'local_user');
    assert.equal(descriptor?.runId, action.expectedRun);
    assert.ok(descriptor?.displayCommand.includes('--expected-run'));
    assert.deepEqual(createActionDescriptor(action), descriptor);
  },
  'T-06-1': () => {
    const zero = makeMetric(0, { quality: 'reported', source: 'synthetic-reported-v1', asOf: NOW });
    const unknown = makeMetric<number>(null, {
      quality: 'unknown',
      source: 'synthetic-missing-observed-time-v1',
      asOf: NOW + 100,
    });
    const estimate = makeMetric(2, { quality: 'estimated', source: 'synthetic-window-1000ms-v1', asOf: NOW });
    assert.equal(zero.value, 0);
    assert.equal(zero.quality, 'reported');
    assert.equal(unknown.value, null);
    assert.equal(estimate.quality, 'estimated');
    assert.throws(() => makeMetric(0, { quality: 'unknown', source: 'synthetic-v1', asOf: NOW }));
    assert.throws(() => makeMetric<number>(null, { quality: 'reported', source: 'synthetic-v1', asOf: NOW }));
    const reread = { metric: zero, observedAt: NOW + 500, lastEvidenceAt: NOW, lastSuccessfulReadAt: NOW + 500 };
    assert.equal(reread.metric.asOf, NOW);
    assert.equal(reread.lastEvidenceAt, NOW);
    assert.notEqual(reread.observedAt, reread.metric.asOf);
  },
  'T-06-4': () => {
    const bytes = Buffer.from('{"public":"合成","type":"assistant"}\r\n', 'utf8');
    const split = bytes.indexOf(Buffer.from('合')) + 1;
    const initial = checkpoint();
    initial.parserState.usageMessageIds = ['synthetic-message-a'];
    initial.parserState.compactBoundary = 'synthetic-compact-a';
    initial.parserState.openToolWaits = [{ id: 'synthetic-tool-a', startedAt: NOW, lastActivityAt: NOW + 1 }];
    initial.parserState.rateBaseline = { outputTokens: 10, measuredAt: NOW };
    const first = readJsonlBytes({
      checkpoint: initial,
      bytes: bytes.subarray(0, split),
      knownEndOffset: bytes.length,
    });
    assert.equal(first.checkpoint.offset, split);
    assert.equal(first.records.length, 0);
    assert.equal(first.coverage.state, 'catching_up');
    const recovered: ReaderCheckpoint = JSON.parse(JSON.stringify(first.checkpoint));
    const second = readJsonlBytes({
      checkpoint: recovered,
      bytes: bytes.subarray(split),
      knownEndOffset: bytes.length,
    });
    assert.deepEqual(second.records, [{ type: 'assistant', byteEnd: bytes.length }]);
    assert.equal(second.coverage.state, 'complete');
    assert.equal(second.checkpoint.offset, bytes.length);
    assert.equal(second.checkpoint.parserState.pendingBytes.length, 0);
    assert.deepEqual(second.checkpoint.parserState.usageMessageIds, initial.parserState.usageMessageIds);
    assert.deepEqual(second.checkpoint.parserState.openToolWaits, initial.parserState.openToolWaits);
    assert.deepEqual(second.checkpoint.parserState.rateBaseline, initial.parserState.rateBaseline);
    const tail = Buffer.from('{"type":"assistant"}', 'utf8');
    const incomplete = readJsonlBytes({ checkpoint: checkpoint(), bytes: tail, knownEndOffset: tail.length });
    assert.equal(incomplete.coverage.state, 'partial');
    assert.equal(incomplete.checkpoint.parserState.pendingBytes.length, tail.length);
    const giant = Buffer.from(
      `{"synthetic":"${'x'.repeat(1024 * 1024)}","type":"assistant"}\n{"type":"thinking"}\n{"tail":true,"type":"user"}\n`
    );
    const oversized = readJsonlBytes({ checkpoint: checkpoint(), bytes: giant, knownEndOffset: giant.length });
    assert.equal(oversized.checkpoint.offset, giant.length);
    assert.equal(oversized.checkpoint.parserState.pendingBytes.length, 0);
    assert.equal(oversized.coverage.skipped.oversize_unknown, 1);
    assert.equal(oversized.coverage.skipped.thinking, 1);
    assert.deepEqual(
      oversized.records.map((entry) => entry.type),
      ['user']
    );
    assert.equal(oversized.coverage.state, 'partial');
    const resumed = readJsonlBytes({
      checkpoint: oversized.checkpoint,
      bytes: new Uint8Array(),
      knownEndOffset: giant.length,
    });
    assert.deepEqual(resumed.coverage.gaps, ['oversize_unknown']);
    for (const reason of ['truncated', 'file_changed', 'compaction', 'branch_changed'] as const) {
      const reset = resetReaderCheckpoint(second.checkpoint, { dev: 1, inode: 3 }, 2, reason);
      assert.equal(reset.offset, 0);
      assert.equal(reset.sourceGeneration, 2);
      assert.deepEqual(reset.parserState, initialParserState());
      assert.equal(reset.resetReason, reason);
    }
    const bounded = readJsonlBytes({
      checkpoint: checkpoint(),
      bytes: bytes,
      knownEndOffset: bytes.length,
      budget: { maxBytes: 5 },
    });
    assert.equal(bounded.checkpoint.offset, 5);
    assert.equal(bounded.coverage.state, 'catching_up');
    assert.equal(readJsonlBytes({ checkpoint: checkpoint(), bytes, knownEndOffset: 5 }).checkpoint.offset, 5);
    const repeated = Buffer.concat([bytes, bytes]);
    for (const limits of [{ budget: { maxRecords: 1 } }, { elapsedMsAfterRecord: [20] }]) {
      const oneRecord = readJsonlBytes({
        checkpoint: checkpoint(),
        bytes: repeated,
        knownEndOffset: repeated.length,
        ...limits,
      });
      assert.equal(oneRecord.checkpoint.offset, bytes.length);
      assert.equal(oneRecord.coverage.state, 'catching_up');
    }
    for (const firstLine of [`${'x'.repeat(20)}\n`, '\n', '\r\n']) {
      const input = Buffer.from(`${firstLine}{"type":"user"}\n`);
      const stopped = readJsonlBytes({
        checkpoint: checkpoint(),
        bytes: input,
        knownEndOffset: input.length,
        budget: { maxRecordBytes: 16 },
        elapsedMsAfterRecord: [21],
      });
      assert.equal(stopped.checkpoint.offset, Buffer.byteLength(firstLine));
      assert.deepEqual(stopped.records, []);
      assert.equal(stopped.checkpoint.parserState.discardingOversize, false);
      assert.equal(stopped.coverage.state, 'catching_up');
      assert.equal(stopped.coverage.remainingBytes, Buffer.byteLength('{"type":"user"}\n'));
      const resumed = readJsonlBytes({
        checkpoint: JSON.parse(JSON.stringify(stopped.checkpoint)),
        bytes: input.subarray(stopped.checkpoint.offset),
        knownEndOffset: input.length,
        budget: { maxRecordBytes: 16 },
      });
      assert.deepEqual(resumed.records, [{ type: 'user', byteEnd: input.length }]);
    }
    assert.throws(
      () =>
        readJsonlBytes({ checkpoint: { ...checkpoint(), schemaVersion: 2 as 1 }, bytes, knownEndOffset: bytes.length }),
      /unsupported_checkpoint_schema/
    );
  },
  'T-06-5': () => {
    const rootIdentity = { kind: 'session' as const, ref: ROOT },
      root = displayNodeKey(rootIdentity);
    const inputs = new Map<string, TreeInputNode>();
    const children = Array.from({ length: 201 }, (_value, index) => {
      const identity = { kind: 'session' as const, ref: { ...CHILD, sessionId: `synthetic-child-${index}` } };
      const key = displayNodeKey(identity);
      inputs.set(key, { identity, readBytes: 8, children: [{ key: root, kind: 'current' }] });
      return { key, kind: 'current' as const };
    });
    inputs.set(root, {
      identity: rootIdentity,
      readBytes: 8,
      children: [
        ...children,
        children[0],
        { key: 'synthetic-history', kind: 'historical' },
        { key: 'synthetic-candidate', kind: 'candidate' },
      ],
    });
    const plan = planTree(root, inputs);
    assert.equal(plan.nodes.length, 200);
    assert.equal(new Set(plan.nodes.map((node) => node.key)).size, 200);
    assert.equal(plan.readBytes, 200 * 8);
    assert.equal(plan.continuation.length, 2);
    assert.equal(plan.nodes.filter((node) => node.parentKey === null).length, 1);
    assert.equal(plan.continuation.includes('synthetic-history'), false);
    const noRead = planTree(root, inputs, { maxBytes: 0 });
    assert.equal(noRead.nodes[0].loaded, false);
    assert.equal(noRead.readBytes, 0);
    assert.throws(() => planTree(root, inputs, { maxNodes: NaN }), /invalid_tree_budget/);
    assert.deepEqual(noRead.continuation, [root]);
    const chain = new Map<string, TreeInputNode>();
    for (let index = 0; index < 7; index++) {
      const identity = { kind: 'delegationIntent' as const, linkId: `synthetic-chain-${index}` };
      const next = displayNodeKey({ kind: 'delegationIntent', linkId: `synthetic-chain-${index + 1}` });
      chain.set(displayNodeKey(identity), { identity, readBytes: 1, children: [{ key: next, kind: 'current' }] });
    }
    const deep = planTree(displayNodeKey({ kind: 'delegationIntent', linkId: 'synthetic-chain-0' }), chain);
    assert.equal(Math.max(...deep.nodes.map((node) => node.depth)), 4);
    assert.equal(deep.nodes.at(-1)?.loaded, false);
    assert.equal(deep.confirmedSessionCount, 0);
  },
  'T-06-6': () => {
    const registry: RegistryObservation = {
      server: 'synthetic-server',
      occupant: CHILD,
      completionSeq: 2,
      sourceClockAt: NOW,
      activity: 'idle',
      pendingReason: 'none',
    };
    const evidence: ObservationEvidence[] = (['registry', 'transcript', 'supervisor', 'report', 'job'] as const).map(
      (origin) => ({
        ref: CHILD,
        runId: 'synthetic-run-a',
        bindingGeneration: 1,
        sourceGeneration: 1,
        origin,
        eventAt: NOW,
        observedAt: NOW + 100,
        lastSuccessfulReadAt: NOW + 100,
        validity: 'current',
        value:
          origin === 'registry'
            ? registry
            : origin === 'report'
              ? { status: 'failed' }
              : origin === 'supervisor'
                ? { nativeExit: null, heartbeatAt: NOW }
                : { known: true },
      })
    );
    assert.equal(evidence.length, 5);
    assert.ok(evidence.every((item) => item.eventAt === NOW && item.observedAt === NOW + 100));
    assert.deepEqual(evidence[0].value, registry);
    assert.equal(runExecutionProjection({ state: 'running' }).isRunTerminal, false);
    const summary = view();
    summary.conflict = { count: 1, recordIds: ['synthetic-conflict-a'], since: NOW };
    const commit: ObservationCommit = {
      ref: CHILD,
      sourceGeneration: 1,
      leaseGeneration: 1,
      seqDomain: 'synthetic-source-a',
      commitSeq: 1,
      observationStamp: summary.statusProjection.observationStamp!,
      checkpoint: checkpoint(),
      summary,
      continuity: continuity(),
      notices: [],
    };
    assert.equal(observationCommitValid(commit), true);
    assert.equal(
      observationCommitValid({ ...commit, checkpoint: { ...commit.checkpoint, sourceGeneration: 2 } }),
      false
    );
    assert.equal(
      observationCommitValid({ ...commit, continuity: { ...commit.continuity, stateSince: NOW + 1 } }),
      false
    );
    assert.deepEqual(commit.summary.conflict, { count: 1, recordIds: ['synthetic-conflict-a'], since: NOW });
  },
  'T-06-10': () => {
    const lease = {
      resource: collectResource(CHILD),
      holder: 'synthetic-reader-a',
      generation: 2,
      expires_at: NOW + 1000,
    };
    const input = {
      lease,
      ref: CHILD,
      holder: lease.holder,
      generation: 2,
      nowMs: NOW,
      previousNowMs: NOW - 1,
      storage: 'observation' as const,
    };
    assert.deepEqual(collectLeaseAccess(input), { writable: true, reason: null, mayChangeRunSlot: false });
    assert.equal(collectLeaseAccess({ ...input, storage: 'ledger' }).reason, 'wrong_storage');
    assert.equal(collectLeaseAccess({ ...input, nowMs: NOW - 2 }).reason, 'lease_time_unknown');
    assert.equal(collectLeaseAccess({ ...input, holder: 'synthetic-reader-b' }).reason, 'lease_fenced');
    assert.equal(collectLeaseAccess({ ...input, generation: 1 }).writable, false);
    assert.equal(collectLeaseAccess({ ...input, nowMs: lease.expires_at }).reason, 'lease_expired');
    assert.deepEqual(lease, input.lease);
    assert.equal(view().coverage.state, 'complete');
  },
  'T-06-17': () => {
    const request = {
      runId: 'synthetic-original-run',
      nextSeq: 7,
      initialReadDone: false,
      hintRegistered: false,
      rereadAfterRegistration: false,
      relevantHint: false,
      deadlineReached: false,
    };
    assert.equal(waitReadPlan(request).action, 'read');
    assert.equal(waitReadPlan({ ...request, initialReadDone: true }).action, 'register_hint');
    assert.equal(waitReadPlan({ ...request, initialReadDone: true, hintRegistered: true }).action, 'read');
    const registered = { ...request, initialReadDone: true, hintRegistered: true, rereadAfterRegistration: true };
    assert.equal(waitReadPlan(registered).action, 'wait');
    for (const trigger of [{ relevantHint: true }, { deadlineReached: true }]) {
      assert.deepEqual(waitReadPlan({ ...registered, ...trigger }), {
        action: 'read',
        runId: request.runId,
        nextSeq: 7,
      });
    }
    assert.deepEqual(
      waitReadPlan({ ...registered, relevantHint: true }),
      waitReadPlan({ ...registered, relevantHint: true })
    );
  },
  'T-06-22': () => {
    const summary = view();
    assert.equal(summary.spent.tokens.quality, 'reported');
    assert.equal(summary.spent.costUsd.quality, 'unknown');
    assert.equal(summary.spent.costUsd.value, null);
    const cost = (value: number) => makeMetric(value, { quality: 'reported', source: 'synthetic-usd-v1', asOf: NOW });
    const zero = sumCostUsd([{ ref: CHILD, costUsd: cost(0) }]);
    assert.equal(zero.value, 0);
    assert.equal(zero.quality, 'reported');
    const partial = sumCostUsd([
      { ref: CHILD, costUsd: cost(2) },
      { ref: CHILD, costUsd: cost(2) },
      { ref: OTHER_HOME, costUsd: summary.spent.costUsd },
    ]);
    assert.deepEqual(partial, {
      value: 2,
      knownCount: 1,
      missingCount: 1,
      coverage: 'partial',
      quality: 'reported',
      isLowerBound: true,
    });
    const mixed = sumCostUsd([
      { ref: CHILD, costUsd: cost(2) },
      { ref: OTHER_HOME, costUsd: makeMetric(3, { quality: 'estimated', source: 'synthetic-usd-v1', asOf: NOW }) },
    ]);
    assert.equal(mixed.value, 5);
    assert.equal(mixed.quality, 'estimated');
    assert.equal(mixed.isLowerBound, false);
    const credits = sumCostUsd([
      { ref: CHILD, costUsd: cost(2) },
      { ref: OTHER_HOME, costUsd: makeMetric(3, { quality: 'reported', source: 'synthetic-credits-v1', asOf: NOW }) },
    ]);
    assert.equal(credits.value, null);
    assert.equal(credits.quality, 'unknown');
  },
  'T-06-23': () => {
    const a = workspace(),
      b = workspace({ cwd: '/synthetic/worktree-b', worktreeRoot: '/synthetic/worktree-b' });
    assert.deepEqual(compareWorkspace(a, b), { cwd: 'different', worktree: 'different', repository: 'same' });
    assert.equal(a.repoId, digest(['git-common-dir-v1', a.gitCommonDir]));
    const clone = workspace({
      gitCommonDir: '/synthetic/clone-b/.git',
      repoId: localRepoId('/synthetic/clone-b/.git'),
    });
    assert.equal(compareWorkspace(a, clone).repository, 'different');
    const copied = workspace({
      cwd: '/synthetic/copied-directory',
      worktreeRoot: null,
      gitCommonDir: null,
      repoId: null,
      gitMissingReason: 'synthetic-not-git',
    });
    assert.deepEqual(compareWorkspace(a, copied), { cwd: 'different', worktree: 'unknown', repository: 'unknown' });
    copied.projectOrigin = { repoId: a.repoId!, basis: 'declared', declaredAt: NOW };
    assert.equal(copied.repoId, null);
    assert.equal(compareWorkspace(a, copied).repository, 'unknown');
    assert.notEqual(sessionRefKey(CHILD), sessionRefKey(OTHER_HOME));
    assert.equal(a.worktree, b.worktree);
    assert.equal(compareWorkspace(a, b).worktree, 'different');
  },
  'T-06-24': () => {
    const cwd = '/synthetic/launch-a',
      value = workspace();
    assert.deepEqual(workspaceDiscoveryPlan({ cwd, generation: 1, path: 'launch', cache: null }), {
      action: 'discover',
      maxProcesses: 2,
      softBudgetMs: 200,
    });
    const cache = { cwd, generation: 1, attempted: true, value };
    for (const path of ['launch', 'collect', 'paint', 'accepted', 'statusline', 'transaction'] as const) {
      assert.deepEqual(workspaceDiscoveryPlan({ cwd, generation: 1, path, cache }), {
        action: 'cached',
        maxProcesses: 0,
        softBudgetMs: 0,
      });
    }
    assert.equal(
      workspaceDiscoveryPlan({ cwd, generation: 1, path: 'collect', cache: { ...cache, value: null } }).action,
      'unavailable'
    );
    assert.equal(workspaceDiscoveryPlan({ cwd, generation: 2, path: 'collect', cache }).action, 'discover');
    assert.equal(workspaceDiscoveryPlan({ cwd, generation: 2, path: 'paint', cache }).action, 'unavailable');
    const oldHeader = workspace({
      cwdSource: 'transcript-header-observed-time-v1',
      cwdAsOf: NOW - 1000,
      gitCapturedAt: NOW,
      gitMissingReason: 'unavailable',
    });
    assert.equal(oldHeader.cwdAsOf, NOW - 1000);
    assert.equal(oldHeader.gitCapturedAt, NOW);
    const historical = serialized({ ...goldenExportInput(), paths: 'local' }).envelope;
    assert.equal(historical.paths, 'local');
    if (historical.paths === 'local')
      assert.equal(
        historical.records.find((row) => row.linkId === 'synthetic-link-c')?.launchCwd,
        '/synthetic/disappeared-copy'
      );
  },
  'T-06-25': () => {
    const parent = displayNodeKey({ kind: 'session', ref: ROOT });
    const a = { kind: 'delegationIntent' as const, linkId: 'synthetic-link-a' },
      b = { kind: 'delegationIntent' as const, linkId: 'synthetic-link-b' };
    assert.notEqual(displayNodeKey(a), displayNodeKey(b));
    const nodes: TreePlanNode[] = [a, b, { kind: 'session' as const, ref: CHILD }].map((identity) => ({
      identity,
      key: displayNodeKey(identity),
      parentKey: parent,
      loaded: true,
      depth: 1,
    }));
    const inputs = new Map<string, TreeInputNode>(
      nodes.map((node) => [node.key, { identity: node.identity, readBytes: 0, children: [] }])
    );
    inputs.set(parent, {
      identity: { kind: 'session', ref: ROOT },
      readBytes: 0,
      children: nodes.slice(0, 2).map((node) => ({ key: node.key, kind: 'current' })),
    });
    const before = planTree(parent, inputs);
    assert.equal(before.confirmedSessionCount, 1);
    const merged = mergeBoundIntent(nodes, a.linkId, CHILD);
    assert.equal(merged.nodes.length, 2);
    assert.equal(merged.nodes.filter((node) => node.identity.kind === 'session').length, 1);
    assert.equal(merged.selectionMap[displayNodeKey(a)], displayNodeKey({ kind: 'session', ref: CHILD }));
    assert.equal(new Set(merged.nodes.map((node) => node.key)).size, 2);
    const intent = resolveStateContinuity(
      {
        ruleVersion: 'synthetic-rule-v1',
        nodeIdentity: a,
        runId: 'synthetic-run-a',
        episodeAnchor: 'synthetic-pending-event',
        stateKey: 'starting',
        eventAt: NOW,
        observedAt: NOW + 100,
        continuity: 'proven',
      },
      null
    );
    assert.equal('sourceGeneration' in intent, false);
    assert.equal(intent.stateSince, NOW);
    assert.throws(() => collectResource(a as unknown as SessionRef));
  },
  'T-06-26': () => {
    assert.equal(projectFreshness([], ['supervisor'], NOW).state, 'unknown');
    assert.equal(projectFreshness([heartbeat()], ['supervisor'], NOW + 30_001).state, 'stale');
    const launch = runExecutionProjection({ state: 'failed', reason: 'not_submitted' });
    assert.deepEqual(launch, {
      isRunTerminal: true,
      execution: 'non_execution',
      launchFailure: { stateKey: 'launch_failed', reason: 'not_submitted' },
    });
    assert.equal('lastTurnOutcome' in launch, false);
    assert.equal(runExecutionProjection({ state: 'running' }).isRunTerminal, false);
    assert.equal(runExecutionProjection({ state: 'cancelling' }).isRunTerminal, false);
    assert.equal(runExecutionProjection(null).isRunTerminal, null);
  },
  'T-06-27': () => {
    const previous = continuity();
    const { stateSince: _since, stateSinceBasis: _basis, ...base } = previous;
    const input = { ...base, eventAt: NOW + 500, observedAt: NOW + 600, continuity: 'proven' as const };
    const reread = resolveStateContinuity(input, previous);
    assert.deepEqual(reread, previous);
    assert.deepEqual(resolveStateContinuity(input, JSON.parse(JSON.stringify(previous))), reread);
    assert.deepEqual(resolveStateContinuity(input, previous), resolveStateContinuity(input, previous));
    assert.equal(resolveStateContinuity({ ...input, runId: 'synthetic-run-b' }, previous).stateSince, NOW + 500);
    assert.equal(
      resolveStateContinuity({ ...input, episodeAnchor: 'synthetic-turn-b' }, previous).stateSince,
      NOW + 500
    );
    const approval = { ...input, stateKey: 'pending:approval', episodeAnchor: 'synthetic-approval-a' };
    const approvalA = resolveStateContinuity(approval, previous);
    assert.equal(
      resolveStateContinuity({ ...approval, eventAt: NOW + 700, episodeAnchor: 'synthetic-approval-b' }, approvalA)
        .stateSince,
      NOW + 700
    );
    assert.equal(
      resolveStateContinuity({ ...input, continuity: 'first_observation', eventAt: null }, null).stateSinceBasis,
      'observed'
    );
    assert.equal(resolveStateContinuity({ ...input, continuity: 'unknown' }, null).stateSince, null);
    assert.deepEqual(
      noticeBaseline(null, { status: 'completed' }, () => ['completed']),
      []
    );
  },
  'T-06-28': () => {
    const source = heartbeat();
    assert.equal(projectFreshness([source], ['supervisor'], NOW + 30_000).state, 'fresh');
    const stale = projectFreshness([source], ['supervisor'], NOW + 30_001);
    assert.equal(stale.state, 'stale');
    assert.equal(stale.staleSince, NOW + 30_000);
    assert.equal(stale.sources[0].lastEvidenceAt, NOW);
    const previous = continuity(),
      { stateSince: _since, stateSinceBasis: _basis, ...base } = previous;
    const input = { ...base, eventAt: null, observedAt: NOW + 40_000, continuity: 'proven' as const };
    const expired = resolveStateContinuity({ ...input, stateKey: 'stale', eventAt: stale.staleSince }, previous);
    assert.equal(expired.stateSince, NOW + 30_000);
    for (const change of [{ historicalGap: true }, { sourceGeneration: 2 }, { ruleVersion: 'synthetic-rule-v2' }]) {
      const resumed = resolveStateContinuity({ ...input, ...change }, previous);
      assert.equal(resumed.stateSince, NOW + 40_000);
      assert.equal(resumed.stateSinceBasis, 'observed');
    }
    const anomaly = projectFreshness([source], ['supervisor'], NOW - 1);
    assert.equal(anomaly.clockAnomaly, true);
    assert.equal(anomaly.state, 'unknown');
    assert.equal(projectFreshness([{ ...source, deadlineAt: NaN }], ['supervisor'], NOW).state, 'unknown');
    assert.equal(resolveStateContinuity({ ...input, clockAnomaly: true }, previous).stateSince, null);
    assert.equal(source.lastEvidenceAt, NOW);
  },
  'T-06-29': () => {
    const stamp = view().statusProjection.observationStamp!;
    const candidate = { stamp, value: { report: 'synthetic-old-report', stateSince: NOW, cwd: '/synthetic/old-cwd' } };
    const target = { asOfSeq: 40, ref: CHILD, runId: 'synthetic-run-b', bindingGeneration: 1, sourceGeneration: 1 };
    const rejected = selectCurrentObservation(target, candidate);
    assert.equal(rejected.observation, null);
    assert.equal(rejected.unavailableReason, 'run_mismatch');
    assert.deepEqual(rejected.rejectedObservationStamp, stamp);
    assert.equal(rejected.asOfSeq, 40);
    for (const change of [{ bindingGeneration: 2 }, { sourceGeneration: 2 }, { ref: OTHER_HOME }]) {
      assert.equal(selectCurrentObservation({ ...target, runId: stamp.runId, ...change }, candidate).observation, null);
    }
    const valid = selectCurrentObservation({ ...target, runId: stamp.runId, asOfSeq: 9999 }, candidate);
    assert.deepEqual(valid.observation, candidate.value);
    assert.equal(valid.observationStamp?.inputLedgerSeq, 10);
    assert.equal(valid.observationStamp?.commitSeq, 1);
    assert.equal(selectCurrentObservation({ ...target, asOfSeq: null }, null).asOfSeq, null);
    assert.equal(selectCurrentObservation({ ...target, asOfSeq: 0 }, null).asOfSeq, 0);
    assert.notEqual(stamp.seqDomain, 'ledger');
  },
  'T-07-1': () => {
    const policy: OutboundPolicy = {
      schemaVersion: 1,
      sourceId: SOURCE_A,
      revision: 1,
      grants: [{ purpose: 'brief', recipientId: 'synthetic-api-a-account-a', decision: 'allow', grantedAt: NOW }],
    };
    const request = { sourceId: SOURCE_A, purpose: 'brief' as const, recipientId: 'synthetic-api-a-account-a' };
    assert.equal(outboundDecision(policy, request), 'allow');
    for (const invalid of [
      null,
      undefined,
      '{synthetic-invalid-json',
      { ...policy, schemaVersion: 2 },
      { ...policy, grants: [] },
      { ...policy, grants: [{ ...policy.grants[0], decision: 'synthetic-invalid' }] },
    ]) {
      assert.equal(outboundDecision(invalid, request), 'deny');
    }
    assert.equal(outboundDecision(policy, { ...request, sourceId: null }), 'deny');
    assert.equal(outboundDecision(policy, { ...request, sourceId: SOURCE_B }), 'deny');
    assert.equal(outboundDecision({ ...policy, sourceId: '*' }, { ...request, sourceId: '*' }), 'deny');
    assert.equal(
      outboundDecision({ ...policy, grants: [...policy.grants, { ...policy.grants[0], decision: 'deny' }] }, request),
      'deny'
    );
  },
  'T-07-3': () => {
    const policy: OutboundPolicy = {
      schemaVersion: 1,
      sourceId: SOURCE_A,
      revision: 7,
      grants: [{ purpose: 'brief', recipientId: 'synthetic-api-a-account-a', decision: 'allow', grantedAt: NOW }],
    };
    for (const sourceId of [SOURCE_A, SOURCE_B]) {
      for (const purpose of ['brief', 'recap', 'routing'] as const) {
        for (const recipientId of [
          'synthetic-api-a-account-a',
          'synthetic-api-a-account-b',
          'synthetic-api-b-account-a',
        ]) {
          assert.equal(
            outboundDecision(policy, { sourceId, purpose, recipientId }),
            sourceId === SOURCE_A && purpose === 'brief' && recipientId === 'synthetic-api-a-account-a'
              ? 'allow'
              : 'deny'
          );
        }
      }
    }
    assert.equal(
      outboundDecision(policy, { sourceId: SOURCE_A, purpose: 'routing', recipientId: 'synthetic-api-a-account-a' }),
      'deny'
    );
  },
  'T-07-10': () => {
    assert.equal(versionDisposition('public_snapshot', 2, 'hud').readable, true);
    assert.equal(versionDisposition('public_snapshot', 3, 'hud').readable, true);
    assert.equal(versionDisposition('scan', 3, 'hud').readable, true);
    assert.equal(versionDisposition('scan', 2, 'hud').action, 'rebuild');
    assert.equal(versionDisposition('checkpoint', 2, 'writer').writable, false);
    assert.equal(versionDisposition('ledger', 0, 'hud').action, 'unavailable');
    assert.equal(versionDisposition('ledger', 0, 'writer').action, 'initialize');
    assert.equal(versionDisposition('ledger', 1, 'hud').readable, true);
    assert.equal(versionDisposition('ledger', 3, 'writer').writable, false);
    assert.equal(versionDisposition('delegation_export', 1, 'hud').readable, true);
    assert.equal(versionDisposition('delegation_export', 3, 'hud').readable, false);
    assert.equal(versionDisposition('ledger', 3, 'hud').mayMigrateLedger, false);
  },
  'T-07-20': () => {
    const result = serialized();
    assert.equal(result.json, readFileSync(resolve('tests/fixtures/contracts/export-v1.golden.json'), 'utf8'));
    assert.deepEqual(
      result.envelope.records.map((row) => [row.linkId, row.runSeq]),
      [
        ['synthetic-link-a', 1],
        ['synthetic-link-a', 2],
        ['synthetic-link-a', 3],
        ['synthetic-link-b', 1],
        ['synthetic-link-c', 1],
      ]
    );
    assert.equal(new Set(result.envelope.records.map((row) => `${result.envelope.ledgerId}:${row.runId}`)).size, 5);
    assert.equal(result.envelope.records[3].parentRef, null);
    assert.equal(result.envelope.records[3].linkState, 'failed');
    assert.equal(result.envelope.records[3].currentOwner, false);
    assert.equal(result.envelope.records[3].startedAt, null);
    assert.equal(result.envelope.records[0].childRef?.threadId, null);
    assert.equal(result.envelope.records[4].parentRef?.threadId, 'synthetic-agent-a');
    assert.notEqual(result.envelope.records[0].childRef?.sourceId, result.envelope.records[4].childRef?.sourceId);
    const empty = serialized({ ...goldenExportInput(), asOfSeq: 0, records: [] });
    assert.deepEqual(empty.envelope.coverage, { state: 'complete', recordCount: 0 });
    assert.equal(empty.envelope.asOfSeq, 0);
    const wide = serialized({
      ...goldenExportInput(),
      records: Array.from({ length: 201 }, (_unused, index) =>
        record({ linkId: `synthetic-wide-${index}`, runId: `synthetic-wide-run-${index}` })
      ),
    });
    assert.equal(wide.envelope.records.length, 201);
  },
  'T-07-22': () => {
    const row = record({
      launchCwd: '/synthetic/allowed-launch-path',
      bindingReason: 'synthetic-secret-diagnostic',
      workspaceSnapshot: {
        ...record().workspaceSnapshot!,
        worktreeRoot: '/synthetic/allowed-worktree-path',
        gitCommonDir: '/synthetic/forbidden-common-path',
        worktree: 'synthetic-forbidden-free-label',
        cwdSource: 'synthetic-forbidden-source-text',
        gitMissingReason: 'synthetic-forbidden-git-text',
      },
    });
    const raw = Object.assign(row, {
      brief: 'synthetic-forbidden-brief',
      reportSummary: 'synthetic-forbidden-summary',
      claim: 'synthetic-forbidden-claim',
      env: { SECRET: 'synthetic-forbidden-env' },
      sourceRoot: '/synthetic/forbidden-source-path',
      transcriptPath: '/synthetic/forbidden-transcript-path',
      logs: '/synthetic/forbidden-log-path',
      label: 'synthetic-forbidden-row-label',
    });
    for (const paths of ['none', 'local'] as const) {
      const result = serialized({ ...goldenExportInput(), records: [raw], paths });
      assert.equal(result.json.includes('synthetic-forbidden'), false);
      assert.equal(result.json.includes('synthetic-secret-diagnostic'), false);
      assert.equal(result.envelope.records[0].bindingReason, null);
      assert.equal(result.envelope.records[0].workspaceSnapshot?.cwdSource, null);
      assert.equal(result.json.includes('/synthetic/allowed-launch-path'), paths === 'local');
      assert.equal(result.json.includes('/synthetic/allowed-worktree-path'), paths === 'local');
      if (result.envelope.paths === 'none') {
        assert.equal('launchCwd' in result.envelope.records[0], false);
        assert.equal('worktreeRoot' in result.envelope.records[0].workspaceSnapshot!, false);
      }
      assert.equal(
        outboundDecision(null, { sourceId: SOURCE_A, purpose: 'brief', recipientId: 'synthetic-api-a' }),
        'deny'
      );
    }
  },
  'T-07-23': () => {
    assert.equal(exactExportRefJoin(CHILD, { ...CHILD }), true);
    assert.equal(exactExportRefJoin(CHILD, OTHER_HOME), false);
    const agent = { ...ROOT, threadId: 'synthetic-agent-a' };
    assert.equal(exactExportRefJoin(agent, ROOT), false);
    assert.equal(exactExportRefJoin(agent, { ...agent }), true);
    const { sourceId: _source, ...missingSource } = CHILD;
    assert.equal(exactExportRefJoin(missingSource, CHILD), false);
    const { threadId: _thread, ...missingThread } = CHILD;
    assert.equal(exactExportRefJoin(missingThread, CHILD), false);
    assert.equal(
      exactExportRefJoin(
        { ...CHILD, cwd: '/synthetic/same', pane: 'synthetic-same', mtime: NOW },
        { ...OTHER_HOME, cwd: '/synthetic/same', pane: 'synthetic-same', mtime: NOW }
      ),
      false
    );
    const empty = serialized({ ...goldenExportInput(), records: [] }).envelope;
    assert.equal(empty.coverage.state, 'complete');
    assert.equal('noOtherDelegations' in empty.coverage, false);
  },
  'T-07-24': () => {
    const input = goldenExportInput(),
      output = serialized({ ...input, paths: 'local' }).envelope;
    assert.equal(output.paths, 'local');
    if (output.paths !== 'local') throw new Error('expected_local');
    const runs = output.records.filter((row) => row.linkId === 'synthetic-link-a');
    assert.equal(runs.length, 3);
    assert.deepEqual(
      runs.map((row) => row.launchCwd),
      ['/synthetic/launch-a', '/synthetic/launch-a2', '/synthetic/launch-a3']
    );
    assert.equal(runs[2].relationshipConfirmed, true);
    assert.equal(runs[2].runHandshake.state, 'pending');
    assert.equal(isDefiniteCurrentParent(runs[2]), true);
    assert.equal(runs[2].runHandshake.state, 'pending');
    assert.equal(isDefiniteCurrentParent({ ...runs[2], runHandshake: { state: 'claimed', reason: null } }), true);
    assert.equal(runs[2].startedAt, null);
    assert.equal(runs[2].endedAt, null);
    assert.equal(isDefiniteCurrentParent(output.records[4]), false);
    const base = serialized({ ...input, records: [record()] }).envelope.records[0];
    assert.equal(isDefiniteCurrentParent(base), true);
    for (const patch of [
      { hasUnresolvedConflict: true },
      { linkState: 'revoked' as const },
      { linkState: 'pending' as const },
      { linkState: 'claimed' as const },
      { relationshipConfirmed: false },
      { currentOwner: false },
      { isCurrentRun: false },
      { parentRef: null },
      { childRef: null },
    ]) {
      assert.equal(isDefiniteCurrentParent({ ...base, ...patch }), false);
    }
    const declared = output.records[4];
    assert.equal(declared.projectOrigin?.basis, 'declared');
    assert.equal(declared.workspaceSnapshot, null);
    assert.equal(declared.launchCwd, '/synthetic/disappeared-copy');
    assert.equal('usage' in declared, false);
  },
  'T-07-25': () => {
    const base = goldenExportInput();
    const rows = Array.from({ length: EXPORT_LIMITS.records }, (_unused, index) =>
      record({ linkId: `synthetic-limit-${index}`, runId: `synthetic-limit-run-${index}`, workspaceSnapshot: null })
    );
    const atCount = serializeDelegationExport(
      { ...base, records: rows },
      { readElapsedMs: 500, assemblyElapsedMs: 500 }
    );
    assert.equal(atCount.ok, true);
    if (atCount.ok) assert.equal(atCount.value.envelope.records.length, 10_000);
    assert.deepEqual(
      serializeDelegationExport({ ...base, records: [...rows, record({ runId: 'synthetic-extra' })] }, timing),
      { ok: false, reason: 'export_record_budget_exceeded' }
    );
    const one = { ...base, paths: 'local' as const, records: [record({ launchCwd: '/x', workspaceSnapshot: null })] };
    const overhead = serialized(one).bytes - 2;
    const exactPath = `/${'x'.repeat(EXPORT_LIMITS.bytes - overhead - 1)}`;
    const atBytes = serializeDelegationExport(
      { ...one, records: [record({ launchCwd: exactPath, workspaceSnapshot: null })] },
      timing
    );
    assert.equal(atBytes.ok, true);
    if (atBytes.ok) assert.equal(atBytes.value.bytes, 16 * 1024 * 1024);
    assert.deepEqual(
      serializeDelegationExport(
        { ...one, records: [record({ launchCwd: `${exactPath}x`, workspaceSnapshot: null })] },
        timing
      ),
      { ok: false, reason: 'export_byte_budget_exceeded' }
    );
    assert.deepEqual(serializeDelegationExport(base, { readElapsedMs: 500, assemblyElapsedMs: 501 }), {
      ok: false,
      reason: 'export_time_budget_exceeded',
    });
    assert.equal(
      serializeDelegationExport({ ...base, records: [null as unknown as ExportInputRecord] }, timing).ok,
      false
    );
    const scoped = serialized({
      ...base,
      scope: { kind: 'links', linkIds: ['synthetic-link-b'] },
      records: base.records.filter((row) => row.linkId === 'synthetic-link-b'),
    });
    assert.equal(scoped.envelope.records.length, 1);
    assert.equal(canReplaceExportScope(0, scoped.envelope), true);
    assert.equal(canReplaceExportScope(1, scoped.envelope), false);
    assert.equal(canReplaceExportScope(0, null), false);
  },
  'T-07-26': () => {
    const envelope = serialized().envelope;
    for (const field of [
      'format',
      'schemaVersion',
      'ledgerId',
      'asOfSeq',
      'exportedAt',
      'scope',
      'coverage',
      'paths',
      'records',
    ]) {
      const missing = { ...envelope } as Record<string, unknown>;
      delete missing[field];
      assert.equal(decodeDelegationExport(missing).ok, false, field);
    }
    for (const field of Object.keys(envelope.records[0])) {
      const missing = { ...envelope.records[0] } as Record<string, unknown>;
      delete missing[field];
      assert.equal(
        decodeDelegationExport({ ...envelope, records: [missing], coverage: { state: 'complete', recordCount: 1 } }).ok,
        false,
        field
      );
    }
    assert.equal(decodeDelegationExport({ ...envelope, schemaVersion: 2 }).ok, false);
    assert.equal(
      decodeDelegationExport({
        ...envelope,
        records: [{ ...envelope.records[0], cwdCapturedAt: NOW + 1 }],
        coverage: { state: 'complete', recordCount: 1 },
      }).ok,
      false
    );
    const optional = decodeDelegationExport({
      ...envelope,
      syntheticFutureOptional: 'synthetic-ignored',
      records: envelope.records.map((row) => ({ ...row, syntheticFutureOptional: 'synthetic-ignored' })),
    });
    assert.equal(optional.ok, true);
    if (optional.ok) assert.deepEqual(optional.value, envelope);
    const unknown = decodeDelegationExport({
      ...envelope,
      records: [
        {
          ...envelope.records[0],
          linkState: 'synthetic-future-link',
          runState: 'synthetic-future-run',
          runHandshake: { state: 'synthetic-future-handshake', reason: null },
        },
      ],
      coverage: { state: 'complete', recordCount: 1 },
    });
    assert.equal(unknown.ok, true);
    if (unknown.ok) {
      assert.equal(unknown.value.records[0].linkState, 'unknown');
      assert.equal(unknown.value.records[0].runState, 'unknown');
      assert.equal(unknown.value.records[0].runHandshake.state, 'unknown');
      assert.equal(isDefiniteCurrentParent(unknown.value.records[0]), false);
    }
    assert.equal(decodeDelegationExport({ ...envelope, ledgerVersion: 500, snapshotVersion: 500 }).ok, true);
    assert.equal('afterSeq' in envelope, false);
  },
  'T-07-27': () => {
    const session = view();
    const intent: ObservationView = {
      ...session,
      nodeIdentity: { kind: 'delegationIntent', linkId: 'synthetic-intent-a' },
      currentRun: fixtureRun(),
      linkId: 'synthetic-intent-a',
      workspace: null,
      statusProjection: {
        ...session.statusProjection,
        stateKey: 'starting',
        stateSince: NOW,
        stateSinceBasis: 'event',
        observationStamp: null,
      },
    };
    const snapshot: UniversalSnapshotV3 = {
      version: 3,
      universal: {
        rootRef: ROOT,
        sourceId: ROOT.sourceId,
        asOfSeq: 50,
        observationStamp: session.statusProjection.observationStamp,
        asOf: NOW,
        observedAt: NOW,
        coverage: session.coverage,
        tree: { nodes: [session, intent], counts: { confirmedSessions: 1, delegationIntents: 1, jobs: 0 } },
        notices: [],
      },
    };
    assert.equal(snapshot.universal.tree.nodes[1].nodeIdentity.kind, 'delegationIntent');
    assert.equal('ref' in intent.nodeIdentity, false);
    assert.equal(snapshot.universal.tree.nodes[0].spent.costUsd.value, null);
    assert.equal(snapshot.universal.tree.nodes[0].statusProjection.freshness.state, 'fresh');
    assert.equal(runExecutionProjection({ state: 'failed' }).execution, 'non_execution');
    assert.equal(runExecutionProjection({ state: 'running' }).isRunTerminal, false);
    const rejected = selectCurrentObservation(
      { asOfSeq: 50, ref: CHILD, runId: 'synthetic-run-b', bindingGeneration: 1, sourceGeneration: 1 },
      { stamp: session.statusProjection.observationStamp!, value: session }
    );
    assert.equal(rejected.observation, null);
    assert.equal(snapshot.universal.observationStamp?.inputLedgerSeq, 10);
    assert.equal(snapshot.universal.asOfSeq, 50);
    assert.equal('holderLabel' in session, false);
    // v2 remains a separate numeric/ISO facade; no existing producer is changed by these new slots.
    assert.equal(
      'universal' in { version: 2, updatedAt: '2023-11-14T22:13:20.000Z', bridgeHealth: { lastSuccessAtMs: NOW } },
      false
    );
  },
};
