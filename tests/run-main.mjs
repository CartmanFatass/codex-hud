#!/usr/bin/env node
/**
 * Main-feature gate for tests/run-main.sh (native HUD v2.2 §7.1).
 *
 * tests/main-features.json has one shape. `tests` maps each main test path to
 * its branch carrier. The gate checks that map; it does not read git history.
 *
 * - `coverage` is the stored list of main test paths. The keys of `tests` must
 *   equal it. `changed` must be a non-empty string and cannot be combined with
 *   `branch`.
 * - Each assertion of a node:test carrier must be a passed TAP `ok` line.
 *   A `${...}` title is a pattern (each interpolation is `.+`).
 *   node --test writes `\` as `\\` and `#` as `\#` in that line. The check
 *   reverses those two escapes before comparing with the source title.
 * - Each kept scene stores the sha256 of the baseline frame. The branch frame
 *   must hash to the same value.
 * - `assertStatements` stores the sha256 of each main `assert*` statement
 *   (Prettier-normalised for JS/TS, whitespace-collapsed otherwise). The same
 *   statement must still occur in the carrier, unless `assertExceptions` lists
 *   that hash under the assertion it belongs to. A replacement `branch` hash,
 *   when present, must occur instead.
 *
 * `node --test` runs the same files main's `npm test` runs: compiled
 * `tests/unit/*.test.ts` and `tests/unit/*.mjs`, plus the visual baselines
 * test. Integration shell scripts run only when RUN_MAIN_INTEGRATION=1, and
 * only the ones marked `"integration": "opt-in"`. Exit 77 is a skip. The rest
 * are `{ "manual": "<reason>" }` and are not executed.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import * as prettier from 'prettier';

const ts = createRequire(import.meta.url)('typescript');

export const MANIFEST_PATH = 'tests/main-features.json';
export const VISUAL_BASELINE_TEST = 'dist-test/tests/unit/visual-baselines.test.js';
export const VISUAL_BASELINES = 'tests/fixtures/visual-baselines.json';

const COMPILED_UNIT_TEST = /^(tests\/unit\/[^/]+)\.test\.ts$/;
const DIRECT_UNIT_TEST = /^tests\/unit\/[^/]+\.mjs$/;
const PRETTIER_OPTIONS = {
  printWidth: 120,
  tabWidth: 2,
  useTabs: false,
  semi: true,
  singleQuote: true,
  trailingComma: 'es5',
};

export class MainFeaturesError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MainFeaturesError';
  }
}

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

const collapse = (value) => value.replace(/\s+/g, ' ').trim();

export function assertStatementHash(statement) {
  return createHash('sha256').update(statement).digest('hex');
}

export function parseManifest(text, source = MANIFEST_PATH) {
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    throw new MainFeaturesError(`${source}: invalid JSON: ${error.message}`);
  }
  if (!isRecord(manifest)) throw new MainFeaturesError(`${source}: expected a JSON object`);
  return manifest;
}

export function readManifest(path = MANIFEST_PATH) {
  if (!existsSync(path)) throw new MainFeaturesError(`manifest not found: ${path}`);
  return parseManifest(readFileSync(path, 'utf8'), path);
}

/** The map of main test path -> manifest entry. Only `{ tests }` is accepted. */
export function testEntries(manifest, source = MANIFEST_PATH) {
  if (!isRecord(manifest) || !isRecord(manifest.tests)) {
    throw new MainFeaturesError(
      `${source}: expected { tests: { "<main test path>": ... } } ` +
        `(top-level keys: ${isRecord(manifest) ? Object.keys(manifest).join(', ') || '(none)' : typeof manifest})`
    );
  }
  return manifest.tests;
}

