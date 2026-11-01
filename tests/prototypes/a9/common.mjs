// Isolated executable specifications, deliberately outside src/. Linux /proc only.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { fork } from 'node:child_process';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

export { assert, existsSync, join, readFileSync, writeFileSync };
export const repo = fileURLToPath(new URL('../../../', import.meta.url));
export const home = realpathSync(process.env.HUD_HOME || '/a9-requires-run-all');
assert.equal(readFileSync(join(home, '.a9-isolated'), 'utf8').trim(), 'isolated synthetic A9 prototype');
export const evidenceDir = process.env.A9_EVIDENCE;
export const now = () => Date.now();
export const observationClock = () => ({
  at: now(),
  monoNs: process.hrtime.bigint().toString(),
  producer: stat(process.pid),
});
export const id = () => randomUUID();
export const json = (value) => JSON.stringify(value);
export const hash = (value) =>
  createHash('sha256')
    .update(typeof value === 'string' ? value : json(value))
    .digest('hex');
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const sessionOwner = (ref) => json(['session', ref]);
export const procOwner = (key, generation) => json(['proc', key, generation]);
export const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
export const domain = json([boot, readlinkSync('/proc/self/ns/pid')]);

export function stat(pid) {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = raw
      .slice(raw.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/);
    return {
      pid: Number(pid),
      proc_start: fields[19],
      boot_id: boot,
      pid_domain: domain,
      state: fields[0],
      ppid: Number(fields[1]),
      pgid: Number(fields[2]),
      sid: Number(fields[3]),
      tpgid: Number(fields[5]),
    };
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return null;
    throw error;
  }
}

export function sameInstance(a, b) {
  return !!a && !!b && ['pid', 'proc_start', 'boot_id', 'pid_domain'].every((key) => a[key] === b[key]);
}

export const live = (processState) => processState != null && !['Z', 'X'].includes(processState.state);
export function signal(stamp, name) {
  if (!sameInstance(stamp, stat(stamp.pid))) return false;
  process.kill(stamp.pid, name);
  return true;
}

export async function until(predicate, description, timeout = 5000) {
  const end = now() + timeout;
  while (now() < end) {
    const value = await predicate();
    if (value) return value;
    await sleep(10);
  }
  throw new Error(`timeout: ${description}`);
}

export function registerProcess() {
  const stamp = stat(process.pid);
  appendFileSync(process.env.A9_REGISTRY, `${json(stamp)}\n`, { mode: 0o600 });
  return stamp;
}

export function ownedProcesses() {
  return existsSync(process.env.A9_REGISTRY)
    ? readFileSync(process.env.A9_REGISTRY, 'utf8').split('\n').filter(Boolean).map(JSON.parse).filter(Boolean)
    : [];
}

export async function stopOwned(stamps) {
  for (const stamp of [...stamps].reverse()) {
    if (sameInstance(stamp, stat(stamp.pid))) signal(stamp, 'SIGKILL');
  }
  await until(
    () => stamps.every((stamp) => !sameInstance(stamp, stat(stamp.pid)) || !live(stat(stamp.pid))),
    'owned processes stopped'
  );
}

export function schemaSql() {
  const blocks = [
    ...readFileSync(join(repo, 'docs/contracts/02-execution.md'), 'utf8').matchAll(/```sql\r?\n([\s\S]*?)```/g),
  ];
  assert.equal(blocks.length, 1, 'one authoritative SQL block');
  return blocks[0][1];
}

export function openDb(path, initialize = false) {
  assert.ok(path.startsWith(`${home}/`), 'SQLite must remain in temporary HUD_HOME');
  const db = new DatabaseSync(path);
  if (initialize) db.exec(schemaSql());
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0;');
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  return db;
}

