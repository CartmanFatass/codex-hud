import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  snapshotBrief,
  MAX_BRIEF_BYTES,
  formatLaunchMessage,
  parseLaunchMessage,
  prepareCodexLaunch,
  createShippedCodexCapabilityVerifier,
  verifyCodexCapability,
  launchPreparedRun,
  SupervisorDispatchError,
  captureLaunchWorkspace,
} from '../../src/core/launch/index.js';
import { digest } from '../../src/core/canonical.js';
import * as TOML from '@iarna/toml';
import { parseFallbackLaunchMessage } from '../../src/harness/claude/reader.js';
import { injectCodexHudEnv } from '../../src/core/capabilities.js';
import { launchDigest } from '../../src/core/run/control.js';
import { RUN_NODE_FLAGS } from '../../src/core/run/runtime.js';
import type {
  CapabilityCell,
  CapabilityVersions,
  LaunchProfile,
  CodexConfig,
} from '../../src/core/types/capabilities.js';
import type { PrepareCodexLaunchOptions } from '../../src/harness/codex/profile.js';

const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const versions: CapabilityVersions = {
  hudRevision: 'synthetic-revision',
  harness: 'synthetic-codex',
  host: 'none',
  shell: 'none',
  node: 'synthetic-node',
  platform: 'synthetic-platform',
  kernel: 'synthetic-kernel',
  mcpClient: 'synthetic-mcp',
};

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'hud-b45-launch-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'codex');
  const cwd = join(root, 'project');
  const hudHome = join(root, 'hud');
  mkdirSync(source);
  mkdirSync(cwd);
  mkdirSync(hudHome, { mode: 0o700 });
  const briefPath = join(root, 'brief.txt');
  const bytes = Buffer.from('Synthetic brief with UTF-8: \u4efb\u52a1\n');
  writeFileSync(briefPath, bytes);
  writeFileSync(
    join(source, 'config.toml'),
    '[mcp_servers.synthetic_hud]\ncommand = "synthetic-hud-mcp"\ntool_timeout_sec = 60\n' +
      '[mcp_servers.synthetic_hud.env]\nUSER_SENTINEL = "preserved"\n'
  );
  const profile: LaunchProfile = {
    name: 'synthetic-codex',
    harness: 'codex',
    source: { root: source, label: 'Synthetic source' },
    launch: { argv: ['synthetic-codex'] },
    headless: { argv: ['synthetic-codex', 'exec', '-'] },
    resume: { argv: ['synthetic-codex', 'resume', '{{sessionId}}'] },
    resumeHeadless: { argv: ['synthetic-codex', 'exec', 'resume', '{{sessionId}}', '-'] },
    host: { kind: 'none', layout: 'none' },
    env: { USER_SENTINEL: 'preserved' },
    mcpServerName: 'synthetic_hud',
    claimTransport: 'config_env',
    clientToolTimeoutMs: 60000,
    responseMarginMs: 2000,
    orphan_policy: 'continue',
    managedShellVerified: false,
    roles: { implementer: { model: 'synthetic-model', effort: 'low' } },
  };
  const options: PrepareCodexLaunchOptions = { profile, operation: 'spawn', mode: 'headless', cwd, briefPath, env: {} };
  const run = { runId: 'synthetic-run-1', linkId: 'synthetic-link', claim: 'synthetic-claim-1', hudHome };
  return { root, source, cwd, hudHome, briefPath, bytes, profile, options, run };
}

function acceptedCell(
  request: ReturnType<Awaited<ReturnType<typeof prepareCodexLaunch>>['capabilityRequest']>
): CapabilityCell {
  return {
    key: request.key,
    support: 'verified',
    versions,
    topology: 'synthetic-direct-stdio',
    sourceId: request.sourceId,
    profileFingerprint: request.profileFingerprint,
    evidence: {
      scope: 'product',
      reviewStatus: 'accepted',
      script: 'synthetic-script',
      report: 'synthetic-report',
      reportSha256: 'a'.repeat(64),
      artifactDigest: 'b'.repeat(64),
      observedAt: 1,
    },
    results: { identity: 'passed', input: 'passed', scope: 'passed', receipt: 'passed', singleSubmission: 'passed' },
    incomplete: [],
  };
}

