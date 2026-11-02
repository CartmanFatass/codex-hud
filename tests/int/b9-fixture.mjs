import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCHEMA_V1_DDL } from '../../dist/ledger/schema.js';
import { mergeStatus, STATUS_RULE_VERSION } from '../../dist/core/status/merge.js';

export const sourceId = '1'.repeat(64);
export const ref = (sessionId, harness = 'codex', threadId = null) => ({
  harness,
  sourceId: harness === 'codex' ? sourceId : harness === 'claude' ? '4'.repeat(64) : '5'.repeat(64),
  sessionId,
  threadId,
});
export const root = ref('synthetic-parent');
export const child = ref('synthetic-child');
export const encodeRef = (r) => JSON.stringify([r.harness, r.sourceId, r.sessionId, r.threadId]);
export const hash = (s) => createHash('sha256').update(s).digest('hex');
export const supervisor = { pid: 456, proc_start: '789', boot_id: 'synthetic-boot', pid_domain: 'synthetic-domain' };
export const harnessStamp = { pid: 123, proc_start: '456', boot_id: 'synthetic-boot', pid_domain: 'synthetic-domain' };
export const runProof = (r, id = 'a') => ({
  sourceId: r.sourceId,
  bindingGeneration: 1,
  supervisor,
  harness: harnessStamp,
  processKey: JSON.stringify([r.harness, r.sourceId, 'synthetic-caller-domain', 123, '456']),
  sessionRef: r,
  contextId: 'context-a',
  generation: 1,
  selectionEvidenceId: null,
  bindingEvidenceId: `identity-${id}`,
});

export function insert(db, table, row) {
  const keys = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(
    ...Object.values(row)
  );
}

/** All ledger-backed B9 cases use a real WAL ledger in their own temporary HUD_HOME. */
export async function fixture({ links = 1 } = {}) {
  const { DatabaseSync } = await import('node:sqlite');
  const home = mkdtempSync(join(tmpdir(), 'hud-b9-'));
  const previousHome = process.env.HUD_HOME;
  process.env.HUD_HOME = home;
  const path = join(home, 'ledger.sqlite');
  const db = new DatabaseSync(path);
  db.exec(SCHEMA_V1_DDL);
  chmodSync(path, 0o600);
  insert(db, 'sources', { source_id: sourceId, harness: 'codex', root_path: '/synthetic/home', label: 'Synthetic' });
  const session = (r) => {
    db.prepare('INSERT OR IGNORE INTO sources VALUES(?,?,?,?)').run(
      r.sourceId,
      r.harness,
      `/synthetic/${r.harness}`,
      'Synthetic'
    );
    db.prepare('INSERT OR IGNORE INTO sessions VALUES(?,?,?,?,?)').run(
      encodeRef(r),
      r.harness,
      r.sourceId,
      r.sessionId,
      r.threadId ?? ''
    );
    return r;
  };
  session(root);
  session(child);
  const processKey = JSON.stringify(['codex', sourceId, 'synthetic-domain', 123, '456']);
  insert(db, 'callers', {
    caller_id: 'caller-a',
    harness: 'codex',
    source_id: sourceId,
    pid: 124,
    proc_start: '457',
    ppid: 123,
    parent_proc_start: '456',
    cwd: '/synthetic/launch',
    started_at: 1,
    last_seen_at: 1,
  });
  insert(db, 'caller_scopes', {
    process_key: processKey,
    generation: 1,
    harness: 'codex',
    source_id: sourceId,
    pid_domain: 'synthetic-domain',
    harness_pid: 123,
    harness_proc_start: '456',
    created_at: 1,
  });
  insert(db, 'caller_contexts', {
    context_id: 'context-a',
    generation: 1,
    caller_id: 'caller-a',
    context_key: 'stdio',
    kind: 'dedicated',
    source_id: sourceId,
    harness: 'codex',
    process_key: processKey,
    proc_generation: 1,
    created_at: 1,
  });
  const evidence = (id, kind, payload = {}, linkId = 'link-a', runId = 'run-a') => {
    insert(db, 'evidence', {
      evidence_id: id,
      run_id: runId,
      link_id: linkId,
      kind,
      producer: 'reconciler',
      fingerprint: hash(id),
      payload: JSON.stringify(payload),
      observed_at: 11000,
      validated_at: 11000,
      validation: 'accepted',
    });
  };
  const addLink = (id = 'a', parent = root, target = child, state = 'bound') => {
    if (parent) session(parent);
    if (target) session(target);
    const linkId = `link-${id}`,
      runId = `run-${id}`;
    insert(db, 'links', {
      link_id: linkId,
      state,
      parent_caller: 'caller-a',
      parent_context_id: 'context-a',
      parent_context_generation: 1,
      parent_ref: parent ? encodeRef(parent) : null,
      child_ref: target ? encodeRef(target) : null,
      current_owner: target && !['revoked', 'handed_over'].includes(state) ? 1 : 0,
      backend: 'synthetic-codex',
      role: 'implementer',
      label: 'Synthetic worker',
      brief_path: '/synthetic/brief.md',
      task_digest: '2'.repeat(64),
      created_at: 10000,
      bound_at: target ? 11000 : null,
      closed_at: state === 'closed' ? 12000 : null,
    });
    insert(db, 'runs', {
      run_id: runId,
      link_id: linkId,
      run_seq: 1,
      operation: 'spawn',
      target_session_ref: target ? encodeRef(target) : null,
      source_id: target?.sourceId ?? sourceId,
      harness: target?.harness ?? 'codex',
      expected_generation: 1,
      mode: 'headless',
      launch_cwd: '/synthetic/launch',
      state: 'running',
      launch_token_hash: hash(`token-${id}`),
      launch_digest: '3'.repeat(64),
      launch_call_id: `call-${id}`,
      launch_correlation_id: `correlation-${id}`,
      launch_message_id: `message-${id}`,
      supervisor_pid: supervisor.pid,
      supervisor_proc_start: supervisor.proc_start,
      created_at: 10000,
      started_at: 10001,
    });
    insert(db, 'claims', {
      run_id: runId,
      claim_hash: hash(`claim-${id}`),
      source_id: target?.sourceId ?? sourceId,
      expected_generation: 1,
      state: 'issued',
      issued_at: 10000,
      expires_at: 1810000,
      supervisor_pid: supervisor.pid,
      supervisor_proc_start: supervisor.proc_start,
    });
    insert(db, 'events', { link_id: linkId, run_id: runId, kind: 'intent.accepted', payload: '{}', at: 10000 });
    insert(db, 'events', {
      link_id: linkId,
      run_id: runId,
      kind: 'supervisor.registered',
      payload: JSON.stringify({ sourceId: target?.sourceId ?? sourceId, bindingGeneration: 1, supervisor }),
      at: 10001,
    });
    if (target && !['pending', 'claimed'].includes(state)) {
      evidence(`proof-${id}`, 'launch_receipt', runProof(target, id), linkId, runId);
      insert(db, 'child_bindings', {
        binding_id: `binding-${id}`,
        run_id: runId,
        session_ref: encodeRef(target),
        binding_generation: 1,
        caller_id: 'caller-a',
        caller_context_id: 'context-a',
        context_generation: 1,
        bound_by: 'receipt',
        capabilities: 'mcp',
        evidence_id: `proof-${id}`,
        created_at: 11000,
      });
    }
    return { linkId, runId, target };
  };
  db.exec('BEGIN');
  for (let i = 0; i < links; i++) addLink(i === 0 ? 'a' : `n${i}`, root, i === 0 ? child : ref(`synthetic-${i}`));
  db.exec('COMMIT');
  return {
    db,
    path,
    home,
    session,
    evidence,
    addLink,
    cleanup: () => {
      db.close();
      if (previousHome === undefined) delete process.env.HUD_HOME;
      else process.env.HUD_HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
    },
  };
}

