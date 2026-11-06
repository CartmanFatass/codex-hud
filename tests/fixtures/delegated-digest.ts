/** Synthetic ledger-v1 rows, not live provider/host qualification. No processes are launched. */
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCHEMA_V1_DDL } from '../../src/ledger/schema.js';
import { loadLedgerSqlite } from '../../src/ledger/runtime.js';
import { sessionRefKey } from '../../src/core/identity.js';
import type { Harness, SessionRef } from '../../src/core/types/identity.js';
import { modelHttpRequest } from '../../src/collectors/small-model.js';
import { resolveRecipient } from '../../src/core/materials/recipient.js';
import type { SourceModelConfig } from '../../src/core/materials/source-config.js';

export const SUMMARY = 'The synthetic component now validates input and its focused checks passed.';
export const PRIVATE = 'PRIVATE_SYNTHETIC_PATH_TASK_STDOUT_SENTINEL';
export const response = (text = JSON.stringify({ conclusion: 'Input validation is implemented.', basis: 'Focused checks passed.', caveats: 'Only the report was reviewed.' })) =>
  new Response(JSON.stringify({ choices: [{ message: { content: text } }] }));
export function withResponseText(reply: Response, readText: () => Promise<string>): Response {
  return new Proxy(reply, {
    get(target, property) {
      if (property === 'text') return readText;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
export const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
export async function until(predicate: () => boolean) {
  const end = Date.now() + 4000;
  while (!predicate()) { if (Date.now() >= end) throw new Error('synthetic wait expired'); await tick(); }
}
export function deferredTransport() {
  const calls: Array<{ url: string; init: RequestInit; resolve: (response: Response) => void }> = [];
  // Intentionally uncooperative with abort, to prove late results cannot be admitted.
  const fetcher = ((url: string, init: RequestInit) => new Promise<Response>((resolve) => {
    calls.push({ url: String(url), init, resolve });
  })) as typeof fetch;
  return { calls, fetcher };
}
export async function digestFixture(harness: Harness = 'claude', threadId: string | null = null) {
  const home = fs.mkdtempSync(join(tmpdir(), 'hud-digest-synthetic-'));
  fs.chmodSync(home, 0o700);
  const { DatabaseSync } = await loadLedgerSqlite();
  const db = new DatabaseSync(join(home, 'ledger.sqlite'));
  db.exec(SCHEMA_V1_DDL);
  const sourceId = (harness === 'claude' ? 'a' : harness === 'codex' ? 'b' : 'c').repeat(64);
  const ref: SessionRef = { harness, sourceId, sessionId: 'synthetic-child', threadId };
  const parent: SessionRef = { ...ref, sessionId: 'synthetic-parent', threadId: null };
  const runId = 'synthetic-run';
  const reportId = 'synthetic-report';
  const linkId = 'synthetic-link';
  const insert = (table: string, row: Record<string, string | number | null>) => {
    db.prepare(`INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`)
      .run(...Object.values(row));
  };
  db.exec('BEGIN; PRAGMA defer_foreign_keys=ON');
  insert('sources', { source_id: sourceId, harness, root_path: '/synthetic/source', label: 'Synthetic' });
  for (const [index, session] of [parent, ref].entries()) {
    const who = index === 0 ? 'parent' : 'child';
    const key = JSON.stringify([harness, sourceId, 'synthetic-domain', 101 + index, 'synthetic-start']);
    insert('sessions', { session_ref: sessionRefKey(session), harness, source_id: sourceId,
      session_id: session.sessionId, thread_id: session.threadId ?? '' });
    insert('callers', { caller_id: who, instance_kind: 'dedicated', harness, source_id: sourceId,
      pid: 101 + index, proc_start: 'synthetic-start', ppid: 100, parent_proc_start: 'synthetic-parent-start',
      cwd: '/synthetic', started_at: 100, last_seen_at: 100 });
    insert('caller_scopes', { process_key: key, generation: 1, harness, source_id: sourceId,
      pid_domain: 'synthetic-domain', harness_pid: 101 + index, harness_proc_start: 'synthetic-start',
      session_ref: sessionRefKey(session), bound_by: 'trusted_session', binding_evidence_id: 'proof', created_at: 100 });
    insert('caller_contexts', { context_id: `${who}-context`, generation: 1, caller_id: who, context_key: 'stdio',
      kind: 'dedicated', source_id: sourceId, harness, process_key: key, proc_generation: 1,
      session_ref: sessionRefKey(session), bound_by: 'trusted_session', binding_evidence_id: 'proof', created_at: 100 });
  }
  insert('links', { link_id: linkId, state: 'reported', parent_caller: 'parent', parent_context_id: 'parent-context',
    parent_context_generation: 1, parent_ref: sessionRefKey(parent), child_ref: sessionRefKey(ref), current_owner: 1,
    backend: 'synthetic', role: PRIVATE, brief_path: `/synthetic/${PRIVATE}`, task_digest: 'd'.repeat(64),
    report_path: `/synthetic/${PRIVATE}`, created_at: 100, bound_at: 100 });
  insert('runs', { run_id: runId, link_id: linkId, run_seq: 1, operation: 'spawn', target_session_ref: sessionRefKey(ref),
    source_id: sourceId, harness, expected_generation: 1, mode: 'headless', launch_cwd: '/synthetic', state: 'running',
    launch_token_hash: 'e'.repeat(64), launch_digest: 'f'.repeat(64), launch_call_id: 'call', launch_correlation_id: 'correlation', created_at: 100 });
  insert('evidence', { evidence_id: 'proof', run_id: runId, link_id: linkId, kind: 'trusted_session', producer: 'hud-mcp',
    fingerprint: 'd'.repeat(64), payload: JSON.stringify({ private: PRIVATE }), observed_at: 100, validated_at: 100, validation: 'accepted' });
  insert('child_bindings', { binding_id: 'binding', run_id: runId, session_ref: sessionRefKey(ref), binding_generation: 1,
    caller_id: 'child', caller_context_id: 'child-context', context_generation: 1, bound_by: 'trusted_session',
    capabilities: 'mcp', evidence_id: 'proof', is_current: 1, created_at: 100 });
  insert('reports', { report_id: reportId, run_id: runId, link_id: linkId, child_binding_id: 'binding', caller_id: 'child',
    caller_context_id: 'child-context', context_generation: 1, status: 'completed', summary: SUMMARY,
    path: `/synthetic/${PRIVATE}`, created_at: 100 });
  insert('events', { run_id: runId, link_id: linkId, kind: 'report.received', payload: JSON.stringify({ reportId }), at: 100 });
  db.exec('COMMIT');
  for (const name of fs.readdirSync(home)) fs.chmodSync(join(home, name), 0o600);
  const dir = join(home, 'sources', sourceId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const config: SourceModelConfig = {
    schemaVersion: 1, sourceId, revision: 1,
    connection: { backend: 'api', base: 'https://synthetic.invalid/v1', model: 'synthetic-model',
      account: 'synthetic-account', keyEnv: 'SYNTHETIC_DIGEST_KEY', reasoning: false },
    delegatedDigest: { enabled: true, paused: false, language: 'en', hourlyCap: 60 },
    materials: [{ ref, origin: 'delegated', purpose: 'digest', fields: ['result'] }],
  };
  const http = modelHttpRequest({ base: 'https://synthetic.invalid/v1', model: 'synthetic-model', key: '' },
    { feature: 'digest', prompt: '', system: '' }, {});
  if ('error' in http) throw new Error('synthetic route failed');
  const recipient = resolveRecipient({ backend: 'api', endpoint: http.url, model: 'synthetic-model' }, 'synthetic-account')!;
  const policy = { schemaVersion: 1, sourceId, revision: 1,
    grants: [{ purpose: 'digest', recipientId: recipient.recipientId, decision: 'allow', grantedAt: 100 }] };
  const write = (name: string, value: unknown) => fs.writeFileSync(join(dir, name), JSON.stringify(value), { mode: 0o600 });
  write('model.json', config);
  write('outbound.json', policy);
  const env: NodeJS.ProcessEnv = { HOME: join(home, 'unused-home'), HUD_HOME: home, CODEX_HOME: join(home, 'unused-codex'),
    SYNTHETIC_DIGEST_KEY: 'synthetic-key', CODEX_HUD_BRIEF_MODEL: 'forbidden-model', OPENAI_API_KEY: 'forbidden-key' };
  const input = { home, runId, reportId, env, expectedLedger: String(db.prepare('SELECT ledger_id FROM ledger_metadata').get()!.ledger_id),
    expectedRecipient: recipient.recipientId };
  return { home, dir, db, ref, config, policy, env, input, write, insert, recipient,
    cleanup() { db.close(); fs.rmSync(home, { recursive: true, force: true }); } };
}