test('B45 brief captures bounded bytes and owns a copy independent of replacement, deletion and caller mutation', async (t) => {
  const f = fixture(t);
  const captured = await snapshotBrief(f.briefPath);
  const mutable = captured.bytes();
  mutable.fill(0);
  writeFileSync(join(f.root, 'replacement'), 'Synthetic replacement');
  renameSync(join(f.root, 'replacement'), f.briefPath);
  rmSync(f.briefPath);
  assert.deepEqual(captured.bytes(), f.bytes);
  assert.equal(captured.sha256, hash(captured.bytes()));
  assert.equal(captured.byteLength, f.bytes.length);
  writeFileSync(f.briefPath, Buffer.alloc(MAX_BRIEF_BYTES + 1));
  await assert.rejects(snapshotBrief(f.briefPath), /brief_too_large/);
  writeFileSync(f.briefPath, Buffer.alloc(MAX_BRIEF_BYTES));
  assert.equal((await snapshotBrief(f.briefPath)).byteLength, MAX_BRIEF_BYTES);
  await assert.rejects(snapshotBrief(f.briefPath, 10), /brief_too_large/);
  await assert.rejects(snapshotBrief(f.cwd), /brief_not_regular_file/);
});

test('B45 accepted brief segment and delivered suffix use captured bytes with separately reproducible hashes', async (t) => {
  const f = fixture(t);
  const p = await prepareCodexLaunch({ ...f.options, prompt: 'Synthetic follow-up', role: 'implementer' });
  rmSync(f.briefPath);
  const prepared = p.forRun(f.run);
  const delivered = Buffer.from(prepared.payload.briefBase64, 'base64');
  assert.deepEqual(delivered.subarray(0, p.brief.byteLength), f.bytes);
  assert.equal(hash(delivered.subarray(0, p.brief.byteLength)), p.brief.sha256);
  assert.equal(hash(delivered), prepared.deliveredSha256);
  assert.match(delivered.toString('utf8'), /Synthetic follow-up/);
  assert.match(delivered.toString('utf8'), /delegate_whoami/);
  assert.match(delivered.toString('utf8'), /delegate_report.*synthetic-run-1/);
  assert.ok(!delivered.includes(Buffer.from(f.run.claim)));
  assert.ok(!delivered.includes(Buffer.from('[hud-launch]')));
  assert.equal(prepared.launchDigest, launchDigest(prepared.input));
  assert.equal(p.model, 'synthetic-model');
  assert.equal(p.effort, 'low');
  assert.equal(p.promptHash, hash('Synthetic follow-up'));
  assert.equal(prepared.payload.env!.CODEX_HOME, f.source);
  assert.equal(prepared.payload.env!.USER_SENTINEL, 'preserved');
});

