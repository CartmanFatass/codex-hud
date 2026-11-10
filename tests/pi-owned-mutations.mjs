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
    fs.mkdirSync(join(root, 'tests'));
    fs.symlinkSync(join(repo, 'tests/fakes'), join(root, 'tests/fakes'));
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
    const env = { ...process.env, HOME: home, HUD_HOME: join(home, '.hud'), CODEX_HOME: join(home, 'codex') };
    delete env.NO_COLOR;
    delete env.FORCE_COLOR;
    const result = spawnSync(
      process.execPath,
      [
        '--test',
        '--test-reporter=spec',
        '--test-name-pattern',
        mutant.pattern,
        join(root, 'dist-test/tests/unit', mutant.suite ?? 'pi-owned-orchestration.test.js'),
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
