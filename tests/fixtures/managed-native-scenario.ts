// SIMULATED historical DelegationService composition, constructor-only package fixture.
// Not the default native-session MCP path. Legacy scope evidence is composed explicitly here.
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { discoverExecutable } from '../../src/cli/capability.js';
import { validateDelegateConfig } from '../../packages/hud-mcp/src/config.js';
import { LinuxProcessReader } from '../../packages/hud-mcp/src/process.js';
import { registerCaller } from '../../packages/hud-mcp/src/registry.js';
import { createLedgerCallerRegistry } from '../../packages/hud-mcp/src/ledger-registry.js';
import { ManagedNativeRuntime, createManagedNativeRuntime } from '../../packages/hud-mcp/src/managed-runtime.js';
import { SessionRefResolver } from '../../packages/hud-mcp/src/resolvers.js';
import { DelegationService } from '../../packages/hud-mcp/src/delegation.js';
import { makeProcessKey } from '../../src/core/identity.js';
import { ReadOnlyScopeSnapshot } from '../../src/core/ledger-scope-read.js';
import { openLedger } from '../../src/ledger/ledger.js';
import { prepareCodexLaunch } from '../../src/harness/codex/profile.js';
import { launchPreparedRun, type SupervisorDispatch } from '../../src/core/launch/supervisor.js';
import { readProcess } from '../../src/core/run/process.js';
import { RUNTIME_CAPABILITY_FILES } from '../../src/core/runtime-build.js';
import { syntheticBuild, sealSyntheticBuild } from './managed-native-build.js';
import type { CapabilityExpectation } from '../../src/core/capability-manifest.js';
import type { CapabilityCell, LaunchProfile } from '../../src/core/types/capabilities.js';

