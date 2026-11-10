/** Explicit negative controls: npm run build:test, then node tests/pi-owned-mutations.mjs.
 * Mutates private COPIES of built code only; never edits/rebuilds the tree under a running suite.
 */
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const repo = resolve(import.meta.dirname, '..');
const mutants = [
  {
    name: 'retained-release-strict-again',
    suite: 'runtime-install.test.mjs',
    sourceSuite: true,
    copyScripts: true,
    copyDist: true,
    pattern: '^retained prior inventory survives',
    edits: [
      [
        '../../../../scripts/runtime-package/installer.mjs',
        'const installed = verifyBundle(`${directory.root}/releases/${name}`, { required: false });',
        'const installed = verifyBundle(`${directory.root}/releases/${name}`);',
      ],
    ],
    witness: /missing_required_entry/,
  },
  {
    name: 'facade-path-dispatch-restored',
    suite: 'pi-dispatch-facade.test.js',
    pattern: '^PR4 cutover:',
    edits: [
      [
        '../facade.js',
        'const outcome = await launchOwned(context, {',
        "const outcome = await (async () => { await (await import('./herdr-run.js')).runCommand('pi-dispatch', [], ctx.env); return launchOwned(context, {",
      ],
      [
        '../facade.js',
        "associationPath: join(ctx.home, 'assoc', `${receipt.job}.json`),\n        });",
        "associationPath: join(ctx.home, 'assoc', `${receipt.job}.json`),\n        }); })();",
      ],
    ],
    witness: /true !== false/,
  },
  {
    name: 'mutate-legacy-receipt',
    suite: 'pi-dispatch-facade.test.js',
    pattern: '^PR4 legacy receipts',
    edits: [
      [
        '../facade.js',
        "if (metadata.contract_version !== 2)\n        return fail('legacy_owner_required', { job: receipt.job });",
        "if (metadata.contract_version !== 2) { metadata.launch = 'sent'; remember(ctx.home, receipt); return fail('legacy_owner_required', { job: receipt.job }); }",
      ],
    ],
    witness: /legacy receipt must remain byte-identical/,
  },
  {
    name: 'missing-owner-current-fallback',
    suite: 'pi-dispatch-facade.test.js',
    pattern: '^PR4 missing pinned release',
    edits: [
      [
        '../facade.js',
        'const release = await facadeRelease(ctx.piOwned?.releaseRoot, dispatch.release);',
        'const release = await facadeRelease(ctx.piOwned?.releaseRoot); dispatch.release = {id:release.id,root:release.root};',
      ],
    ],
    witness: /pi_owned_owner_unavailable/,
  },
  {
    name: 'waiter-execution-import',
    suite: 'role-wait.test.js',
    pattern: '^wait module transitive import graph',
    copyDist: true,
    edits: [
      [
        '../../../../dist/roles/job-wait.js',
        "import * as fs from 'node:fs';",
        "import * as fs from 'node:fs';\nimport './pi-owned/launch.js';",
      ],
    ],
    witness: /waiter imports an execution module/,
  },
  {
    name: 'env-only-endpoint',
    suite: 'pi-dispatch-facade.test.js',
    pattern: '^PR4 production acquisition: env-only endpoint',
    edits: [
      [
        'facade-context.js',
        "if (!server || !socket || !socket.startsWith('/') || /[\\0\\r\\n]/.test(socket))",
        "if (!socket || !socket.startsWith('/') || /[\\0\\r\\n]/.test(socket))",
      ],
    ],
    witness: /Missing expected rejection/,
  },
  {
    name: 'intent-after-effect',
    pattern: '^owned launch: intent',
    edits: [
      [
        'runtime.js',
        "            j.steps[key] = { state: 'intent' };\n            this.writeJournal(j);\n            j.steps[key] = { state: 'sent' };\n            this.writeJournal(j);\n            const out = await this.call(argv, cap);",
        "            const out = await this.call(argv, cap);\n            j.steps[key] = { state: 'sent' };\n            this.writeJournal(j);",
      ],
    ],
    witness: /launch_unknown/,
  },
  {
    name: 'repeat-lost-enter',
    pattern: '^owned crash matrix: lost enter reply before',
    // Remove all independent guards: explicit Enter state, effect journal and
    // the newly required post-Enter native session persistence corroboration.
    edits: [
      [
        'runtime.js',
        "const beforePrompt = !j.steps.prompt || j.steps.prompt.state === 'intent';",
        'const beforePrompt = true;',
      ],
      [
        'prompt.js',
        "    if (journal.steps.enter?.state === 'sent' || journal.steps.enter?.state === 'acked')\n        throw new ExecutionError('launch_unknown');",
        '',
      ],
      [
        'runtime.js',
        "            if (step?.state === 'sent')\n                throw new ExecutionError('launch_unknown');",
        "            if (step?.state === 'sent' && key !== 'enter')\n                throw new ExecutionError('launch_unknown');",
      ],
    ],
    witness: /enter must not be repeated/,
  },
  {
    name: 'drop-session-pane-ownership',
    pattern: '^ownership: stale SESSION',
    edits: [
      [
        'runtime.js',
        '    matches(agent, owner, j) {',
        '    matches(agent, owner, j) {\n        return record(agent); // MUTANT: ignore exact pane/session\n',
      ],
    ],
    witness: /session/,
  },
  {
    name: 'agent-end-settlement',
    suite: 'pi-owned-worker.test.js',
    pattern: '^worker adapter subscribes settlement',
    edits: [['../../harness/pi/role-extension.js', "pi.on('agent_settled',", "pi.on('agent_end',"]],
    witness: /true !== false/,
  },
  {
    name: 'accept-unchanged-output',
    suite: 'pi-owned-worker.test.js',
    pattern: '^worker settlement refuses unchanged',
    edits: [['lifecycle.js', ' || facts.outputAfter === facts.outputBefore', '']],
    witness: /closed.*failed|failed.*closed/s,
  },
  {
    name: 'nested-sonic-job-mutex',
    pattern: '^nested sonic: helper reviewer borrows',
    edits: [['helpers.js', "borrowed ? 'child-helper' : 'helper'", "'helper'"]],
    witness: /helper_busy|deadline/,
  },
  {
    name: 'autoclose-quit-during-grace',
    suite: 'pi-owned-worker.test.js',
    pattern: '^implementer autoclose eligibility excludes quit',
    edits: [['reap-main.js', "(c.role !== 'implementer' || status.exit_reason === 'idle_grace_expired')", 'true']],
    witness: /true !== false/,
  },
  {
    name: 'review-full-suite-reruns',
    suite: 'pi-owned-worker.test.js',
    pattern: '^review brief separates full-suite',
    edits: [['helpers.js', 'do not rerun the full suites', 'rerun the full suites']],
    witness: /do not rerun the full suites/,
  },
  {
    name: 'round-two-stale-full-suite-rerun',
    suite: 'pi-owned-worker.test.js',
    pattern: '^review brief separates full-suite',
    edits: [
      [
        'helpers.js',
        'stale full-suite logs after fixes are expected; note them, never rerun full suites.',
        'rerun stale full-suite logs after fixes yourself.',
      ],
    ],
    witness: /stale full-suite logs after fixes are expected/,
  },
  {
    name: 'sonic-helper-tools',
    suite: 'pi-owned-worker.test.js',
    pattern: '^every non-sonic slot can reserve sonic',
    edits: [
      [
        'contracts.js',
        "sonic: 'read,bash,edit,write,grep,find,ls,ask_orchestrator'",
        "sonic: 'read,bash,edit,write,grep,find,ls,ask_orchestrator,call_sonic'",
      ],
    ],
    witness: /call_sonic/,
  },
  {
    name: 'release-outer-before-borrowed-child-cleanup',
    pattern: '^borrowed sonic child is cleaned before closed reviewer release',
    edits: [['helpers.js', 'await drainChild();\n', '']],
    witness: /alive.*dead|dead.*alive/s,
  },
  {
    name: 'bypass-close-fence',
    pattern: '^a durable closing fence',
    edits: [
      [
        'runtime.js',
        "            if (this.control().closing)\n                throw new ExecutionError('closing');",
        '',
      ],
    ],
    witness: /acked/,
  },
];
for (const mutant of mutants) {
  const root = fs.mkdtempSync(join(tmpdir(), 'hud-pi-mutant-'));
  try {
    fs.cpSync(join(repo, 'dist-test'), join(root, 'dist-test'), { recursive: true });
    if (mutant.copyDist) fs.cpSync(join(repo, 'dist'), join(root, 'dist'), { recursive: true });
    fs.mkdirSync(join(root, 'tests'));
    fs.symlinkSync(join(repo, 'tests/fakes'), join(root, 'tests/fakes'));
    if (mutant.copyScripts) fs.cpSync(join(repo, 'scripts'), join(root, 'scripts'), { recursive: true });
    else fs.symlinkSync(join(repo, 'scripts'), join(root, 'scripts'));
    if (mutant.sourceSuite) {
      fs.mkdirSync(join(root, 'tests/unit'));
      fs.copyFileSync(join(repo, 'tests/unit', mutant.suite), join(root, 'tests/unit', mutant.suite));
      fs.mkdirSync(join(root, 'packages/hud-mcp/bin'), { recursive: true });
      fs.copyFileSync(join(repo, 'packages/hud-mcp/bin/surface.mjs'), join(root, 'packages/hud-mcp/bin/surface.mjs'));
    }
    fs.writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    fs.symlinkSync(join(repo, 'node_modules'), join(root, 'node_modules'));
    for (const [file, before, after] of mutant.edits) {
      const path = join(root, 'dist-test/src/roles/pi-owned', file);
      const text = fs.readFileSync(path, 'utf8');
      assert.equal(text.split(before).length, 2, `exact mutation anchor ${mutant.name}/${file}`);
      fs.writeFileSync(path, text.replace(before, after));
    }
    const home = join(root, 'suite-home');
    fs.mkdirSync(home);
    const env = {
      ...process.env,
      HOME: home,
      HUD_HOME: join(home, '.hud'),
      CODEX_HOME: join(home, 'codex'),
      CLAUDE_CONFIG_DIR: join(home, 'claude'),
    };
    for (const key of [
      'NO_COLOR',
      'FORCE_COLOR',
      'HUD_SETTINGS_PATH',
      'CODEX_HUD_SETTINGS_PATH',
      'HERDR_SOCKET',
      'HERDR_SOCKET_PATH',
      'HERDR_PANE_ID',
      'HERDR_ENV',
    ])
      delete env[key];
    const result = spawnSync(
      process.execPath,
      [
        '--test',
        '--test-reporter=spec',
        '--test-name-pattern',
        mutant.pattern,
        join(
          root,
          mutant.sourceSuite ? 'tests/unit' : 'dist-test/tests/unit',
          mutant.suite ?? 'pi-owned-orchestration.test.js'
        ),
      ],
      { env, encoding: 'utf8', timeout: 90_000, maxBuffer: 1024 * 1024 }
    );
    const output = result.stdout + result.stderr;
    process.stdout.write(`=== ${mutant.name}: exit=${result.status} ===\n${output}\n`);
    assert.notEqual(result.status, 0, `${mutant.name} must be killed`);
    assert.match(output, /fail 1/, `${mutant.name}: an assertion, not a syntax/loader failure`);
    assert.match(output, mutant.witness, `${mutant.name}: expected behavioral witness`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
console.log(`${mutants.length}/${mutants.length} behavioral mutants killed; original source/build untouched.`);
