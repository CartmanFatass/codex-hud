import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';

import { JevFailure } from '../../src/jev/ask/error.js';
import {
  acquireBrowserLock,
  acquireWaitLease,
  tryAcquireBrowserLock,
  type HeldLease,
} from '../../src/jev/ask/lease.js';
import { operationPath } from '../../src/jev/ask/names.js';
import {
  askKey,
  askKeyFromBytes,
  assertCanSend,
  assertPrompt,
  assertProvider,
  mergeRecord,
  appendAttempt,
  mergeSave,
  openForUpdate,
  operationKey,
  persistClick,
  persistRelease,
  promptSha256,
  pySquash,
  pyStrip,
  pythonJsonPair,
  pythonJsonString,
  pythonTimestamp,
  readOperation,
  readOperationLocked,
  readPromptBytes,
  squashedSha256,
} from '../../src/jev/ask/records.js';
import { REPO_ROOT } from '../fixtures/paths.js';

interface KeyCase {
  name: string;
  provider: 'chatgpt' | 'gemini';
  label: string;
  prompt_base64: string;
  prompt: string;
  squashed: string;
  prompt_sha256: string;
  squashed_sha256: string;
  json_dumps: string;
  key: string;
  label_rejected: boolean;
}

const fixture = JSON.parse(readFileSync(join(REPO_ROOT, 'tests/fixtures/jev/ask-key-cross.json'), 'utf8')) as {
  cases: KeyCase[];
};

