import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  MainFeaturesError,
  VISUAL_BASELINE_TEST,
  VISUAL_BASELINES,
  assertCoverage,
  assertStatementHash,
  branchTestFiles,
  checkScenes,
  enforceManifest,
  extractAssertStatements,
  integrationPlan,
  missingAssertHashes,
  passedTapTitles,
  planMainTests,
  readBaselineFrames,
  readManifest,
  sceneHash,
  titleMatches,
  unmatchedTapTitles,
} from '../run-main.mjs';

const entry = (extra = {}) => ({
  branch: ['tests/unit/a.test.ts'],
  assertions: ['keeps A'],
  assertStatements: [],
  ...extra,
});

const manifest = {
  coverage: ['tests/integration/old.sh', 'tests/unit/a.test.ts', 'tests/unit/b.test.mjs', 'tests/unit/c.test.ts'],
  tests: {
    'tests/unit/a.test.ts': {
      branch: ['tests/unit/a.test.ts', 'tests/unit/b.test.mjs'],
      assertions: ['keeps A'],
      assertStatements: [],
    },
    'tests/unit/b.test.mjs': {
      branch: ['tests/unit/b.test.mjs'],
      assertions: ['keeps B'],
      assertStatements: [],
    },
    'tests/unit/c.test.ts': { changed: 'moved to a branch test' },
    'tests/integration/old.sh': {
      branch: ['tests/integration/old.sh'],
      assertions: ['keeps the shell suite'],
      assertStatements: [],
      integration: { manual: 'synthetic fixture' },
    },
  },
  scenes: {},
  mixed: {},
};

function syntheticRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'hud-main-features-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = [
    'tests/unit/a.test.ts',
    'tests/unit/b.test.mjs',
    'tests/integration/old.sh',
    'dist-test/tests/unit/a.test.js',
    VISUAL_BASELINE_TEST,
  ];
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), '');
  }
  mkdirSync(dirname(join(root, VISUAL_BASELINES)), { recursive: true });
  writeFileSync(join(root, VISUAL_BASELINES), JSON.stringify({ version: 1, frames: {} }));
  return root;
}

test('branch column is deduplicated, sorted and skips changed entries', () => {
  assert.deepEqual(branchTestFiles(manifest), [
    'tests/integration/old.sh',
    'tests/unit/a.test.ts',
    'tests/unit/b.test.mjs',
  ]);
});

test('mapped files become compiled .js or direct .mjs, plus the visual test', (t) => {
  const plan = planMainTests(manifest, { root: syntheticRoot(t) });
  assert.deepEqual(plan.run, ['dist-test/tests/unit/a.test.js', VISUAL_BASELINE_TEST, 'tests/unit/b.test.mjs']);
  assert.deepEqual(plan.skipped, ['tests/integration/old.sh']);
  assert.equal(plan.mapped, 3);
});

