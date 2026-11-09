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
    edits: [
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
    const env = { ...process.env, HOME: home, HUD_HOME: join(home, '.hud') };
    delete env.NO_COLOR;
    delete env.FORCE_COLOR;
    const result = spawnSync(
      process.execPath,
      [
        '--test',
        '--test-reporter=spec',
        '--test-name-pattern',
        mutant.pattern,
        join(root, 'dist-test/tests/unit/pi-owned-orchestration.test.js'),
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
console.log('4/4 behavioral mutants killed; original source/build untouched.');