export function simulatedCell(expected: CapabilityExpectation): CapabilityCell {
  return {
    ...structuredClone(expected),
    support: 'verified',
    evidence: {
      script: 'SIMULATED',
      report: 'SIMULATED',
      reportSha256: 'a'.repeat(64),
      artifactDigest: 'b'.repeat(64),
      observedAt: 1,
      reviewStatus: 'accepted',
      scope: 'product',
    },
    results: { identity: 'passed', input: 'passed', scope: 'passed', receipt: 'passed', singleSubmission: 'passed' },
    incomplete: [],
  };
}
function session(root: string) {
  const hex = Date.now().toString(16).padStart(12, '0');
  const id = `${hex.slice(0, 8)}-${hex.slice(8)}-7000-8000-000000000000`;
  const date = new Date();
  const directory = join(
    root,
    'sessions',
    String(date.getUTCFullYear()),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0')
  );
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(directory, `rollout-simulated-${id}.jsonl`),
    JSON.stringify({ type: 'session_meta', payload: { id, source: 'exec', cli_version: '0.166.0' } }) + '\n',
    { mode: 0o600 }
  );
  return id;
}
async function until<T>(fn: () => T | Promise<T>) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await delay(20);
  }
  throw Error('SIMULATED_owned_scope_deadline');
}
export async function scenario(root: string, integration: boolean, parentMismatch = false, targetMismatch = false) {
  const source = join(root, 'source'),
    targetSource = join(root, 'target-source'),
    home = join(root, 'hud'),
    buildRoot = join(root, 'build');
  for (const dir of [source, targetSource, home]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  syntheticBuild(buildRoot);
  const executable = join(root, 'codex');
  const base: LaunchProfile = {
    name: 'native-parent',
    harness: 'codex',
    source: { root: source, label: 'SIMULATED parent' },
    launch: { argv: [executable] },
    headless: null,
    resume: null,
    resumeHeadless: null,
    host: { kind: 'none', layout: 'none' },
    env: {},
    mcpServerName: 'hud',
    claimTransport: 'config_env',
    clientToolTimeoutMs: null,
    responseMarginMs: 1000,
    orphan_policy: 'continue',
    managedShellVerified: false,
    roles: { worker: { model: 'SIMULATED-model', effort: 'low' } },
  };
  const targetExecutable = existsSync(join(root, 'target-bin', 'codex'))
    ? join(root, 'target-bin', 'codex')
    : executable;
  const target: LaunchProfile = {
    ...base,
    name: 'native-target',
    source: { root: targetSource, label: 'SIMULATED target' },
    headless: { argv: [targetExecutable, 'exec', '-'] },
    resumeHeadless: { argv: [targetExecutable, 'exec', 'resume', '{{sessionId}}', '-'] },
    env: {
      SYNTHETIC_NATIVE_REPO: resolve('.'),
      SYNTHETIC_NATIVE_NODE: process.execPath,
      SYNTHETIC_NATIVE_DRIVER: resolve('tests/fixtures/managed-native-target.mjs'),
    },
  };
  const config = validateDelegateConfig({ version: 1, profiles: [base, target] });
  const selected = config.profiles[0],
    profile = config.profiles[1];
  writeFileSync(join(home, 'delegate.json'), JSON.stringify(config), { mode: 0o600 });
  writeFileSync(join(targetSource, 'config.toml'), '[mcp_servers.hud]\ncommand = "SIMULATED-hud-mcp"\n', {
    mode: 0o600,
  });
  const brief = join(root, 'brief.md');
  writeFileSync(brief, 'SIMULATED task.\n', { mode: 0o600 });
  const initial = await openLedger(join(home, 'ledger.sqlite'));
  await initial.close();
  const reader = new LinuxProcessReader();
  const registry = await createLedgerCallerRegistry(home);
  const registration = await registerCaller({
    reader,
    registry,
    profile: selected,
    pid: process.pid,
    cwd: () => process.cwd(),
    envPane: null,
    nowMs: Date.now(),
  });
  assert.equal(registration.harnessPid, process.ppid);
  assert.equal(registration.source?.rootPath, source);
  const env = {
    ...process.env,
    HUD_CLAIM: undefined,
    HUD_RUN: undefined,
    HUD_LINK: undefined,
    HUD_HOME: home,
    CODEX_HOME: undefined,
    PI_SESSION_ID: 'SIMULATED-stale',
    PI_CODING_AGENT_SESSION_DIR: 'SIMULATED-stale',
    SYNTHETIC_NATIVE_PROBE_LOG: join(root, 'probe-receipts.jsonl'),
  };
  const probeReceipts = () =>
    readFileSync(join(root, 'probe-receipts.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => {
        const receipt = JSON.parse(line);
        const alive = readProcess(receipt.pid)?.stamp.proc_start === receipt.procStart;
        assert.equal(alive, false);
        return { ...receipt, observedEndedAt: Date.now(), alive };
      });
  const input = { registration, reader, config, selected, env };
  const observed = await new ManagedNativeRuntime(buildRoot).observe(input);
  if (parentMismatch) {
    assert.equal(observed.startup.parentObserved, false);
    assert.equal(
      observed.launchExecutableIdentities.get(JSON.stringify([profile.name, 'spawn', 'headless']))?.version,
      '0.166.0'
    );
    await registry.ledger.close();
    return { synthetic: true, mode: 'parent-version-mismatch', startup: observed.startup, dispatches: 0, receipts: [] };
  }
  assert.equal(observed.startup.parentObserved, true);
  assert.equal(observed.startup.bootstrapObserved, true);
  assert.equal(observed.startup.probes, 2); // parent and separately observed target; spawn/resume share target probe.
  const prepare = async (operation: 'spawn' | 'resume') =>
    prepareCodexLaunch({
      profile,
      operation,
      mode: 'headless',
      cwd: root,
      briefPath: brief,
      role: 'worker',
      env,
      ...(operation === 'resume' ? { resumeSessionId: '00000000-0000-7000-8000-000000000001' } : {}),
      executableIdentity: observed.launchExecutableIdentities.get(
        JSON.stringify([profile.name, operation, 'headless'])
      ),
    });
  const spawnPrepared = await prepare('spawn'),
    resumePrepared = await prepare('resume');
  const request = spawnPrepared.capabilityRequest(),
    resumeRequest = resumePrepared.capabilityRequest('headless');
  const expected = observed.expectation(request);
  if (targetMismatch) {
    assert.equal(request.executableIdentity.version, '0.165.0');
    assert.equal(expected, null);
    assert.equal(observed.capability.verify(request).ok, false);
    await registry.ledger.close();
    return {
      synthetic: true,
      mode: 'target-version-mismatch',
      startup: observed.startup,
      probes: probeReceipts(),
      dispatches: 0,
      receipts: [],
    };
  }
  assert.ok(expected);
  assert.equal(observed.capability.verify(request).ok, false);
  const cells = [simulatedCell(expected), simulatedCell(observed.expectation(resumeRequest)!)];
  for (const path of RUNTIME_CAPABILITY_FILES)
    writeFileSync(
      join(buildRoot, path),
      JSON.stringify({ version: 1, hudRevision: expected.versions.hudRevision, cells })
    );
  sealSyntheticBuild(buildRoot);
  const runtime = await new ManagedNativeRuntime(buildRoot).observe(input);
  assert.equal(runtime.capability.verify(request).ok, true);
  assert.equal(runtime.capability.verify(resumeRequest).ok, true);
  const sourceCheckout = await createManagedNativeRuntime(input);
  assert.equal(sourceCheckout.capability.verify(request).ok, false);
  assert.equal(sourceCheckout.startup.buildId, null);
  // Request dimensions cannot borrow the original exact reviewed cell.
  for (const changed of [
    { ...request, sourceId: 'f'.repeat(64) },
    { ...request, profileFingerprint: 'e'.repeat(64) },
    { ...request, configurationCoverage: 'partial' as const },
    { ...request, executableIdentity: { path: '/other', version: '0.166.0' } },
    { ...request, executableIdentity: { ...request.executableIdentity, version: '0.165.0' } },
    ...Object.entries({
      harness: 'pi',
      profileDigest: 'd'.repeat(64),
      hostKind: 'tmux',
      layout: 'pane',
      mode: 'visible',
      operation: 'launch',
    }).map(([key, value]) => ({ ...request, key: { ...request.key, [key]: value } })),
    { ...resumeRequest, key: { ...resumeRequest.key, resumeFrom: 'visible' as const } },
  ])
    assert.equal(runtime.capability.verify(changed as typeof request).ok, false);
  // Forged config/env version/manifest cannot fill missing observations.
  const forged = await new ManagedNativeRuntime(join(root, 'missing')).observe({
    ...input,
    env: { ...env, HUD_RUNTIME_MANIFEST: buildRoot, HUD_CODEX_VERSION: '0.166.0', MCP_CLIENT_VERSION: '0.166.0' },
  });
  assert.equal(forged.capability.verify(request).ok, false);
  for (const mutation of ['pid', 'source', 'domain', 'departed', 'indirect'] as const) {
    let calls = 0;
    const badReader = {
      domain: () => ({ ...reader.domain(), ...(mutation === 'domain' && calls > 2 ? { bootId: 'changed' } : {}) }),
      get: (pid: number) => {
        const p = reader.get(pid);
        calls++;
        if (pid === registration.harnessPid && calls > 2) {
          if (mutation === 'pid') p.procStart = 'reused';
          if (mutation === 'source') p.env.CODEX_HOME = targetSource;
          if (mutation === 'departed') throw Error('owned_parent_departed');
        }
        if (mutation === 'indirect' && pid === process.pid) p.ppid = 1;
        return p;
      },
    };
    const bad = await new ManagedNativeRuntime(buildRoot).observe({ ...input, reader: badReader });
    assert.equal(bad.capability.verify(request).ok, false, mutation);
  }
  // Same-version replacement at the same target path still changes the real
  // preparer's executable fingerprint, so the prior exact cell cannot be reused.
  const originalTarget = `${targetExecutable}.original`;
  renameSync(targetExecutable, originalTarget);
  try {
    copyFileSync(originalTarget, targetExecutable);
    const replacement = await discoverExecutable(profile.headless!, { ...env, ...profile.env });
    assert.equal(replacement.version, '0.166.0');
    const replacedRequest = (await prepare('spawn')).capabilityRequest();
    assert.notEqual(replacedRequest.profileFingerprint, request.profileFingerprint);
    const replacedRuntime = await new ManagedNativeRuntime(buildRoot).observe(input);
    assert.equal(replacedRuntime.startup.parentObserved, true);
    assert.equal(replacedRuntime.capability.verify(replacedRequest).ok, false);
  } finally {
    rmSync(targetExecutable);
    renameSync(originalTarget, targetExecutable);
  }
  // Different selected parent configuration cannot reuse the old parent's cell.
  const changedConfig = structuredClone(config);
  changedConfig.profiles[0].env.SIMULATED_PROFILE_CHANGE = 'changed';
  const changedParent = await new ManagedNativeRuntime(buildRoot).observe({
    ...input,
    config: changedConfig,
    selected: changedConfig.profiles[0],
  });
  assert.equal(changedParent.startup.parentObserved, true);
  assert.equal(changedParent.capability.verify(request).ok, false);
  // No target discovery fact is fabricated for a missing native binary or shell template.
  for (const shell of [false, true]) {
    const changed = structuredClone(config);
    changed.profiles[1].headless = shell
      ? { shell: 'never execute this text', shellPath: '/bin/sh' }
      : { argv: [join(root, 'missing-codex')] };
    changed.profiles[1].resumeHeadless = null;
    const unknown = await new ManagedNativeRuntime(buildRoot).observe({
      ...input,
      config: changed,
      selected: changed.profiles[0],
    });
    assert.equal(unknown.launchExecutableIdentities.size, 0);
    assert.equal(unknown.capability.verify(request).ok, false);
  }
  // Constructor-only paths are observed, never executed or supplied through production input.
  const helperRoot = join(root, 'helpers');
  mkdirSync(helperRoot, { mode: 0o700 });
  const helpers: [string, string, string] = ['env', 'mkfifo', 'sh'].map((name) => join(helperRoot, name)) as [
    string,
    string,
    string,
  ];
  for (const path of helpers) writeFileSync(path, 'SIMULATED helper bytes', { mode: 0o600 });
  const originalHelpers = [...helpers] as [string, string, string];
  const helperConstructor = new ManagedNativeRuntime(buildRoot, helpers);
  helpers[0] = join(root, 'missing-helper');
  const helperA = await helperConstructor.observe(input);
  assert.equal(helperA.startup.bootstrapObserved, true);
  const helperCell = simulatedCell(helperA.expectation(request)!);
  for (const path of RUNTIME_CAPABILITY_FILES)
    writeFileSync(
      join(buildRoot, path),
      JSON.stringify({ version: 1, hudRevision: expected.versions.hudRevision, cells: [helperCell] })
    );
  sealSyntheticBuild(buildRoot);
  const helperAccepted = await new ManagedNativeRuntime(buildRoot, originalHelpers).observe(input);
  assert.equal(helperAccepted.capability.verify(request).ok, true);
  writeFileSync(originalHelpers[0], 'SIMULATED changed helper bytes');
  const helperB = await new ManagedNativeRuntime(buildRoot, originalHelpers).observe(input);
  assert.equal(helperB.startup.bootstrapObserved, true);
  assert.equal(helperB.capability.verify(request).ok, false);
  rmSync(originalHelpers[0]);
  assert.equal(
    (await new ManagedNativeRuntime(buildRoot, originalHelpers).observe(input)).startup.bootstrapObserved,
    false
  );
  writeFileSync(originalHelpers[0], Buffer.alloc(2 * 1024 * 1024 + 1), { mode: 0o600 });
  assert.equal(
    (await new ManagedNativeRuntime(buildRoot, originalHelpers).observe(input)).startup.bootstrapObserved,
    false
  );
  assert.throws(() => new ManagedNativeRuntime(undefined, originalHelpers), /invalid_synthetic_bootstrap_paths/);
  assert.throws(
    () => new ManagedNativeRuntime(buildRoot, ['relative', '/a', '/b']),
    /invalid_synthetic_bootstrap_paths/
  );
  const noOverride = await createManagedNativeRuntime({
    ...input,
    ...{ runtimeRoot: buildRoot, bootstrapPaths: originalHelpers },
  });
  assert.equal(noOverride.startup.buildId, null);
  for (const path of RUNTIME_CAPABILITY_FILES)
    writeFileSync(
      join(buildRoot, path),
      JSON.stringify({ version: 1, hudRevision: expected.versions.hudRevision, cells })
    );
  sealSyntheticBuild(buildRoot);
  const dispatches: SupervisorDispatch[] = [];
  const receipts: unknown[] = [];
  let service: DelegationService | undefined;
  try {
    if (integration) {
      const sessionId = session(source);
      const resolver = new SessionRefResolver(registration, reader, selected);
      const scopes = new ReadOnlyScopeSnapshot(join(home, 'ledger.sqlite'));
      assert.ok(registration.source && registration.harnessPid && registration.harnessProcStart);
      const legacyProcessKey = makeProcessKey(
        selected.harness,
        registration.source.sourceId,
        reader.domain().pidDomain,
        registration.harnessPid,
        registration.harnessProcStart
      );
      let sequence = 0;
      const sourceCall = async () => {
        // Only this historical service fixture requires HUD generation evidence.
        const scopePremise = scopes.read(legacyProcessKey);
        const result = await resolver.resolve(
          {
            callId: `SIMULATED-${++sequence}`,
            sessionId,
            threadId: sessionId,
            'x-codex-turn-metadata': {
              session_id: sessionId,
              thread_id: sessionId,
              thread_source: 'user',
              turn_trigger: 'exec',
              codex_version: '0.166.0',
            },
          },
          'delegate_spawn'
        );
        assert.ok(result.ok, JSON.stringify(result));
        assert.equal(result.scopePremise, undefined, 'native resolver never reads the legacy database');
        assert.equal(result.processKey, legacyProcessKey);
        return { ...result, scopePremise };
      };
      const common = {
        ledger: registry.ledger,
        home,
        config,
        registration,
        reader,
        env,
        hudRunPath: resolve('bin/hud-run'),
        launchExecutableIdentities: runtime.launchExecutableIdentities,
        launch: async (...args: Parameters<typeof launchPreparedRun>) => {
          const d = await launchPreparedRun(...args);
          dispatches.push(d);
          receipts.push({ pid: d.pid, start: readProcess(d.pid)?.stamp, deadlineAt: Date.now() + 12000 });
          return d;
        },
      };
      service = new DelegationService({ ...common, capability: runtime.capability });
      const denied = new DelegationService({ ...common, capability: observed.capability });
      const args = {
        backend: profile.name,
        role: 'worker',
        brief,
        cwd: root,
        mode: 'headless',
        request_key: 'SIMULATED-spawn',
      };
      const counts = () =>
        registry.ledger.snapshot((tx) =>
          ['runs', 'claims', 'slots'].map((table) => tx.get(`SELECT count(*) AS n FROM ${table}`)?.n)
        );
      const brokenRoot = join(root, 'broken-build');
      syntheticBuild(brokenRoot);
      writeFileSync(join(brokenRoot, RUNTIME_CAPABILITY_FILES[3]), '{malformed');
      const brokenRuntime = await new ManagedNativeRuntime(brokenRoot).observe(input);
      const before = counts();
      for (const unavailable of [sourceCheckout, brokenRuntime]) {
        const unavailableService = new DelegationService({ ...common, capability: unavailable.capability });
        try {
          await assert.rejects(
            unavailableService.invoke(await sourceCall(), 'delegate_spawn', args),
            /capability_unverified/
          );
          assert.deepEqual(counts(), before);
          assert.equal(dispatches.length, 0);
          assert.ok(await unavailableService.invoke(await sourceCall(), 'delegate_list', {}));
        } finally {
          await unavailableService.close();
        }
      }
      await assert.rejects(denied.invoke(await sourceCall(), 'delegate_spawn', args), /capability_unverified/);
      assert.deepEqual(counts(), before);
      assert.equal(dispatches.length, 0);
      const list = await denied.invoke(await sourceCall(), 'delegate_list', {});
      assert.ok(list);
      const accepted = (await service.invoke(await sourceCall(), 'delegate_spawn', args)) as {
        ok: boolean;
        runId: string;
        linkId: string;
      };
      assert.equal(accepted.ok, true);
      const replay = (await denied.invoke(await sourceCall(), 'delegate_spawn', args)) as typeof accepted;
      assert.equal(replay.runId, accepted.runId);
      assert.ok(await denied.invoke(await sourceCall(), 'delegate_status', { runId: accepted.runId }));
      await denied.close();
      const terminal = async (runId: string) =>
        until(() =>
          registry.ledger.snapshot((tx) => tx.get('SELECT state FROM runs WHERE run_id=?', runId)?.state === 'ended')
        );
      await terminal(accepted.runId);
      assert.equal(dispatches.length, 1);
      const output = JSON.parse(readFileSync(join(home, 'runs', accepted.runId, 'stdout.log'), 'utf8').trim());
      assert.equal(output.report.ok, true);
      const original = registry.ledger.snapshot(
        (tx) => tx.get('SELECT child_ref FROM links WHERE link_id=?', accepted.linkId)?.child_ref
      );
      const resumed = (await service.invoke(await sourceCall(), 'delegate_resume', {
        linkId: accepted.linkId,
        mode: 'headless',
        request_key: 'SIMULATED-resume',
        prompt: 'SIMULATED second turn',
      })) as typeof accepted;
      assert.equal(resumed.ok, true);
      await terminal(resumed.runId);
      assert.equal(dispatches.length, 2);
      const second = JSON.parse(readFileSync(join(home, 'runs', resumed.runId, 'stdout.log'), 'utf8').trim());
      assert.equal(second.report.ok, true);
      assert.equal(second.sessionId, output.sessionId);
      assert.equal(second.resumed, true);
      assert.equal(
        registry.ledger.snapshot(
          (tx) => tx.get('SELECT target_session_ref FROM runs WHERE run_id=?', resumed.runId)?.target_session_ref
        ),
        original
      );
      for (const d of dispatches) {
        let timer: NodeJS.Timeout | undefined;
        try {
          const end = await Promise.race([
            d.completion,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(Error('owned_supervisor_deadline')), 12000);
            }),
          ]);
          receipts.push({ pid: d.pid, end, alive: readProcess(d.pid) !== null });
        } finally {
          clearTimeout(timer);
        }
      }
      assert.equal(
        registry.ledger.snapshot((tx) => tx.get('SELECT count(*) AS n FROM slots')?.n),
        0
      );
    }
    return {
      synthetic: true,
      mode: integration ? 'integration' : 'unit',
      startup: runtime.startup,
      firstStartup: observed.startup,
      probes: probeReceipts(),
      parent: { pid: process.ppid, start: readProcess(process.ppid)?.stamp },
      dispatches: dispatches.length,
      receipts,
    };
  } finally {
    await service?.close();
    await registry.ledger.close();
  }
}
if (process.argv[2] === '--scenario') {
  scenario(
    process.argv[3],
    process.argv[4] === 'integration',
    process.argv[4] === 'parent-mismatch',
    process.argv[4] === 'target-mismatch'
  )
    .then((value) => process.stdout.write(JSON.stringify(value) + '\n'))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
