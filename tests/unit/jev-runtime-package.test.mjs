// The packaged Jev runtime is only as complete as the lists that select it. Derive the real
// relative-import closure of the emitted JS and fail when a dependency is missing from any list.
// The entry and its providers are parsed, never imported or executed.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { REQUIRED_OUTPUTS, MCP_RUNTIME_OUTPUTS, EXTRA_FILES } from '../../scripts/pack-cloud-preview.mjs';
import { REQUIRED } from '../../scripts/runtime-package/manifest.mjs';
import { MINIMUM_RUNTIME_FILES } from '../../dist/core/runtime-build.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ROOT_ENTRY = 'dist/jev/runtime/entry.js';
const MCP_ENTRY = 'packages/hud-mcp/dist/src/jev/runtime/executor.js';
const SNAPSHOT_ASSET = 'src/jev/snapshot.js';
const ROOT_LISTS = {
  REQUIRED_OUTPUTS: Object.values(REQUIRED_OUTPUTS),
  REQUIRED,
  MINIMUM_RUNTIME_FILES,
};
const MCP_LISTS = {
  MCP_RUNTIME_OUTPUTS,
  REQUIRED,
  MINIMUM_RUNTIME_FILES,
};

/** Static import/export specifiers plus string-literal `import()` calls of one emitted JS file. */
function relativeSpecifiers(file) {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  );
  const found = [];
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    )
      found.push(node.moduleSpecifier.text);
    else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0])
    )
      found.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Repo-relative POSIX path of a resolvable relative specifier, or null. */
function resolveRelative(root, from, specifier) {
  if (!specifier.startsWith('.')) return null;
  const target = path.resolve(path.dirname(path.join(root, from)), specifier);
  for (const candidate of [target, `${target}.js`, path.join(target, 'index.js')])
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile())
      return path.relative(root, candidate).split(path.sep).join('/');
  return null;
}

/** Every relative-import dist JS path reachable from `entry`. Bare node:/npm imports are ignored. */
function importClosure(root, entry) {
  const files = new Set();
  const missing = [];
  const bare = new Set();
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift();
    if (files.has(file)) continue;
    files.add(file);
    for (const specifier of relativeSpecifiers(path.join(root, file))) {
      const target = resolveRelative(root, file, specifier);
      if (target) {
        if (!files.has(target)) queue.push(target);
      } else if (specifier.startsWith('.')) missing.push(`${file} -> ${specifier}`);
      else bare.add(specifier);
    }
  }
  return { files: [...files].sort(), missing, bare: [...bare].sort() };
}

/** Closure entries absent from one or more of the packaging lists. */
function drift(closure, lists) {
  const absent = [];
  for (const file of closure)
    for (const [name, entries] of Object.entries(lists)) if (!entries.includes(file)) absent.push(`${name}: ${file}`);
  return absent.sort();
}

function declaredDependencies() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  return new Set(Object.keys(manifest.dependencies ?? {}));
}

test('derived root Jev runtime closure is selected by every root packaging list', () => {
  assert.ok(fs.existsSync(path.join(ROOT, ROOT_ENTRY)), `missing ${ROOT_ENTRY}; run npm run build`);
  const closure = importClosure(ROOT, ROOT_ENTRY);
  assert.deepEqual(closure.missing, [], 'unresolved relative import in the closure');
  assert.ok(closure.files.includes(ROOT_ENTRY));
  assert.ok(closure.files.length > 1);
  for (const file of closure.files) assert.ok(fs.existsSync(path.join(ROOT, file)), file);
  assert.deepEqual(drift(closure.files, ROOT_LISTS), []);
  const declared = declaredDependencies();
  for (const specifier of closure.bare)
    assert.ok(specifier.startsWith('node:') || declared.has(specifier), `unpackaged bare import: ${specifier}`);
});

