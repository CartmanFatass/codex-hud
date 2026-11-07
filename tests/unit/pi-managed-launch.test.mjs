/** Synthetic preparation + real owned hud-run process tests. No account/provider or production capability claim. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  promises as fsp,
  renameSync,
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { preparePiLaunch, PI_MANAGED_EXTENSION } from '../../dist/harness/pi/managed-launch.js';
import { launchDigest } from '../../dist/core/run/control.js';
import { launchPreparedRun } from '../../dist/core/launch/supervisor.js';
import { FileRunFactPort } from '../../dist/core/run/fake-port.js';
import { RunArtifacts } from '../../dist/core/run/artifacts.js';
import { createShippedCodexCapabilityVerifier, verifyManagedCapability } from '../../dist/core/launch/capability.js';
import { seedRun } from '../../dist-test/tests/run/fixtures.js';
import { ledgerRuntimeSupported } from '../../dist/ledger/runtime.js';

const managedProcessSkip =
  process.platform !== 'linux'
    ? 'Pi managed process scope requires Linux'
    : !ledgerRuntimeSupported()
      ? 'hud-run requires Node 22.x >=22.13 or Node >=24'
      : false;
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
const officialPiSkip =
  managedProcessSkip ||
  (nodeMajor === 22 && nodeMinor < 19 ? 'Official Pi 1.4 package requires Node 22.19+' : false) ||
  (!process.env.HUD_PI_OFFICIAL_PACKAGE ? 'Official Pi package not selected' : false);

const switches = ['--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes'];
const hash = (value) => createHash('sha256').update(value).digest('hex');
const id = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
function session(file, sessionId = id, more = {}) {
  writeFileSync(
    file,
    JSON.stringify({
      type: 'session',
      version: 3,
      id: sessionId,
      timestamp: '2026-11-05T00:00:00.000Z',
      cwd: '/synthetic/project',
      ...more,
    }) + '\n'
  );
}
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hud-pi-managed-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home'),
    source = join(root, 'sessions'),
    cwd = join(root, 'project'),
    hudHome = join(root, 'hud');
  for (const path of [home, source, cwd, hudHome]) mkdirSync(path, { mode: 0o700 });
  const briefPath = join(root, 'brief.md');
  writeFileSync(briefPath, 'Synthetic brief: \u4efb\u52a1; $(never-execute)\n');
  // Explicit format also works when CI places TMPDIR beneath this ESM package.
  const executable = join(root, 'pi.cjs');
  writeFileSync(executable, '#!/bin/sh\nexit 0\n');
  chmodSync(executable, 0o700);
  const profile = {
    name: 'synthetic-pi',
    harness: 'pi',
    source: { root: source, label: 'Synthetic Pi source' },
    launch: { argv: [executable] },
    headless: { argv: [executable, ...switches] },
    resume: null,
    resumeHeadless: { argv: [executable, ...switches, '--session', '{{sessionId}}'] },
    host: { kind: 'none', layout: 'none' },
    env: {},
    mcpServerName: 'hud',
    claimTransport: 'config_env',
    clientToolTimeoutMs: null,
    responseMarginMs: 1000,
    orphan_policy: 'continue',
    managedShellVerified: false,
    callSource: { kind: 'pi_extension_v1' },
    roles: { implementer: { model: 'synthetic/model', effort: 'high' } },
  };
  const options = {
    profile,
    operation: 'spawn',
    mode: 'headless',
    cwd,
    briefPath,
    role: 'implementer',
    env: { HOME: home, PATH: process.env.PATH, PI_CODING_AGENT_DIR: join(home, '.pi', 'agent') },
    executableIdentity: { path: executable, version: '1.4.0' },
  };
  const run = { runId: 'synthetic-run', linkId: 'synthetic-link', claim: 'synthetic-claim', hudHome };
  return { root, home, source, cwd, hudHome, briefPath, executable, profile, options, run };
}

test('Pi managed spawn uses persisted print/json with explicitly selected discovery, role and shipped extension', async (t) => {
  const f = fixture(t),
    before = structuredClone(f.options);
  const p = await preparePiLaunch(f.options),
    prepared = p.forRun(f.run),
    argv = prepared.input.launch.argv;
  assert.deepEqual(f.options, before);
  assert.deepEqual(argv, [
    f.executable,
    '--session-dir',
    f.source,
    '--mode',
    'json',
    '--print',
    ...switches,
    '-e',
    PI_MANAGED_EXTENSION,
    '--model',
    'synthetic/model',
    '--thinking',
    'high',
  ]);
  assert.equal(argv.includes('--no-session'), false);
  assert.equal(argv.includes('--session'), false);
  assert.equal(argv.includes('--session-id'), false);
  assert.equal(p.harness, 'pi');
  assert.equal(p.model, 'synthetic/model');
  assert.equal(p.effort, 'high');
  assert.equal(p.capabilityRequest().key.harness, 'pi');
  assert.equal(p.capabilityRequest().executableIdentity.version, '1.4.0');
  assert.equal(prepared.launchDigest, launchDigest(prepared.input));
});

test('Pi managed MCP emitted layout fingerprints the installed extension closure, not missing sibling bridge files', async (t) => {
  const f = fixture(t);
  const packaged = await import('../../packages/hud-mcp/dist/src/harness/pi/managed-launch.js');
  assert.equal(packaged.PI_MANAGED_EXTENSION, PI_MANAGED_EXTENSION);
  const preparation = await packaged.preparePiLaunch(f.options);
  assert.equal(preparation.harness, 'pi');
  assert.equal(preparation.capabilityRequest().configurationCoverage, 'partial');
  const argv = preparation.forRun(f.run).input.launch.argv;
  assert.equal(argv[argv.indexOf('-e') + 1], PI_MANAGED_EXTENSION);
});

test('Pi managed delivery freezes literal bytes, adds whoami/report role instructions and refreshes only authority', async (t) => {
  const f = fixture(t);
  const stale = {
    HUD_RUN: 'old',
    HUD_LINK: 'old',
    HUD_CLAIM: 'old-secret',
    HUD_HOME: '/old',
    HUD_MCP_PROFILE: 'wrong',
    HUD_PI_DELEGATION_FD: '8',
    HUD_MCP_REGISTRY_DIR: '/old',
    HUD_RUN_PORT_MODULE: '/old',
    PI_SESSION_ID: 'old',
    PI_SESSION_FILE: '/old',
    PI_CODING_AGENT_SESSION_DIR: '/old',
  };
  const p = await preparePiLaunch({
    ...f.options,
    env: { ...f.options.env, ...stale, SYNTHETIC_KEEP: 'kept' },
    prompt: 'Follow-up; $literal',
  });
  const original = readFileSync(f.briefPath);
  rmSync(f.briefPath);
  const prepared = p.forRun(f.run),
    content = Buffer.from(prepared.payload.briefBase64, 'base64');
  assert.deepEqual(content.subarray(0, original.length), original);
  assert.match(content.toString(), /Follow-up; \$literal/);
  assert.match(content.toString(), /delegate_whoami/);
  assert.match(content.toString(), /delegate_report.*synthetic-run/);
  assert.equal(content.includes(Buffer.from(f.run.claim)), false);
  assert.equal(hash(content), prepared.deliveredSha256);
  const env = prepared.payload.env;
  assert.equal(env.HUD_MCP_PROFILE, f.profile.name);
  assert.equal(env.HUD_RUN, f.run.runId);
  assert.equal(env.HUD_LINK, f.run.linkId);
  assert.equal(env.HUD_CLAIM, f.run.claim);
  assert.equal(env.HUD_HOME, f.hudHome);
  for (const key of Object.keys(stale).filter(
    (key) => !['HUD_MCP_PROFILE', 'HUD_RUN', 'HUD_LINK', 'HUD_CLAIM', 'HUD_HOME'].includes(key)
  ))
    assert.equal(env[key], undefined, key);
  assert.equal(env.SYNTHETIC_KEEP, 'kept');
  assert.equal(env.HOME, f.home);
  assert.equal(prepared.input.retire.role, 'implementer');
  const second = p.forRun({ ...f.run, runId: 'next-run', claim: 'next-claim' });
  assert.equal(second.payload.env.HUD_CLAIM, 'next-claim');
  assert.equal(prepared.payload.env.HUD_CLAIM, f.run.claim);
  prepared.input.launch.argv[0] = '/mutated';
  assert.equal(p.forRun(f.run).input.launch.argv[0], f.executable);
});

test('Pi resume selects exactly one existing canonical native header and uses the exact file, never fuzzy ID', async (t) => {
  const f = fixture(t),
    file = join(f.source, 'arbitrary-name.jsonl');
  session(file);
  session(join(f.source, 'other.jsonl'), otherId);
  const p = await preparePiLaunch({ ...f.options, operation: 'resume', resumeSessionId: id });
  assert.throws(() => p.capabilityRequest(), /resume_from_required/);
  assert.equal(p.capabilityRequest('headless').key.resumeFrom, 'headless');
  const argv = p.forRun(f.run).input.launch.argv;
  assert.equal(argv[argv.indexOf('--session') + 1], file);
  assert.equal(argv.includes(id), false);
  assert.equal(argv.includes('--session-id'), false);
  assert.equal(argv.includes('--fork'), false);
});

test('Pi resume refuses missing/empty/replaced/ambiguous sessions rather than allowing native creation', async (t) => {
  const f = fixture(t),
    file = join(f.source, 'target.jsonl');
  const options = { ...f.options, operation: 'resume', resumeSessionId: id };
  await assert.rejects(preparePiLaunch(options), /pi_resume_session_unavailable/);
  writeFileSync(file, '');
  await assert.rejects(preparePiLaunch(options), /pi_resume_session_unavailable/);
  session(file, otherId);
  await assert.rejects(preparePiLaunch(options), /pi_resume_session_unavailable/);
  for (const version of [2, 3, 99]) {
    session(file, id, { version });
    const prepared = await preparePiLaunch(options);
    const argv = prepared.forRun(f.run).input.launch.argv;
    assert.equal(argv[argv.indexOf('--session') + 1], file);
  }
  writeFileSync(file, JSON.stringify({ type: 'tool_result', id }) + '\n');
  await assert.rejects(preparePiLaunch(options), /pi_resume_session_unavailable/);
  writeFileSync(file, JSON.stringify({ type: 'session', version: 3 }) + '\n');
  await assert.rejects(preparePiLaunch(options), /pi_resume_session_unavailable/);
  session(file);
  session(join(f.source, 'duplicate.jsonl'));
  await assert.rejects(preparePiLaunch(options), /ambiguous_pi_resume_session/);
});

test('Pi exact-ID disk discovery rejects replacement during read but permits transcript append', async (t) => {
  for (const kind of ['replace', 'append']) {
    const f = fixture(t),
      file = join(f.source, 'selected.jsonl');
    session(file);
    const originalOpen = fsp.open;
    let injected = false;
    fsp.open = async function (name, ...args) {
      const handle = await originalOpen.call(this, name, ...args);
      if (name === file && !injected) {
        const read = handle.read.bind(handle);
        handle.read = async (...readArgs) => {
          if (!injected) {
            injected = true;
            if (kind === 'replace') {
              renameSync(file, join(f.root, 'old-session.jsonl'));
              session(file, otherId);
            } else appendFileSync(file, JSON.stringify({ type: 'message', message: { role: 'assistant' } }) + '\n');
          }
          return read(...readArgs);
        };
      }
      return handle;
    };
    try {
      const options = { ...f.options, operation: 'resume', resumeSessionId: id };
      if (kind === 'replace') await assert.rejects(preparePiLaunch(options), /pi_resume_session_unavailable/);
      else {
        const argv = (await preparePiLaunch(options)).forRun(f.run).input.launch.argv;
        assert.equal(argv[argv.indexOf('--session') + 1], file);
      }
      assert.equal(injected, true);
    } finally {
      fsp.open = originalOpen;
    }
  }
});

test('Pi resume rejects path escapes, symlinks, partial IDs and oversized headers', async (t) => {
  const f = fixture(t),
    outside = join(f.root, 'outside.jsonl');
  session(outside);
  symlinkSync(outside, join(f.source, 'alias.jsonl'));
  const options = { ...f.options, operation: 'resume', resumeSessionId: id };
  await assert.rejects(preparePiLaunch(options), /pi_resume_session_unavailable/);
  session(join(f.source, 'target.jsonl'));
  await assert.rejects(preparePiLaunch({ ...options, resumeSessionId: '11111111' }), /pi_resume_session_unavailable/);
  await assert.rejects(preparePiLaunch({ ...options, resumeSessionId: '../target' }), /invalid_pi_resume_session/);
  writeFileSync(
    join(f.source, 'target.jsonl'),
    JSON.stringify({ type: 'session', version: 3, id, padding: 'x'.repeat(65536) }) + '\n'
  );
  await assert.rejects(preparePiLaunch(options), /pi_resume_session_unavailable/);
});

test('Pi managed profile refuses unsupported selectors, duplicates, prompts, shell and implicit discovery changes', async (t) => {
  const f = fixture(t);
  for (const tail of [
    ['--no-session'],
    ['--session-id', id],
    ['--continue'],
    ['--resume'],
    ['--fork', id],
    ['--mode', 'rpc'],
    ['--session-dir', '/other'],
    ['--model', 'wrong'],
    ['--thinking', 'low'],
    ['--session', '/other'],
    ['--tools', 'read'],
    ['--', 'prompt'],
    ['positional'],
    ['@private-file'],
    ['--no-skills'],
    ['--session-dir=' + f.source],
    ['--extension', '/other'],
  ]) {
    const profile = { ...f.profile, headless: { argv: [f.executable, ...switches, ...tail] } };
    await assert.rejects(
      preparePiLaunch({ ...f.options, profile }),
      /unsupported_pi_managed_arguments|duplicate_pi_managed_flag/,
      JSON.stringify(tail)
    );
  }
  await assert.rejects(
    preparePiLaunch({ ...f.options, profile: { ...f.profile, headless: { argv: [f.executable] } } }),
    /pi_managed_discovery_profile_required/
  );
  await assert.rejects(
    preparePiLaunch({ ...f.options, profile: { ...f.profile, headless: { shell: 'pi', shellPath: '/bin/sh' } } }),
    /pi_managed_shell_unsupported/
  );
});

test('Pi managed role mapping, mode and extension checks do not gate vendor versions', async (t) => {
  const f = fixture(t);
  await assert.rejects(preparePiLaunch({ ...f.options, role: 'unmapped' }), /role_model_unconfigured/);
  await assert.rejects(preparePiLaunch({ ...f.options, effort: 'ultra' }), /unsupported_pi_thinking/);
  await assert.rejects(preparePiLaunch({ ...f.options, mode: 'visible' }), /visible_launch_not_in_this_build/);
  for (const version of ['0.73.1', '1.4.0', '99.123.456']) {
    const prepared = await preparePiLaunch({ ...f.options, executableIdentity: { path: f.executable, version } });
    assert.equal(prepared.capabilityRequest().executableIdentity.version, version);
    assert.equal(prepared.forRun(f.run).input.launch.argv[0], f.executable);
  }
  await assert.rejects(
    preparePiLaunch({ ...f.options, profile: { ...f.profile, callSource: undefined } }),
    /pi_managed_extension_required/
  );
  await assert.rejects(
    preparePiLaunch({ ...f.options, profile: { ...f.profile, claimTransport: 'launch_message' } }),
    /pi_managed_extension_required/
  );
  await assert.rejects(preparePiLaunch({ ...f.options, resumeSessionId: id }), /unexpected_resume_session/);
  await assert.rejects(preparePiLaunch({ ...f.options, operation: 'resume' }), /resume_session_required/);
  await assert.rejects(preparePiLaunch({ ...f.options, prompt: 'x'.repeat(65537) }), /prompt_too_large/);
  const p = await preparePiLaunch({ ...f.options, model: 'override/model', effort: 'max' });
  assert.equal(p.model, 'override/model');
  assert.equal(p.effort, 'max');
});

test('Pi capability binds fixed configuration and executable, while fresh run identities do not change it', async (t) => {
  const f = fixture(t),
    base = await preparePiLaunch(f.options);
  const request = base.capabilityRequest();
  assert.equal(request.configurationCoverage, 'partial');
  assert.deepEqual(verifyManagedCapability(request, null, {}), { ok: false, reason: 'capability_unverified' });
  base.forRun(f.run);
  base.forRun({ ...f.run, claim: 'new', runId: 'new-run' });
  assert.deepEqual(base.capabilityRequest(), request);
  const agent = f.options.env.PI_CODING_AGENT_DIR;
  mkdirSync(agent, { recursive: true });
  writeFileSync(join(agent, 'settings.json'), '{"synthetic":true}');
  const changed = await preparePiLaunch(f.options);
  assert.notEqual(changed.configFingerprint, base.configFingerprint);
  assert.notEqual(changed.capabilityRequest().profileFingerprint, request.profileFingerprint);
  const model = await preparePiLaunch({ ...f.options, model: 'other/model' });
  assert.notEqual(model.capabilityRequest().profileFingerprint, changed.capabilityRequest().profileFingerprint);
  // Existing production verifier cannot promote this Pi preparation, even with a resolved executable.
  assert.equal(
    createShippedCodexCapabilityVerifier({ hudRevision: 'synthetic', versions: {} }).verify(request).ok,
    false
  );
});

test('Pi resume discovery has a finite header budget', async (t) => {
  const f = fixture(t);
  for (let n = 0; n < 65; n++) session(join(f.source, `unrelated-${n}.jsonl`), otherId);
  await assert.rejects(
    preparePiLaunch({ ...f.options, operation: 'resume', resumeSessionId: id }),
    /pi_resume_header_limit/
  );
});

test(
  'optional installed Pi 1.4 parser and native persisted SessionManager accept prepared spawn/resume without a model',
  { skip: officialPiSkip },
  async (t) => {
    const pkg = realpathSync(process.env.HUD_PI_OFFICIAL_PACKAGE);
    const manifest = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'));
    assert.equal(manifest.name, '@earendil-works/pi-coding-agent');
    assert.equal(manifest.version, '1.4.0');
    const { parseArgs } = await import(pathToFileURL(join(pkg, 'dist/cli/args.js')).href);
    const { SessionManager } = await import(pathToFileURL(join(pkg, 'dist/core/session-manager.js')).href);
    const f = fixture(t),
      spawn = await preparePiLaunch(f.options);
    const args = parseArgs(spawn.forRun(f.run).input.launch.argv.slice(1));
    assert.deepEqual(args.diagnostics, []);
    assert.equal(args.mode, 'json');
    assert.equal(args.print, true);
    assert.deepEqual(args.extensions, [PI_MANAGED_EXTENSION]);
    assert.equal(args.noExtensions, true);
    assert.deepEqual(args.messages, []);
    assert.equal(args.noSession, undefined);
    assert.equal(args.session, undefined);
    const manager = SessionManager.create(f.cwd, f.source);
    manager.appendMessage({ role: 'user', content: 'Synthetic no-model persistence check.', timestamp: 0 });
    const exactId = manager.getSessionId(),
      file = manager.getSessionFile();
    assert.ok(file);
    assert.equal(JSON.parse(readFileSync(file, 'utf8').split('\n')[0]).id, exactId);
    const resume = await preparePiLaunch({ ...f.options, operation: 'resume', resumeSessionId: exactId });
    const resumedArgs = parseArgs(resume.forRun(f.run).input.launch.argv.slice(1));
    assert.deepEqual(resumedArgs.diagnostics, []);
    assert.equal(resumedArgs.session, file);
    assert.equal(SessionManager.open(resumedArgs.session, f.source).getSessionId(), exactId);
  }
);

test(
  'Pi managed preparation runs once through real hud-run, protected stdin and group receipt (synthetic vendor)',
  { timeout: 20000, skip: managedProcessSkip },
  async (t) => {
    const f = fixture(t);
    // A finite fake Pi executable accepts the exact production command and persists
    // one synthetic session. It does not impersonate MCP handshake/report evidence.
    writeFileSync(
      f.executable,
      `#!${process.execPath}\n` +
        `const fs=require('node:fs'),path=require('node:path');const argv=process.argv.slice(2);let chunks=[];` +
        `process.stdin.on('data',b=>chunks.push(b));process.stdin.on('end',()=>{` +
        `const root=argv[argv.indexOf('--session-dir')+1];const selected=argv.indexOf('--session');` +
        `const file=selected<0?path.join(root,'synthetic_${id}.jsonl'):argv[selected+1];` +
        `if(selected<0)fs.writeFileSync(file,JSON.stringify({type:'session',version:3,id:'${id}',cwd:process.cwd()})+'\\n');` +
        `const header=JSON.parse(fs.readFileSync(file,'utf8').split('\\n')[0]);` +
        `const record={argv,stdin:Buffer.concat(chunks).toString(),id:header.id,run:process.env.HUD_RUN,profile:process.env.HUD_MCP_PROFILE};` +
        `fs.appendFileSync(path.join(root,'launches.jsonl'),JSON.stringify(record)+'\\n');` +
        `setTimeout(()=>process.stdout.write(JSON.stringify({type:'synthetic_done',id:header.id})+'\\n'),120);});\n`
    );
    chmodSync(f.executable, 0o700);
    async function execute(operation) {
      const p = await preparePiLaunch({
        ...f.options,
        operation,
        ...(operation === 'resume' ? { resumeSessionId: id } : {}),
      });
      const data = seedRun(f.cwd, []),
        run = { ...f.run, runId: data.input.runId };
      const prepared = p.forRun(run);
      const diagnose = (error) => {
        let stderr;
        try {
          stderr = RunArtifacts.open(f.hudHome, run.runId).readLog('stderr', 0, 16384).data.toString();
        } catch (readError) {
          stderr = `unavailable: ${readError.message}`;
        }
        // Capture the bounded synthetic diagnostic in the test log before the
        // fixture cleanup removes its private temporary run directory.
        t.diagnostic(JSON.stringify({ operation, runId: run.runId, stderr }));
        throw error;
      };
      Object.assign(data.seed.snapshot.run, { sourceId: prepared.input.sourceId, launchDigest: prepared.launchDigest });
      const facts = join(f.hudHome, 'facts.json');
      writeFileSync(facts, JSON.stringify(data.seed), { mode: 0o600 });
      const port = new FileRunFactPort(facts);
      const launched = await launchPreparedRun(prepared, data.ticket, {
        hudRunPath: resolve('bin/hud-run'),
        env: { HOME: f.home, HUD_RUN_PORT_MODULE: resolve('tests/run/file-port.mjs') },
      });
      let timer;
      try {
        const completion = await Promise.race([
          launched.completion,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(Error('synthetic_managed_process_timeout')), 8000);
          }),
        ]);
        assert.equal(completion.code, 0);
      } catch (error) {
        diagnose(error);
      } finally {
        clearTimeout(timer);
        // Scope retirement is the production supervisor's job; only this exact
        // test-owned supervisor PID is touched if it has failed to terminate.
        const state = await port.read(run.runId);
        if (!['ended', 'failed', 'cancelled', 'launch_failed'].includes(state.run.state)) {
          try {
            process.kill(launched.pid, 'SIGTERM');
          } catch (e) {
            if (e.code !== 'ESRCH') throw e;
          }
        }
      }
      try {
        const state = await port.read(run.runId);
        assert.equal(state.run.state, 'ended');
        assert.equal(state.slotHeld, false);
        assert.equal(state.events.filter((e) => e.kind === 'supervisor.registered').length, 1);
        assert.equal(state.events.filter((e) => e.kind === 'launch.sealed').length, 1);
        assert.ok(state.receipt);
        assert.equal(state.run.targetSessionRef, null, 'synthetic process does not manufacture a managed binding');
        // Scope termination and supervisor exit are not workload-success proof.
        // Verify actual output, input consumption and persisted identity now,
        // before a subsequent resume can hide the original command failure.
        const stdout = RunArtifacts.open(f.hudHome, run.runId).readLog('stdout', 0, 65536).data;
        assert.equal(stdout.toString(), JSON.stringify({ type: 'synthetic_done', id }) + '\n');
        const file = join(f.source, `synthetic_${id}.jsonl`);
        assert.equal(realpathSync(file), file);
        const header = readFileSync(file);
        assert.equal(header.indexOf(10), header.length - 1, 'session header must be framed by an actual LF');
        assert.deepEqual(JSON.parse(header.toString()), { type: 'session', version: 3, id, cwd: f.cwd });
        const launchBytes = readFileSync(join(f.source, 'launches.jsonl'));
        assert.equal(launchBytes.at(-1), 10, 'launch records must end with an actual LF');
        const records = launchBytes.toString().trimEnd().split('\n').map(JSON.parse);
        assert.equal(records.length, operation === 'spawn' ? 1 : 2);
        assert.deepEqual(records.at(-1), {
          argv: prepared.input.launch.argv.slice(1),
          stdin: Buffer.from(prepared.payload.briefBase64, 'base64').toString(),
          id,
          run: run.runId,
          profile: f.profile.name,
        });
      } catch (error) {
        diagnose(error);
      }
      return { run, prepared };
    }
    const first = await execute('spawn'),
      second = await execute('resume');
    const launches = readFileSync(join(f.source, 'launches.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(launches.length, 2);
    assert.deepEqual(
      launches.map((x) => x.id),
      [id, id]
    );
    assert.notEqual(first.run.runId, second.run.runId);
    for (const [index, result] of [first, second].entries()) {
      assert.equal(launches[index].stdin, Buffer.from(result.prepared.payload.briefBase64, 'base64').toString());
      assert.equal(launches[index].run, result.run.runId);
      assert.equal(launches[index].profile, f.profile.name);
    }
  }
);
