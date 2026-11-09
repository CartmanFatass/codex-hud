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

export const ROOT_BINS = {
  'codex-hud': 'bin/codex-hud',
  hud: 'bin/hud',
  'hud-run': 'bin/hud-run',
  'hud-statusline': 'bin/hud-statusline',
};
const ENTRYPOINTS = Object.values(ROOT_BINS);
export const REQUIRED_OUTPUTS = {
  'src/cli/statusline.ts': 'dist/cli/statusline.js',
  'src/cli/install.ts': 'dist/cli/install.js',
  'src/cli/roster.ts': 'dist/cli/roster.js',
  'src/cli/setup.ts': 'dist/cli/setup.js',
  'src/cli/wait.ts': 'dist/cli/wait.js',
  'src/cli/hud-main.ts': 'dist/cli/hud-main.js',
  'src/cli/private-home.ts': 'dist/cli/private-home.js',
  'src/harness/pi/managed-launch.ts': 'dist/harness/pi/managed-launch.js',
  'src/harness/claude/managed-launch.ts': 'dist/harness/claude/managed-launch.js',
  'src/core/run/launch-artifacts.ts': 'dist/core/run/launch-artifacts.js',
  'src/harness/pi/wake-extension.ts': 'dist/harness/pi/wake-extension.js',
  'src/managed/wake-message.ts': 'dist/managed/wake-message.js',
  'src/harness/pi/footer.ts': 'dist/harness/pi/footer.js',
  'src/harness/pi/delegation-bridge.ts': 'dist/harness/pi/delegation-bridge.js',
  'src/harness/pi/delegation-channel.ts': 'dist/harness/pi/delegation-channel.js',
  'src/harness/pi/delegation-context.ts': 'dist/harness/pi/delegation-context.js',
  'src/roles/adapters.ts': 'dist/roles/adapters.js',
  'src/roles/association.ts': 'dist/roles/association.js',
  'src/roles/caller.ts': 'dist/roles/caller.js',
  'src/roles/facade.ts': 'dist/roles/facade.js',
  'src/roles/herdr-run.ts': 'dist/roles/herdr-run.js',
  'src/roles/index.ts': 'dist/roles/index.js',
  'src/roles/job-store.ts': 'dist/roles/job-store.js',
  'src/roles/job-receipt.ts': 'dist/roles/job-receipt.js',
  'src/roles/job-wait.ts': 'dist/roles/job-wait.js',
  'src/roles/launch.ts': 'dist/roles/launch.js',
  'src/roles/pi-dispatch.ts': 'dist/roles/pi-dispatch.js',
  'src/roles/pi-dispatch-status.ts': 'dist/roles/pi-dispatch-status.js',
  'src/roles/role-tools.ts': 'dist/roles/role-tools.js',
  'src/roles/roles.ts': 'dist/roles/roles.js',
  'src/roles/routing.ts': 'dist/roles/routing.js',
  'src/roles/selection.ts': 'dist/roles/selection.js',
  'src/jev/agent.ts': 'dist/jev/agent.js',
  'src/jev/ask/chrome.ts': 'dist/jev/ask/chrome.js',
  'src/jev/ask/config.ts': 'dist/jev/ask/config.js',
  'src/jev/ask/error.ts': 'dist/jev/ask/error.js',
  'src/jev/ask/lease.ts': 'dist/jev/ask/lease.js',
  'src/jev/ask/names.ts': 'dist/jev/ask/names.js',
  'src/jev/ask/records.ts': 'dist/jev/ask/records.js',
  'src/jev/browser.ts': 'dist/jev/browser.js',
  'src/jev/cdp.ts': 'dist/jev/cdp.js',
  'src/jev/decide.ts': 'dist/jev/decide.js',
  'src/jev/judge.ts': 'dist/jev/judge.js',
  'src/jev/model.ts': 'dist/jev/model.js',
  'src/jev/providers/openai.ts': 'dist/jev/providers/openai.js',
  'src/jev/providers/typesafe.ts': 'dist/jev/providers/typesafe.js',
  'src/jev/questions.ts': 'dist/jev/questions.js',
  'src/jev/runtime/aistudio-facts.ts': 'dist/jev/runtime/aistudio-facts.js',
  'src/jev/runtime/aistudio-state.ts': 'dist/jev/runtime/aistudio-state.js',
  'src/jev/runtime/aistudio.ts': 'dist/jev/runtime/aistudio.js',
  'src/jev/runtime/chatgpt-facts.ts': 'dist/jev/runtime/chatgpt-facts.js',
  'src/jev/runtime/chatgpt.ts': 'dist/jev/runtime/chatgpt.js',
  'src/jev/runtime/client.ts': 'dist/jev/runtime/client.js',
  'src/jev/runtime/diagnostic.ts': 'dist/jev/runtime/diagnostic.js',
  'src/jev/runtime/oracle-read.ts': 'dist/jev/runtime/oracle-read.js',
  'src/jev/runtime/entry.ts': 'dist/jev/runtime/entry.js',
  'src/jev/runtime/executor.ts': 'dist/jev/runtime/executor.js',
  'src/jev/runtime/fake.ts': 'dist/jev/runtime/fake.js',
  'src/jev/runtime/index.ts': 'dist/jev/runtime/index.js',
  'src/jev/runtime/ipc.ts': 'dist/jev/runtime/ipc.js',
  'src/jev/runtime/oracle.ts': 'dist/jev/runtime/oracle.js',
  'src/jev/runtime/types.ts': 'dist/jev/runtime/types.js',
};
/**
 * hud-mcp outputs the role entry imports. `src/cli/{roster,wait,setup}.ts` and
 * `src/jev/runtime/entry.ts` are root-build only; that tsconfig does not reach them.
 */