test('B45 Codex spawn and resume inject exactly four env leaves and preserve every other user setting', async (t) => {
  const f = fixture(t);
  const config: CodexConfig = {
    model: 'synthetic-user-model',
    mcp_servers: {
      synthetic_hud: {
        command: 'synthetic-hud',
        args: ['--user-arg'],
        env: { USER_KEY: 'kept' },
        tool_timeout_sec: 91,
      },
      another: { command: 'synthetic-other', env: { OTHER: 'kept' } },
    },
  };
  const before = structuredClone(config);
  const spawn = await prepareCodexLaunch({ ...f.options, codexConfig: config });
  const resumed = await prepareCodexLaunch({ ...f.options, operation: 'resume', resumeSessionId: 'synthetic-session' });
  const first = spawn.forRun(f.run);
  const nextRun = { ...f.run, runId: 'synthetic-run-2', claim: 'synthetic-claim-2' };
  const next = resumed.forRun(nextRun);
  for (const prepared of [first, next]) {
    const argv = prepared.input.launch.argv!;
    assert.equal(argv.filter((arg) => arg.startsWith('mcp_servers.')).length, 4);
    assert.ok(argv.some((arg) => arg.includes('.env.HUD_HOME=' + JSON.stringify(f.hudHome))));
    assert.ok(!argv.includes('mcp_servers={}'));
  }
  assert.ok(next.input.launch.argv!.includes('synthetic-session'));
  assert.ok(JSON.stringify(next.input.launch).includes(nextRun.claim));
  assert.ok(!JSON.stringify(next.input.launch).includes(f.run.claim));
  assert.throws(() => resumed.capabilityRequest(), /resume_from_required/);
  assert.equal(resumed.capabilityRequest('headless').key.operation, 'resume');
  const applied = injectCodexHudEnv(config, 'synthetic_hud', {
    HUD_CLAIM: nextRun.claim,
    HUD_RUN: nextRun.runId,
    HUD_LINK: nextRun.linkId,
    HUD_HOME: f.hudHome,
  }).config;
  assert.deepEqual(config, before);
  assert.deepEqual(applied.mcp_servers.another, before.mcp_servers.another);
  assert.deepEqual(applied.mcp_servers.synthetic_hud.args, ['--user-arg']);
  assert.equal(applied.mcp_servers.synthetic_hud.env!.USER_KEY, 'kept');
  assert.equal(applied.mcp_servers.synthetic_hud.tool_timeout_sec, 91);
  const specialClaim = 'synthetic-quote"\\\n\u007f-\u4efb\u52a1';
  const special = spawn.forRun({ ...f.run, claim: specialClaim });
  const claimOverride = special.input.launch.argv!.find((arg) =>
    arg.startsWith('mcp_servers.synthetic_hud.env.HUD_CLAIM=')
  )!;
  const parsed = TOML.parse(claimOverride) as unknown as CodexConfig;
  assert.equal(parsed.mcp_servers.synthetic_hud.env!.HUD_CLAIM, specialClaim);
});

test('B45 explicit launch-message fallback has one shared envelope and checkpoints retain only its fingerprint', async (t) => {
  const f = fixture(t);
  const marker = formatLaunchMessage(f.run);
  assert.deepEqual(JSON.parse(marker.slice('[hud-launch] '.length)), { linkId: f.run.linkId, claim: f.run.claim });
  const anchor = parseLaunchMessage(marker)!;
  assert.deepEqual(anchor, { linkId: f.run.linkId, claimFingerprint: hash(f.run.claim) });
  const observed = parseFallbackLaunchMessage(marker, 'synthetic-native-message', 17);
  assert.equal(observed[0].claimFingerprint, anchor.claimFingerprint);
  assert.ok(!JSON.stringify(observed).includes(f.run.claim));
  assert.equal(parseLaunchMessage('[hud-launch] {"linkId":"x","claim":""}'), null);
  assert.equal(parseLaunchMessage('[hud-launch] invalid'), null);
  assert.equal(parseLaunchMessage('prefix ' + marker), null);
  const p = await prepareCodexLaunch({ ...f.options, profile: { ...f.profile, claimTransport: 'launch_message' } });
  assert.ok(Buffer.from(p.forRun(f.run).payload.briefBase64, 'base64').includes(Buffer.from(marker)));
});

test('B45 visible launch and resume clearly refuse this build without manufacturing capability support', async (t) => {
  const f = fixture(t);
  for (const operation of ['spawn', 'resume'] as const) {
    const p = await prepareCodexLaunch({
      ...f.options,
      operation,
      mode: 'visible',
      ...(operation === 'resume' ? { resumeSessionId: 'synthetic-session' } : {}),
    });
    assert.throws(() => p.forRun(f.run), /visible_launch_not_in_this_build/);
    const request = p.capabilityRequest(operation === 'resume' ? 'headless' : undefined);
    assert.equal(verifyCodexCapability(request, acceptedCell(request), versions).ok, false);
  }
});