export function begin(db) {
  const deadline = now() + 1500;
  let retries = 0;
  for (;;) {
    try {
      db.exec('BEGIN IMMEDIATE');
      return retries;
    } catch (error) {
      if (!/locked|busy/i.test(error.message) || now() >= deadline) throw error;
      retries += 1;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
}

export function tx(db, fn) {
  begin(db);
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function insert(db, table, row) {
  assert.match(table, /^[a-z_]+$/);
  const keys = Object.keys(row);
  return db
    .prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
    .run(...Object.values(row));
}

export function event(db, kind, runId = null, payload = {}) {
  return insert(db, 'events', { kind, run_id: runId, payload: json(payload), at: now() });
}

export function evidence(db, kind, payload, runId = null) {
  const evidenceId = id();
  insert(db, 'evidence', {
    evidence_id: evidenceId,
    run_id: runId,
    kind,
    producer: 'reconciler',
    fingerprint: hash(payload),
    payload: json(payload),
    observed_at: now(),
    validated_at: now(),
    validation: 'accepted',
  });
  return evidenceId;
}

export function source(db, root, harness = 'codex') {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const rootPath = realpathSync(root);
  const sourceId = hash([harness, rootPath]);
  db.prepare('INSERT OR IGNORE INTO sources VALUES (?,?,?,?)').run(sourceId, harness, rootPath, 'synthetic');
  return { sourceId, root: rootPath, harness };
}

export function session(db, origin, sessionId, thread = '') {
  const ref = json([origin.harness, origin.sourceId, sessionId, thread || null]);
  db.prepare('INSERT OR IGNORE INTO sessions VALUES (?,?,?,?,?)').run(
    ref,
    origin.harness,
    origin.sourceId,
    sessionId,
    thread
  );
  return ref;
}

export function newCaller(db, origin, stamp = stat(process.pid), parent = stat(process.ppid)) {
  const callerId = id();
  insert(db, 'callers', {
    caller_id: callerId,
    harness: origin.harness,
    source_id: origin.sourceId,
    pid: stamp.pid,
    proc_start: stamp.proc_start,
    ppid: parent.pid,
    parent_proc_start: parent.proc_start,
    cwd: home,
    started_at: now(),
    last_seen_at: now(),
  });
  return callerId;
}

export function context(db, origin, harnessStamp, callerId, ref = null) {
  const processKey = json([origin.harness, origin.sourceId, domain, harnessStamp.pid, harnessStamp.proc_start]);
  let scope = db.prepare('SELECT * FROM caller_scopes WHERE process_key=? AND closed_at IS NULL').get(processKey);
  if (!scope) {
    const generation =
      (db.prepare('SELECT max(generation) AS n FROM caller_scopes WHERE process_key=?').get(processKey).n || 0) + 1;
    const proofId = ref ? evidence(db, 'trusted_session', { ref, harnessStamp }) : null;
    insert(db, 'caller_scopes', {
      process_key: processKey,
      generation,
      harness: origin.harness,
      source_id: origin.sourceId,
      pid_domain: domain,
      harness_pid: harnessStamp.pid,
      harness_proc_start: harnessStamp.proc_start,
      session_ref: ref,
      bound_by: ref ? 'trusted_session' : null,
      binding_evidence_id: proofId,
      created_at: now(),
    });
    scope = db.prepare('SELECT * FROM caller_scopes WHERE process_key=? AND generation=?').get(processKey, generation);
  }
  let ctx = db.prepare('SELECT * FROM caller_contexts WHERE caller_id=? AND closed_at IS NULL').get(callerId);
  if (!ctx) {
    insert(db, 'caller_contexts', {
      context_id: id(),
      generation: scope.generation,
      caller_id: callerId,
      context_key: 'stdio',
      kind: 'dedicated',
      source_id: origin.sourceId,
      harness: origin.harness,
      process_key: processKey,
      proc_generation: scope.generation,
      session_ref: scope.session_ref,
      bound_by: scope.bound_by,
      binding_evidence_id: scope.binding_evidence_id,
      created_at: now(),
    });
    ctx = db.prepare('SELECT * FROM caller_contexts WHERE caller_id=? AND closed_at IS NULL').get(callerId);
  }
  return { ...ctx, owner: ctx.session_ref ? sessionOwner(ctx.session_ref) : procOwner(processKey, ctx.generation) };
}

export function current(db, ctx) {
  const found = db
    .prepare('SELECT * FROM caller_contexts WHERE context_id=? AND generation=? AND closed_at IS NULL')
    .get(ctx.context_id, ctx.generation);
  assert.ok(found, 'identity_unverified: stale context');
  const scope = db
    .prepare('SELECT * FROM caller_scopes WHERE process_key=? AND generation=? AND closed_at IS NULL')
    .get(found.process_key, found.generation);
  assert.ok(scope, 'identity_unverified: closed scope');
  return found.session_ref ? sessionOwner(found.session_ref) : procOwner(found.process_key, found.generation);
}

export function switchSession(db, ctx) {
  return tx(db, () => {
    current(db, ctx);
    const at = now();
    db.prepare('UPDATE caller_contexts SET closed_at=? WHERE process_key=? AND generation=? AND closed_at IS NULL').run(
      at,
      ctx.process_key,
      ctx.generation
    );
    db.prepare('UPDATE caller_scopes SET closed_at=? WHERE process_key=? AND generation=?').run(
      at,
      ctx.process_key,
      ctx.generation
    );
    db.prepare('UPDATE owner_aliases SET closed_at=? WHERE process_key=? AND generation=?').run(
      at,
      ctx.process_key,
      ctx.generation
    );
    db.prepare(
      `UPDATE claims SET state='revoked' WHERE redeemed_context_id IN
      (SELECT context_id FROM caller_contexts WHERE process_key=? AND generation=?)`
    ).run(ctx.process_key, ctx.generation);
    db.prepare(
      `UPDATE child_bindings SET is_current=0,revoked_at=? WHERE is_current=1 AND caller_context_id IN
      (SELECT context_id FROM caller_contexts WHERE process_key=? AND generation=?)`
    ).run(at, ctx.process_key, ctx.generation);
    event(db, 'identity.invalidated', null, { processKey: ctx.process_key, generation: ctx.generation });
  });
}

export function mergeOwner(db, ctx, ref, checkpoint = () => {}) {
  try {
    return tx(db, () => {
      current(db, ctx);
      const oldOwner = procOwner(ctx.process_key, ctx.generation);
      const owner = sessionOwner(ref);
      const alias = db
        .prepare('SELECT * FROM owner_aliases WHERE process_key=? AND generation=?')
        .get(ctx.process_key, ctx.generation);
      assert.ok(!alias || alias.session_ref === ref, 'alias_conflict');
      const rows = db.prepare('SELECT * FROM idempotency WHERE owner_key=?').all(oldOwner);
      for (const row of rows) {
        const collision = db
          .prepare('SELECT * FROM idempotency WHERE owner_key=? AND request_key=?')
          .get(owner, row.request_key);
        if (collision) {
          for (const key of ['params_version', 'params_digest', 'link_id', 'run_id', 'outcome'])
            assert.equal(row[key], collision[key], `merge_conflict: ${key}`);
        }
      }
      const proofId = evidence(db, 'trusted_session', { ref, processKey: ctx.process_key, generation: ctx.generation });
      db.prepare(
        "UPDATE caller_scopes SET session_ref=?,bound_by='trusted_session',binding_evidence_id=? WHERE process_key=? AND generation=?"
      ).run(ref, proofId, ctx.process_key, ctx.generation);
      db.prepare(
        "UPDATE caller_contexts SET session_ref=?,bound_by='trusted_session',binding_evidence_id=? WHERE process_key=? AND generation=? AND closed_at IS NULL"
      ).run(ref, proofId, ctx.process_key, ctx.generation);
      if (!alias)
        insert(db, 'owner_aliases', {
          process_key: ctx.process_key,
          generation: ctx.generation,
          session_ref: ref,
          evidence_id: proofId,
          created_at: now(),
        });
      for (const row of rows) {
        if (db.prepare('SELECT 1 FROM idempotency WHERE owner_key=? AND request_key=?').get(owner, row.request_key)) {
          db.prepare('DELETE FROM idempotency WHERE owner_key=? AND request_key=?').run(oldOwner, row.request_key);
        } else {
          db.prepare('UPDATE idempotency SET owner_key=? WHERE owner_key=? AND request_key=?').run(
            owner,
            oldOwner,
            row.request_key
          );
        }
      }
      db.prepare(
        `UPDATE links SET parent_ref=? WHERE parent_context_id IN
        (SELECT context_id FROM caller_contexts WHERE process_key=? AND generation=?) AND parent_ref IS NULL`
      ).run(ref, ctx.process_key, ctx.generation);
      checkpoint('merge_updated');
      event(db, 'owner.merged', null, { oldOwner, owner });
      return owner;
    });
  } catch (error) {
    tx(db, () => event(db, 'identity.conflict', null, { reason: error.message }));
    throw error;
  }
}

export async function accept(db, ctx, origin, requestKey, params, checkpoint = async () => {}) {
  const busyRetries = begin(db);
  try {
    await checkpoint('write_lock');
    const owner = current(db, ctx);
    const digest = hash(params);
    const prior = db.prepare('SELECT * FROM idempotency WHERE owner_key=? AND request_key=?').get(owner, requestKey);
    if (prior) {
      assert.equal(prior.params_digest, digest, 'idempotency_conflict');
      db.exec('COMMIT');
      return { ...JSON.parse(prior.outcome), replay: true, busyRetries };
    }
    const runId = id();
    const linkId = id();
    const ticket = randomBytes(32).toString('hex');
    const claim = randomBytes(32).toString('hex');
    const at = now();
    const outcome = { linkId, runId, state: 'starting' };
    insert(db, 'links', {
      link_id: linkId,
      state: 'pending',
      parent_caller: ctx.caller_id,
      parent_context_id: ctx.context_id,
      parent_context_generation: ctx.generation,
      parent_ref: ctx.session_ref,
      backend: origin.harness,
      role: 'synthetic',
      brief_path: join(home, 'synthetic-brief'),
      task_digest: hash('synthetic'),
      created_at: at,
    });
    await checkpoint('links');
    insert(db, 'runs', {
      run_id: runId,
      link_id: linkId,
      run_seq: 1,
      operation: 'spawn',
      source_id: origin.sourceId,
      harness: origin.harness,
      expected_generation: 1,
      mode: 'headless',
      launch_cwd: home,
      state: 'starting',
      launch_token_hash: hash(ticket),
      launch_digest: digest,
      launch_call_id: id(),
      launch_correlation_id: id(),
      created_at: at,
    });
    await checkpoint('runs');
    insert(db, 'claims', {
      run_id: runId,
      claim_hash: hash(claim),
      source_id: origin.sourceId,
      expected_generation: 1,
      state: 'issued',
      issued_at: at,
      expires_at: at + 1800000,
    });
    await checkpoint('claims');
    insert(db, 'idempotency', {
      owner_key: owner,
      origin_owner_key: owner,
      request_key: requestKey,
      params_digest: digest,
      link_id: linkId,
      run_id: runId,
      outcome: json(outcome),
      at,
    });
    await checkpoint('idempotency');
    insert(db, 'slots', {
      slot_key: `provisional:${runId}`,
      session_ref: null,
      run_id: runId,
      holder: hash(ticket),
      acquired_at: at,
    });
    await checkpoint('slots');
    event(db, 'accepted', runId, {
      actor: { kind: 'mcp', callerId: ctx.caller_id, contextId: ctx.context_id, contextGeneration: ctx.generation },
    });
    await checkpoint('events');
    await checkpoint('before_commit');
    db.exec('COMMIT');
    await checkpoint('after_commit');
    return { ...outcome, replay: false, ticket, claim, busyRetries };
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

export function arm(db, runId, ticket, stamp) {
  return tx(db, () => {
    const run = db.prepare('SELECT * FROM runs WHERE run_id=?').get(runId);
    const slot = db.prepare('SELECT * FROM slots WHERE run_id=?').get(runId);
    if (
      !run ||
      !slot ||
      run.state !== 'starting' ||
      run.launch_phase !== 'reserved' ||
      run.submission_fenced_at ||
      run.cancel_requested_at ||
      run.supervisor_pid ||
      hash(ticket) !== run.launch_token_hash ||
      slot.holder !== hash(ticket)
    )
      return false;
    const link = db.prepare('SELECT * FROM links WHERE link_id=?').get(run.link_id);
    current(db, { context_id: link.parent_context_id, generation: link.parent_context_generation });
    db.prepare(
      "UPDATE runs SET supervisor_pid=?,supervisor_proc_start=?,launch_phase='armed',heartbeat_at=?,heartbeat_seq=1,heartbeat_mono_ms=0 WHERE run_id=?"
    ).run(stamp.pid, stamp.proc_start, now(), runId);
    db.prepare("UPDATE claims SET state='armed',supervisor_pid=?,supervisor_proc_start=? WHERE run_id=?").run(
      stamp.pid,
      stamp.proc_start,
      runId
    );
    return true;
  });
}

export function scopeOf(stamp) {
  return {
    scope_kind: 'pgid',
    scope_id: hash([stamp.pid, stamp.proc_start, boot]),
    boot_id: boot,
    pid_domain: domain,
    pgid: stamp.pgid,
    sid: stamp.sid,
    group_leader: stamp,
    harness: stamp,
  };
}

export function inspectScope(scope, options = {}) {
  let scanned = false;
  if (!scope || options.visibility === 'partial')
    return { result: 'unknown', missing: ['scope_or_visibility'], scanned };
  if (scope.boot_id !== boot || scope.pid_domain !== domain)
    return { result: 'unknown', missing: ['boot_or_domain'], scanned };
  scanned = true;
  const members = [];
  let complete = true;
  for (const name of readdirSync('/proc').filter((name) => /^\d+$/.test(name))) {
    try {
      const member = stat(Number(name));
      if (member?.pgid === scope.pgid) members.push(member);
    } catch {
      complete = false;
    }
  }
  const oldLeader = stat(scope.group_leader.pid);
  const reused = oldLeader && !sameInstance(scope.group_leader, oldLeader);
  const alive = members.filter(live);
  return {
    result: !complete || reused ? 'unknown' : alive.length ? 'alive' : 'gone',
    members,
    zombies: members.filter((m) => m.state === 'Z'),
    scanned,
  };
}

export function receiptPath(runId) {
  return join(home, `receipt-${runId}.json`);
}

export async function reconcile(db, runId, options = {}, checkpoint = async () => {}) {
  const run = db.prepare('SELECT * FROM runs WHERE run_id=?').get(runId);
  const scope = run.scope_ref ? JSON.parse(run.scope_ref) : null;
  const group = inspectScope(scope, options);
  const supervisor = run.supervisor_pid
    ? { pid: run.supervisor_pid, proc_start: run.supervisor_proc_start, boot_id: boot, pid_domain: domain }
    : null;
  const supervisorDead =
    !!supervisor && (!sameInstance(supervisor, stat(supervisor.pid)) || !live(stat(supervisor.pid)));
  const launchProof = db
    .prepare("SELECT * FROM evidence WHERE run_id=? AND kind='launch_receipt' AND validation='accepted'")
    .get(runId);
  const proof = launchProof && JSON.parse(launchProof.payload);
  const rosterComplete =
    proof?.launchersComplete === true && Array.isArray(proof.launchers) && proof.launchers.length > 0;
  const launchersSealed =
    rosterComplete &&
    proof.launchers.every(
      (launcher) =>
        Number.isInteger(launcher.pid) &&
        typeof launcher.proc_start === 'string' &&
        launcher.boot_id === boot &&
        launcher.pid_domain === domain &&
        (!sameInstance(launcher, stat(launcher.pid)) ||
          !live(stat(launcher.pid)) ||
          (proof.sealed || []).some((sealed) => sameInstance(sealed, launcher)))
    );
  const harness = proof?.harness;
  const harnessGone = !!harness && (!sameInstance(harness, stat(harness.pid)) || !live(stat(harness.pid)));
  const escaped = (proof?.writers || []).some(
    (writer) =>
      sameInstance(writer, stat(writer.pid)) && live(stat(writer.pid)) && stat(writer.pid).pgid !== scope?.pgid
  );
  const R = options.receiptMissing
    ? null
    : existsSync(receiptPath(runId))
      ? JSON.parse(readFileSync(receiptPath(runId), 'utf8'))
      : null;
  const receiptMatches =
    !!R &&
    R.runId === runId &&
    R.sourceId === run.source_id &&
    R.generation === run.expected_generation &&
    R.scopeId === scope?.scope_id;
  const complete = !!launchProof && !!scope && group.result === 'gone' && harnessGone && launchersSealed && !escaped;
  const N =
    run.launch_phase !== 'submitting' &&
    run.launch_phase !== 'submitted' &&
    !!run.submission_fenced_at &&
    !launchProof &&
    (!supervisor || supervisorDead) &&
    !options.unproven;
  const Q = complete && !receiptMatches;
  const validR = complete && receiptMatches;
  const cancelEvent = db
    .prepare("SELECT seq,payload FROM events WHERE run_id=? AND kind='cancel.accepted' ORDER BY seq LIMIT 1")
    .get(runId);
  const cancelFact = cancelEvent && JSON.parse(cancelEvent.payload);
  const scopeEvent =
    cancelEvent &&
    db
      .prepare(
        "SELECT seq,payload FROM events WHERE run_id=? AND kind='cancel.scope_observed' AND seq>? ORDER BY seq LIMIT 1"
      )
      .get(runId, cancelEvent.seq);
  const scopeFact = scopeEvent && JSON.parse(scopeEvent.payload);
  const end = receiptMatches ? R.scopeEnded : null;
  const sourcedEnd =
    end &&
    end.scopeId === scope.scope_id &&
    end.group.result === 'gone' &&
    end.harnessTerminated &&
    end.launchersSealed &&
    sameInstance(end.clock.producer, supervisor);
  let exitBeforeCancel = false;
  let cancelBeforeExit = false;
  if (run.cancel_requested_at && cancelFact) {
    if (sourcedEnd && sameInstance(end.clock.producer, cancelFact.clock.producer)) {
      exitBeforeCancel = BigInt(end.clock.monoNs) < BigInt(cancelFact.clock.monoNs);
    }
    // An exit observation after acceptance is only an upper bound. Positive C needs a later live observation.
    if (
      scopeFact?.acceptedSeq === cancelEvent.seq &&
      scopeFact.scopeId === scope?.scope_id &&
      scopeFact.group.result === 'alive' &&
      sameInstance(scopeFact.clock.producer, cancelFact.clock.producer) &&
      BigInt(scopeFact.clock.monoNs) > BigInt(cancelFact.clock.monoNs)
    )
      cancelBeforeExit = true;
  }
  let state = run.state;
  let basis = null;
  let cancelResult = null;
  const savedTerminal = db
    .prepare(
      "SELECT payload FROM events WHERE run_id=? AND kind IN ('run.ended','run.cancelled','run.failed') ORDER BY seq LIMIT 1"
    )
    .get(runId);
  let terminalNote = savedTerminal ? (JSON.parse(savedTerminal.payload).terminalNote ?? null) : null;
  if (!['ended', 'failed', 'cancelled'].includes(state)) {
    if (
      escaped ||
      (R && (!receiptMatches || !complete)) ||
      (group.result === 'gone' && launchProof && !launchersSealed)
    )
      state = 'uncertain';
    else if (validR || Q) {
      if (run.cancel_requested_at && exitBeforeCancel && cancelBeforeExit) state = 'uncertain';
      else {
        state = run.cancel_requested_at && cancelBeforeExit ? 'cancelled' : 'ended';
        cancelResult = run.cancel_requested_at
          ? exitBeforeCancel
            ? 'already_ended'
            : cancelBeforeExit
              ? 'confirmed'
              : null
          : null;
        terminalNote =
          run.cancel_requested_at && !exitBeforeCancel && !cancelBeforeExit ? 'cancel_timing_unknown' : null;
        basis = validR ? 'R' : 'Q';
      }
    } else if (N) {
      state = 'failed';
      basis = 'N';
    } else if (
      run.launch_phase === 'reserved' &&
      !supervisor &&
      !run.cancel_requested_at &&
      !run.submission_fenced_at &&
      (options.age ?? now() - run.created_at) <= 30000
    )
      state = 'starting';
    else if (supervisorDead || (run.heartbeat_at != null && now() - run.heartbeat_at > 30000)) state = 'uncertain';
    else if (group.result === 'alive' && proof && run.heartbeat_at != null)
      state = run.cancel_requested_at ? 'cancelling' : 'running';
    else if (
      run.launch_phase === 'armed' &&
      !run.submission_fenced_at &&
      !run.cancel_requested_at &&
      now() - run.created_at <= 30000
    )
      state = 'starting';
    else if (state !== 'cancelling') state = 'uncertain';
  }
  const observation = {
    state,
    basis,
    group,
    supervisorDead,
    launchersSealed,
    rosterComplete,
    harnessGone,
    escaped,
    Q,
    N,
    cancelResult,
    terminalNote,
    exitBeforeCancel,
    cancelBeforeExit,
    missing: [
      !scope && 'scope',
      !launchProof && 'launch_record',
      !harnessGone && 'harness_termination',
      !rosterComplete && 'complete_launcher_roster',
      !launchersSealed && 'launcher_seal',
      group.result === 'unknown' && 'complete_visibility',
      (validR || Q) && run.cancel_requested_at && exitBeforeCancel && cancelBeforeExit && 'cancel_exit_conflict',
    ].filter(Boolean),
    interaction: {
      focus: !supervisorDead && state === 'running',
      input: !supervisorDead && state === 'running',
      resume: false,
    },
    cause: supervisorDead && !basis ? 'supervisor_dead' : null,
  };
  begin(db);
  try {
    if (basis) {
      const proofId = evidence(
        db,
        basis === 'N' ? 'never_submitted' : basis === 'R' ? 'exit_receipt' : 'scope_reconciled',
        observation,
        runId
      );
      await checkpoint('terminal_evidence');
      const native = basis === 'R' ? R.native : null;
      assert.ok(
        !native || (native.subject === 'harness' && ['wait_status', 'trusted_harness_result'].includes(native.source)),
        'native exit needs harness provenance'
      );
      db.prepare(
        `UPDATE runs SET state=?,ended_at=?,terminal_evidence_id=?,submission_fenced_at=coalesce(submission_fenced_at,?),exit_code=?,exit_signal=?,exit_source=?,shell_status=? WHERE run_id=?`
      ).run(
        state,
        now(),
        proofId,
        now(),
        native?.code ?? null,
        native?.signal ?? null,
        native?.source ?? null,
        basis === 'R' ? (R.shellStatus ?? null) : null,
        runId
      );
      await checkpoint('terminal_state');
      db.prepare("UPDATE claims SET state='revoked' WHERE run_id=?").run(runId);
      await checkpoint('terminal_claim');
      db.prepare('DELETE FROM slots WHERE run_id=?').run(runId);
      await checkpoint('terminal_slot');
      event(db, `run.${state}`, runId, { basis, terminalNote });
      await checkpoint('terminal_event');
    } else if (state !== run.state) {
      db.prepare('UPDATE runs SET state=? WHERE run_id=?').run(state, runId);
      event(db, `run.${state}`, runId, observation);
    }
    await checkpoint('terminal_before_commit');
    db.exec('COMMIT');
    await checkpoint('terminal_after_commit');
    return observation;
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

export class Peer {
  constructor(mode, options = {}) {
    this.messages = [];
    this.pending = new Map();
    this.child = fork(fileURLToPath(new URL('./process.mjs', import.meta.url)), [mode, ...(options.argv || [])], {
      cwd: home,
      env: {
        ...(options.env || {}),
        PATH: process.env.PATH,
        HUD_HOME: home,
        A9_EVIDENCE: evidenceDir,
        A9_REGISTRY: process.env.A9_REGISTRY,
        NODE_NO_WARNINGS: '1',
        A9_OPTIONS: json(options),
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      detached: !!options.detached,
    });
    this.pid = this.child.pid;
    const childStamp = stat(this.pid);
    if (childStamp) appendFileSync(process.env.A9_REGISTRY, `${json(childStamp)}\n`, { mode: 0o600 });
    this.output = '';
    this.child.stdout.on('data', (chunk) => {
      this.output += chunk;
    });
    this.child.stderr.on('data', (chunk) => {
      this.output += chunk;
    });
    this.child.on('message', (message) => {
      this.messages.push(message);
      const deferred = this.pending.get(message.reply);
      if (deferred) {
        this.pending.delete(message.reply);
        deferred.resolve(message);
      }
    });
    this.closed = new Promise((resolve) => {
      this.child.on('error', (error) => resolve({ error: error.message }));
      this.child.on('exit', (code, signalName) => {
        this.exit = { code, signal: signalName };
        for (const deferred of this.pending.values())
          deferred.reject(new Error(`peer ${mode} exited ${json(this.exit)}: ${this.output}`));
        this.pending.clear();
        resolve(this.exit);
      });
    });
  }
  async wait(type) {
    return until(
      () =>
        this.messages.find((message) => message.type === type) ||
        (this.exit && Promise.reject(new Error(`peer exited before ${type}: ${this.output}`))),
      type
    );
  }
  call(action, payload = {}) {
    const request = id();
    return new Promise((resolve, reject) => {
      this.pending.set(request, { resolve, reject });
      this.child.send({ request, action, ...payload });
    });
  }
  async stop() {
    const stamp = stat(this.pid);
    if (stamp && !this.exit) signal(stamp, 'SIGKILL');
    return this.closed;
  }
}

export class Suite {
  constructor(group) {
    this.group = group;
    this.results = [];
    this.peers = [];
    this.stamp = registerProcess();
  }
  peer(mode, options) {
    const peer = new Peer(mode, options);
    this.peers.push(peer);
    return peer;
  }
  fixture(label, bound = true) {
    const directory = join(home, `${this.group}-${label}-${id()}`);
    mkdirSync(directory, { mode: 0o700 });
    const path = join(directory, 'ledger.sqlite');
    const db = openDb(path, true);
    const origin = source(db, join(directory, 'source'));
    const ref = session(db, origin, 'synthetic-parent');
    const caller = newCaller(db, origin);
    const ctx = context(db, origin, stat(process.pid), caller, bound ? ref : null);
    return { directory, path, db, origin, ref, ctx };
  }
  async test(testId, description, body) {
    const start = this.peers.length;
    const processStart = ownedProcesses().length;
    const detail = [];
    let result;
    try {
      await body(detail);
      result = { testId, status: 'PASS', description, detail };
    } catch (error) {
      result = { testId, status: 'FAIL', description, error: error.stack, detail };
      process.exitCode = 1;
    } finally {
      for (const peer of this.peers.slice(start).reverse()) await peer.stop();
      await stopOwned(ownedProcesses().slice(processStart));
    }
    this.results.push(result);
    writeFileSync(join(evidenceDir, `${testId}.json`), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    console.log(`${result.status} ${testId} ${description}${result.error ? `: ${result.error}` : ''}`);
  }
  finish() {
    const schema = schemaSql();
    writeFileSync(join(evidenceDir, 'schema.sql'), schema, { mode: 0o600 });
    writeFileSync(
      join(evidenceDir, `${this.group}-schema.json`),
      json({ sha256: hash(schema), tables: 16, userVersion: 1 }),
      { mode: 0o600 }
    );
  }
}

export async function killedAt(suite, fixture, mode, point, extra = {}) {
  const peer = suite.peer(mode, { path: fixture.path, ctx: fixture.ctx, origin: fixture.origin, cut: point, ...extra });
  const reached = await peer.wait('cut');
  assert.equal(reached.point, point);
  const outcome = await peer.stop();
  assert.equal(outcome.signal, 'SIGKILL');
  return { point, pid: peer.pid, ...outcome, ...reached };
}

export function snapshot(db) {
  return Object.fromEntries(
    ['links', 'runs', 'claims', 'idempotency', 'slots', 'events'].map((table) => [
      table,
      db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n,
    ])
  );
}

export function countSubmissions(directory) {
  const path = join(directory, 'submissions.jsonl');
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).length : 0;
}

export function value(reply) {
  while (reply && typeof reply === 'object') {
    if (reply.error) throw new Error(reply.error);
    if (!Object.hasOwn(reply, 'value')) break;
    reply = reply.value;
  }
  return reply;
}

export async function harnessPeer(suite, fixture, options = {}) {
  const peer = suite.peer('harness', {
    path: fixture.path,
    origin: fixture.origin,
    record: join(fixture.directory, `current-${id()}.json`),
    ...options,
  });
  const ready = await peer.wait('ready');
  return {
    peer,
    stamp: ready.stamp,
    call: async (method, payload = {}, name = 'main') => value(await peer.call('call', { method, payload, name })),
    start: async (name = 'main', cut) => value(await peer.call('start', { name, cut })),
  };
}

export function meta(sessionId = 'synthetic-session', extras = {}) {
  return { _meta: { sessionId, 'x-codex-turn-metadata': { session_id: sessionId }, ...extras } };
}