export const MCP_RUNTIME_OUTPUTS = [
  'packages/hud-mcp/dist/packages/hud-mcp/src/role-main.js',
  'packages/hud-mcp/dist/packages/hud-mcp/src/role-extension.js',
  'packages/hud-mcp/dist/packages/hud-mcp/src/surface.js',
  'packages/hud-mcp/dist/src/roles/adapters.js',
  'packages/hud-mcp/dist/src/roles/association.js',
  'packages/hud-mcp/dist/src/roles/caller.js',
  'packages/hud-mcp/dist/src/roles/facade.js',
  'packages/hud-mcp/dist/src/roles/herdr-run.js',
  'packages/hud-mcp/dist/src/roles/job-store.js',
  'packages/hud-mcp/dist/src/roles/job-receipt.js',
  'packages/hud-mcp/dist/src/roles/job-wait.js',
  'packages/hud-mcp/dist/src/roles/launch.js',
  'packages/hud-mcp/dist/src/roles/pi-dispatch.js',
  'packages/hud-mcp/dist/src/roles/pi-dispatch-status.js',
  'packages/hud-mcp/dist/src/roles/role-tools.js',
  'packages/hud-mcp/dist/src/roles/roles.js',
  'packages/hud-mcp/dist/src/roles/routing.js',
  'packages/hud-mcp/dist/src/roles/selection.js',
  'packages/hud-mcp/dist/src/jev/agent.js',
  'packages/hud-mcp/dist/src/jev/ask/chrome.js',
  'packages/hud-mcp/dist/src/jev/ask/config.js',
  'packages/hud-mcp/dist/src/jev/ask/error.js',
  'packages/hud-mcp/dist/src/jev/ask/lease.js',
  'packages/hud-mcp/dist/src/jev/ask/names.js',
  'packages/hud-mcp/dist/src/jev/ask/records.js',
  'packages/hud-mcp/dist/src/jev/browser.js',
  'packages/hud-mcp/dist/src/jev/cdp.js',
  'packages/hud-mcp/dist/src/jev/decide.js',
  'packages/hud-mcp/dist/src/jev/judge.js',
  'packages/hud-mcp/dist/src/jev/model.js',
  'packages/hud-mcp/dist/src/jev/providers/openai.js',
  'packages/hud-mcp/dist/src/jev/providers/typesafe.js',
  'packages/hud-mcp/dist/src/jev/questions.js',
  'packages/hud-mcp/dist/src/jev/runtime/aistudio-facts.js',
  'packages/hud-mcp/dist/src/jev/runtime/aistudio-state.js',
  'packages/hud-mcp/dist/src/jev/runtime/aistudio.js',
  'packages/hud-mcp/dist/src/jev/runtime/chatgpt-facts.js',
  'packages/hud-mcp/dist/src/jev/runtime/chatgpt.js',
  'packages/hud-mcp/dist/src/jev/runtime/client.js',
  'packages/hud-mcp/dist/src/jev/runtime/diagnostic.js',
  'packages/hud-mcp/dist/src/jev/runtime/oracle-read.js',
  'packages/hud-mcp/dist/src/jev/runtime/executor.js',
  'packages/hud-mcp/dist/src/jev/runtime/fake.js',
  'packages/hud-mcp/dist/src/jev/runtime/index.js',
  'packages/hud-mcp/dist/src/jev/runtime/ipc.js',
  'packages/hud-mcp/dist/src/jev/runtime/oracle.js',
  'packages/hud-mcp/dist/src/jev/runtime/types.js',
];
const EXTENSION_ENTRIES = ['extensions/pi/hud-footer.ts', 'extensions/pi/hud-delegate.ts'];
export const EXTRA_FILES = [
  'README.md',
  'bin/hud-statusline-preview',
  ...EXTENSION_ENTRIES,
  'integrations/pi/hud-wake.ts',
  'integrations/skills/hud-delegate/SKILL.md',
  'integrations/claude/README.md',
  'integrations/pi/package/README.md',
  'packages/hud-mcp/bin/hud-mcp.mjs',
  // The wrapper imports this sibling. A release without it cannot start.
  'packages/hud-mcp/bin/surface.mjs',
  'packages/hud-mcp/bin/hud-claude-hook.mjs',
  // Explicit non-TS runtime asset shared by source/compiled host entrypoints.
  'src/managed/jev-bridge.py',
  // Jev snapshot body and the MIT notice that has to travel with the port.
  'src/jev/snapshot.js',
  'THIRD_PARTY_NOTICES.md',
];
export function outputForSource(file, mcp = false) {
  if (!/^(src\/|packages\/hud-mcp\/src\/)/.test(file) || !file.endsWith('.ts') || file.endsWith('.d.ts')) return null;
  const js = file.slice(0, -3) + '.js';
  return mcp ? `packages/hud-mcp/dist/${js}` : file.startsWith('src/') ? `dist/${js.slice(4)}` : null;
}
// Shared exact tracked-source/fresh-build selection. Neither caller recursively packs dist.
export function selectedOutputs(inputs, hasOutput) {
  const selected = [];
  for (const source of inputs) {
    const main = outputForSource(source);
    if (main) selected.push({ source, output: main, generatedPath: `main/${main.slice(5)}` });
    const mcp = outputForSource(source, true);
    const generatedPath = `mcp/${source.slice(0, -3)}.js`;
    if (mcp && (source.startsWith('packages/hud-mcp/src/') || hasOutput(generatedPath)))
      selected.push({ source, output: mcp, generatedPath });
  }
  return selected;
}
export function previewManifest(original, mcp = false, releaseVersion = original.version) {
  if (typeof original.name !== 'string' || typeof original.version !== 'string' || original.type !== 'module')
    throw new Error('invalid_package_manifest');
  // One canonical release version for every manifest in the release.
  if (typeof releaseVersion !== 'string' || !releaseVersion) throw new Error('invalid_release_version');
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
    version: releaseVersion,
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
  const built = selectedOutputs(Object.keys(REQUIRED_OUTPUTS), (file) =>
    fs.existsSync(path.join(ROOT, 'packages/hud-mcp/dist', file.slice(4)))
  );
  for (const [source, output] of Object.entries(REQUIRED_OUTPUTS)) {
    assert.equal(outputForSource(source), output);
    assert.ok(fs.lstatSync(safeFile(source)).isFile(), source);
    assert.ok(fs.lstatSync(path.join(ROOT, output)).isFile(), `missing build output: ${output}`);
    assert.ok(
      built.some((entry) => entry.source === source && entry.output === output),
      output
    );
  }
  for (const output of MCP_RUNTIME_OUTPUTS)
    assert.ok(fs.lstatSync(path.join(ROOT, output)).isFile(), `missing MCP build output: ${output}`);
  assert.equal(EXTRA_FILES.filter((file) => file.startsWith('extensions/')).length, 2);
  for (const entry of EXTENSION_ENTRIES) assert.equal(EXTRA_FILES.includes(entry), true);
  assert.equal(EXTRA_FILES.includes('src/managed/jev-bridge.py'), true);
  assert.equal(EXTRA_FILES.includes('src/jev/snapshot.js'), true);
  assert.equal(EXTRA_FILES.includes('THIRD_PARTY_NOTICES.md'), true);
  assert.equal(EXTRA_FILES.includes('integrations/pi/hud-wake.ts'), true);
  assert.equal(EXTRA_FILES.includes('packages/hud-mcp/bin/surface.mjs'), true);
  const { REQUIRED } = await import('./runtime-package/manifest.mjs');
  for (const file of ['packages/hud-mcp/bin/surface.mjs', ...Object.values(REQUIRED_OUTPUTS), ...MCP_RUNTIME_OUTPUTS])
    assert.equal(REQUIRED.includes(file), true, file);
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
  let original;
  try {
    original = JSON.parse(fs.readFileSync(safeFile('package.json'), 'utf8'));
  } catch (cause) {
    throw new Error('invalid_package_manifest', { cause });
  }
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
      'source TS except the two explicit Pi extension entries',
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
    for (const { source, output, generatedPath } of selectedOutputs(inputs, (file) =>
      fs.existsSync(path.join(out, file))
    ))
      add(output, generated(generatedPath), 0o644, source);
    for (const [source, output] of Object.entries(REQUIRED_OUTPUTS)) {
      if (!report.entries.some((entry) => entry.path === output && entry.origin === source))
        throw new Error(`missing_required_runtime_output: ${output}`);
    }
    // Explicit runtime capability manifests, never a recursive JSON/config glob.
    for (const name of ['codex-cells.json', 'managed-cells.json']) {
      const cells = `src/core/launch/${name}`;
      if (!tracked.includes(cells)) throw new Error('missing_runtime_json');
      const cellBytes = fs.readFileSync(safeFile(cells));
      add(`dist/core/launch/${name}`, cellBytes, 0o644, cells);
      add(`packages/hud-mcp/dist/src/core/launch/${name}`, cellBytes, 0o644, cells);
    }
    for (const file of [...ENTRYPOINTS, ...EXTRA_FILES]) {
      if (!tracked.includes(file)) throw new Error('untracked_package_input');
      add(
        file,
        fs.readFileSync(safeFile(file)),
        file.includes('/bin/') || file.startsWith('bin/') ? 0o755 : 0o644,
        file
      );
    }
    const releaseVersion = JSON.parse(fs.readFileSync(safeFile('package.json'), 'utf8')).version;
    for (const file of ['package.json', 'packages/hud-mcp/package.json']) {
      const manifest = previewManifest(
        JSON.parse(fs.readFileSync(safeFile(file), 'utf8')),
        file !== 'package.json',
        releaseVersion
      );
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