function validateEntry(mainFile, entry, source) {
  if (!isRecord(entry)) {
    throw new MainFeaturesError(`${source}: ${mainFile}: expected an object with "branch" or "changed"`);
  }
  const hasChanged = Object.prototype.hasOwnProperty.call(entry, 'changed');
  const hasBranch = Object.prototype.hasOwnProperty.call(entry, 'branch');
  if (hasChanged && hasBranch) {
    throw new MainFeaturesError(`${source}: ${mainFile}: an entry cannot have both "changed" and "branch"`);
  }
  if (hasChanged) {
    if (typeof entry.changed !== 'string' || entry.changed.trim() === '') {
      throw new MainFeaturesError(`${source}: ${mainFile}: "changed" must be a non-empty string`);
    }
    return;
  }
  if (!Array.isArray(entry.branch) || entry.branch.some((file) => typeof file !== 'string' || file.trim() === '')) {
    throw new MainFeaturesError(`${source}: ${mainFile}: expected a "branch" array of non-empty strings`);
  }
  for (const file of entry.branch) {
    if (file.startsWith('/') || file.split('/').includes('..')) {
      throw new MainFeaturesError(`${source}: ${mainFile}: branch entry must be repo-relative: ${file}`);
    }
  }
  if (!Array.isArray(entry.assertions) || entry.assertions.some((title) => typeof title !== 'string')) {
    throw new MainFeaturesError(`${source}: ${mainFile}: "assertions" must be an array of strings`);
  }
  if (!Array.isArray(entry.assertStatements) || entry.assertStatements.some((hash) => !/^[0-9a-f]{64}$/.test(hash))) {
    throw new MainFeaturesError(`${source}: ${mainFile}: "assertStatements" must be an array of sha256 hashes`);
  }
  if (entry.divergence !== undefined) {
    if (!isRecord(entry.divergence)) {
      throw new MainFeaturesError(`${source}: ${mainFile}: "divergence" must be a map of assertion title to reason`);
    }
    for (const [title, reason] of Object.entries(entry.divergence)) {
      if (!entry.assertions.includes(title)) {
        throw new MainFeaturesError(`${source}: ${mainFile}: divergence title is not an assertion: ${title}`);
      }
      if (typeof reason !== 'string' || reason.trim() === '') {
        throw new MainFeaturesError(`${source}: ${mainFile}: divergence reason must be a non-empty string`);
      }
    }
  }
  if (entry.assertExceptions !== undefined) {
    if (!isRecord(entry.assertExceptions)) {
      throw new MainFeaturesError(
        `${source}: ${mainFile}: "assertExceptions" must be a map of assertion title to hashes`
      );
    }
    const known = new Set(entry.assertStatements);
    for (const [title, hashes] of Object.entries(entry.assertExceptions)) {
      if (title !== '*' && !entry.assertions.includes(title)) {
        throw new MainFeaturesError(`${source}: ${mainFile}: assert exception title is not an assertion: ${title}`);
      }
      if (!Array.isArray(hashes)) {
        throw new MainFeaturesError(`${source}: ${mainFile}: assert exceptions for ${title} must be an array`);
      }
      for (const hash of hashes) {
        const mainHash = typeof hash === 'string' ? hash : hash?.main;
        const branchHash = typeof hash === 'string' ? undefined : hash?.branch;
        if (typeof mainHash !== 'string' || !known.has(mainHash)) {
          throw new MainFeaturesError(`${source}: ${mainFile}: assert exception is not a main statement: ${mainHash}`);
        }
        if (branchHash !== undefined && !/^[0-9a-f]{64}$/.test(branchHash)) {
          throw new MainFeaturesError(`${source}: ${mainFile}: assert exception replacement must be a sha256`);
        }
      }
    }
  }
  if (mainFile.startsWith('tests/integration/') && mainFile.endsWith('.sh')) {
    const mode = entry.integration;
    const manual = isRecord(mode) && typeof mode.manual === 'string' && mode.manual.trim() !== '';
    if (mode !== 'opt-in' && !manual) {
      throw new MainFeaturesError(`${source}: ${mainFile}: integration must be "opt-in" or { "manual": "<reason>" }`);
    }
  }
}

/** Keys of `tests` must equal the stored main-test list. */
export function assertCoverage(manifest, source = MANIFEST_PATH) {
  const entries = testEntries(manifest, source);
  for (const [mainFile, entry] of Object.entries(entries)) validateEntry(mainFile, entry, source);
  if (!Array.isArray(manifest.coverage) || manifest.coverage.some((file) => typeof file !== 'string')) {
    throw new MainFeaturesError(`${source}: "coverage" must be an array of main test paths`);
  }
  const keys = Object.keys(entries).sort();
  const coverage = [...manifest.coverage].sort();
  if (keys.length !== coverage.length || keys.some((key, index) => key !== coverage[index])) {
    const missing = coverage.filter((file) => !Object.prototype.hasOwnProperty.call(entries, file));
    const extra = keys.filter((file) => !coverage.includes(file));
    throw new MainFeaturesError(
      `${source}: tests keys must equal coverage ` +
        `(missing ${missing.length}, extra ${extra.length}` +
        `${missing.length ? `; missing: ${missing.slice(0, 5).join(', ')}` : ''}` +
        `${extra.length ? `; extra: ${extra.slice(0, 5).join(', ')}` : ''})`
    );
  }
}

