import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { JevFailure } from '../../src/jev/ask/error.js';
import { tryAcquireBrowserLock } from '../../src/jev/ask/lease.js';
import { operationPath } from '../../src/jev/ask/names.js';
import { assertCanSend, assertProvider, mergeSave, pythonTimestamp } from '../../src/jev/ask/records.js';

function workspace(t: { after(fn: () => void): void }): string {
  const root = mkdtempSync(join(tmpdir(), 'hud-jev-records-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function codeOf(error: unknown): string {
  assert.ok(error instanceof JevFailure);
  return error.code;
}

test('provider and resend gates', () => {
  assert.doesNotThrow(() => assertProvider(null, 'gemini'));
  assert.doesNotThrow(() => assertProvider({}, 'gemini'));
  assert.doesNotThrow(() => assertProvider({ steps: [] }, 'chatgpt'));
  assert.throws(
    () => assertProvider({ steps: [] }, 'gemini'),
    (error: unknown) =>
      error instanceof JevFailure &&
      error.code === 'provider_mismatch' &&
      error.message === 'this key belongs to provider chatgpt; a key never changes provider'
  );
  assert.doesNotThrow(() => assertCanSend(null));
  assert.throws(
    () => assertCanSend({ send_attempted: true }),
    (error: unknown) => codeOf(error) === 'already_attempted'
  );
  assert.throws(
    () => assertCanSend({ released: true }),
    (error: unknown) => codeOf(error) === 'resend_needs_confirmation'
  );
  assert.doesNotThrow(() => assertCanSend({ released: true }, true));
});

test('merge keeps send_attempted sticky and preserves nulls', (t) => {
  const dir = workspace(t);
  const key = 'review-key';
  const when = new Date('2026-11-07T04:34:56Z');
  const lease = tryAcquireBrowserLock({ stateDir: dir, jobId: 'job', phase: 'send', heartbeat: false });
  t.after(() => lease.release());
  let saved = mergeSave(dir, key, { send_attempted: true, prompt_sha256: 'abc', cli_note: 'keep' }, lease, {
    now: () => when,
  });
  saved = mergeSave(dir, key, { send_attempted: false, pill_text: 'Pro' }, lease, { now: () => when });
  assert.equal(saved.send_attempted, true);
  assert.equal(saved.pill_text, 'Pro');
  saved = mergeSave(dir, key, { released: true }, lease, { now: () => when });
  assert.equal(saved.send_attempted, true);
  assert.equal(saved.released, true);
  saved = mergeSave(
    dir,
    key,
    { released: true, send_attempted: false, prompt_sha256: null, send_effect: 'not submitted' },
    lease,
    { now: () => when }
  );
  assert.equal(saved.send_attempted, false);
  assert.equal(saved.prompt_sha256, null);
  assert.equal(saved.cli_note, 'keep');
  assert.equal('schema_version' in saved, false);
  assert.equal(saved.updated, pythonTimestamp(when));
  assert.match(saved.updated ?? '', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{4}$/);
  const text = readFileSync(operationPath(dir, key), 'utf8');
  assert.equal(text.endsWith('\n'), false);
  assert.equal(JSON.parse(text).prompt_sha256, null);
  assert.equal(statSync(operationPath(dir, key)).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, 'operations')).mode & 0o777, 0o700);
});
