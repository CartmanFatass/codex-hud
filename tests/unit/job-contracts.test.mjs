import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { jobFiles } from '../../dist/mcp/paths.js';
import { readTurn, saveTurn, writeTurn } from '../../dist/mcp/cli-judge.js';
import { sendHistory } from '../../dist/mcp/pi-read-settlement.js';
import { jobRow } from '../../dist/collectors/thin-jobs.js';
import { CHECKS_FILE, readCheckReceipt } from '../../dist/roles/job-checks.js';
import { DONE_FILE, readDone } from '../../dist/roles/cli-turn.js';

test('turn, done and check receipts interoperate with the existing filenames and wire format', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'job-contracts-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const turn = { seq: 1, sent_at: '2026-01-01T00:00:00.000Z', report_sig: null };
  saveTurn(dir, turn);
  const file = join(dir, 'turn.json');
  assert.equal(readFileSync(file, 'utf8'), JSON.stringify(turn) + '\n');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const next = writeTurn(dir, { by: 'hud' });
  assert.deepEqual(readTurn(dir), next);
  assert.equal(next.caller_token, `1@${turn.sent_at}`);

  const done = { seq: next.seq, sent_at: next.sent_at, report_sig: 'synthetic', at: next.sent_at };
  writeFileSync(join(dir, 'done.json'), JSON.stringify(done));
  assert.equal(DONE_FILE, jobFiles.done);
  assert.deepEqual(readDone(dir), done);
  const checks = { turn: `${next.seq}@${next.sent_at}`, report_sig: 'synthetic', state: 'done', results: [] };
  writeFileSync(join(dir, 'checks.json'), JSON.stringify(checks));
  assert.equal(CHECKS_FILE, jobFiles.checks);
  assert.deepEqual(readCheckReceipt(dir), checks);
});

test('legacy send keys, browser receipts and unversioned status keep their meaning', () => {
  const job = { job: 'j0000000000000001', jev: { role: 'browser' }, message_keys: ['first'] };
  assert.deepEqual(sendHistory(job), [{ key: 'first', legacy: true }]);
  const row = jobRow(job, { state: 'closed', output_written: true });
  assert.equal(row.display_state, 'done');
  assert.equal(row.report_present, true);
});