/** Deduplicated, sorted branch test files named by the manifest. */
export function branchTestFiles(manifest, source = MANIFEST_PATH) {
  const entries = testEntries(manifest, source);
  const files = [];
  for (const [mainFile, entry] of Object.entries(entries)) {
    validateEntry(mainFile, entry, source);
    if (typeof entry.changed === 'string') continue;
    files.push(...entry.branch);
  }
  return [...new Set(files)].sort();
}

/** The `node --test` path for a branch file, or null when main's npm test does not run it. */
export function nodeTestFile(file) {
  const compiled = COMPILED_UNIT_TEST.exec(file);
  if (compiled) return `dist-test/${compiled[1]}.test.js`;
  if (DIRECT_UNIT_TEST.test(file)) return file;
  return null;
}

function carrierIsNodeTest(file, root) {
  if (COMPILED_UNIT_TEST.test(file)) return true;
  if (!DIRECT_UNIT_TEST.test(file)) return false;
  const path = join(root, file);
  if (!existsSync(path)) return false;
  return /from\s+['"]node:test['"]/.test(readFileSync(path, 'utf8'));
}

/**
 * Resolve the manifest to `{ run, skipped, mapped }`:
 * - `run`: repo-relative paths for `node --test` (always includes the visual test)
 * - `skipped`: mapped files this gate does not run (main's npm test does not either)
 * - `mapped`: number of distinct branch files named by the manifest
 */
export function planMainTests(manifest, { root = process.cwd(), source = MANIFEST_PATH } = {}) {
  const mapped = branchTestFiles(manifest, source);
  const run = new Set();
  const skipped = [];
  const missing = [];
  for (const file of mapped) {
    if (!existsSync(join(root, file))) {
      missing.push(file);
      continue;
    }
    const runnable = nodeTestFile(file);
    if (runnable) run.add(runnable);
    else skipped.push(file);
  }
  if (missing.length > 0) {
    throw new MainFeaturesError(`mapped files do not exist:\n  ${missing.join('\n  ')}`);
  }
  run.add(VISUAL_BASELINE_TEST);
  const missingCompiled = [...run].filter((file) => !existsSync(join(root, file)));
  if (missingCompiled.length > 0) {
    throw new MainFeaturesError(
      `compiled test files do not exist (run "npm run build:test" first):\n  ${missingCompiled.join('\n  ')}`
    );
  }
  return { run: [...run].sort(), skipped: skipped.sort(), mapped: mapped.length };
}

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

export function sceneHash(frame) {
  return createHash('sha256').update(canonicalJson(frame)).digest('hex');
}

export function readBaselineFrames(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new MainFeaturesError(`${path}: ${error.message}`);
  }
  if (!isRecord(parsed) || !isRecord(parsed.frames)) {
    throw new MainFeaturesError(`${path}: expected { frames: { "<scene>": ... } }`);
  }
  return parsed.frames;
}

