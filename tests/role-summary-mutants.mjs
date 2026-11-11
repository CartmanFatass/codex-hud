// Negative controls run emitted copies in fresh synthetic homes, never mutate the working outputs.
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
const root = resolve(import.meta.dirname, '..');
const variants = [
  [
    'expired-is-current',
    'dist-test/src/roles/role-summary.js',
    'now - summary.observedAt >= ROLE_SUMMARY_TTL_MS',
    'false',
    'role-summary',
    'role summary expired',
  ],
  [
    'unavailable-is-zero',
    'dist-test/src/roles/role-summary.js',
    "const unavailable = () => ({ state: 'unavailable', counts: null });",
    "const unavailable = () => ({ state: 'available', summary: { counts: {'needs-you':0,stalled:0,'awaiting-acceptance':0,'in-progress':0,done:0},coverage:'complete'} });",
    'role-summary',
    'role summary missing',
  ],
  [
    'publish-in-paint',
    'dist/tree-page.js',
    'const render = () => {',
    'const render = () => { roleSummary?.publish(selectedRoot, jobPipeline.workboard(tree, panelDelegation), Date.now(), 10);',
    'role-summary',
    'role summary actual collection',
  ],
];
let killed = 0;
for (const [name, relative, before, after, suite, pattern] of variants) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'hud-a67-mutant-'));
  try {
    for (const part of ['home', 'hud', 'codex', 'claude', 'bin', 'src']) fs.mkdirSync(join(dir, part), { mode: 0o700 });
    fs.writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    for (const part of ['dist', 'dist-test/src', 'dist-test/tests/fixtures', 'tests/fakes'])
      fs.cpSync(join(root, part), join(dir, part), { recursive: true });
    fs.mkdirSync(join(dir, 'dist-test/tests/unit'), { recursive: true });
    fs.copyFileSync(
      join(root, `dist-test/tests/unit/${suite}.test.js`),
      join(dir, `dist-test/tests/unit/${suite}.test.js`)
    );
    for (const bin of ['hud', 'hud-statusline']) fs.copyFileSync(join(root, 'bin', bin), join(dir, 'bin', bin));
    fs.copyFileSync(join(root, 'src/tree-page.ts'), join(dir, 'src/tree-page.ts'));
    fs.symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'));
    const file = join(dir, relative);
    const text = fs.readFileSync(file, 'utf8');
    if (text.split(before).length !== 2) throw Error(`non-unique target ${name}`);
    fs.writeFileSync(file, text.replace(before, after));
    const env = {
      ...process.env,
      HOME: join(dir, 'home'),
      HUD_HOME: join(dir, 'hud'),
      CODEX_HOME: join(dir, 'codex'),
      CLAUDE_CONFIG_DIR: join(dir, 'claude'),
    };
    for (const key of Object.keys(env))
      if (
        key.startsWith('HUD_PANEL_') ||
        ['NO_COLOR', 'FORCE_COLOR', 'HUD_SETTINGS_PATH', 'CODEX_HUD_SETTINGS_PATH'].includes(key)
      )
        delete env[key];
    const out = spawnSync(
      process.execPath,
      ['--test', '--test-name-pattern', pattern, join(dir, `dist-test/tests/unit/${suite}.test.js`)],
      { env, cwd: dir, encoding: 'utf8', timeout: 30000 }
    );
    if (out.status !== 1 || !out.stdout.includes('AssertionError')) {
      console.error(out.stdout, out.stderr);
      throw Error(`survived or invalid mutation ${name}: ${out.status}`);
    }
    console.log(`KILLED ${name}`);
    killed++;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
console.log(`${killed}/${variants.length} A67 mutants killed`);