export const launchEvidence = (r = child, eventAt = 11000, id = 'a') => ({
  kind: 'launch_message',
  ref: r,
  nativeMessageId: `message-${id}`,
  linkId: `link-${id}`,
  claimFingerprint: hash(`claim-${id}`),
  eventAt,
  launchCallId: `call-${id}`,
  launchCorrelationId: `correlation-${id}`,
});
export const parentEvidence = (eventAt = 11000, id = 'a') => ({
  kind: 'tool_result',
  ref: root,
  tool: 'delegate_spawn',
  callId: `call-${id}`,
  nativeMessageId: `parent-message-${id}`,
  linkId: `link-${id}`,
  runId: `run-${id}`,
  eventAt,
});

export function collected(r, native = [], linkEvidence = [], bytesRead = 0) {
  const identity = { kind: 'session', ref: r };
  const statusProjection = mergeStatus(
    {
      target: { nodeIdentity: identity, sourceGeneration: 1 },
      sources: [],
      asOfSeq: null,
      observationStamp: null,
      history: { continuity: 'unknown' },
    },
    null,
    STATUS_RULE_VERSION,
    12000
  ).projection;
  const unknown = { value: null, quality: 'unknown', source: 'synthetic:unavailable', asOf: 12000 };
  const observation = {
    nodeIdentity: identity,
    statusProjection,
    conflict: null,
    spent: { tokens: unknown, costUsd: unknown },
    workspace: null,
    coverage: { state: 'complete', skipped: {}, gaps: [], loaded: true },
    loaded: true,
    depth: 0,
    evidenceStamp: 'synthetic',
  };
  return {
    evidence: {
      ref: r,
      observation,
      cwd: null,
      cwdSource: 'unknown',
      cwdAsOf: null,
      startedAt: 10000,
      version: null,
      model: unknown,
      context: unknown,
      reports: [],
      native,
      linkEvidence,
      caps: {},
    },
    sourceGeneration: 1,
    linkEvidenceCurrent: true,
    bytesRead,
    recordsRead: 0,
    loaded: true,
    topology: {
      ref: r,
      sourceGeneration: 1,
      children: native,
      loaded: true,
      bytesRead: 0,
      recordsRead: 0,
      coverage: { state: 'complete', skipped: {}, gaps: [], loaded: true },
    },
  };
}
