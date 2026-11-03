import { parentPort } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { SessionPublisher } from '../../dist/core/link/publisher.js';
import { ObservationStore } from '../../dist/core/observation-store.js';
import { HudDelegationCollector } from '../../dist/collectors/delegation.js';

// Private deterministic test bootstrap. Production open() cannot select this module.
export function install(data) {
  if (data.epoch) Date.now = () => data.epoch;
  if (data.debugEviction) {
    const evict = SessionPublisher.prototype.evictAcceptedReading;
    SessionPublisher.prototype.evictAcceptedReading = function () {
      const a = this.prepared?.checkpoint.identity,
        b = this.prior?.checkpointIdentity,
        c = this.result?.checkpoint;
      const info = {
        pending: this.pending,
        prepared: !!this.prepared,
        prior: !!this.prior,
        result: !!this.result,
        content: [a?.contentIdentity, b?.contentIdentity],
        file: [JSON.stringify(c?.fileId), JSON.stringify(b?.fileId)],
        offset: [c?.offset, b?.offset],
        generation: [c?.sourceGeneration, b?.sourceGeneration],
        context: [
          this.context,
          JSON.stringify([this.prior?.observationStamp.runId, this.prior?.observationStamp.bindingGeneration]),
        ],
      };
      const okay = evict.call(this);
      if (!okay) console.log('EVICTION_REJECT', JSON.stringify(info));
      return okay;
    };
  }
  if (data.pinProbe) {
    const open = HudDelegationCollector.open;
    HudDelegationCollector.open = async function (...args) {
      const c = await open.apply(this, args);
      if (!c) return c;
      const port = c.port,
        admit = port.admit.bind(port);
      let dumps = 0;
      port.admit = function (r) {
        const accepted = admit(r);
        if (!accepted && port.resourceBlocked === 'reader_slots_pinned' && dumps++ < 3) {
          console.log(
            'B10D_PIN_DETAIL',
            JSON.stringify(
              [...port.readings.values()]
                .filter((x) => port.residency(x))
                .map((x) => ({
                  id: x.ref.sessionId,
                  reader: Boolean(x.reader),
                  checkpoint: Boolean(x.checkpoint),
                  pending: x.publisher?.hasPending(),
                  hasReading: x.publisher?.hasReading(),
                  caughtUp: x.caughtUp,
                  recovery: x.recoveryPending,
                  reset: x.resetPending,
                  delivery: x.deliveryPending,
                  continuityRestorable: x.publisher?.recoverableContinuity,
                  acceptedEvictable: x.publisher?.canEvictAcceptedReading(),
                  tail: x.checkpoint?.parserState?.tailAtEof,
                  tailBytes: x.checkpoint?.parserState?.tailBytesSeen,
                  discarding: x.checkpoint?.parserState?.discardingOversize,
                  preparedMatches:
                    x.publisher?.prepared?.checkpoint.identity.contentIdentity ===
                    x.publisher?.prior?.checkpointIdentity.contentIdentity,
                  leaseValid: x.publisher?.valid(Date.now()),
                }))
            )
          );
        }
        return accepted;
      };
      return c;
    };
  }
  const flags = new Int32Array(data.control);
  Atomics.add(flags, 5, 1);
  if (Atomics.load(flags, 0) === 9) throw new Error('synthetic_worker_startup_failure');
  if (data.probe) {
    const open = HudDelegationCollector.open;
    HudDelegationCollector.open = async function (...args) {
      const runtime = await open.apply(this, args);
      if (!runtime) return runtime;
      const port = runtime.port,
        original = port.collect.bind(port),
        begin = port.begin.bind(port);
      let n = 0,
        selected = null,
        beginMs = 0;
      port.begin = function (...args) {
        const at = performance.now();
        try {
          return begin(...args);
        } finally {
          beginMs = performance.now() - at;
        }
      };
      port.collect = async function (ref, kind, budget) {
        const at = performance.now();
        const value = await original(ref, kind, budget);
        selected = { id: ref.sessionId, kind, budget, ms: performance.now() - at };
        return value;
      };
      const tick = runtime.tick.bind(runtime);
      runtime.tick = async function (...args) {
        selected = null;
        const v = await tick(...args);
        if (++n % 100 === 0) {
          const rows = [...port.readings.values()];
          console.log(
            'B10D_PROBE',
            JSON.stringify({
              n,
              beginMs,
              selected,
              stats: runtime.collector.stats(),
              resources: port.resources(),
              pendingCommits: port.pendingCommits.size,
              counts: {
                reader: rows.filter((r) => r.reader).length,
                caughtUp: rows.filter((r) => r.caughtUp).length,
                dirty: rows.filter((r) => r.dirty).length,
                pending: rows.filter((r) => r.publisher?.hasPending()).length,
                lease: rows.filter((r) => r.publisher?.lease).length,
                recovery: rows.filter((r) => r.recoveryPending).length,
              },
              unavailable: rows
                .filter((r) => !r.envelope?.loaded)
                .slice(0, 3)
                .map((r) => ({
                  id: r.ref.sessionId,
                  caughtUp: r.caughtUp,
                  dirty: r.dirty,
                  reader: !!r.reader,
                  recovery: r.recoveryPending,
                  lease: !!r.publisher?.lease,
                  lastKind: r.lastGrantedKind,
                  offset: r.checkpoint?.offset,
                })),
            })
          );
        }
        return v;
      };
      return runtime;
    };
  }
  const traces = HudDelegationCollector.prototype.takeCommitTraces;
  HudDelegationCollector.prototype.takeCommitTraces = function () {
    const rows = traces.call(this);
    if (rows.length && [15, 16].includes(Atomics.load(flags, 0))) {
      const code = Atomics.load(flags, 0);
      Atomics.store(flags, 0, code === 16 ? 17 : 0);
      Atomics.store(flags, 1, code);
      rows[0].stamp.seqDomain = 'x'.repeat(2 * 1024 * 1024 + 1);
    }
    return rows;
  };
  const close = HudDelegationCollector.prototype.close;
  HudDelegationCollector.prototype.close = function () {
    hit(17);
    return close.call(this);
  };
  let inPublish = false;
  const renewals = new Map();
  const hit = (code) => {
    if (Atomics.load(flags, 0) !== code) return;
    Atomics.store(flags, 0, 0);
    Atomics.store(flags, 1, code);
    Atomics.notify(flags, 1);
    const action = Atomics.load(flags, 3);
    if (action === 1) process.exit(77);
    if (action === 2) throw new Error('synthetic_storage_failure');
    Atomics.wait(flags, 2, 0, 35000);
  };
  for (const [method, code] of [
    ['acquire', 1],
    ['renew', 2],
    ['readRecovery', 10],
  ]) {
    const original = ObservationStore.prototype[method];
    ObservationStore.prototype[method] = function (...args) {
      if (method === 'renew') {
        Atomics.add(flags, 8, 1);
        const key = JSON.stringify(args[0]),
          previous = renewals.get(key);
        if (previous !== undefined && Date.now() - previous < 5000) Atomics.add(flags, 9, 1);
      }
      if (method === 'readRecovery') Atomics.add(flags, 10, 1);
      hit(code);
      const result = original.apply(this, args);
      if (method === 'renew') renewals.set(JSON.stringify(args[0]), Date.now());
      return result;
    };
  }
  const publish = ObservationStore.prototype.publishPrepared;
  ObservationStore.prototype.publishPrepared = function (...args) {
    hit(3);
    inPublish = true;
    try {
      return publish.apply(this, args);
    } finally {
      inPublish = false;
    }
  };
  const exec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function (sql) {
    if (inPublish && sql === 'COMMIT') hit(4);
    const result = exec.call(this, sql);
    if (inPublish && sql === 'COMMIT') hit(5);
    return result;
  };
  const post = parentPort.postMessage.bind(parentPort);
  parentPort.postMessage = function (message, ...rest) {
    if (message?.type === 'result' && message.trace.commits.length && Atomics.load(flags, 0) === 13) {
      Atomics.store(flags, 0, 0);
      Atomics.store(flags, 1, 13);
      message.payload = new ArrayBuffer(2 * 1024 * 1024 + 1);
      message.unchanged = false;
    }
    if (message?.type === 'result' && Atomics.load(flags, 0) === 14) {
      Atomics.store(flags, 0, 0);
      Atomics.store(flags, 1, 14);
      message.trace = null;
    }
    if (message?.type === 'fatal' && message.requestId !== null) {
      Atomics.store(flags, 12, JSON.stringify(message).length);
      post(message);
    }
    if (message?.type === 'result') hit(6);
    const result = post(message, ...rest);
    if (message?.type === 'result') hit(7);
    return result;
  };
  parentPort.on('message', (message) => {
    if (message?.type === 'test_exit') process.exit(78);
  });
}
