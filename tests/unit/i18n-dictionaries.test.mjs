import assert from 'node:assert/strict';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../../', import.meta.url));
const untranslated = new Set(); // Literal panel keys intentionally left in English.
const dictionaries = [
  ['src/render/i18n.ts', 'ZH'],
  ['src/render/workboard-i18n.ts', 'WORKBOARD_ZH'],
];

function location(node) {
  const file = node.getSourceFile();
  const { line } = file.getLineAndCharacterOfPosition(node.getStart());
  return `${relative(root, file.fileName)}:${line + 1}`;
}

function* entries(program, path, binding) {
  const file = program.getSourceFile(join(root, path));
  const declaration = file?.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .find((node) => ts.isIdentifier(node.name) && node.name.text === binding);
  const object = declaration?.initializer;
  assert.ok(object && ts.isObjectLiteralExpression(object), `${path}: expected ${binding} to be an object literal`);
  for (const property of object.properties) {
    if (ts.isSpreadAssignment(property)) continue; // Inspect each dictionary's own entries before the spread.
    assert.ok(ts.isPropertyAssignment(property), `${location(property)}: expected a dictionary entry`);
    const { name, initializer } = property;
    assert.ok(
      (ts.isIdentifier(name) || ts.isStringLiteral(name)) && ts.isStringLiteralLike(initializer),
      `${location(property)}: expected a static dictionary key and translation`
    );
    yield [name.text, initializer.text, location(property)];
  }
}

function isTranslationCall(callee, checker) {
  // Use the binding so aliases count, but a local function or a shadowed import does not.
  const specifier = checker.getSymbolAtLocation(callee)?.declarations?.[0];
  if (!specifier || !ts.isImportSpecifier(specifier) || (specifier.propertyName ?? specifier.name).text !== 't') {
    return false;
  }
  const module = specifier.parent.parent.parent.moduleSpecifier;
  return (
    ts.isStringLiteral(module) &&
    module.text.startsWith('.') &&
    resolve(dirname(specifier.getSourceFile().fileName), module.text) === join(root, 'src/render/i18n.js')
  );
}

// Match the runtime's placeholder syntax. Order and repeated uses may differ by language.
function placeholders(text) {
  const names = Array.from(text.matchAll(/\{(\w+)\}/g), (match) => match[1]);
  return [...new Set(names)].sort().join(', ');
}

test('Chinese dictionaries have unique keys, cover literal t() calls, and preserve placeholders', () => {
  const files = ts.sys.readDirectory(join(root, 'src'), ['.ts']).sort();
  // Only local import bindings are needed; don't load libraries or dependencies.
  const program = ts.createProgram(files, { noLib: true, noResolve: true, types: [] });
  const checker = program.getTypeChecker();
  const en = new Map(
    Array.from(entries(program, 'src/render/i18n.ts', 'EN_OVERRIDES'), ([key, value]) => [key, value])
  );
  const zh = new Map();
  const problems = [];
  for (const [path, name] of dictionaries) {
    for (const [key, value, at] of entries(program, path, name)) {
      if (!zh.has(key)) zh.set(key, []);
      zh.get(key).push(`${at} (${JSON.stringify(value)})`);
      const expected = placeholders(en.get(key) ?? key);
      const actual = placeholders(value);
      if (expected !== actual) {
        problems.push(`${at}: placeholder mismatch for ${JSON.stringify(key)} (EN: [${expected}]; ZH: [${actual}])`);
      }
    }
  }
  for (const [key, definitions] of zh) {
    if (definitions.length > 1) problems.push(`duplicate ${JSON.stringify(key)}: ${definitions.join(', ')}`);
  }

  function visit(node) {
    if (ts.isCallExpression(node)) {
      const [key] = node.arguments;
      if (
        key &&
        ts.isStringLiteralLike(key) &&
        !zh.has(key.text) &&
        !untranslated.has(key.text) &&
        ts.isIdentifier(node.expression) &&
        isTranslationCall(node.expression, checker)
      ) {
        problems.push(`${location(node)}: missing Chinese entry for ${JSON.stringify(key.text)}`);
      }
    }
    ts.forEachChild(node, visit);
  }
  for (const file of program.getSourceFiles()) visit(file);

  assert.ok(problems.length === 0, `\n${problems.join('\n')}`);
});