test('B45 preparation captures source/cwd/config and rejects mismatched source, server, placeholders and excessive input', async (t) => {
  const f = fixture(t);
  await assert.rejects(prepareCodexLaunch({ ...f.options, env: { CODEX_HOME: f.cwd } }), /codex_source_mismatch/);
  await assert.rejects(
    prepareCodexLaunch({ ...f.options, profile: { ...f.profile, mcpServerName: 'quoted.server' } }),
    /invalid_mcp_server/
  );
  await assert.rejects(
    prepareCodexLaunch({ ...f.options, codexConfig: { mcp_servers: {} } }),
    /hud_stdio_server_unavailable/
  );
  await assert.rejects(prepareCodexLaunch({ ...f.options, prompt: 'x'.repeat(65_537) }), /prompt_too_large/);
  await assert.rejects(prepareCodexLaunch({ ...f.options, operation: 'resume' }), /resume_session_required/);
  await assert.rejects(
    prepareCodexLaunch({
      ...f.options,
      profile: { ...f.profile, headless: { argv: ['synthetic-codex', '{{missing}}'] } },
    }),
    /undeclared_launch_placeholder/
  );
  const options = { ...f.options };
  const p = await prepareCodexLaunch(options);
  options.mode = 'visible';
  options.profile.headless!.argv![0] = 'changed-after-preparation';
  const prepared = p.forRun(f.run);
  assert.equal(prepared.input.mode, 'headless');
  assert.equal(prepared.input.launch.argv![0], 'synthetic-codex');
  assert.equal(prepared.input.cwd, f.cwd);
});

test('B45 model and effort use explicit configuration and fingerprints invalidate changed server command', async (t) => {
  const f = fixture(t);
  const codexConfig: CodexConfig = {
    model: 'synthetic-configured-model',
    model_reasoning_effort: 'synthetic-effort',
    mcp_servers: { synthetic_hud: { command: 'synthetic-command', env: { API_KEY: 'synthetic-secret' } } },
  };
  const p = await prepareCodexLaunch({ ...f.options, role: 'unmapped-role', codexConfig });
  assert.equal(p.model, 'synthetic-configured-model');
  assert.equal(p.effort, 'synthetic-effort');
  const changed = structuredClone(codexConfig);
  changed.mcp_servers.synthetic_hud.command = 'changed-synthetic-command';
  const q = await prepareCodexLaunch({ ...f.options, role: 'unmapped-role', codexConfig: changed });
  assert.notEqual(p.configFingerprint, q.configFingerprint);
  assert.notEqual(p.commandFingerprint, q.commandFingerprint);
  assert.notEqual(p.capabilityRequest().profileFingerprint, q.capabilityRequest().profileFingerprint);
  assert.equal(p.profileDigest, q.profileDigest);
  await assert.rejects(prepareCodexLaunch({ ...f.options, role: 'unmapped-role' }), /role_model_unconfigured/);
});

test('B45 production capability evidence is revision/version/key/source/profile bound and empty shipped cells stay unverified', async (t) => {
  const f = fixture(t);
  const p = await prepareCodexLaunch({
    ...f.options,
    profile: { ...f.profile, headless: { argv: [process.execPath, 'exec', '-'] } },
    executableIdentity: { path: process.execPath, version: versions.harness },
  });
  const request = p.capabilityRequest();
  const cell = acceptedCell(request);
  assert.deepEqual(verifyCodexCapability(request, cell, versions), { ok: true, reason: null });
  assert.equal(
    verifyCodexCapability({ ...request, executableIdentity: { path: null, version: null } }, cell, versions).ok,
    false
  );
  assert.equal(verifyCodexCapability(request, { ...cell, sourceId: 'f'.repeat(64) }, versions).ok, false);
  assert.equal(verifyCodexCapability(request, { ...cell, evidence: null }, versions).ok, false);
  assert.equal(verifyCodexCapability(request, { ...cell, profileFingerprint: 'f'.repeat(64) }, versions).ok, false);
  assert.equal(verifyCodexCapability(request, cell, { ...versions, harness: 'changed' }).ok, false);
  assert.equal(
    createShippedCodexCapabilityVerifier({ hudRevision: versions.hudRevision, versions }).verify(request).ok,
    false
  );
  const cellFile = join(f.root, 'synthetic-cells.json');
  writeFileSync(cellFile, JSON.stringify({ version: 1, hudRevision: versions.hudRevision, cells: [cell] }));
  const verifier = createShippedCodexCapabilityVerifier({ hudRevision: versions.hudRevision, versions, cellFile });
  assert.equal(verifier.verify(request).ok, true);
  assert.equal(
    createShippedCodexCapabilityVerifier({ hudRevision: 'different', versions, cellFile }).verify(request).ok,
    false
  );
  writeFileSync(cellFile, JSON.stringify({ version: 1, hudRevision: versions.hudRevision, cells: [cell, cell] }));
  assert.equal(
    createShippedCodexCapabilityVerifier({ hudRevision: versions.hudRevision, versions, cellFile }).verify(request).ok,
    false
  );
});

