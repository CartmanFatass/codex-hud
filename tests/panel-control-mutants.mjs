// Focused negative controls against isolated emitted copies, never edits source/dist in place.
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = resolve(import.meta.dirname, '..');
const variants = [
  [
    'create-before-intent',
    'control',
    "saveJson(s.file(key, 'intent'), r);",
    '// mutant: no intent before split',
    'panel intent precedes split',
  ],
  [
    'blind-recreate',
    'control',
    "r?.reason === 'split_reply_lost' && o.automatic",
    "r?.reason === 'split_reply_lost' && false",
    'panel split-only lost reply',
  ],
  [
    'old-generation-end',
    'control',
    '!r || !sameTarget(r, c) || o.generation !== r.generation',
    '!r || !sameTarget(r, c)',
    'panel intent precedes split',
  ],
  [
    'inherited-pane-eligibility',
    'eligibility',
    'const no = (diagnostic) => ({ eligible: false, diagnostic });',
    "const no = (diagnostic) => ({ eligible: false, diagnostic }); if (!evidence) return {eligible:true, diagnostic:'ok'};",
    'panel auto-open requires native',
  ],
  [
    'unvalidated-session',
    'receipt',
    'formatRosterRoot(parseRosterRoot(`${sourceId}/${session}`))',
    '`${sourceId}/${session}`',
    'panel CLI harness/session/source parsing',
  ],
  [
    'positive-get-as-absence',
    'herdr',
    'if (!clean(reportedWorkspace, 256))',
    'if (!clean(reportedWorkspace, 256)) return null; if (false)',
    'panel positive get with missing workspace',
  ],
  [
    'skip-token-registration',
    'control',
    'if (await reconcile(s, r, o, d)) {',
    "if ((r.phase = 'open', s.write(r), true)) {",
    'panel missing token registration',
  ],
];
let killed = 0;
for (const [name, module, before, after, pattern] of variants) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'hud-panel-mutant-'));
  try {
    for (const n of ['home', 'hud', 'codex']) fs.mkdirSync(join(dir, n), { mode: 0o700 });
    fs.cpSync(join(root, 'dist-test/src'), join(dir, 'dist-test/src'), { recursive: true });
    fs.mkdirSync(join(dir, 'dist-test/tests/unit'), { recursive: true });
    fs.copyFileSync(
      join(root, 'dist-test/tests/unit/panel-control.test.js'),
      join(dir, 'dist-test/tests/unit/panel-control.test.js')
    );
    fs.mkdirSync(join(dir, 'tests/fakes'), { recursive: true });
    fs.copyFileSync(join(root, 'tests/fakes/panel-herdr.mjs'), join(dir, 'tests/fakes/panel-herdr.mjs'));
    fs.writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    // Shared installed dependencies remain read-only; no install, no modification.
    fs.symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'));
    const file = join(dir, `dist-test/src/integrations/panel/${module}.js`);
    const text = fs.readFileSync(file, 'utf8');
    if (text.split(before).length !== 2) throw new Error(`mutant target not unique: ${name}`);
    fs.writeFileSync(file, text.replace(before, after));
    const env = { ...process.env, HOME: join(dir, 'home'), HUD_HOME: join(dir, 'hud'), CODEX_HOME: join(dir, 'codex') };
    delete env.NO_COLOR;
    delete env.FORCE_COLOR;
    const out = spawnSync(
      process.execPath,
      ['--test', '--test-name-pattern', pattern, join(dir, 'dist-test/tests/unit/panel-control.test.js')],
      { env, cwd: root, encoding: 'utf8', timeout: 20000 }
    );
    if (out.status !== 1 || (!out.stdout.includes('AssertionError') && !out.stderr.includes('AssertionError'))) {
      console.error(out.stdout, out.stderr);
      throw new Error(`mutant survived or did not fail an assertion: ${name} status=${out.status}`);
    }
    console.log(`KILLED ${name}: ${pattern}`);
    killed++;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
console.log(`${killed}/${variants.length} panel mutants killed`);
