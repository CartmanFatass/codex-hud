import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
function graph(entry) {
  const seen = new Set();
  function visit(file) {
    if (seen.has(file)) return;
    seen.add(file);
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS
    );
    const take = (spec) => {
      if (!spec.startsWith('.')) return;
      const next = resolve(dirname(file), spec);
      assert.ok(existsSync(next), `unresolved runtime import ${next}`);
      visit(next);
    };
    function walk(node) {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        take(node.moduleSpecifier.text);
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length === 1 &&
        ts.isStringLiteral(node.arguments[0])
      )
        take(node.arguments[0].text);
      ts.forEachChild(node, walk);
    }
    walk(source);
  }
  visit(resolve(root, entry));
  return [...seen].map((path) => path.slice(root.length + 1));
}
test('R5 bar runtime import graph reaches none of the new observation/composition modules', () => {
  const files = graph('dist/index.js');
  assert.ok(files.length > 20);
  assert.deepEqual(
    files.filter((path) => /collectors\/job-(?:display-types|observations|live-observation|tree)\.js$/.test(path)),
    []
  );
});
test('R5 panel reaches collector but not facade, Jev adapter/client/executor/factory', () => {
  const files = graph('dist/tree-page.js');
  assert.ok(files.includes('dist/collectors/job-observations.js'));
  assert.deepEqual(
    files.filter((path) =>
      /roles\/(?:facade|jev-adapter)\.js$|jev\/runtime\/(?:client|executor|index)\.js$/.test(path)
    ),
    []
  );
});
test('R5 collector runtime graph cannot reach facade, Jev adapter/client/executor/factory', () => {
  const files = graph('dist/collectors/job-observations.js');
  assert.ok(files.includes('dist/collectors/job-live-observation.js'));
  assert.deepEqual(
    files.filter((path) =>
      /roles\/(?:facade|jev-adapter)\.js$|jev\/runtime\/(?:client|executor|index)\.js$/.test(path)
    ),
    []
  );
});
