import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { ledgerRuntimeSupported } from '../../src/ledger/runtime.js';
const supported = process.platform === 'linux' && ledgerRuntimeSupported();
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
const piHostSupported = nodeMajor >= 24 || (nodeMajor === 22 && nodeMinor >= 18);
import { handshakeFixture, hashClaim } from '../unit/b45-handshake-fixture.js';
import { scopeSnapshot } from '../../src/ledger/call-context.js';
import { validateDelegateConfig } from '../../packages/hud-mcp/src/config.js';
import { DelegationService } from '../../packages/hud-mcp/src/delegation.js';
import { createShippedManagedCapabilityVerifier } from '../../src/core/launch/capability.js';
import { launchPreparedRun, type SupervisorDispatch } from '../../src/core/launch/supervisor.js';
import { readProcess } from '../../src/core/run/process.js';
import type { LaunchProfile } from '../../src/core/types/capabilities.js';

async function until<T>(read: () => T | Promise<T>): Promise<NonNullable<T>> {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value as NonNullable<T>;
    await delay(25);
  }
  throw Error('managed_target_deadline');
}

for (const harness of ['pi', 'claude'] as const)
  test(
    `production default ${harness} target: accepted intent, hud-run, authenticated handshake/report and exact-session resume`,
    {
      timeout: 45000,
      skip:
        !supported || (harness === 'pi' && !piHostSupported)
          ? 'Managed synthetic host needs Linux/ledger runtime; Pi TypeScript host needs Node22.18+/24+'
          : false,
    },
    async (t) => {
      const f = await handshakeFixture();
      const sourceRoot = join(f.root, 'sessions'),
        userHome = join(f.root, 'user-home');
      mkdirSync(sourceRoot);
      mkdirSync(userHome);
      let executable: string;
      const version = harness === 'pi' ? '1.4.0' : '2.1.305';
      if (harness === 'pi') {
        const packageRoot = join(f.root, 'node_modules', '@earendil-works', 'pi-coding-agent');
        mkdirSync(join(packageRoot, 'dist', 'bundle'), { recursive: true });
        executable = join(packageRoot, 'dist', 'bundle', 'cli.js');
        copyFileSync(resolve('tests/fixtures/pi-managed-target-host.mjs'), executable);
        chmodSync(executable, 0o700);
        writeFileSync(
          join(packageRoot, 'package.json'),
          JSON.stringify({
            name: '@earendil-works/pi-coding-agent',
            version,
            type: 'module',
            bin: { pi: 'dist/bundle/cli.js' },
          })
        );
      } else {
        executable = join(f.root, 'claude');
        execFileSync('cc', [
          '-O2',
          '-Wall',
          '-Wextra',
          '-Werror',
          resolve('tests/fixtures/claude-managed-target.c'),
          '-o',
          executable,
        ]);
        writeFileSync(
          join(sourceRoot, '.claude.json'),
          JSON.stringify({
            mcpServers: { hud: { command: process.execPath, args: [resolve('packages/hud-mcp/bin/hud-mcp.mjs')] } },
          })
        );
      }
      const switches =
        harness === 'pi'
          ? ['--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes']
          : ['-p', '--output-format', 'stream-json', '--verbose'];
      const profile: LaunchProfile = {
        name: `${harness}-target`,
        harness,
        source: { root: sourceRoot, label: 'Synthetic managed target' },
        launch: { argv: [executable] },
        headless: { argv: [executable, ...switches] },
        resume: null,
        resumeHeadless: {
          argv: [executable, ...switches, ...(harness === 'claude' ? ['--resume', '{{sessionId}}'] : [])],
        },
        host: { kind: 'none', layout: 'none' },
        env:
          harness === 'claude' ? { SYNTHETIC_CLAUDE_REPO: resolve('.'), SYNTHETIC_CLAUDE_NODE: process.execPath } : {},
        mcpServerName: 'hud',
        claimTransport: 'config_env',
        clientToolTimeoutMs: null,
        responseMarginMs: 1000,
        orphan_policy: 'continue',
        managedShellVerified: false,
        callSource: { kind: harness === 'pi' ? 'pi_extension_v1' : 'claude_pre_tool_use_v1' },
        roles: { worker: { model: 'synthetic-provider/synthetic-model', effort: 'low' } },
      };
      const config = validateDelegateConfig({ version: 1, profiles: [profile] });
      writeFileSync(join(f.root, 'delegate.json'), JSON.stringify(config));
      const brief = join(f.root, 'brief.md');
      writeFileSync(brief, 'Synthetic managed task.');
      const dispatches: SupervisorDispatch[] = [];
      let replaceResumeAtDispatch = false;
      const common = {
        ledger: f.ledger,
        home: f.root,
        config,
        registration: f.parent.registration,
        reader: f.reader,
        env: { HOME: userHome, PATH: process.env.PATH },
        executableIdentity: { path: executable, version },
        hudRunPath: resolve('bin/hud-run'),
        // Trusted synthetic acceptance gate only. Preparers, supervisor, writer, host proof and tools are real.
        capability: { verify: () => ({ ok: true as const, reason: null }) },
        launch: async (...args: Parameters<typeof launchPreparedRun>) => {
          if (replaceResumeAtDispatch) {
            replaceResumeAtDispatch = false;
            const argv = args[0].input.launch.argv!;
            const file = argv[argv.indexOf('--session') + 1];
            writeFileSync(
              file,
              JSON.stringify({ type: 'session', version: 3, id: 'synthetic-replaced-after-acceptance' }) + '\n'
            );
          }
          const dispatched = await launchPreparedRun(...args);
          dispatches.push(dispatched);
          return dispatched;
        },
      };
      const service = new DelegationService(common);
      const source = () => ({
        ok: true as const,
        callId: 'synthetic-' + performance.now(),
        sessionRef: f.parent.ref,
        processKey: f.parent.authority.evidence.processKey,
        evidenceDigest: hashClaim('synthetic'),
        scopePremise: f.ledger.snapshot((tx) =>
          scopeSnapshot(tx, f.ledger.ledgerId, f.parent.authority.evidence.processKey)
        ),
      });
      const args = {
        backend: profile.name,
        role: 'worker',
        brief,
        cwd: f.root,
        mode: 'headless',
        request_key: 'managed-spawn',
      };
      try {
        const denied = new DelegationService({
          ...common,
          capability: createShippedManagedCapabilityVerifier({
            hudRevision: 'synthetic',
            versions: {
              hudRevision: 'synthetic',
              harness: version,
              host: 'none',
              shell: 'none',
              node: process.versions.node,
              platform: process.platform,
              kernel: 'synthetic',
              mcpClient: 'synthetic',
            },
          }),
        });
        try {
          await assert.rejects(denied.invoke(source(), 'delegate_spawn', args), /capability_unverified/);
        } finally {
          await denied.close();
        }
        assert.equal(dispatches.length, 0);
        const accepted = (await service.invoke(source(), 'delegate_spawn', args)) as {
          ok: true;
          runId: string;
          linkId: string;
        };
        assert.equal(accepted.ok, true);
        const replay = (await service.invoke(source(), 'delegate_spawn', args)) as typeof accepted;
        assert.equal(replay.runId, accepted.runId);
        const terminal = async (runId: string) =>
          until(() =>
            f.ledger.snapshot((tx) => tx.get('SELECT state FROM runs WHERE run_id=?', runId)?.state === 'ended')
          );
        await terminal(accepted.runId);
        assert.equal(dispatches.length, 1);
        const output = JSON.parse(readFileSync(join(f.root, 'runs', accepted.runId, 'stdout.log'), 'utf8').trim());
        assert.equal(output.synthetic, true);
        assert.equal(output.report?.ok, true, JSON.stringify(output));
        assert.equal(output.nested?.ok, false);
        assert.equal(output.nested?.code, 'nested_delegation_not_supported');
        assert.equal(
          f.ledger.snapshot((tx) => tx.get('SELECT count(*) AS n FROM runs WHERE harness=?', harness)?.n),
          1
        );
        const firstRef = f.ledger.snapshot(
          (tx) => tx.get('SELECT child_ref FROM links WHERE link_id=?', accepted.linkId)?.child_ref
        );
        assert.ok(firstRef);
        const resumed = (await service.invoke(source(), 'delegate_resume', {
          linkId: accepted.linkId,
          expectedRun: accepted.runId,
          mode: 'headless',
          request_key: 'managed-resume',
          prompt: 'Continue synthetic work',
        })) as typeof accepted;
        assert.equal(resumed.ok, true);
        assert.notEqual(resumed.runId, accepted.runId);
        await terminal(resumed.runId);
        assert.equal(dispatches.length, 2);
        const second = JSON.parse(readFileSync(join(f.root, 'runs', resumed.runId, 'stdout.log'), 'utf8').trim());
        assert.equal(second.resumed, true);
        assert.equal(second.sessionId, output.sessionId);
        assert.equal(
          f.ledger.snapshot((tx) => tx.get('SELECT child_ref FROM links WHERE link_id=?', accepted.linkId)?.child_ref),
          firstRef
        );
        await assert.rejects(
          service.invoke(source(), 'delegate_resume', {
            linkId: accepted.linkId,
            expectedRun: accepted.runId,
            mode: 'headless',
            request_key: 'stale-resume',
          }),
          /stale|expected/
        );
        if (harness === 'pi') {
          // An actual filesystem race after exact resume preparation cannot bind a replacement identity.
          replaceResumeAtDispatch = true;
          const mismatched = (await service.invoke(source(), 'delegate_resume', {
            linkId: accepted.linkId,
            expectedRun: resumed.runId,
            mode: 'headless',
            request_key: 'replaced-resume',
          })) as typeof accepted;
          await until(() => dispatches.length === 3);
          await dispatches[2].completion;
          const receipt = JSON.parse(readFileSync(join(f.root, 'runs', mismatched.runId, 'exit.json'), 'utf8'));
          assert.equal(receipt.coverage, 'scope');
          assert.equal(receipt.scope_check.result, 'gone');
          assert.equal(
            f.ledger.snapshot((tx) => tx.get('SELECT state FROM runs WHERE run_id=?', mismatched.runId)?.state),
            'uncertain'
          );
          const conflict = f.ledger.snapshot(
            (tx) =>
              tx.get("SELECT payload FROM events WHERE run_id=? AND kind='run.conflict'", mismatched.runId)?.payload
          );
          assert.equal(JSON.parse(String(conflict)).cause, 'resume_ref_mismatch');
          assert.equal(dispatches.length, 3);
          assert.match(
            readFileSync(join(f.root, 'runs', mismatched.runId, 'stderr.log'), 'utf8'),
            /resume_ref_mismatch/
          );
          assert.equal(
            f.ledger.snapshot((tx) => tx.get('SELECT count(*) AS n FROM reports WHERE run_id=?', mismatched.runId)?.n),
            0
          );
          assert.equal(
            f.ledger.snapshot(
              (tx) => tx.get('SELECT child_ref FROM links WHERE link_id=?', accepted.linkId)?.child_ref
            ),
            firstRef
          );
        }
        writeFileSync(brief, 'Changed brief');
        await assert.rejects(service.invoke(source(), 'delegate_spawn', args), /idempotency_conflict/);
        assert.equal(dispatches.length, harness === 'pi' ? 3 : 2);
        for (const dispatched of dispatches) {
          await dispatched.completion;
          assert.equal(readProcess(dispatched.pid), null);
        }
        const facts = f.ledger.snapshot((tx) => tx.all('SELECT kind FROM events WHERE link_id=?', accepted.linkId));
        assert.equal(facts.filter((event) => event.kind === 'claim.redeemed').length, 2);
        assert.equal(facts.filter((event) => event.kind === 'report.received').length, 2);
        t.diagnostic(
          JSON.stringify({
            harness,
            synthetic: true,
            dispatches: dispatches.length,
            supervisorsReaped: true,
            productionCapability: 'unverified',
          })
        );
      } finally {
        // Tests only remove their temporary directory after their owned supervisors exit.
        await service.close();
        await Promise.all(dispatches.map((dispatch) => dispatch.completion));
        await f.close();
      }
    }
  );