test('B45 supervisor launch uses optimized Node argv and a private stdin payload without ticket or claim in supervisor argv', async (t) => {
  const f = fixture(t);
  const p = await prepareCodexLaunch(f.options);
  const prepared = p.forRun(f.run);
  const output = join(f.root, 'supervisor-observation.json');
  const executable = join(f.root, 'synthetic-hud-run.mjs');
  writeFileSync(
    executable,
    `import {writeFileSync} from 'node:fs';\nconst chunks=[]; for await(const c of process.stdin) chunks.push(c); writeFileSync(${JSON.stringify(output)},JSON.stringify({argv:process.argv,execArgv:process.execArgv,payload:JSON.parse(Buffer.concat(chunks).toString())}));`
  );
  const result = await launchPreparedRun(prepared, 'synthetic-private-ticket', { hudRunPath: executable });
  assert.ok(result.pid > 0);
  // launchPreparedRun unrefs the detached supervisor by design, so while this test waits for its
  // exit nothing in this process holds the event loop open; Node 22's test runner then cancels
  // the test and every later one in the file, and Node 24's would wait forever if it never exits.
  // A rejecting timer bounds the wait on both: the synthetic supervisor exits in well under 1 s.
  let deadline: NodeJS.Timeout | undefined;
  try {
    const timedOut = new Promise<never>((_, reject) => {
      deadline = setTimeout(() => reject(new Error('supervisor did not exit within 10 s')), 10_000);
    });
    assert.deepEqual(await Promise.race([result.completion, timedOut]), { code: 0, signal: null });
  } finally {
    clearTimeout(deadline);
  }
  const seen = JSON.parse(readFileSync(output, 'utf8'));
  assert.equal(seen.argv[0], process.execPath);
  assert.deepEqual(seen.execArgv, [...RUN_NODE_FLAGS]);
  assert.equal(seen.argv.at(-1), 'start');
  assert.ok(!JSON.stringify(seen.argv).includes(f.run.claim));
  assert.ok(!JSON.stringify(seen.argv).includes('synthetic-private-ticket'));
  assert.equal(seen.payload.ticket, 'synthetic-private-ticket');
  assert.equal(seen.payload.input.runId, f.run.runId);
  assert.equal(seen.payload.briefBase64, prepared.payload.briefBase64);
});

test('B45 supervisor dispatch failure is bounded and never retries or rewrites a run state', async (t) => {
  const f = fixture(t);
  const p = await prepareCodexLaunch(f.options);
  const prepared = p.forRun(f.run);
  rmSync(f.cwd, { recursive: true });
  await assert.rejects(launchPreparedRun(prepared, 'synthetic-ticket'), (error: unknown) => {
    assert.ok(error instanceof SupervisorDispatchError);
    assert.equal(error.submission, 'not_submitted');
    return true;
  });
});

test('B45 one post-acceptance workspace capture uses canonical common-dir identity or records bounded missing evidence', async (t) => {
  const f = fixture(t);
  const common = join(f.root, 'synthetic-common-dir');
  mkdirSync(common);
  const git = join(f.root, 'synthetic-git');
  writeFileSync(git, `#!/bin/sh\nprintf '%s\\n' '${f.cwd}' '${common}'\n`);
  chmodSync(git, 0o700);
  const captured = await captureLaunchWorkspace(f.cwd, { cwdAsOf: 10, gitPath: git });
  assert.equal(captured.worktreeRoot, f.cwd);
  assert.equal(captured.gitCommonDir, common);
  assert.equal(captured.repoId, digest(['git-common-dir-v1', common]));
  assert.equal(captured.gitMissingReason, null);
  assert.equal(captured.cwdSource, 'launch_cwd');
  assert.equal(captured.cwdAsOf, 10);
  assert.ok(captured.gitCapturedAt! > 0);
  writeFileSync(git, '#!/bin/sh\nprintf "fatal: not a git repository\\n" >&2\nexit 128\n');
  assert.equal((await captureLaunchWorkspace(f.cwd, { cwdAsOf: 11, gitPath: git })).gitMissingReason, 'not_git');
  writeFileSync(git, '#!/bin/sh\nwhile :; do :; done\n');
  const timedOut = await captureLaunchWorkspace(f.cwd, { cwdAsOf: 12, gitPath: git });
  assert.equal(timedOut.gitMissingReason, 'timeout');
  assert.equal(timedOut.repoId, null);
  assert.ok(timedOut.gitCapturedAt! > 0);
  await assert.rejects(captureLaunchWorkspace(f.cwd, { cwdAsOf: 13, timeoutMs: 21 }), /invalid_workspace_budget/);
});

