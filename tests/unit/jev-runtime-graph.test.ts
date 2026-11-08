// The Jev runtime may not import the general host or a CLI launcher.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createJevExecutor } from '../../src/jev/runtime/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');

function forbidden(value: string): boolean {
  const text = value.replaceAll('\\', '/');
  return (
    text.includes('/src/managed/host') ||
    text.includes('/src/cli/') ||
    text.includes('/bin/') ||
    text.includes('jev-bridge') ||
    text.includes('host-entry')
  );
}

function resolveSpec(from: string, spec: string): string {
  const base = resolve(dirname(from), spec);
  const candidates: string[] = [];
  if (spec.endsWith('.js')) candidates.push(`${base.slice(0, -3)}.ts`);
  candidates.push(base, `${base}.ts`, `${base}.tsx`, `${base}.js`, join(base, 'index.ts'));
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`unresolved ${spec} from ${from}`);
}

function walk(file: string, seen: Set<string>): void {
  const full = resolve(file);
  if (seen.has(full)) return;
  seen.add(full);
  assert.equal(forbidden(full), false, full);
  const text = readFileSync(full, 'utf8');
  for (const match of text.matchAll(/(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g)) {
    const spec = match[1];
    if (!spec.startsWith('.')) continue;
    assert.equal(forbidden(spec), false, spec);
    walk(resolveSpec(full, spec), seen);
  }
}

test('the runtime graph reaches the executor and skips the host and CLI', () => {
  const seen = new Set<string>();
  walk(join(root, 'src/jev/runtime/index.ts'), seen);
  walk(join(root, 'src/jev/runtime/entry.ts'), seen);
  assert.equal(
    [...seen].some((file) => file.endsWith('/src/jev/runtime/executor.ts')),
    true
  );
  assert.equal(typeof createJevExecutor, 'function');
});