test(
  'production default Claude target reaches its partial-coverage capability gate without writing support files',
  { skip: !supported },
  async () => {
    const f = await handshakeFixture();
    const root = join(f.root, 'claude-source');
    mkdirSync(root);
    writeFileSync(
      join(root, '.claude.json'),
      JSON.stringify({
        mcpServers: {
          hud: {
            command: process.execPath,
            args: [resolve('packages/hud-mcp/bin/hud-mcp.mjs')],
            env: { SYNTHETIC_KEEP: 'preserved' },
          },
        },
      })
    );
    const brief = join(f.root, 'brief.md');
    writeFileSync(brief, 'Synthetic Claude task');
    const profile: LaunchProfile = {
      name: 'claude-target',
      harness: 'claude',
      source: { root, label: 'Synthetic Claude' },
      launch: { argv: [process.execPath] },
      headless: { argv: [process.execPath, '-p', '--output-format', 'stream-json', '--verbose'] },
      resume: null,
      resumeHeadless: {
        argv: [process.execPath, '-p', '--output-format', 'stream-json', '--verbose', '--resume', '{{sessionId}}'],
      },
      host: { kind: 'none', layout: 'none' },
      env: {},
      mcpServerName: 'hud',
      claimTransport: 'config_env',
      clientToolTimeoutMs: null,
      responseMarginMs: 1000,
      orphan_policy: 'continue',
      managedShellVerified: false,
      callSource: { kind: 'claude_pre_tool_use_v1' },
      roles: { worker: { model: 'synthetic-model' } },
    };
    let launches = 0,
      checked = false;
    const service = new DelegationService({
      ledger: f.ledger,
      home: f.root,
      config: { version: 1, profiles: [profile] },
      registration: f.parent.registration,
      reader: f.reader,
      env: { HOME: f.root, PATH: process.env.PATH },
      executableIdentity: { path: process.execPath, version: '2.1.305' },
      hudRunPath: resolve('bin/hud-run'),
      capability: {
        verify(request) {
          checked = true;
          assert.equal(request.key.harness, 'claude');
          assert.equal(request.configurationCoverage, 'partial');
          return { ok: false, reason: 'capability_unverified' };
        },
      },
      launch: async () => {
        launches++;
        throw Error('must_not_launch');
      },
    });
    try {
      const source = {
        ok: true as const,
        callId: 'claude-capability',
        sessionRef: f.parent.ref,
        processKey: f.parent.authority.evidence.processKey,
        evidenceDigest: hashClaim('synthetic'),
        scopePremise: f.ledger.snapshot((tx) =>
          scopeSnapshot(tx, f.ledger.ledgerId, f.parent.authority.evidence.processKey)
        ),
      };
      await assert.rejects(
        service.invoke(source, 'delegate_spawn', {
          backend: profile.name,
          role: 'worker',
          brief,
          cwd: f.root,
          mode: 'headless',
          request_key: 'claude-refused',
        }),
        /capability_unverified/
      );
      assert.equal(checked, true);
      assert.equal(launches, 0);
      assert.equal(
        f.ledger.snapshot((tx) => tx.get("SELECT count(*) AS n FROM runs WHERE harness='claude'")?.n),
        0
      );
    } finally {
      await service.close();
      await f.close();
    }
  }
);