test('B45 preserved MCP environment values invalidate intent and capability fingerprints', async (t) => {
  const f = fixture(t);
  const config: CodexConfig = {
    mcp_servers: {
      synthetic_hud: {
        command: 'synthetic-command',
        env: {
          HUD_MCP_PROFILE: 'profile-a',
          NODE_OPTIONS: '--synthetic-option-a',
          HUD_CLAIM: 'per-run-a',
          HUD_RUN: 'run-a',
          HUD_LINK: 'link-a',
          HUD_HOME: '/synthetic/home-a',
        },
      },
    },
  };
  const first = await prepareCodexLaunch({ ...f.options, codexConfig: config });
  for (const [key, value] of [
    ['HUD_MCP_PROFILE', 'profile-b'],
    ['NODE_OPTIONS', '--synthetic-option-b'],
  ]) {
    const changed = structuredClone(config);
    changed.mcp_servers.synthetic_hud.env![key] = value;
    const next = await prepareCodexLaunch({ ...f.options, codexConfig: changed });
    assert.notEqual(first.configFingerprint, next.configFingerprint);
    assert.notEqual(first.commandFingerprint, next.commandFingerprint);
    assert.notDeepEqual(first.capabilityRequest(), next.capabilityRequest());
  }
  const rotated = structuredClone(config);
  Object.assign(rotated.mcp_servers.synthetic_hud.env!, {
    HUD_CLAIM: 'per-run-b',
    HUD_RUN: 'run-b',
    HUD_LINK: 'link-b',
    HUD_HOME: '/synthetic/home-b',
  });
  const next = await prepareCodexLaunch({ ...f.options, codexConfig: rotated });
  assert.equal(first.configFingerprint, next.configFingerprint);
  assert.equal(first.commandFingerprint, next.commandFingerprint);
  assert.deepEqual(first.capabilityRequest(), next.capabilityRequest());
  assert.equal(JSON.stringify(first.capabilityRequest()).includes('profile-a'), false);
});