test('derived hud-mcp Jev runtime closure is selected by every MCP packaging list', () => {
  assert.ok(fs.existsSync(path.join(ROOT, MCP_ENTRY)), `missing ${MCP_ENTRY}; run npm run build:hud-mcp`);
  const closure = importClosure(ROOT, MCP_ENTRY);
  assert.deepEqual(closure.missing, [], 'unresolved relative import in the closure');
  assert.ok(closure.files.includes(MCP_ENTRY));
  for (const file of closure.files) assert.ok(fs.existsSync(path.join(ROOT, file)), file);
  assert.deepEqual(drift(closure.files, MCP_LISTS), []);
  const declared = declaredDependencies();
  for (const specifier of closure.bare)
    assert.ok(specifier.startsWith('node:') || declared.has(specifier), `unpackaged bare import: ${specifier}`);
});

test('closure stays inside Jev plus the one neutral HUD-home resolver; other entries are rejected', (t) => {
  const root = importClosure(ROOT, ROOT_ENTRY);
  const mcp = importClosure(ROOT, MCP_ENTRY);
  assert.deepEqual(
    root.files.filter((file) => !file.startsWith('dist/jev/')),
    ['dist/hud-home.js']
  );
  assert.deepEqual(
    mcp.files.filter((file) => !file.startsWith('packages/hud-mcp/dist/src/jev/')),
    ['packages/hud-mcp/dist/src/hud-home.js']
  );
  for (const home of ['dist/hud-home.js', 'packages/hud-mcp/dist/src/hud-home.js']) {
    const neutral = importClosure(ROOT, home);
    assert.deepEqual(neutral.files, [home]);
    assert.deepEqual(neutral.missing, []);
    assert.ok(neutral.bare.every((specifier) => specifier.startsWith('node:')));
  }
  const nonRuntime = root.files.filter((file) => !file.startsWith('dist/jev/runtime/'));
  t.diagnostic(`non-Jev-runtime closure (${nonRuntime.length}): ${nonRuntime.join(', ')}`);
  assert.ok(nonRuntime.length > 0);
  for (const file of nonRuntime) {
    const source = file.replace(/^dist\//, 'src/').replace(/\.js$/, '.ts');
    assert.ok(fs.existsSync(path.join(ROOT, source)), source);
  }
});

test('explicit non-TS snapshot asset stays selected beside the derived closure', () => {
  assert.ok(EXTRA_FILES.includes(SNAPSHOT_ASSET));
  assert.ok(REQUIRED.includes(SNAPSHOT_ASSET));
  assert.ok(fs.existsSync(path.join(ROOT, SNAPSHOT_ASSET)));
  // The asset is located at run time, so no import edge reaches it: the explicit entry is the only guard.
  const closure = importClosure(ROOT, ROOT_ENTRY);
  assert.equal(closure.files.includes(SNAPSHOT_ASSET), false);
  assert.equal(closure.files.includes('dist/jev/snapshot.js'), false);
});

test('packaging lists carry no duplicate entries', () => {
  for (const [name, entries] of Object.entries({
    REQUIRED_OUTPUTS: Object.values(REQUIRED_OUTPUTS),
    MCP_RUNTIME_OUTPUTS,
    REQUIRED,
    MINIMUM_RUNTIME_FILES,
  })) {
    const seen = new Set();
    for (const entry of entries) {
      assert.equal(seen.has(entry), false, `${name} duplicate: ${entry}`);
      seen.add(entry);
    }
  }
});

test('negative fixture: removing one dependency is detected as drift', (t) => {
  const closure = importClosure(ROOT, ROOT_ENTRY);
  const removed = 'dist/jev/runtime/chatgpt.js';
  assert.ok(closure.files.includes(removed));
  assert.deepEqual(drift(closure.files, ROOT_LISTS), []);

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-runtime-closure-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  fs.cpSync(path.join(ROOT, 'dist/jev'), path.join(temporary, 'dist/jev'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'dist/hud-home.js'), path.join(temporary, 'dist/hud-home.js'));
  fs.rmSync(path.join(temporary, removed));
  const broken = importClosure(temporary, ROOT_ENTRY);
  assert.equal(broken.files.includes(removed), false);
  assert.ok(
    broken.missing.some((entry) => entry.endsWith('-> ./chatgpt.js')),
    JSON.stringify(broken.missing)
  );

  const lists = { ...ROOT_LISTS, REQUIRED_OUTPUTS: ROOT_LISTS.REQUIRED_OUTPUTS.filter((file) => file !== removed) };
  assert.deepEqual(drift(closure.files, lists), [`REQUIRED_OUTPUTS: ${removed}`]);
});