function workspace(t: { after(fn: () => void): void }): string {
  const root = mkdtempSync(join(tmpdir(), 'hud-jev-records-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function codeOf(error: unknown): string {
  assert.ok(error instanceof JevFailure);
  return error.code;
}

test('key and squashed sha256 match the Python fixture', () => {
  assert.ok(fixture.cases.length >= 8);
  for (const item of fixture.cases) {
    const bytes = Buffer.from(item.prompt_base64, 'base64');
    const stripped = readPromptBytes(bytes);
    assert.equal(stripped, item.prompt, item.name);
    assert.equal(pySquash(stripped), item.squashed, item.name);
    assert.equal(promptSha256(stripped), item.prompt_sha256, item.name);
    assert.equal(squashedSha256(stripped), item.squashed_sha256, item.name);
    assert.equal(pythonJsonPair(item.label, item.prompt_sha256), item.json_dumps, item.name);
    assert.equal(operationKey(item.provider, item.label, stripped), item.key, item.name);
    if (item.label_rejected) {
      assert.throws(
        () => askKey(item.provider, item.label, stripped),
        (error: unknown) => codeOf(error) === 'invalid_label'
      );
    } else {
      assert.equal(askKeyFromBytes(item.provider, item.label, bytes), item.key, item.name);
    }
  }
});

test('python json.dumps escapes match the probed samples', () => {
  assert.equal(pythonJsonString('a"b\\c\n\t\u007f'), '"a\\"b\\\\c\\n\\t\\u007f"');
  assert.equal(pythonJsonString('hi😀'), '"hi\\ud83d\\ude00"');
  assert.equal(pythonJsonString('a/b'), '"a/b"');
  assert.equal(pyStrip('\ufeffhello'), '\ufeffhello');
  assert.equal(pyStrip('\u0085hello\u001c'), 'hello');
  assert.equal(pySquash('\ufeffhi\u0085there\u3000'), '\ufeffhi there');
});

test('empty prompt still hashes, and the send path rejects it', () => {
  const empty = fixture.cases.find((item) => item.name === 'empty');
  assert.ok(empty);
  assert.equal(operationKey('chatgpt', 'review-v2', ''), empty.key);
  assert.throws(
    () => assertPrompt(''),
    (error: unknown) => codeOf(error) === 'empty_prompt'
  );
});

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

test('temps are unique and a refused click does not fsync', (t) => {
  const dir = workspace(t);
  const key = 'review-key';
  const lease = tryAcquireBrowserLock({ stateDir: dir, jobId: 'job', phase: 'send', heartbeat: false });
  t.after(() => lease.release());
  const temps: string[] = [];
  let syncs = 0;
  const deps = {
    pid: () => 9,
    fsync: () => {
      syncs += 1;
    },
    onTemp: (file: string) => temps.push(basename(file)),
  };
  persistClick(dir, key, { sent_target_id: 'tab-1', sidebar_before: ['digest'] }, lease, {
    ...deps,
    random: () => 'aaaa1111',
  });
  // File, operations directory, and the new operations entry in the state directory.
  assert.equal(syncs, 3);
  assert.throws(
    () => persistClick(dir, key, { sent_target_id: 'tab-2' }, lease, { ...deps, random: () => 'bbbb2222' }),
    (error: unknown) => codeOf(error) === 'already_attempted'
  );
  assert.equal(syncs, 3);
  const disk = readOperation(dir, key);
  assert.equal(disk?.send_attempted, true);
  assert.equal(disk?.send_effect, 'uncertain');
  assert.equal(disk?.sent_target_id, 'tab-1');
  assert.deepEqual(disk?.sidebar_before, ['digest']);
  assert.equal(temps.length, 1);
  assert.match(temps[0] ?? '', /^review-key\.9\.aaaa1111\.tmp$/);
  mergeSave(dir, key, { pill_text: 'Pro' }, lease, { ...deps, random: () => 'cccc3333' });
  assert.match(temps[1] ?? '', /^review-key\.9\.cccc3333\.tmp$/);
  assert.equal(temps[0] === temps[1], false);
  assert.equal(syncs, 5);
  assert.deepEqual(
    readdirSync(join(dir, 'operations')).filter((name) => name.endsWith('.tmp')),
    []
  );
});

test('attempts keep the last 20', () => {
  const attempts = Array.from({ length: 21 }, (_, index) => ({
    at: String(index),
    phase_reached: 'send',
    result: 'pre_send' as const,
  }));
  const merged = mergeRecord({}, { attempts });
  assert.equal(merged.attempts?.length, 20);
  assert.equal(merged.attempts?.[0]?.at, '1');
  assert.equal(merged.attempts?.[19]?.at, '20');
});

test('the browser lock is held before the record is read', (t) => {
  const dir = workspace(t);
  const key = 'review-key';
  const events: string[] = [];
  const opened = openForUpdate(
    dir,
    key,
    { jobId: 'job', phase: 'send', heartbeat: false },
    {
      onLocked() {
        events.push('lock');
      },
      beforeRead() {
        events.push('read');
      },
    }
  );
  t.after(() => opened.lease.release());
  assert.deepEqual(events, ['lock', 'read']);
  assert.equal(opened.record, null);

  let read = false;
  opened.lease.release();
  assert.throws(
    () =>
      readOperationLocked(dir, key, opened.lease, {
        beforeRead() {
          read = true;
        },
      }),
    (error: unknown) => codeOf(error) === 'lease_lost'
  );
  assert.equal(read, false);

  const wait = acquireWaitLease(dir, 'other-key', { jobId: 'wait', phase: 'wait', heartbeat: false });
  assert.equal(wait.role, 'owner');
  t.after(() => {
    if (wait.role === 'owner') wait.lease.release();
  });
  read = false;
  assert.throws(
    () =>
      readOperationLocked(dir, key, wait.lease, {
        beforeRead() {
          read = true;
        },
      }),
    (error: unknown) => codeOf(error) === 'lease_required'
  );
  assert.equal(read, false);

  const elsewhere = mkdtempSync(join(tmpdir(), 'hud-jev-other-'));
  t.after(() => rmSync(elsewhere, { recursive: true, force: true }));
  const foreign = tryAcquireBrowserLock({ stateDir: elsewhere, jobId: 'other', phase: 'send', heartbeat: false });
  t.after(() => foreign.release());
  assert.throws(
    () => readOperationLocked(dir, key, foreign),
    (error: unknown) => codeOf(error) === 'lease_required'
  );
});

test('two holders interleave without downgrading send_attempted', async (t) => {
  const dir = workspace(t);
  const key = 'review-key';
  const first = tryAcquireBrowserLock({ stateDir: dir, jobId: 'a', phase: 'send', heartbeat: false });
  let go = false;
  const secondPromise = waitForHolder(dir, () => go, first);
  await new Promise((resolve) => setImmediate(resolve));
  try {
    mergeSave(dir, key, { send_attempted: true, note: 'a' }, first);
  } finally {
    go = true;
  }
  const second = await secondPromise;
  t.after(() => second.release());
  mergeSave(dir, key, { send_attempted: false, note: 'b' }, second);
  const disk = readOperation(dir, key);
  assert.equal(disk?.send_attempted, true);
  assert.equal(disk?.note, 'b');
});

test('a wait lease saves non-click fields and cannot click or release', (t) => {
  const dir = workspace(t);
  const key = 'review-key';
  const wait = acquireWaitLease(dir, key, { jobId: 'wait', phase: 'wait', heartbeat: false });
  assert.equal(wait.role, 'owner');
  if (wait.role !== 'owner') return;
  t.after(() => wait.lease.release());
  assert.equal(wait.lease.key, key);
  mergeSave(
    dir,
    key,
    {
      conversation_url: 'https://example.invalid/c/synthetic',
      completion: 'done',
      answer_sha256: 'abc',
      partial_answer_chars: 4,
    },
    wait.lease
  );
  appendAttempt(dir, key, { at: '1', phase_reached: 'wait', result: 'pre_send' }, wait.lease);
  assert.throws(
    () => persistClick(dir, key, { sent_target_id: 'tab-1' }, wait.lease),
    (error: unknown) => codeOf(error) === 'lease_required'
  );
  assert.throws(
    () => persistRelease(dir, key, { released_evidence: 'human' }, wait.lease),
    (error: unknown) => codeOf(error) === 'lease_required'
  );
  const disk = readOperation(dir, key);
  assert.equal(disk?.conversation_url, 'https://example.invalid/c/synthetic');
  assert.equal(disk?.completion, 'done');
  assert.equal(disk?.answer_sha256, 'abc');
  assert.equal(disk?.partial_answer_chars, 4);
  assert.equal(disk?.attempts?.length, 1);
  assert.equal(disk?.send_attempted, undefined);

  const other = acquireWaitLease(dir, 'other-key', { jobId: 'other', phase: 'wait', heartbeat: false });
  assert.equal(other.role, 'owner');
  if (other.role !== 'owner') return;
  t.after(() => other.lease.release());
  assert.throws(
    () => mergeSave(dir, key, { pill_text: 'no' }, other.lease),
    (error: unknown) => codeOf(error) === 'lease_required'
  );
});

test('persistRelease re-reads and refuses a sent or already released record', (t) => {
  const dir = workspace(t);
  const key = 'review-key';
  const lease = tryAcquireBrowserLock({ stateDir: dir, jobId: 'job', phase: 'reconcile', heartbeat: false });
  t.after(() => lease.release());
  persistClick(dir, key, { sent_target_id: 'tab-1' }, lease);
  mergeSave(dir, key, { send_effect: 'sent' }, lease);
  let temps = 0;
  assert.throws(
    () =>
      persistRelease(dir, key, { released_evidence: 'human' }, lease, {
        onTemp: () => {
          temps += 1;
        },
      }),
    (error: unknown) => codeOf(error) === 'already_sent'
  );
  assert.equal(temps, 0);
  const ignored = mergeSave(
    dir,
    key,
    { released: true, send_attempted: false, prompt_sha256: null, send_effect: 'not submitted' },
    lease
  );
  assert.equal(ignored.send_attempted, true);
  assert.equal(ignored.send_effect, 'sent');
  assert.equal(ignored.released, undefined);
  assert.equal(ignored.prompt_sha256, undefined);

  const other = 'other-key';
  persistClick(dir, other, { sent_target_id: 'tab-2' }, lease);
  const released = persistRelease(dir, other, { released_evidence: 'human' }, lease);
  assert.equal(released.released, true);
  assert.equal(released.send_attempted, false);
  assert.equal(released.released_evidence, 'human');
  assert.throws(
    () => persistRelease(dir, other, { released_evidence: 'again' }, lease),
    (error: unknown) => codeOf(error) === 'already_released'
  );
  assert.equal(readOperation(dir, other)?.released_evidence, 'human');
});

test('a trailing slash is the same state directory', (t) => {
  const dir = workspace(t);
  const key = 'review-key';
  const lease = tryAcquireBrowserLock({ stateDir: dir, jobId: 'job', phase: 'send', heartbeat: false });
  t.after(() => lease.release());
  mergeSave(`${dir}/`, key, { pill_text: 'Pro' }, lease);
  const disk = readOperationLocked(`${dir}/`, key, lease);
  assert.equal(disk?.pill_text, 'Pro');
});

function waitForHolder(dir: string, ready: () => boolean, holder: HeldLease): Promise<HeldLease> {
  return acquireBrowserLock({
    stateDir: dir,
    jobId: 'b',
    phase: 'send',
    heartbeat: false,
    waitMs: 5_000,
    pollMs: 20,
    deps: {
      sleep: () =>
        new Promise((resolve) => {
          const tick = () => {
            if (!ready()) {
              setImmediate(tick);
              return;
            }
            holder.release();
            resolve();
          };
          setImmediate(tick);
        }),
    },
  });
}
