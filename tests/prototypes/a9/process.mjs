// Every actor is an OS process. IPC barriers expose exact SIGKILL cut points.
import { appendFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import {
  accept,
  arm,
  begin,
  assert,
  context,
  current,
  domain,
  event,
  evidence,
  existsSync,
  hash,
  home,
  id,
  inspectScope,
  join,
  json,
  live,
  mergeOwner,
  newCaller,
  observationClock,
  now,
  openDb,
  Peer,
  readFileSync,
  receiptPath,
  reconcile,
  registerProcess,
  sameInstance,
  scopeOf,
  session,
  signal,
  sleep,
  source,
  stat,
  switchSession,
  tx,
  until,
  writeFileSync,
} from './common.mjs';

const mode = process.argv[2];
const options = JSON.parse(process.env.A9_OPTIONS || '{}');
const self = registerProcess();
const db = options.path ? openDb(options.path) : null;
const send = (message) => process.send?.(message);
const forever = () => new Promise(() => {});
const checkpoint = async (point, extra = {}) => {
  if (options.cut === point) {
    send({ type: 'cut', point, ...extra });
    await forever();
  }
};
const peers = [];
process.on('disconnect', () => {
  if (mode === 'mcp') process.exit(0);
});

async function supervise() {
  if (!(await arm(db, options.runId, options.ticket, self))) return { won: false };
  if (options.exitAfterArmed != null) process.exit(options.exitAfterArmed);
  await checkpoint('armed');
  db.prepare("UPDATE runs SET launch_phase='submitting' WHERE run_id=? AND submission_fenced_at IS NULL").run(
    options.runId
  );
  await checkpoint('submitting');
  const target = new Peer('workload', { detached: true, directory: options.directory });
  peers.push(target);
  const ready = await target.wait('ready');
  const scope = scopeOf(ready.stamp);
  const proof = { harness: ready.stamp, launchers: [self], launchersComplete: true, sealed: [self], writers: [] };
  if (options.omitProof) delete proof[options.omitProof];
  // Immutable single-spawn actor has now sealed its only dispatch path.
  tx(db, () => {
    if (options.omitProof !== 'scope')
      db.prepare('UPDATE runs SET scope_ref=? WHERE run_id=?').run(json(scope), options.runId);
    if (options.omitProof !== 'launch_record') evidence(db, 'launch_receipt', proof, options.runId);
  });
  await checkpoint('after_spawn', { harness: ready.stamp });
  db.prepare("UPDATE runs SET launch_phase='submitted' WHERE run_id=?").run(options.runId);
  send({ type: 'submitted', stamp: ready.stamp, scope });
  return { won: true, harness: ready.stamp, scope };
}

let callerId;
let origin;
if (mode === 'mcp') {
  origin = options.origin;
  callerId = tx(db, () => newCaller(db, origin, self));
}

function identity(params = {}) {
  const record = JSON.parse(readFileSync(options.record, 'utf8'));
  const harness = stat(process.ppid);
  assert.ok(sameInstance(record.harness, harness), 'identity_unverified: harness instance');
  assert.equal(self.ppid, harness.pid, 'dedicated stdio parent');
  assert.equal(record.sourceId, origin.sourceId, 'identity_unverified: source');
  assert.equal(hash([origin.harness, origin.root]), origin.sourceId);
  const meta = params._meta;
  assert.ok(meta, 'identity_source_missing');
  assert.equal(meta.sessionId, record.sessionId, 'identity_unverified: current session');
  if (origin.harness === 'codex') {
    assert.equal(
      meta['x-codex-turn-metadata']?.session_id,
      record.sessionId,
      'identity_unverified: conflicting metadata'
    );
    assert.ok(!meta.threadId, 'identity_unverified: native child');
  } else {
    const call = record.calls[meta.toolUseId];
    assert.ok(
      call && call.sessionId === record.sessionId && call.agentId === null,
      'identity_source_missing: current root toolUseId'
    );
  }
  const header = JSON.parse(readFileSync(join(origin.root, `${record.sessionId}.json`), 'utf8'));
  assert.equal(header.sessionId, record.sessionId);
  assert.equal(header.sourceId, origin.sourceId, 'identity_unverified: exact source/header');
  const existing = db.prepare('SELECT * FROM caller_contexts WHERE caller_id=? AND closed_at IS NULL').get(callerId);
  let ctx = existing
    ? { ...existing, owner: current(db, existing) }
    : tx(db, () => context(db, origin, harness, callerId, record.bound ? record.ref : null));
  if (params.authContext) {
    assert.equal(ctx.context_id, params.authContext.context_id, 'identity_unverified: old context');
    assert.equal(ctx.generation, params.authContext.generation, 'identity_unverified: old generation');
  }
  if (record.bound && !ctx.session_ref) {
    mergeOwner(db, ctx, record.ref);
    ctx = tx(db, () => context(db, origin, harness, callerId));
  }
  assert.ok(!ctx.session_ref || ctx.session_ref === record.ref, 'identity_unverified: changed session');
  return ctx;
}

function whoami(params) {
  const ctx = identity(params);
  const claim = params.claim ?? process.env.HUD_CLAIM;
  const runId = params.runId ?? process.env.HUD_RUN;
  return tx(db, () => {
    current(db, ctx);
    const run = db.prepare('SELECT * FROM runs WHERE run_id=?').get(runId);
    const credential = db.prepare('SELECT * FROM claims WHERE run_id=?').get(runId);
    assert.ok(run && credential && credential.claim_hash === hash(claim || ''), 'claim_invalid');
    const binding = db.prepare('SELECT * FROM child_bindings WHERE run_id=? AND is_current=1').get(runId);
    const record = JSON.parse(readFileSync(options.record, 'utf8'));
    const launch = db
      .prepare("SELECT * FROM evidence WHERE run_id=? AND kind='launch_receipt' AND validation='accepted'")
      .get(runId);
    const independent = launch && sameInstance(JSON.parse(launch.payload).harness, record.harness);
    if (binding) {
      assert.ok(
        independent && binding.session_ref === ctx.session_ref && credential.state === 'redeemed',
        'claim_conflict'
      );
      if (binding.caller_id !== callerId) {
        db.prepare('UPDATE child_bindings SET is_current=0,revoked_at=? WHERE binding_id=?').run(
          now(),
          binding.binding_id
        );
      } else return { runId, linkId: run.link_id, ref: binding.session_ref, ctx };
    } else {
      assert.ok(['armed', 'redeemed'].includes(credential.state), 'claim_revoked_or_unarmed');
      assert.ok(now() < credential.expires_at, 'claim_expired');
      assert.equal(credential.source_id, origin.sourceId, 'claim_source_mismatch');
      assert.equal(credential.expected_generation, run.expected_generation);
      assert.equal(credential.supervisor_pid, run.supervisor_pid);
      assert.equal(credential.supervisor_proc_start, run.supervisor_proc_start);
      if (credential.state === 'redeemed') assert.ok(independent, 'claim_conflict');
      db.prepare(
        "UPDATE claims SET state='redeemed',redeemed_context_id=?,redeemed_generation=?,redeemed_session_ref=?,redeemed_at=? WHERE run_id=?"
      ).run(ctx.context_id, ctx.generation, ctx.session_ref, now(), runId);
      db.prepare("UPDATE links SET state='claimed',claimed_at=? WHERE link_id=? AND state='pending'").run(
        now(),
        run.link_id
      );
      if (!independent) return { runId, state: 'claimed', authorized: false };
    }
    assert.ok(ctx.session_ref, 'unique session required');
    assert.ok(!run.target_session_ref || run.target_session_ref === ctx.session_ref, 'resume_ref_mismatch');
    const proofId = evidence(db, 'trusted_session', { ref: ctx.session_ref, harness: record.harness }, runId);
    db.prepare('UPDATE slots SET slot_key=?,session_ref=? WHERE run_id=?').run(ctx.session_ref, ctx.session_ref, runId);
    db.prepare('UPDATE runs SET target_session_ref=? WHERE run_id=?').run(ctx.session_ref, runId);
    db.prepare("UPDATE links SET child_ref=?,state='bound',bound_at=?,current_owner=1 WHERE link_id=?").run(
      ctx.session_ref,
      now(),
      run.link_id
    );
    insertBinding(runId, run, ctx, proofId);
    return { runId, linkId: run.link_id, ref: ctx.session_ref, ctx, authorized: true };
  });
}

function insertBinding(runId, run, ctx, proofId) {
  db.prepare(
    `INSERT INTO child_bindings(binding_id,run_id,session_ref,binding_generation,caller_id,caller_context_id,context_generation,bound_by,capabilities,evidence_id,created_at)
    VALUES(?,?,?,?,?,?,?,'trusted_session','mcp',?,?)`
  ).run(
    id(),
    runId,
    ctx.session_ref,
    run.expected_generation,
    callerId,
    ctx.context_id,
    ctx.generation,
    proofId,
    now()
  );
}

let record;
if (mode === 'harness') {
  origin = options.origin;
  options.config = structuredClone(options.config || { mcp_servers: { hud: { env: {} } } });
  const overrides = process.argv.slice(3);
  for (let i = 0; i < overrides.length; i += 2) {
    assert.equal(overrides[i], '-c');
    const match = /^mcp_servers\.hud\.env\.(HUD_CLAIM|HUD_RUN|HUD_LINK|HUD_HOME)=(.*)$/s.exec(overrides[i + 1]);
    assert.ok(match, 'synthetic harness only accepts named configuration leaves');
    options.config.mcp_servers.hud.env[match[1]] = JSON.parse(match[2]);
  }
  record = {
    harness: self,
    sourceId: origin.sourceId,
    sessionId: options.sessionId || 'synthetic-session',
    bound: options.bound !== false,
    calls: {},
  };
  const save = () => {
    record.ref = session(db, origin, record.sessionId);
    writeFileSync(
      join(origin.root, `${record.sessionId}.json`),
      json({ sessionId: record.sessionId, sourceId: origin.sourceId }),
      { mode: 0o600 }
    );
    writeFileSync(options.record, json(record), { mode: 0o600 });
  };
  save();
  const startMcp = async (name, cut) => {
    const env = options.config?.mcp_servers?.hud?.env || {};
    const peer = new Peer('mcp', { path: options.path, origin, record: options.record, env, cut });
    peers[name] = peer;
    const ready = await peer.wait('ready');
    return {
      ...ready,
      harness: self,
      ref: record.ref,
      preserved: {
        command: options.config.mcp_servers.hud.command,
        args: options.config.mcp_servers.hud.args,
        other: options.config.mcp_servers.other,
      },
    };
  };
  options.startMcp = startMcp;
  options.save = save;
}

async function handle(message) {
  if (mode === 'harness') {
    if (message.action === 'start') return options.startMcp(message.name || 'main', message.cut);
    if (message.action === 'wait-cut') return peers[message.name || 'main'].wait('cut');
    if (message.action === 'stop') return peers[message.name || 'main'].stop();
    if (message.action === 'call') return peers[message.name || 'main'].call(message.method, message.payload);
    if (message.action === 'call-record') {
      record.calls[message.toolUseId] = { sessionId: record.sessionId, agentId: message.agentId ?? null };
      options.save();
      return record;
    }
    if (message.action === 'switch') {
      switchSession(db, message.ctx);
      record.sessionId = message.sessionId;
      record.bound = message.bound !== false;
      options.save();
      return record;
    }
    if (message.action === 'bound') {
      record.bound = true;
      options.save();
      return record;
    }
  }
  if (mode === 'mcp') {
    if (message.action === 'initialize' || message.action === 'list') return { bound: false, callerId };
    if (message.action === 'identify') return identity(message.params);
    if (message.action === 'whoami') return whoami(message.params || {});
    const ctx = identity(message.params);
    if (message.action === 'report') {
      const binding = db
        .prepare(
          'SELECT * FROM child_bindings WHERE run_id=? AND caller_context_id=? AND context_generation=? AND is_current=1'
        )
        .get(message.runId, ctx.context_id, ctx.generation);
      assert.ok(binding, 'report_unauthorized');
      db.prepare(`INSERT INTO reports VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
        id(),
        message.runId,
        message.linkId,
        binding.binding_id,
        callerId,
        ctx.context_id,
        ctx.generation,
        'completed',
        'synthetic',
        null,
        now()
      );
      return { reported: true };
    }
    if (message.action === 'resume') {
      current(db, message.oldContext || ctx);
      return { allowed: true };
    }
    if (message.action === 'spawn') {
      const accepted = await accept(
        db,
        ctx,
        origin,
        message.key,
        message.control || { mode: 'headless' },
        async (point) => {
          if (point === 'write_lock' && message.lockPath) {
            writeFileSync(message.lockPath, 'writer holds BEGIN IMMEDIATE', { mode: 0o600 });
            await sleep(200);
          }
        }
      );
      if (!accepted.replay) {
        const supervisor = new Peer('supervisor', {
          path: options.path,
          runId: accepted.runId,
          ticket: accepted.ticket,
          directory: message.directory,
        });
        peers.push(supervisor);
        await supervisor.wait('submitted');
      }
      await checkpoint('before_reply', { runId: accepted.runId });
      return {
        linkId: accepted.linkId,
        runId: accepted.runId,
        state: accepted.state,
        ctx,
        callerId,
        replay: accepted.replay,
        busyRetries: accepted.busyRetries,
      };
    }
  }
  if (mode === 'recovery') {
    if (['heartbeat', 'ticket', 'exit', 'submit'].includes(message.action))
      throw new Error('recovery_has_no_execution_or_writer_right');
    if (message.action === 'reconcile') return reconcile(db, message.runId, message.options, checkpoint);
  }
  throw new Error(`unsupported ${mode}/${message.action}`);
}

process.on('message', async (message) => {
  try {
    send({ reply: message.request, value: await handle(message) });
  } catch (error) {
    send({ reply: message.request, error: error.message });
  }
});

try {
  if (mode === 'intent') {
    const result = await accept(
      db,
      options.ctx,
      options.origin,
      options.key || 'synthetic-key',
      options.params || { mode: 'headless' },
      checkpoint
    );
    send({ type: 'result', value: result });
  } else if (mode === 'lock-until-exit') {
    begin(db);
    send({ type: 'ready', stamp: self });
    if (options.trigger) {
      await until(() => existsSync(options.trigger), 'caller begins cancellation while writer lock is held');
      signal(options.target, 'SIGUSR2');
    }
    await until(
      () => !sameInstance(options.target, stat(options.target.pid)) || !live(stat(options.target.pid)),
      'actual target exit while holding SQLite write lock'
    );
    const observedDeath = { clock: observationClock(), target: stat(options.target.pid), deathBeforeUnlock: true };
    writeFileSync(options.marker, json(observedDeath), { mode: 0o600 });
    db.exec('COMMIT');
    send({ type: 'released', observedDeath });
  } else if (mode === 'terminal') {
    send({ type: 'result', value: await reconcile(db, options.runId, {}, checkpoint) });
  } else if (mode === 'merge') {
    const owner = mergeOwner(db, options.ctx, options.ref, (point) => {
      if (options.cut === point) {
        send({ type: 'cut', point });
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      }
    });
    send({ type: 'result', owner });
  } else if (mode === 'supervisor') {
    if (options.barrier) {
      send({ type: 'ready', stamp: self });
      await new Promise((resolve) => process.once('message', resolve));
    }
    const result = await supervise();
    send({ type: 'result', value: result });
  } else if (mode === 'workload') {
    if (options.directory)
      appendFileSync(join(options.directory, 'submissions.jsonl'), `${json({ pid: self.pid, at: now() })}\n`, {
        mode: 0o600,
      });
    if (options.readyFile) writeFileSync(options.readyFile, json(self), { mode: 0o600 });
    if (options.waitForSignal) process.on('SIGUSR2', () => process.exit(options.exitCode));
    send({ type: 'ready', stamp: self });
    if (options.ignoreInt) process.on('SIGINT', () => {});
    if (options.exitCode != null && !options.waitForSignal)
      setTimeout(() => process.exit(options.exitCode), options.delay || 30);
    else setInterval(() => {}, 60000);
  } else if (mode === 'group') {
    const child = new Peer('workload', { directory: options.directory, ignoreInt: true });
    const ready = await child.wait('ready');
    peers.push(child);
    send({ type: 'ready', stamp: self, member: ready.stamp });
    if (options.leave) process.exit(0);
  } else if (mode === 'zombie') {
    const child = new Peer('workload', { detached: true, exitCode: 0, delay: 200 });
    const ready = await child.wait('ready');
    send({ type: 'ready', stamp: self, zombie: ready.stamp });
    // Block libuv before SIGCHLD so the child really remains unreaped in /proc.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
    await child.closed;
    send({ type: 'reaped' });
  } else if (mode === 'shell') {
    const readyFile = join(home, `shell-child-${id()}.json`);
    const text = options.exec
      ? 'read gate; exec "$1" "$2" workload'
      : 'read gate; "$1" "$2" workload & child=$!; wait "$child"; exit "$3"';
    const shell = spawn(
      '/bin/sh',
      ['-c', text, 'a9-synthetic-shell', process.execPath, process.argv[1], String(options.shellStatus ?? 0)],
      {
        cwd: home,
        env: { ...process.env, A9_OPTIONS: json({ readyFile, exitCode: options.exitCode ?? 7, delay: 250 }) },
        detached: true,
        stdio: ['pipe', 'ignore', 'ignore'],
      }
    );
    const commandLeader = stat(shell.pid);
    appendFileSync(process.env.A9_REGISTRY, `${json(commandLeader)}\n`);
    const closed = new Promise((resolve) => shell.once('exit', (code, signal) => resolve({ code, signal })));
    shell.stdin.end('\n');
    await until(() => existsSync(readyFile), 'real shell started synthetic harness');
    const harness = JSON.parse(readFileSync(readyFile, 'utf8'));
    send({ type: 'ready', stamp: self, commandLeader, harness });
    send({ type: 'shell-exit', ...(await closed) });
  } else if (mode === 'delayed-shell') {
    send({ type: 'ready', stamp: self });
    process.once('SIGCONT', () => {
      const child = new Peer('workload', { detached: true, directory: options.directory });
      peers.push(child);
    });
  } else {
    send({
      type: 'ready',
      stamp: self,
      callerId,
      env:
        mode === 'mcp'
          ? Object.fromEntries(Object.keys(options.env || {}).map((key) => [key, process.env[key]]))
          : null,
      envSource: mode === 'mcp' ? 'process.env' : null,
    });
  }
} catch (error) {
  send({ type: 'fatal', error: error.stack });
  console.error(error.stack);
  process.exitCode = 1;
  process.disconnect?.();
}
