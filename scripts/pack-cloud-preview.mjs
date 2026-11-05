#!/usr/bin/env node
/** Local inspection archive only. Never npm pack/publish/install or user configuration. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ROOT,
  git,
  sha,
  metadata,
  runtime,
  safeFile,
  outputDirectory,
  isolatedEnvironment,
  runStep,
} from './check-cloud.mjs';

const ROOT_BINS = {
  'codex-hud': 'bin/codex-hud',
  hud: 'bin/hud',
  'hud-run': 'bin/hud-run',
  'hud-statusline': 'bin/hud-statusline',
};
const ENTRYPOINTS = Object.values(ROOT_BINS);
const REQUIRED_OUTPUTS = {
  'src/cli/statusline.ts': 'dist/cli/statusline.js',
  'src/harness/pi/footer.ts': 'dist/harness/pi/footer.js',
};
const EXTENSION_ENTRY = 'extensions/pi/hud-footer.ts';
const EXTRA_FILES = [
  'README.md',
  'bin/hud-statusline-preview',
  EXTENSION_ENTRY,
  'packages/hud-mcp/bin/hud-mcp.mjs',
  'packages/hud-mcp/bin/hud-claude-hook.mjs',
];
export function outputForSource(file, mcp = false) {
  if (!/^(src\/|packages\/hud-mcp\/src\/)/.test(file) || !file.endsWith('.ts') || file.endsWith('.d.ts')) return null;
  const js = file.slice(0, -3) + '.js';
  return mcp ? `packages/hud-mcp/dist/${js}` : file.startsWith('src/') ? `dist/${js.slice(4)}` : null;
}
function previewManifest(original, mcp = false) {
  if (typeof original.name !== 'string' || typeof original.version !== 'string' || original.type !== 'module')
    throw new Error('invalid_package_manifest');
  const expected = mcp ? { 'hud-mcp': 'bin/hud-mcp.mjs' } : ROOT_BINS;
  const entries = (bins) =>
    Object.entries(bins)
      .map(([name, file]) => [name, typeof file === 'string' ? file.replace(/^\.\//, '') : null])
      .sort();
  if (
    !original.bin ||
    typeof original.bin !== 'object' ||
    Array.isArray(original.bin) ||
    JSON.stringify(entries(original.bin)) !== JSON.stringify(entries(expected)) ||
    (!mcp && original.main !== 'dist/index.js')
  )
    throw new Error(mcp ? 'unreviewed_mcp_entrypoints' : 'unreviewed_package_entrypoints');
  // No lifecycle scripts, dev dependencies, release configuration or implicit installer in the preview.
  return {
    name: original.name,
    version: original.version,
    private: true,
    type: 'module',
    ...(original.main ? { main: original.main } : {}),
    bin: original.bin,
    engines: { node: '^22.13.0 || ^24.0.0' },
    ...(original.license ? { license: original.license } : {}),
    ...(original.dependencies ? { dependencies: original.dependencies } : {}),
    'x-cloud-preview': 'Inspection only; dependencies are not bundled. Not a release or supported install.',
  };
}
async function selfTest() {
  assert.equal(outputForSource('src/cli/hud.ts'), 'dist/cli/hud.js');
  assert.equal(outputForSource('src/cli/hud.ts', true), 'packages/hud-mcp/dist/src/cli/hud.js');
  for (const [source, output] of Object.entries(REQUIRED_OUTPUTS)) assert.equal(outputForSource(source), output);
  assert.equal(EXTRA_FILES.filter((file) => file.startsWith('extensions/')).length, 1);
  assert.equal(EXTRA_FILES.includes(EXTENSION_ENTRY), true);
  for (const name of [
    '.env',
    'node_modules/secret.ts',
    'tests/private.ts',
    'dist/extra.js',
    'src/types.d.ts',
    'src/secret.log',
    'extensions/pi/other.ts',
  ])
    assert.equal(outputForSource(name), null);
  assert.throws(() =>
    previewManifest({ name: 'synthetic', version: '0', type: 'module', main: 'dist/index.js', bin: { x: '../../bad' } })
  );
  const original = JSON.parse(fs.readFileSync(safeFile('package.json'), 'utf8'));
  const value = previewManifest(original);
  const bins = { ...original.bin };
  delete bins['hud-statusline'];
  for (const bin of [
    bins,
    { ...bins, renamed: original.bin['hud-statusline'] },
    { ...original.bin, unexpected: './bin/hud' },
    { ...original.bin, 'hud-statusline': './bin/hud-statusline-preview' },
  ])
    assert.throws(() => previewManifest({ ...original, bin }), /unreviewed_package_entrypoints/);
  assert.equal(value.private, true);
  assert.equal(value.scripts, undefined);
  assert.equal(value.devDependencies, undefined);
  assert.equal(value.engines.node, '^22.13.0 || ^24.0.0');
  console.log('PASS: tracked-source mapping, excluded trees and non-publishable manifest');
}
async function main() {
  runtime();
  if (process.argv.length === 3 && process.argv[2] === '--self-test') return selfTest();
  if (process.argv.length !== 2) throw new Error('usage: node scripts/pack-cloud-preview.mjs [--self-test]');
  const out = outputDirectory('preview');
  const env = isolatedEnvironment(out);
  const stage = path.join(out, 'stage', 'package');
  fs.mkdirSync(stage, { recursive: true });
  const report = {
    ...metadata(),
    status: 'RUNNING',
    results: [],
    entries: [],
    archive: null,
    excluded: [
      'node_modules',
      'tests',
      'source maps',
      'source TS except the explicit Pi footer extension entry',
      'logs',
      'settings',
      'credentials',
      'install/upgrade scripts',
      'session data',
    ],
    limitations: [
      'Local inspection archive, not npm publication or installation',
      'Production dependencies declared but not bundled',
      'No standalone install, live-provider or full-suite qualification',
    ],
  };
  try {
    const tracked = git('ls-files', '-z').split('\0').filter(Boolean);
    const inputs = tracked.filter((p) => p.startsWith('src/') || p.startsWith('packages/hud-mcp/src/'));
    // Validate every selected source before compilation; generated maps/test output are never packed.
    for (const file of inputs) safeFile(file);
    const builds = [
      {
        name: 'preview-build',
        args: ['node_modules/typescript/bin/tsc', '--outDir', path.join(out, 'main')],
        timeoutMs: 180000,
      },
      {
        name: 'preview-build-mcp',
        args: [
          'node_modules/typescript/bin/tsc',
          '-p',
          'packages/hud-mcp/tsconfig.json',
          '--outDir',
          path.join(out, 'mcp'),
        ],
        timeoutMs: 180000,
      },
    ];
    for (const step of builds) {
      const result = await runStep(step, out, env);
      report.results.push(result);
      if (result.status !== 'PASS') throw new Error('preview_build_failed');
    }
    const add = (relative, data, mode = 0o644, origin = 'generated') => {
      if (
        path.isAbsolute(relative) ||
        relative.split('/').some((p) => !p || p === '.' || p === '..' || p.startsWith('.'))
      )
        throw new Error('invalid_archive_path');
      if (report.entries.some((e) => e.path === relative)) throw new Error('duplicate_archive_path');
      if (report.entries.length >= 5000 || data.length > 2 * 1024 * 1024) throw new Error('preview_entry_limit');
      const target = path.join(stage, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data, { flag: 'wx', mode });
      report.entries.push({ path: relative, bytes: data.length, sha256: sha(data), mode: mode.toString(8), origin });
    };
    const generated = (relative) => {
      const file = path.join(out, relative);
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(file) !== file)
        throw new Error('unsafe_generated_output');
      return fs.readFileSync(file);
    };
    for (const source of inputs) {
      const main = outputForSource(source);
      if (main) add(main, generated(`main/${main.slice(5)}`), 0o644, source);
      const mcp = outputForSource(source, true);
      // MCP compiles its own sources and only the root modules it imports, not every CLI.
      const mcpOutput = `mcp/${source.slice(0, -3)}.js`;
      if (mcp && (source.startsWith('packages/hud-mcp/src/') || fs.existsSync(path.join(out, mcpOutput))))
        add(mcp, generated(mcpOutput), 0o644, source);
    }
    for (const [source, output] of Object.entries(REQUIRED_OUTPUTS)) {
      if (!report.entries.some((entry) => entry.path === output && entry.origin === source))
        throw new Error(`missing_required_runtime_output: ${output}`);
    }
    // The sole tracked runtime JSON input is explicit, not a recursive JSON/config glob.
    const cells = 'src/core/launch/codex-cells.json';
    if (!tracked.includes(cells)) throw new Error('missing_runtime_json');
    const cellBytes = fs.readFileSync(safeFile(cells));
    add('dist/core/launch/codex-cells.json', cellBytes, 0o644, cells);
    add('packages/hud-mcp/dist/src/core/launch/codex-cells.json', cellBytes, 0o644, cells);
    for (const file of [...ENTRYPOINTS, ...EXTRA_FILES]) {
      if (!tracked.includes(file)) throw new Error('untracked_package_input');
      add(
        file,
        fs.readFileSync(safeFile(file)),
        file.includes('/bin/') || file.startsWith('bin/') ? 0o755 : 0o644,
        file
      );
    }
    for (const file of ['package.json', 'packages/hud-mcp/package.json']) {
      const manifest = previewManifest(JSON.parse(fs.readFileSync(safeFile(file), 'utf8')), file !== 'package.json');
      add(file, Buffer.from(JSON.stringify(manifest, null, 2) + '\n'), 0o644, file);
    }
    add(
      'CLOUD-PREVIEW.json',
      Buffer.from(JSON.stringify({ ...metadata(), warning: report.limitations }, null, 2) + '\n')
    );
    if (report.entries.reduce((sum, e) => sum + e.bytes, 0) > 50 * 1024 * 1024) throw new Error('preview_size_limit');
    report.entries.sort((a, b) => a.path.localeCompare(b.path));
    const archive = `codex-hud-cloud-preview-${report.repositorySha.slice(0, 12)}.tgz`;
    const packed = await runStep(
      {
        name: 'archive',
        executable: '/usr/bin/tar',
        args: [
          '--sort=name',
          '--mtime=@0',
          '--owner=0',
          '--group=0',
          '--numeric-owner',
          '-czf',
          path.join(out, archive),
          '-C',
          path.dirname(stage),
          'package',
        ],
        timeoutMs: 30000,
      },
      out,
      env
    );
    report.results.push(packed);
    if (packed.status !== 'PASS') throw new Error('archive_failed');
    const listing = await runStep(
      { name: 'archive-list', executable: '/usr/bin/tar', args: ['-tzf', path.join(out, archive)], timeoutMs: 30000 },
      out,
      env
    );
    report.results.push(listing);
    if (listing.status !== 'PASS') throw new Error('archive_list_failed');
    const names = fs
      .readFileSync(path.join(out, 'archive-list.log'), 'utf8')
      .trim()
      .split('\n')
      .filter((p) => !p.endsWith('/'))
      .sort();
    assert.deepEqual(names, report.entries.map((e) => `package/${e.path}`).sort());
    report.archive = { file: archive, sha256: sha(fs.readFileSync(path.join(out, archive))) };
    report.status = 'PASS';
    console.log(`PASS: ${report.entries.length} allowlisted files; no publish or install`);
  } catch (error) {
    report.status = 'FAIL';
    report.reason = error.message;
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(path.join(out, 'preview-manifest.json'), JSON.stringify(report, null, 2) + '\n');
    for (const name of ['stage', 'main', 'mcp', 'home', 'temp'])
      fs.rmSync(path.join(out, name), { recursive: true, force: true });
    console.log(`Preview receipt: ${path.relative(ROOT, out)}/preview-manifest.json`);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