test('B45 capability template has typed per-run sentinels while execution keeps actual values', async (t) => {
  const f = fixture(t),
    otherCwd = join(f.root, 'other-cwd'),
    otherHome = join(f.root, 'other-hud'),
    otherBrief = join(f.root, 'other-brief.txt');
  mkdirSync(otherCwd);
  mkdirSync(otherHome, { mode: 0o700 });
  writeFileSync(otherBrief, 'Different synthetic brief bytes');
  const profile = {
    ...f.profile,
    resumeHeadless: { argv: ['synthetic-codex', 'exec', 'resume', '{{sessionId}}', '--cd', '{{cwd}}', '-'] },
  };
  const first = await prepareCodexLaunch({
    ...f.options,
    profile,
    operation: 'resume',
    role: 'implementer',
    resumeSessionId: 'synthetic-session-a',
    prompt: 'Prompt A',
  });
  const second = await prepareCodexLaunch({
    ...f.options,
    profile,
    operation: 'resume',
    role: 'implementer',
    resumeSessionId: 'synthetic-session-b',
    cwd: otherCwd,
    briefPath: otherBrief,
    prompt: 'Prompt B',
  });
  assert.deepEqual(first.capabilityRequest('headless'), second.capabilityRequest('headless'));
  assert.notEqual(first.commandFingerprint, second.commandFingerprint);
  assert.notEqual(first.promptHash, second.promptHash);
  assert.notEqual(first.brief.sha256, second.brief.sha256);
  const a = first.forRun(f.run),
    b = second.forRun({
      ...f.run,
      runId: 'synthetic-run-2',
      linkId: 'synthetic-link-2',
      claim: 'different-synthetic-claim',
      hudHome: otherHome,
    });
  assert.notEqual(a.launchDigest, b.launchDigest);
  assert.equal(a.input.cwd, f.cwd);
  assert.equal(b.input.cwd, otherCwd);
  for (const change of [
    { model: 'different-model' },
    { effort: 'different-effort' },
    {
      profile: {
        ...profile,
        resumeHeadless: { argv: ['different-executable', 'exec', 'resume', '{{sessionId}}', '--cd', '{{cwd}}', '-'] },
      },
    },
    {
      profile: {
        ...profile,
        resumeHeadless: {
          argv: ['synthetic-codex', 'exec', 'resume', '{{sessionId}}', '--different-flag', '--cd', '{{cwd}}', '-'],
        },
      },
    },
  ]) {
    const altered = await prepareCodexLaunch({
      ...f.options,
      profile,
      operation: 'resume',
      role: 'implementer',
      resumeSessionId: 'synthetic-session-a',
      prompt: 'Prompt A',
      ...change,
    });
    assert.notEqual(
      first.capabilityRequest('headless').profileFingerprint,
      altered.capabilityRequest('headless').profileFingerprint
    );
  }
  const config: CodexConfig = {
    mcp_servers: { other_server: { command: 'synthetic-hud-mcp', env: { USER_SENTINEL: 'preserved' } } },
  };
  const renamed = await prepareCodexLaunch({
    ...f.options,
    profile: { ...profile, mcpServerName: 'other_server' },
    codexConfig: config,
    operation: 'resume',
    role: 'implementer',
    resumeSessionId: 'synthetic-session-a',
    prompt: 'Prompt A',
  });
  assert.notEqual(
    first.capabilityRequest('headless').profileFingerprint,
    renamed.capabilityRequest('headless').profileFingerprint
  );
});
test('B45 trusted executable version and resolved file identity are part of the capability profile', async (t) => {
  const f = fixture(t),
    profile = { ...f.profile, headless: { argv: [process.execPath, 'exec', '-'] } };
  const a = await prepareCodexLaunch({
    ...f.options,
    profile,
    executableIdentity: { path: process.execPath, version: 'synthetic-version-a' },
  });
  const b = await prepareCodexLaunch({
    ...f.options,
    profile,
    executableIdentity: { path: process.execPath, version: 'synthetic-version-b' },
  });
  assert.notEqual(a.capabilityRequest().profileFingerprint, b.capabilityRequest().profileFingerprint);
  await assert.rejects(
    prepareCodexLaunch({
      ...f.options,
      profile,
      executableIdentity: { path: '/synthetic/wrong-executable', version: 'synthetic-version-a' },
    }),
    /executable_identity_mismatch|ENOENT/
  );
});

test('B45 every preserved MCP server setting participates in configuration and capability fingerprints', async (t) => {
  const f = fixture(t);
  const config: CodexConfig = {
    mcp_servers: {
      synthetic_hud: {
        command: 'node',
        args: ['./synthetic-hud-mcp.mjs'],
        cwd: '/synthetic/a',
        env_vars: ['SYNTHETIC_A'],
        enabled_tools: ['delegate_whoami'],
        env: { USER_SENTINEL: 'preserved' },
      },
    },
  };
  const first = await prepareCodexLaunch({ ...f.options, codexConfig: config });
  for (const change of [
    { cwd: '/synthetic/b' },
    { env_vars: ['SYNTHETIC_B'] },
    { enabled_tools: ['delegate_whoami', 'delegate_report'] },
    { other_preserved_setting: 'synthetic-change' },
  ]) {
    const changed = structuredClone(config);
    Object.assign(changed.mcp_servers.synthetic_hud, change);
    const next = await prepareCodexLaunch({ ...f.options, codexConfig: changed });
    assert.notEqual(first.configFingerprint, next.configFingerprint);
    assert.notEqual(first.commandFingerprint, next.commandFingerprint);
    assert.notDeepEqual(first.capabilityRequest(), next.capabilityRequest());
  }
});
