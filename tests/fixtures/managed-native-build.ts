// SIMULATED runtime package bytes. Never a shipped capability or publisher attestation.
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MINIMUM_RUNTIME_FILES, RUNTIME_CAPABILITY_FILES } from '../../src/core/runtime-build.js';
export const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
export function syntheticBuild(root: string) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  for (const name of [...MINIMUM_RUNTIME_FILES, 'synthetic.js']) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(
      path,
      name.endsWith('.json')
        ? JSON.stringify({ version: 1, hudRevision: null, cells: [] })
        : 'SIMULATED runtime bytes\n',
      { mode: name === 'bin/hud-run' ? 0o700 : 0o600 }
    );
  }
  for (const [path, value] of [
    ['package.json', { name: 'codex-hud', type: 'module' }],
    ['packages/hud-mcp/package.json', { name: '@myhud/hud-mcp', type: 'module' }],
    ['node_modules/@iarna/toml/package.json', { name: '@iarna/toml', version: '2.2.5', main: 'toml.js' }],
    [
      'node_modules/chokidar/package.json',
      {
        name: 'chokidar',
        version: '5.0.0',
        type: 'module',
        main: './index.js',
        exports: { '.': { default: './index.js' }, './handler.js': { default: './handler.js' } },
      },
    ],
    [
      'node_modules/readdirp/package.json',
      { name: 'readdirp', version: '5.0.0', type: 'module', main: './index.js', exports: { '.': './index.js' } },
    ],
  ] as const)
    writeFileSync(join(root, path), JSON.stringify(value));
  return sealSyntheticBuild(root);
}
export function sealSyntheticBuild(root: string) {
  const entries: { path: string; bytes: number; sha256: string; mode: string }[] = [];
  const walk = (relative: string) => {
    for (const name of readdirSync(join(root, relative))) {
      const path = relative ? `${relative}/${name}` : name;
      if (path === 'RUNTIME-MANIFEST.json') continue;
      const stat = statSync(join(root, path));
      if (stat.isDirectory()) walk(path);
      else
        entries.push({
          path,
          bytes: stat.size,
          sha256: sha256(readFileSync(join(root, path))),
          mode: (stat.mode & 0o7777).toString(8).padStart(4, '0'),
        });
    }
  };
  walk('');
  const manifest = {
    schemaVersion: 1,
    repositorySha: 'a'.repeat(40),
    repositoryTree: 'b'.repeat(40),
    dirty: false,
    lockfileSha256: 'c'.repeat(64),
    entries,
    provenance: 'SIMULATED test-only package',
  };
  writeFileSync(join(root, 'RUNTIME-MANIFEST.json'), JSON.stringify(manifest), { mode: 0o600 });
  return manifest;
}