test('a flat manifest with top-level tests/... keys is rejected', () => {
  const flat = {
    'tests/unit/a.test.ts': { branch: ['tests/unit/a.test.ts'] },
    visual: { 'panel/en/tab/minimal/32x32': 'kept' },
  };
  assert.throws(() => branchTestFiles(flat), /expected \{ tests:/);
});

test('a missing mapped file fails the plan', (t) => {
  const broken = {
    tests: {
      'tests/unit/missing.test.ts': entry({ branch: ['tests/unit/missing.test.ts'], assertions: [] }),
    },
  };
  assert.throws(
    () => planMainTests(broken, { root: syntheticRoot(t) }),
    (error) => error instanceof MainFeaturesError && /mapped files do not exist/.test(error.message)
  );
});

test('a missing manifest fails readManifest', () => {
  assert.throws(() => readManifest('/nonexistent/main-features.json'), /manifest not found/);
});

test('a malformed entry is rejected', () => {
  assert.throws(
    () => branchTestFiles({ tests: { 'tests/unit/x.test.ts': { assertions: [] } } }),
    /expected a "branch" array of non-empty strings/
  );
});

test('an empty changed reason fails the gate', () => {
  assert.throws(
    () => branchTestFiles({ tests: { 'tests/unit/a.test.ts': { changed: '' } } }),
    (error) => error instanceof MainFeaturesError && /non-empty/.test(error.message)
  );
});

test('changed and branch together fail the gate', () => {
  assert.throws(
    () =>
      branchTestFiles({
        tests: { 'tests/unit/a.test.ts': { changed: 'because', branch: ['tests/unit/a.test.ts'] } },
      }),
    (error) => error instanceof MainFeaturesError && /both/.test(error.message)
  );
});

test('removing a manifest entry fails the coverage check', () => {
  const removed = {
    coverage: ['tests/unit/a.test.ts', 'tests/unit/b.test.ts'],
    tests: { 'tests/unit/a.test.ts': entry() },
    scenes: {},
    mixed: {},
  };
  assert.throws(
    () => assertCoverage(removed),
    (error) => error instanceof MainFeaturesError && /tests keys must equal coverage/.test(error.message)
  );
});

test('an edited scene fails the gate', () => {
  const original = { lines: ['kept frame'] };
  const scenes = { 'panel/en/tab/minimal/32x32': { kept: sceneHash(original) } };
  assert.throws(
    () => checkScenes({ scenes }, { 'panel/en/tab/minimal/32x32': { lines: ['edited frame'] } }),
    (error) => error instanceof MainFeaturesError && /frame hash/.test(error.message)
  );
});

test('a kept scene hash matches the canonical frame', () => {
  const frame = { height: 1, lines: ['a'], width: 1 };
  assert.equal(sceneHash({ lines: ['a'], width: 1, height: 1 }), sceneHash(frame));
  checkScenes({ scenes: { demo: { kept: sceneHash(frame) } } }, { demo: frame, 'delegation/extra': { lines: ['x'] } });
});

test('a deleted test fails when TAP omits its title', () => {
  const tap = ['TAP version 13', 'ok 1 - some other title', '# tests 1', '# pass 1', '# fail 0', ''].join('\n');
  const listed = {
    tests: {
      'tests/unit/monitor.test.ts': entry({
        branch: ['tests/unit/monitor.test.ts'],
        assertions: ['width, height and margins remain bounded with CJK and terminal controls'],
      }),
    },
  };
  assert.deepEqual(unmatchedTapTitles(listed, tap), [
    'tests/unit/monitor.test.ts: width, height and margins remain bounded with CJK and terminal controls',
  ]);
});

test('a doubled TAP backslash matches the source title, and a missing title still fails', () => {
  const required =
    'the prefix: Ctrl+\\ on a fresh install, Ctrl+] kept by a file saved without one, a saved choice kept either way';
  const tap = `ok 1 - the prefix: Ctrl+\\\\ on a fresh install, Ctrl+] kept by a file saved without one, a saved choice kept either way\n`;
  assert.equal(passedTapTitles(tap)[0], required);
  assert.equal(titleMatches(required, passedTapTitles(tap)[0]), true);
  assert.equal(passedTapTitles('ok 2 - hash \\# not skip\n')[0], 'hash # not skip');
  const listed = {
    tests: {
      'tests/unit/settings.test.ts': entry({
        branch: ['tests/unit/settings.test.ts'],
        assertions: [required],
      }),
    },
  };
  assert.deepEqual(unmatchedTapTitles(listed, tap), []);
  assert.deepEqual(unmatchedTapTitles(listed, 'ok 1 - some other title\n'), [
    `tests/unit/settings.test.ts: ${required}`,
  ]);
});

test('a template title matches the expanded TAP name and a SKIP does not count', () => {
  const required = 'optional response validator checks fresh, cache and throwing predicates (${dirMode})';
  assert.equal(
    titleMatches(required, 'optional response validator checks fresh, cache and throwing predicates (memory)'),
    true
  );
  assert.equal(
    titleMatches(required, 'optional response validator checks fresh, cache and throwing predicates ()'),
    false
  );
  const tap = [
    'ok 1 - optional response validator checks fresh, cache and throwing predicates (memory)',
    '    ok 2 - optional response validator checks fresh, cache and throwing predicates (shared)',
    'ok 3 - width, height and margins remain bounded with CJK and terminal controls # SKIP',
    '  ---',
    '  ok 9 - not a real title',
    '  ...',
  ].join('\n');
  assert.deepEqual(passedTapTitles(tap), [
    'optional response validator checks fresh, cache and throwing predicates (memory)',
    'optional response validator checks fresh, cache and throwing predicates (shared)',
  ]);
  const listed = {
    tests: {
      'tests/unit/small-model.test.ts': entry({
        branch: ['tests/unit/small-model.test.ts'],
        assertions: [required],
      }),
    },
  };
  assert.deepEqual(unmatchedTapTitles(listed, tap), []);
});

test('a weakened assertion fails the static check', async () => {
  const source = "import assert from 'node:assert/strict';\nassert.ok(true, 'then the window');\n";
  const extracted = await extractAssertStatements('status-block.test.ts', source);
  const required = assertStatementHash("assert.equal(dropped, 'window')");
  const actual = extracted.statements.map(assertStatementHash);
  assert.deepEqual(missingAssertHashes([required], {}, actual), [required]);
  assert.deepEqual(
    extracted.statements.map((statement) => statement.replace(/\s+/g, ' ')),
    ["assert.ok(true, 'then the window')"]
  );
});

test('an excepted assert statement is not required, and its replacement is', () => {
  const hash = assertStatementHash('assert.equal(1, 1)');
  assert.deepEqual(missingAssertHashes([hash], { 'the title': [hash] }, []), []);
  const branch = assertStatementHash('assert.equal(fs.statSync(syntheticRuntimeFile(dir, name)).mode & 0o777, 0o600)');
  assert.deepEqual(missingAssertHashes([hash], { 'the title': [{ main: hash, branch }] }, []), [branch]);
  assert.deepEqual(missingAssertHashes([hash], { 'the title': [{ main: hash, branch }] }, [branch]), []);
});

test('opt-in integration scripts run and manual scripts are listed', () => {
  const plan = integrationPlan({
    tests: {
      'tests/integration/test-install-dependency-guidance.sh': entry({
        branch: ['tests/integration/test-install-dependency-guidance.sh'],
        assertions: ['Node.js 18+'],
        integration: 'opt-in',
      }),
      'tests/integration/test-bar-click.sh': entry({
        branch: ['tests/integration/test-bar-click.sh'],
        assertions: ['click'],
        integration: { manual: 'needs a real tmux server' },
      }),
    },
  });
  assert.deepEqual(plan.run, ['tests/integration/test-install-dependency-guidance.sh']);
  assert.deepEqual(plan.manual, [{ file: 'tests/integration/test-bar-click.sh', reason: 'needs a real tmux server' }]);
});

test('the manifest on disk has one shape and records the baseline checks', () => {
  const text = readFileSync(new URL('../main-features.json', import.meta.url), 'utf8');
  assert.equal(text.includes('/home/fires'), false);
  const manifest = JSON.parse(text);
  assert.deepEqual(Object.keys(manifest.tests).sort(), [...manifest.coverage].sort());
  assert.equal(manifest.coverage.length, 155);
  assert.equal(
    Object.values(manifest.tests).some((item) => Object.prototype.hasOwnProperty.call(item, 'changed')),
    false
  );
  assertCoverage(manifest);
  const frames = readBaselineFrames(VISUAL_BASELINES);
  checkScenes(manifest, frames);
  assert.equal(Object.keys(manifest.scenes).length, 240);
  assert.equal(
    Object.values(manifest.scenes).every((item) => typeof item.kept === 'string' && item.kept.length === 64),
    true
  );

  const mixed = Object.keys(manifest.mixed).sort();
  assert.deepEqual(mixed, [
    'tests/unit/b11-cli.test.ts',
    'tests/unit/b17-legacy.test.ts',
    'tests/unit/monitor.test.ts',
    'tests/unit/product-cli-routing.test.ts',
    'tests/unit/session-navigation.test.ts',
  ]);
  assert.equal(
    manifest.mixed['tests/unit/b17-legacy.test.ts'].mainAssertions.includes(
      'golden legacy Codex: explicit backend plus historical feature defaults preserves identical request bytes'
    ),
    true
  );
  const viewport = manifest.tests['tests/integration/test-observability-viewport.py'].assertions;
  assert.equal(viewport.includes('Back hidden at end: ${s}'), true);
  assert.equal(viewport.includes('Back hidden at end: ${}'), false);

  const carriers = [
    'tests/unit/brief-report.test.ts',
    'tests/unit/briefing.test.ts',
    'tests/unit/i18n.test.ts',
    'tests/unit/model-jobs.test.ts',
    'tests/unit/model-runtime.test.ts',
    'tests/unit/model-telemetry.test.ts',
    'tests/unit/progress-summary.test.ts',
    'tests/unit/recap.test.ts',
    'tests/unit/reply-language.test.ts',
    'tests/unit/small-model.test.ts',
    'tests/unit/summary-status.test.ts',
  ];
  for (const file of carriers) {
    const item = manifest.tests[file];
    assert.deepEqual(Object.keys(item.divergence).sort(), [...item.assertions].sort(), file);
    for (const reason of Object.values(item.divergence)) {
      assert.match(reason, /7f07c5a/);
      assert.match(reason, /§4\.1/);
      assert.match(reason, /§4\.2\(1\)/);
      assert.match(reason, /B17 test double/);
    }
  }
  for (const file of [
    'tests/unit/model-runtime.test.ts',
    'tests/unit/reply-language.test.ts',
    'tests/unit/small-model.test.ts',
  ]) {
    for (const reason of Object.values(manifest.tests[file].divergence)) {
      assert.match(reason, /cache\.json/);
      assert.match(reason, /calls\.json/);
    }
  }

  const plan = integrationPlan(manifest);
  assert.equal(plan.run.length + plan.manual.length, 27);
  assert.equal(plan.run.includes('tests/integration/test-install-dependency-guidance.sh'), true);
  assert.equal(plan.run.includes('tests/integration/test-management-commands.sh'), true);
  assert.equal(plan.run.includes('tests/integration/test-wrapper-codex-home.sh'), true);
  assert.equal(plan.run.includes('tests/integration/test-wrapper-main-pane-env.sh'), true);
  assert.equal(
    plan.manual.some((item) => item.file.includes('real-tmux') && item.reason.length > 0),
    true
  );
});

test('enforceManifest fails a synthetic tree whose assert hash does not occur', async (t) => {
  const root = syntheticRoot(t);
  writeFileSync(
    join(root, 'tests/unit/a.test.ts'),
    "import assert from 'node:assert/strict';\nassert.ok(true, 'then the window');\n"
  );
  const broken = {
    coverage: ['tests/unit/a.test.ts'],
    tests: {
      'tests/unit/a.test.ts': entry({
        assertions: ['then the window'],
        assertStatements: [assertStatementHash("assert.equal(dropped, 'window')")],
      }),
    },
    scenes: {},
    mixed: {},
  };
  await assert.rejects(
    () => enforceManifest(broken, { root }),
    (error) => error instanceof MainFeaturesError && /assert statement missing/.test(error.message)
  );
});