/** Every kept scene's branch frame must hash to the stored baseline sha256. */
export function checkScenes(manifest, frames, source = MANIFEST_PATH) {
  if (!isRecord(manifest.scenes)) throw new MainFeaturesError(`${source}: "scenes" must be an object`);
  for (const [name, entry] of Object.entries(manifest.scenes)) {
    if (isRecord(entry) && typeof entry.kept === 'string') {
      if (!/^[0-9a-f]{64}$/.test(entry.kept)) {
        throw new MainFeaturesError(`${source}: scene ${name}: "kept" must be a sha256`);
      }
      if (!Object.prototype.hasOwnProperty.call(frames, name)) {
        throw new MainFeaturesError(`${source}: scene ${name}: missing from the branch baselines`);
      }
      const actual = sceneHash(frames[name]);
      if (actual !== entry.kept) {
        throw new MainFeaturesError(`${source}: scene ${name}: frame hash ${actual} != manifest ${entry.kept}`);
      }
      continue;
    }
    if (isRecord(entry) && typeof entry.removed === 'string' && entry.removed.trim() !== '') continue;
    throw new MainFeaturesError(
      `${source}: scene ${name}: expected { "kept": "<sha256>" } or { "removed": "<reason>" }`
    );
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * node --test doubles every `\`, then writes `#` as `\#`. Reverse those two
 * before comparing with the source title. A control character is encoded the
 * same way as a backslash plus a letter, so this leaves that pair as text.
 */
function unescapeTapTitle(title) {
  return title.replaceAll('\\#', '#').replaceAll('\\\\', '\\');
}

/** Passed `ok N - title` lines at any indent, outside YAML blocks. SKIP and TODO are not passes. */
export function passedTapTitles(tap) {
  const titles = [];
  let inYaml = false;
  for (const line of String(tap).split(/\r?\n/)) {
    if (inYaml) {
      if (/^\s*\.\.\.\s*$/.test(line)) inYaml = false;
      continue;
    }
    if (/^\s+---\s*$/.test(line)) {
      inYaml = true;
      continue;
    }
    const match = /^(\s*)ok\s+\d+\s+-\s(.*)$/.exec(line);
    if (!match) continue;
    if (/\s#\s*(?:SKIP|TODO)\b/i.test(match[2])) continue;
    titles.push(unescapeTapTitle(match[2].trimEnd()));
  }
  return titles;
}

export function titleMatches(required, passed) {
  if (required === passed) return true;
  if (!required.includes('${')) return false;
  const pattern = required
    .split(/\$\{[^}]*\}/)
    .map(escapeRegExp)
    .join('.+');
  return new RegExp(`^${pattern}$`).test(passed);
}

/**
 * Assertion titles of node:test carriers that no passed TAP line reports.
 * Template titles (`${...}`) match the expanded name.
 */
export function unmatchedTapTitles(manifest, tap, root = process.cwd(), source = MANIFEST_PATH) {
  const passed = passedTapTitles(tap);
  const missing = [];
  for (const [mainFile, entry] of Object.entries(testEntries(manifest, source))) {
    if (typeof entry.changed === 'string') continue;
    if (!entry.branch.some((file) => carrierIsNodeTest(file, root))) continue;
    for (const title of entry.assertions) {
      if (!passed.some((item) => titleMatches(title, item))) missing.push(`${mainFile}: ${title}`);
    }
  }
  return missing;
}

export function integrationPlan(manifest, source = MANIFEST_PATH) {
  const run = [];
  const manual = [];
  for (const [mainFile, entry] of Object.entries(testEntries(manifest, source))) {
    if (!mainFile.startsWith('tests/integration/') || !mainFile.endsWith('.sh')) continue;
    validateEntry(mainFile, entry, source);
    if (entry.integration === 'opt-in') run.push(mainFile);
    else manual.push({ file: mainFile, reason: entry.integration.manual.trim() });
  }
  run.sort();
  manual.sort((left, right) => left.file.localeCompare(right.file));
  return { run, manual };
}

function literalTitle(argument, sourceFile) {
  if (!argument) return null;
  if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) return argument.text;
  if (ts.isTemplateExpression(argument)) {
    let text = argument.head.text;
    for (const span of argument.templateSpans) {
      text += `\${${span.expression.getText(sourceFile)}}${span.literal.text}`;
    }
    return text;
  }
  return null;
}

function enclosingTestTitle(node, sourceFile) {
  let current = node.parent;
  while (current) {
    if (ts.isCallExpression(current)) {
      const callee = current.expression.getText(sourceFile);
      if (callee === 'test' || callee === 'it') {
        const title = literalTitle(current.arguments[0], sourceFile);
        if (title !== null) return title;
      }
    }
    current = current.parent;
  }
  return '*';
}

function extractJsAsserts(filename, source) {
  const kind = filename.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sourceFile = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, kind);
  const statements = [];
  const byTitle = {};
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(sourceFile);
      if (callee === 'assert' || callee.startsWith('assert.')) {
        const text = collapse(node.getText(sourceFile));
        statements.push(text);
        const title = enclosingTestTitle(node, sourceFile);
        (byTitle[title] ??= []).push(text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { statements, byTitle };
}

function extractShellAsserts(source) {
  const statements = [];
  for (const raw of source.replace(/\\\r?\n/g, ' ').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    // Function definitions (`assert_eq() {`, `run_and_assert_new_session() {`) are not calls.
    if (/^[A-Za-z_][A-Za-z0-9_-]*\(\)\s*\{?\s*$/.test(line)) continue;
    const words = line.matchAll(/(?:^|[;&|`(]\s*)([A-Za-z_][A-Za-z0-9_-]*)\b/g);
    if ([...words].some((match) => match[1].includes('assert'))) statements.push(collapse(line));
  }
  return { statements, byTitle: statements.length ? { '*': statements } : {} };
}

function extractPowerShellAsserts(source) {
  const statements = [];
  for (const raw of source.replace(/`\r?\n/g, ' ').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (/^function\s+Assert-/i.test(line)) continue;
    if (/(?:^|[;|&]\s*)Assert-[A-Za-z0-9]+\b/.test(line)) statements.push(collapse(line));
  }
  return { statements, byTitle: statements.length ? { '*': statements } : {} };
}

function extractPythonAsserts(source, filename) {
  const result = spawnSync(
    'python3',
    [
      '-c',
      [
        'import ast, json, sys',
        'src = sys.stdin.read()',
        'tree = ast.parse(src)',
        'out = []',
        'for node in ast.walk(tree):',
        '    if isinstance(node, ast.Assert):',
        '        seg = ast.get_source_segment(src, node)',
        '        if seg: out.append(" ".join(seg.split()))',
        'json.dump(out, sys.stdout)',
      ].join('\n'),
    ],
    { input: source, encoding: 'utf8' }
  );
  if (result.status !== 0) {
    throw new MainFeaturesError(`${filename}: python assert extract failed: ${result.stderr || result.stdout}`);
  }
  const statements = JSON.parse(result.stdout);
  return { statements, byTitle: statements.length ? { '*': statements } : {} };
}

/**
 * Main `assert*` statements in source order.
 * JS/TS calls are Prettier-normalised, then whitespace-collapsed.
 * Returns `{ statements, byTitle }`. `byTitle['*']` holds asserts outside a test.
 */
export async function extractAssertStatements(filename, source) {
  if (/\.(ts|mts|cts|js|mjs|cjs)$/.test(filename)) {
    const parser = /\.(ts|mts|cts)$/.test(filename) ? 'typescript' : 'babel';
    let formatted;
    try {
      formatted = await prettier.format(source, { ...PRETTIER_OPTIONS, parser, filepath: filename });
    } catch (error) {
      throw new MainFeaturesError(`${filename}: prettier failed: ${error.message}`);
    }
    return extractJsAsserts(filename, formatted);
  }
  if (filename.endsWith('.py')) return extractPythonAsserts(source, filename);
  if (filename.endsWith('.sh')) return extractShellAsserts(source);
  if (filename.endsWith('.ps1')) return extractPowerShellAsserts(source);
  return { statements: [], byTitle: {} };
}

function multiset(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return counts;
}

function exceptionHashes(exceptions) {
  const absent = [];
  const present = [];
  for (const hashes of Object.values(exceptions ?? {})) {
    for (const hash of hashes) {
      if (typeof hash === 'string') absent.push(hash);
      else {
        absent.push(hash.main);
        if (typeof hash.branch === 'string') present.push(hash.branch);
      }
    }
  }
  return { absent, present };
}

/**
 * Main statement hashes the carrier does not cover.
 * An exception names a main hash that may be absent. When it also names
 * `branch`, that replacement hash must occur in the carrier.
 */
export function missingAssertHashes(required, exceptions, actual) {
  const counts = multiset(required);
  const { absent, present } = exceptionHashes(exceptions);
  for (const hash of absent) {
    const have = counts.get(hash) || 0;
    if (have <= 1) counts.delete(hash);
    else counts.set(hash, have - 1);
  }
  const found = multiset(actual);
  const missing = [];
  for (const [hash, count] of counts) {
    if ((found.get(hash) || 0) < count) missing.push(hash);
  }
  for (const hash of present) {
    if ((found.get(hash) || 0) < 1) missing.push(hash);
  }
  return missing;
}

async function checkAssertStatements(manifest, root, source) {
  const missing = [];
  for (const [mainFile, entry] of Object.entries(testEntries(manifest, source))) {
    if (typeof entry.changed === 'string') continue;
    const actual = [];
    for (const file of entry.branch) {
      const path = join(root, file);
      if (!existsSync(path)) throw new MainFeaturesError(`${source}: ${file}: carrier does not exist`);
      const extracted = await extractAssertStatements(file, readFileSync(path, 'utf8'));
      actual.push(...extracted.statements.map(assertStatementHash));
    }
    for (const hash of missingAssertHashes(entry.assertStatements, entry.assertExceptions, actual)) {
      missing.push(`${mainFile}: ${hash}`);
    }
  }
  if (missing.length > 0) {
    throw new MainFeaturesError(`${source}: main assert statement missing:\n  ${missing.join('\n  ')}`);
  }
}

function checkMixed(manifest, root, source) {
  if (!isRecord(manifest.mixed)) throw new MainFeaturesError(`${source}: "mixed" must be an object`);
  for (const [file, entry] of Object.entries(manifest.mixed)) {
    if (!isRecord(entry) || !Array.isArray(entry.mainAssertions) || entry.mainAssertions.length === 0) {
      throw new MainFeaturesError(`${source}: ${file}: mixed.mainAssertions must be a non-empty array`);
    }
    if (file.startsWith('/') || file.split('/').includes('..')) {
      throw new MainFeaturesError(`${source}: mixed path must be repo-relative: ${file}`);
    }
    const path = join(root, file);
    if (!existsSync(path)) throw new MainFeaturesError(`${source}: mixed file does not exist: ${file}`);
    const text = readFileSync(path, 'utf8');
    for (const title of entry.mainAssertions) {
      if (typeof title !== 'string' || title.trim() === '' || !text.includes(title)) {
        throw new MainFeaturesError(`${source}: ${file}: mixed title is not in the file: ${title}`);
      }
    }
  }
}

/**
 * Coverage, entry shape, scene hashes, assert-statement hashes, and mixed titles.
 * Pass `tap` to also require node:test assertion titles to be reported passed.
 */
export async function enforceManifest(manifest, { root = process.cwd(), source = MANIFEST_PATH, tap = null } = {}) {
  assertCoverage(manifest, source);
  checkScenes(manifest, readBaselineFrames(join(root, VISUAL_BASELINES)), source);
  checkMixed(manifest, root, source);
  integrationPlan(manifest, source);
  await checkAssertStatements(manifest, root, source);
  if (tap !== null) {
    const missing = unmatchedTapTitles(manifest, tap, root, source);
    if (missing.length > 0) {
      throw new MainFeaturesError(`${source}: TAP is missing passed titles:\n  ${missing.join('\n  ')}`);
    }
  }
}

function printIntegration(manifest, source) {
  const plan = integrationPlan(manifest, source);
  for (const file of plan.run) process.stdout.write(`RUN\t${file}\n`);
  for (const item of plan.manual) process.stdout.write(`MANUAL\t${item.file}\t${item.reason}\n`);
}

async function main(argv) {
  let manifestPath = MANIFEST_PATH;
  let root = process.cwd();
  let checkTap = null;
  let integration = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--manifest') manifestPath = argv[++index];
    else if (arg === '--root') root = argv[++index];
    else if (arg === '--check-tap') checkTap = argv[++index];
    else if (arg === '--integration') integration = true;
    else throw new MainFeaturesError(`unknown argument: ${arg}`);
  }
  if (!manifestPath) throw new MainFeaturesError('--manifest needs a path');
  const source = manifestPath;
  const manifest = readManifest(resolve(root, manifestPath));
  if (integration) {
    printIntegration(manifest, source);
    return;
  }
  if (checkTap) {
    if (!existsSync(checkTap)) throw new MainFeaturesError(`TAP log not found: ${checkTap}`);
    assertCoverage(manifest, source);
    const missing = unmatchedTapTitles(manifest, readFileSync(checkTap, 'utf8'), root, source);
    if (missing.length > 0) {
      throw new MainFeaturesError(`TAP is missing passed titles:\n  ${missing.join('\n  ')}`);
    }
    process.stdout.write('run-main: TAP covers every named node:test title\n');
    return;
  }
  await enforceManifest(manifest, { root, source });
  const plan = planMainTests(manifest, { root, source });
  for (const file of plan.run) process.stdout.write(`${file}\n`);
  if (plan.skipped.length > 0) {
    process.stderr.write(`not run by this gate (not part of main's npm test): ${plan.skipped.length}\n`);
    for (const file of plan.skipped) process.stderr.write(`  ${file}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`run-main: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
