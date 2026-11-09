import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  associationMetadata,
  parseAssociation,
  writeAssociation,
  associationPath,
  type JobAssociation,
} from '../../src/roles/association.js';

export const oldAssociation = (job = 'j0000000000000001'): JobAssociation => ({
  schema: 1,
  job,
  root: 'synthetic/main',
  role: 'imp',
  phase: null,
  preset: 'launch-preset',
  task_label: 'Synthetic task',
  cwd: '/synthetic/work',
  backend: {
    id: 'synthetic-cli',
    executor: 'herdr',
    harness: 'pi',
    model: 'synthetic-model',
    effort: 'high',
    env_profile: null,
    recipe: 'pi-role',
  },
  herdr: { tab_id: 'tab-1', pane_id: 'pane-1', agent: 'agent-1', workspace_id: null },
  report_path: '/synthetic/report.md',
  closed: false,
});
test('R5 schema-1 associations remain valid; malformed optional metadata is not a binding', () => {
  const old = oldAssociation();
  assert.deepEqual(parseAssociation(old, old.job), old);
  assert.deepEqual(
    associationMetadata({
      native: { harness: 'pi', sessionId: 's', threadId: null },
      helpers: { '../x': {} },
      created_at: 'bad',
    }),
    {}
  );
});
test('R5 facade-style rewrites preserve only independently valid optional metadata', () => {
  const home = mkdtempSync(join(tmpdir(), 'r5-assoc-'));
  try {
    const old = oldAssociation();
    const native = { harness: 'pi' as const, sourceId: 'a'.repeat(64), sessionId: 'synthetic-s', threadId: null };
    writeAssociation(home, { ...old, native, helpers: { 'sonic-1': native }, created_at: '2026-01-01T00:00:00Z' });
    writeAssociation(home, { ...old, closed: true });
    const saved = JSON.parse(readFileSync(associationPath(home, old.job), 'utf8'));
    assert.deepEqual(saved.native, native);
    assert.deepEqual(saved.helpers, { 'sonic-1': native });
    assert.equal(saved.created_at, '2026-01-01T00:00:00Z');
    assert.equal(saved.closed, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
