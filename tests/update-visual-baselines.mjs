// Explicit, local-only update. No network or real session input is involved.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.env.CI !== undefined) {
  console.error('Refusing to update visual baselines in CI. Review and update locally.');
  process.exit(1);
}
const cwd = fileURLToPath(new URL('../', import.meta.url));
const run = (args, env = process.env) => {
  const result = spawnSync(process.execPath, args, { cwd, env, stdio: 'inherit' });
  if (result.error) { console.error(result.error.message); process.exit(1); }
  if (result.status !== 0) process.exit(result.status ?? 1);
};
run(['node_modules/typescript/bin/tsc', '-p', 'tsconfig.test.json']);
run(['--test', 'dist-test/tests/unit/visual-baselines.test.js'],
  { ...process.env, CODEX_HUD_UPDATE_VISUAL_BASELINES: '1' });
