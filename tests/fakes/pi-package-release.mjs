/** Clean-built disposable probe artifact, not the distribution packer or live activation. */
import fs from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { piSteps, PI_TEMPLATES } from '../../scripts/runtime-package/pi.mjs';
import { digest } from '../../scripts/runtime-package/safety.mjs';
export function probeRelease(dir) {
  const stage = join(dir, 'stage');
  fs.mkdirSync(stage, { mode: 0o700 });
  for (const args of [
    ['node_modules/typescript/bin/tsc', '--outDir', join(stage, 'dist')],
    [
      'node_modules/typescript/bin/tsc',
      '-p',
      'packages/hud-mcp/tsconfig.json',
      '--outDir',
      join(stage, 'packages/hud-mcp/dist'),
    ],
    ['scripts/copy-jev-assets.mjs', join(stage, 'dist/jev/snapshot.js')],
  ]) {
    const r = spawnSync(process.execPath, args, {
      cwd: resolve('.'),
      env: process.env,
      encoding: 'utf8',
      timeout: 120000,
    });
    if (r.status !== 0) throw Error('probe_build_failed: ' + r.stdout + r.stderr);
  }
  const files = [
    'package.json',
    'packages/hud-mcp/package.json',
    'packages/hud-mcp/bin/hud-mcp.mjs',
    'packages/hud-mcp/bin/surface.mjs',
    'bin/hud',
    ...PI_TEMPLATES,
    'integrations/pi/package/README.md',
    'integrations/skills/hud-delegate/SKILL.md',
  ];
  for (const name of files) {
    const dest = join(stage, name);
    fs.mkdirSync(join(dest, '..'), { recursive: true, mode: 0o700 });
    fs.copyFileSync(name, dest);
  }
  for (const dir of ['dist/core/launch', 'packages/hud-mcp/dist/src/core/launch']) {
    fs.mkdirSync(join(stage, dir), { recursive: true, mode: 0o700 });
    for (const name of ['codex-cells.json', 'managed-cells.json'])
      fs.copyFileSync('src/core/launch/' + name, join(stage, dir, name));
  }
  fs.mkdirSync(join(stage, 'node_modules/@iarna'), { recursive: true, mode: 0o700 });
  fs.cpSync('node_modules/@iarna/toml', join(stage, 'node_modules/@iarna/toml'), { recursive: true });
  const entries = [];
  function walk(p) {
    for (const n of fs.readdirSync(join(stage, p))) {
      const rel = p ? `${p}/${n}` : n,
        s = fs.lstatSync(join(stage, rel));
      if (s.isDirectory()) {
        fs.chmodSync(join(stage, rel), 0o700);
        walk(rel);
      } else {
        fs.chmodSync(join(stage, rel), 0o600);
        const b = fs.readFileSync(join(stage, rel));
        entries.push({ path: rel, sha256: digest(b), bytes: b.length, mode: '0600' });
      }
    }
  }
  walk('');
  entries.sort((a, b) => a.path.localeCompare(b.path));
  const version = JSON.parse(fs.readFileSync('package.json')).version;
  const manifest = {
    schemaVersion: 1,
    releaseVersion: version,
    entries,
    provenance: 'A5 clean-build probe artifact; not distribution qualification',
  };
  const raw = JSON.stringify(manifest),
    hash = digest(raw),
    prefix = join(dir, 'runtime');
  fs.mkdirSync(join(prefix, 'releases'), { recursive: true, mode: 0o700 });
  const release = join(prefix, 'releases', hash);
  fs.renameSync(stage, release);
  fs.writeFileSync(join(release, 'RUNTIME-MANIFEST.json'), raw, { mode: 0o600 });
  const hudHome = join(dir, 'hud');
  fs.mkdirSync(hudHome, { mode: 0o700 });
  fs.copyFileSync('docs/examples/routing.toml', join(hudHome, 'routing.toml'));
  const bundle = { manifest, directory: { read: (name) => ({ data: fs.readFileSync(join(release, name)) }) } };
  const generated = piSteps(bundle, {
    prefix,
    release: hash,
    hudHome,
    pi: { node: fs.realpathSync(process.execPath) },
  });
  for (const step of generated.steps) {
    if (step.kind === 'private-dir') fs.mkdirSync(step.path, { recursive: true, mode: 0o700 });
    else fs.writeFileSync(step.path, step.content, { mode: step.mode });
  }
  return { release, hash, hudHome, piPackage: generated.piPackage };
}
