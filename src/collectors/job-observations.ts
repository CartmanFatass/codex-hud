/** Incremental bounded file observation. This module has no execution/control port. */
import * as fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { promises as fsp } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { parseAssociation, DISPATCH_SLOT, type JobAssociation } from '../roles/association.js';
import {
  parseExternalAssociation,
  externalRootHash,
  EXTERNAL_ID,
  type ExternalAssociation,
} from '../roles/external-association.js';
import { parseDispatchStatus, type DispatchStatus } from '../roles/pi-dispatch-status.js';
import { validDispatch, type PiDispatch } from '../roles/pi-dispatch.js';
import {
  HerdrListSampler,
  jevRuntimeAlive,
  LIVE_EXPIRY_MS,
  type HerdrListRunner,
  type JevProcessProbe,
} from './job-live-observation.js';
import type { JobDisplay, JobRequest, JobSnapshot, JobCoverage } from './job-display-types.js';

export const JOB_BOUNDS = Object.freeze({
  entries: 128,
  files: 32,
  bytes: 1024 * 1024,
  nodes: 200,
  closed: 50,
  historyMs: 30 * 86400000,
  helpers: 64,
  helperEntries: 256,
  qaEntries: 512,
  questions: 100,
});
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
type JsonRecord = Record<string, unknown> | null;
const json = (text: string | null): JsonRecord => {
  try {
    const value: unknown = text === null ? null : JSON.parse(text);
    return object(value) ? value : null;
  } catch {
    return null;
  }
};
const time = (v: unknown): number | null =>
  typeof v === 'string' && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;
const terminal = (job: JobDisplay) =>
  job.outcome !== null || job.lifecycle === 'closed' || (job.lifecycle === 'completed' && !!job.judgments?.length);
interface ReadValue {
  text: string | null;
  mtime: number | null;
  reason: string | null;
}
type Op = { kind: 'file'; path: string; cap: number; prefix?: boolean } | { kind: 'entry'; path: string };
type Value = ReadValue | fs.Dirent | null | 'unreadable';
interface Work {
  path: string;
  external: boolean;
  iterator: Generator<Op, void, Value>;
  op?: Op;
  value?: Value;
  done: boolean;
  view?: JobDisplay;
}
interface MutableBudget {
  entries: number;
  files: number;
  bytes: number;
  incomplete: boolean;
  diagnostics: string[];
}
interface ReceiptView {
  state: string;
  executor: Record<string, unknown>;
  dispatch: PiDispatch | null;
  decision: { id: string; model: string | null } | null;
}

function receiptView(raw: unknown, a: JobAssociation): ReceiptView | null {
  if (
    !object(raw) ||
    raw.schema !== 1 ||
    raw.job !== a.job ||
    raw.parent !== a.root ||
    raw.role !== a.role ||
    raw.phase !== a.phase ||
    raw.preset !== a.preset ||
    !object(raw.binding) ||
    !object(raw.executor)
  )
    return null;
  if (!['launching', 'open', 'done', 'error', 'closed', 'launch_unknown', 'failed'].includes(String(raw.state)))
    return null;
  for (const key of ['id', 'executor', 'harness', 'model', 'effort', 'env_profile', 'recipe'] as const)
    if (raw.binding[key] !== a.backend[key]) return null;
  if (raw.executor.kind !== a.backend.executor) return null;
  if (raw.executor.kind === 'herdr') {
    for (const key of ['tab_id', 'pane_id', 'agent', 'workspace_id'] as const)
      if (raw.executor[key] !== a.herdr[key]) return null;
  }
  if (raw.pi_dispatch !== undefined && !validDispatch(raw.pi_dispatch, a.role)) return null;
  const decision =
    object(raw.jev_decisions) && typeof raw.jev_decisions.provider === 'string'
      ? {
          id: raw.jev_decisions.provider,
          model: typeof raw.jev_decisions.model === 'string' ? raw.jev_decisions.model : null,
        }
      : null;
  return {
    state: String(raw.state),
    executor: raw.executor,
    dispatch: (raw.pi_dispatch as PiDispatch) ?? null,
    decision,
  };
}

function immutable<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const field of Object.values(value)) immutable(field);
    Object.freeze(value);
  }
  return value;
}

export interface JobReadSlice {
  deadline?: number;
  maxBytes?: number;
}
export interface JobObserverOptions {
  root?: string | null;
  now?: () => number;
  herdr?: HerdrListRunner;
  process?: JevProcessProbe;
  /** Offline preview observes files only, never launches even the read-only herdr CLI. */
  live?: boolean;
}
export class JobObservationCollector {
  readonly home: string;
  readonly live: HerdrListSampler;
  private root: string | null;
  private generation = 0;
  private disposed = false;
  private pending: Promise<JobSnapshot> | null = null;
  private readonly works = new Map<string, Work>();
  private readonly dirs = new Map<string, fs.Dir>();
  private readonly cache = new Map<string, { signature: string; value: ReadValue }>();
  private discovery: Generator<Op, void, Value>;
  private discoveryOp?: Op;
  private discoveryValue?: Value;
  private round = 0;
  private nowMs = 0;
  private budget!: MutableBudget;
  private slice: JobReadSlice = {};
  constructor(
    home: string,
    private readonly options: JobObserverOptions = {}
  ) {
    try {
      this.home = fs.realpathSync(home);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.home = resolve(home);
    }
    this.root = options.root ?? null;
    this.live = new HerdrListSampler(options.herdr);
    this.discovery = this.discover();
  }
  setRoot(root: string | null): void {
    if (root === this.root) return;
    this.generation++;
    this.root = root;
    this.works.clear();
    this.cache.clear();
    this.closeDirs();
    this.discovery = this.discover();
    this.discoveryOp = undefined;
    this.discoveryValue = undefined;
    this.live.dispose();
  }
  dispose(): void {
    this.disposed = true;
    this.generation++;
    this.closeDirs();
    this.live.dispose();
  }
  private closeDir(path: string): void {
    const dir = this.dirs.get(path);
    if (dir) {
      try {
        dir.closeSync();
      } catch {
        /* Already closed. */
      }
      this.dirs.delete(path);
    }
  }
  private closeDirs(): void {
    for (const path of this.dirs.keys()) this.closeDir(path);
  }
  private diagnostic(reason: string): void {
    if (this.budget.diagnostics.length < 100) this.budget.diagnostics.push(reason);
  }
  private admit(path: string, external: boolean): boolean {
    if (this.works.has(path)) return true;
    if (this.works.size >= JOB_BOUNDS.nodes) {
      const victim = [...this.works.values()]
        .filter((w) => w.done)
        .sort((a, b) => Number(!a.view || !terminal(a.view)) - Number(!b.view || !terminal(b.view)))[0];
      if (!victim) {
        this.budget.incomplete = true;
        return false;
      }
      this.works.delete(victim.path);
    }
    const work: Work = { path, external, iterator: undefined!, done: false };
    work.iterator = this.observe(work);
    this.works.set(path, work);
    this.trimHelpers();
    return true;
  }
  private trimHelpers(): void {
    let room = Math.max(0, JOB_BOUNDS.nodes - this.works.size);
    for (const work of this.works.values())
      if (work.view) {
        if (work.view.helpers.length > room) {
          work.view = { ...work.view, helpers: work.view.helpers.slice(0, room) };
          this.budget.incomplete = true;
        }
        room -= work.view.helpers.length;
      }
  }
  private *discover(): Generator<Op, void, Value> {
    while (!this.disposed) {
      let entry: Value;
      while ((entry = yield { kind: 'entry', path: join(this.home, 'assoc') }) && entry !== 'unreadable') {
        const e = entry as fs.Dirent;
        if (/^j[a-f0-9]{16}\.json$/.test(e.name)) {
          while (!this.admit(join(this.home, 'assoc', e.name), false)) yield { kind: 'entry', path: '' };
        }
      }
      const base = join(this.home, 'assoc-external');
      while ((entry = yield { kind: 'entry', path: base }) && entry !== 'unreadable') {
        const e = entry as fs.Dirent;
        if (!e.isDirectory() || !/^[a-f0-9]{64}$/.test(e.name)) continue;
        const directory = join(base, e.name);
        let child: Value;
        while ((child = yield { kind: 'entry', path: directory }) && child !== 'unreadable') {
          const c = child as fs.Dirent;
          if (c.name.endsWith('.json') && EXTERNAL_ID.test(c.name.slice(0, -5))) {
            while (!this.admit(join(directory, c.name), true)) yield { kind: 'entry', path: '' };
          }
        }
      }
      yield { kind: 'entry', path: '' }; // Yield a cycle boundary even for absent directories.
    }
  }
  private async execute(op: Op): Promise<{ value: Value } | null> {
    if (performance.now() >= (this.slice.deadline ?? Infinity)) {
      this.budget.incomplete = true;
      return null;
    }
    if (op.kind === 'entry') {
      if (this.budget.entries >= JOB_BOUNDS.entries) {
        this.budget.incomplete = true;
        return null;
      }
      this.budget.entries++;
      if (!op.path) return { value: null };
      try {
        if ((await fsp.realpath(op.path)) !== op.path) return { value: 'unreadable' };
        const info = await fsp.lstat(op.path);
        if (!info.isDirectory() || !(info.mode & 0o444)) return { value: 'unreadable' };
        let dir = this.dirs.get(op.path);
        if (!dir) {
          dir = fs.opendirSync(op.path);
          this.dirs.set(op.path, dir);
        }
        const entry = dir.readSync();
        if (!entry) {
          dir.closeSync();
          this.dirs.delete(op.path);
        }
        return { value: entry };
      } catch {
        return { value: 'unreadable' };
      }
    }
    if (this.budget.files >= JOB_BOUNDS.files) {
      this.budget.incomplete = true;
      return null;
    }
    let fd: fsp.FileHandle | undefined;
    let charged = false;
    try {
      if ((await fsp.realpath(op.path)) !== op.path) throw new Error('unsafe_path');
      fd = await fsp.open(op.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      if ((await fsp.realpath(op.path)) !== op.path) throw new Error('unsafe_path');
      const s = await fd.stat();
      if (!s.isFile() || !(s.mode & 0o444) || (!op.prefix && s.size > op.cap)) throw new Error('unsafe_or_oversized');
      const size = Math.min(s.size, op.cap);
      const signature = `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
      const cached = this.cache.get(op.path);
      if (cached?.signature === signature) {
        this.budget.files++;
        return { value: cached.value };
      }
      if (size > Math.min(JOB_BOUNDS.bytes, this.slice.maxBytes ?? JOB_BOUNDS.bytes) - this.budget.bytes) {
        this.budget.incomplete = true;
        return null;
      }
      this.budget.files++;
      charged = true;
      const buffer = Buffer.alloc(size);
      const { bytesRead } = await fd.read(buffer, 0, buffer.length, 0);
      this.budget.bytes += bytesRead;
      const after = await fd.stat();
      if (bytesRead !== size || after.size !== s.size || after.mtimeMs !== s.mtimeMs || after.ctimeMs !== s.ctimeMs)
        throw new Error('changed_during_read');
      const value = { text: buffer.toString('utf8'), mtime: s.mtimeMs, reason: null };
      this.cache.delete(op.path);
      this.cache.set(op.path, { signature, value });
      if (this.cache.size > 512) this.cache.delete(this.cache.keys().next().value!);
      return { value };
    } catch (e) {
      if (!charged) this.budget.files++;
      return {
        value: {
          text: null,
          mtime: null,
          reason: (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable',
        },
      };
    } finally {
      await fd?.close();
    }
  }
  private *read(path: string, cap: number): Generator<Op, ReadValue, Value> {
    return (yield { kind: 'file', path, cap }) as ReadValue;
  }
  private stale(work: Work, reason: string): void {
    this.diagnostic(`${basename(work.path)}:${reason}`);
    if (work.view)
      work.view = {
        ...work.view,
        status: terminal(work.view) ? work.view.status : 'unknown',
        freshness: {
          ...work.view.freshness,
          state: work.view.freshness.lastSuccessfulReadAt === null ? 'unavailable' : 'stale',
          observedAt: this.nowMs,
          reason,
        },
        diagnostics: [reason],
      };
  }
  private base(a: JobAssociation, mtime: number | null): JobDisplay {
    return {
      kind: 'role',
      id: `role-job:${a.job}`,
      jobId: a.job,
      root: a.root,
      name: a.task_label || `${a.role} ${a.job.slice(-6)}`,
      role: a.role,
      phase: a.phase,
      preset: a.preset,
      backend: { ...a.backend },
      location: { ...a.herdr },
      lifecycle: a.closed ? 'closed' : 'unknown',
      runtimePhase: null,
      dispatchSession: null,
      outcome: null,
      judgments: null,
      status: 'unknown',
      freshness: {
        state: 'unavailable',
        observedAt: this.nowMs,
        lastSuccessfulReadAt: null,
        evidenceAt: mtime,
        liveDeadline: null,
        reason: 'receipt_missing',
      },
      requests: null,
      report: null,
      native: a.native ? { ...a.native } : null,
      createdAt: time(a.created_at),
      closedAt: a.closed ? (time(a.closed_at) ?? mtime) : null,
      decision: null,
      observedModel: null,
      observedEffort: null,
      helpers: [],
      diagnostics: [],
      coverage: 'partial',
      summaryUnavailable: a.native ? 'requires_authorization' : 'native_ref_required',
    };
  }
  private *observe(work: Work): Generator<Op, void, Value> {
    const file = yield* this.read(work.path, work.external ? 4096 : 16 * 1024);
    if (work.external) {
      yield* this.external(work, file);
      return;
    }
    const a = parseAssociation(json(file.text), basename(work.path, '.json'));
    if (!a) {
      this.stale(work, 'association_invalid_or_unreadable');
      return;
    }
    if (this.root && a.root !== this.root) {
      work.view = undefined;
      return;
    }
    if (work.view && work.view.root !== a.root) {
      this.stale(work, 'root_changed');
      return;
    }
    const directory = join(this.home, 'jobs', a.job);
    const read = yield* this.read(join(directory, 'receipt.json'), 64 * 1024);
    const r = receiptView(json(read.text), a);
    if (!r) {
      if (read.reason === 'missing' && !work.view) work.view = this.base(a, file.mtime);
      else this.stale(work, 'receipt_mismatch_or_unreadable');
      return;
    }
    let view = { ...this.base(a, file.mtime), lifecycle: a.closed ? 'closed' : r.state, decision: r.decision };
    const previous = work.view;
    if (a.backend.executor === 'jev') {
      const id = r.executor.job;
      if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
        this.stale(work, 'runtime_id_missing');
        if (!work.view) work.view = view;
        return;
      }
      const runtimeFile = yield* this.read(join(this.home, 'jev-runtime', 'jobs', `${id}.json`), JOB_BOUNDS.bytes);
      const raw = json(runtimeFile.text);
      const slash = a.root.indexOf('/');
      if (
        !object(raw) ||
        raw.executor !== 'jev' ||
        raw.id !== id ||
        !object(raw.session) ||
        raw.session.namespace !== a.root.slice(0, slash) ||
        raw.session.sessionId !== a.root.slice(slash + 1) ||
        !['queued', 'running', 'completed', 'failed', 'closed', 'interrupted'].includes(String(raw.state)) ||
        typeof raw.closed !== 'boolean'
      ) {
        this.stale(work, 'runtime_record_mismatch_or_unreadable');
        if (!work.view) work.view = view;
        return;
      }
      const result = object(raw.result) ? raw.result : null;
      let outcome: string | null = raw.state === 'failed' ? 'failed' : null;
      let judgments: JobDisplay['judgments'] = null;
      let resultValid = raw.state !== 'completed';
      let resultStatus: JobDisplay['status'] =
        raw.state === 'failed' ? 'error' : raw.state === 'running' ? 'running' : 'unknown';
      if (
        raw.state !== 'failed' &&
        raw.tag === 'ask' &&
        typeof result?.status === 'string' &&
        [
          'answered',
          'failed',
          'uncertain',
          'needs_human',
          'timed_out',
          'wait_failed',
          'incomplete',
          'already_attempted',
          'target_pending',
          'clicked',
          'resend_needs_confirmation',
        ].includes(result.status)
      ) {
        resultValid = true;
        outcome = result.status;
        resultStatus = outcome === 'answered' ? 'completed' : outcome === 'failed' ? 'error' : 'unknown';
      } else if (
        raw.state !== 'failed' &&
        raw.tag === 'browse' &&
        result &&
        ['done', 'blocked'].includes(String(result.status)) &&
        Number.isSafeInteger(result.steps) &&
        Number(result.steps) >= 0 &&
        typeof result.goal === 'string'
      ) {
        resultValid = true;
        outcome = String(result.status);
        resultStatus = outcome === 'done' ? 'completed' : 'unknown';
      } else if (
        raw.state !== 'failed' &&
        raw.tag === 'judge' &&
        result &&
        Array.isArray(result.statements) &&
        result.statements.length <= 12 &&
        result.statements.every(
          (s) =>
            object(s) &&
            typeof s.name === 'string' &&
            s.name.length > 0 &&
            s.name.length <= 128 &&
            ['pass', 'deny', 'unsettled', 'timeout', 'needs_human'].includes(String(s.verdict))
        ) &&
        Number.isSafeInteger(result.calls) &&
        Number(result.calls) >= 0 &&
        typeof result.extendedMs === 'number' &&
        Number.isFinite(result.extendedMs) &&
        result.extendedMs >= 0
      ) {
        resultValid = true;
        judgments = result.statements.map((s) => ({ name: s.name, verdict: s.verdict }));
        resultStatus =
          ['completed', 'closed'].includes(String(raw.state)) &&
          judgments!.length > 0 &&
          judgments!.every((s) => s.verdict === 'pass' || s.verdict === 'deny')
            ? 'completed'
            : 'unknown';
      }
      if (!resultValid) {
        this.stale(work, 'runtime_result_invalid');
        if (!work.view) work.view = view;
        return;
      }
      view = {
        ...view,
        lifecycle: raw.closed || a.closed ? 'closed' : String(raw.state),
        outcome,
        judgments,
        status: resultStatus,
        runtimePhase: ['execute', 'prepare', 'click', 'reconcile', 'confirm', 'wait', 'collect'].includes(
          String(raw.phase)
        )
          ? String(raw.phase)
          : null,
        decision:
          object(raw.provider) &&
          ['typesafe', 'openai'].includes(String(raw.provider.id)) &&
          typeof raw.provider.model === 'string' &&
          raw.provider.model.length <= 400
            ? { id: String(raw.provider.id), model: raw.provider.model }
            : view.decision,
        observedModel: null,
        closedAt:
          raw.closed || a.closed
            ? (view.closedAt ?? time(object(raw.run) ? raw.run.endedAt : null) ?? runtimeFile.mtime)
            : null,
      };
      const runtime = yield* this.read(join(this.home, 'jev-runtime', 'runtime.json'), 4096);
      const alive = jevRuntimeAlive(json(runtime.text), this.options.process);
      view = this.fresh(
        view,
        previous,
        runtimeFile.mtime,
        alive || terminal(view),
        alive ? this.nowMs + LIVE_EXPIRY_MS : null,
        'runtime_uncorroborated'
      );
    } else if (r.dispatch) {
      const primaryFile = yield* this.read(join(directory, 'STATUS.json'), 64 * 1024);
      const primary = parseDispatchStatus(
        json(primaryFile.text),
        directory,
        'primary',
        r.dispatch.role,
        join(directory, 'report.md')
      );
      if (!primary) {
        this.stale(work, 'status_unreadable');
        if (!work.view) work.view = view;
        return;
      }
      const continuation = r.dispatch.continuation;
      const unconfirmed =
        !!continuation &&
        (primary.session_id !== continuation.previous_session_id ||
          primary.settled_at === continuation.previous_settled_at);
      view = this.dispatchView(view, primary, unconfirmed);
      if (!unconfirmed && primary.state === 'closed' && previous?.outcome === 'failed')
        view = { ...view, outcome: 'failed', status: 'error' };
      const helpers: JobDisplay[] = [];
      const helperDir = join(directory, '.dispatch');
      for (let n = 0; n < JOB_BOUNDS.helperEntries && helpers.length < JOB_BOUNDS.helpers; n++) {
        const e = yield { kind: 'entry', path: helperDir };
        if (!e || e === 'unreadable') break;
        const entry = e as fs.Dirent;
        if (!entry.isDirectory() || !DISPATCH_SLOT.test(entry.name)) continue;
        const role = entry.name.startsWith('review-') ? 'reviewer' : entry.name.split('-')[0]!;
        const helperFile = yield* this.read(join(helperDir, entry.name, 'STATUS.json'), 64 * 1024);
        const h = parseDispatchStatus(
          json(helperFile.text),
          directory,
          entry.name,
          role,
          join(directory, `${entry.name}.md`)
        );
        const helperId = `role-job:${a.job}:dispatch:${entry.name}`;
        const old = previous?.helpers.find((candidate) => candidate.id === helperId);
        if (!h) {
          if (old)
            helpers.push({
              ...old,
              status: terminal(old) ? old.status : 'unknown',
              freshness: { ...old.freshness, state: 'stale', reason: 'helper_status_unreadable' },
            });
          continue;
        }
        let child = this.dispatchView(view, h, false);
        if (h.state === 'closed' && old?.outcome === 'failed') child = { ...child, outcome: 'failed', status: 'error' };
        helpers.push({
          ...child,
          kind: 'helper',
          id: helperId,
          role,
          native: a.helpers?.[entry.name] ?? null,
          helpers: [],
          requests: null,
          report: null,
        });
      }
      this.closeDir(helperDir);
      for (const old of previous?.helpers ?? []) {
        if (helpers.length >= JOB_BOUNDS.helpers) break;
        if (!helpers.some((h) => h.id === old.id))
          helpers.push({
            ...old,
            status: terminal(old) ? old.status : 'unknown',
            freshness: { ...old.freshness, state: 'stale', reason: 'helper_status_unreadable' },
          });
      }
      const requests = yield* this.questions(directory, primary, helpers);
      const report = (yield {
        kind: 'file',
        path: join(directory, 'report.md'),
        cap: 32 * 1024,
        prefix: true,
      }) as ReadValue;
      const live = this.live.match(a.herdr, this.nowMs);
      view = {
        ...view,
        requests,
        report: {
          path: join(directory, 'report.md'),
          available: report.text !== null ? !!report.text.trim() : report.reason === 'missing' ? false : null,
        },
        helpers,
      };
      view = this.fresh(
        view,
        previous,
        primaryFile.mtime,
        !!live || terminal(view),
        live?.deadline ?? null,
        'herdr_uncorroborated'
      );
      const reportLost =
        report.text === null &&
        (previous?.report?.available === true || previous?.diagnostics.includes('report_unreadable'));
      const diagnostics = [
        ...(requests === null ? ['qa_unreadable'] : []),
        ...(reportLost ? ['report_unreadable'] : []),
      ];
      if (diagnostics.length) {
        const reason = diagnostics[0]!;
        view = {
          ...view,
          status: terminal(view) ? view.status : 'unknown',
          report: reportLost ? { path: join(directory, 'report.md'), available: null } : view.report,
          freshness: { ...view.freshness, state: previous ? 'stale' : 'unavailable', reason },
          diagnostics,
        };
      }
      view = {
        ...view,
        helpers: helpers.map((h) =>
          h.freshness.reason === 'helper_status_unreadable'
            ? h
            : this.fresh(
                h,
                previous?.helpers.find((old) => old.id === h.id),
                primaryFile.mtime,
                !!live || terminal(h),
                live?.deadline ?? null,
                'herdr_uncorroborated'
              )
        ),
      };
    } else {
      const live = this.live.match(a.herdr, this.nowMs);
      const closed = a.closed || r.state === 'closed';
      const recordedOutcome = ['done', 'error', 'failed'].includes(r.state)
        ? r.state === 'done'
          ? 'completed'
          : 'failed'
        : null;
      const outcome = recordedOutcome ?? (closed ? (previous?.outcome ?? null) : null);
      view = {
        ...view,
        lifecycle: closed ? 'closed' : view.lifecycle,
        outcome,
        closedAt: closed ? (view.closedAt ?? read.mtime) : null,
        status:
          outcome === 'completed'
            ? 'completed'
            : outcome === 'failed'
              ? 'error'
              : !closed && live?.status === 'working'
                ? 'running'
                : 'unknown',
      };
      view = this.fresh(
        view,
        previous,
        read.mtime,
        !!live || terminal(view),
        live?.deadline ?? null,
        'herdr_uncorroborated'
      );
      view = { ...view, requests: a.backend.harness === 'pi' ? yield* this.questions(directory, null, []) : null };
    }
    work.view = view;
    this.trimHelpers();
  }
  private dispatchView(view: JobDisplay, s: DispatchStatus, continuation: boolean): JobDisplay {
    const outcome = continuation
      ? null
      : s.state === 'failed'
        ? 'failed'
        : ['idle_grace', 'closed'].includes(s.state)
          ? 'completed'
          : null;
    return {
      ...view,
      lifecycle: view.lifecycle === 'closed' ? 'closed' : s.state,
      outcome,
      observedModel: s.model,
      observedEffort: s.thinking,
      dispatchSession: s.session_id,
      status:
        outcome === 'failed'
          ? 'error'
          : outcome
            ? 'completed'
            : s.state === 'working' || s.state === 'waiting_helper'
              ? 'running'
              : 'unknown',
    };
  }
  private fresh(
    view: JobDisplay,
    previous: JobDisplay | undefined,
    evidenceAt: number | null,
    current: boolean,
    deadline: number | null,
    reason: string
  ): JobDisplay {
    const validBefore = previous?.freshness.lastSuccessfulReadAt !== null && previous !== undefined;
    const unchanged =
      previous &&
      previous.lifecycle === view.lifecycle &&
      previous.runtimePhase === view.runtimePhase &&
      previous.outcome === view.outcome &&
      previous.observedModel === view.observedModel &&
      previous.observedEffort === view.observedEffort &&
      previous.dispatchSession === view.dispatchSession &&
      JSON.stringify(previous.judgments) === JSON.stringify(view.judgments);
    return {
      ...view,
      status: current || terminal(view) ? view.status : 'unknown',
      freshness: {
        state: current ? 'current' : validBefore ? 'stale' : 'unavailable',
        observedAt: this.nowMs,
        lastSuccessfulReadAt: this.nowMs,
        evidenceAt: unchanged ? previous.freshness.evidenceAt : evidenceAt,
        liveDeadline: deadline,
        reason: current ? null : reason,
      },
      coverage: 'partial',
    };
  }
  private *questions(
    directory: string,
    primary: DispatchStatus | null,
    helpers: readonly JobDisplay[]
  ): Generator<Op, readonly JobRequest[] | null, Value> {
    const result: JobRequest[] = [];
    const path = join(directory, 'qa');
    try {
      for (let n = 0; n < JOB_BOUNDS.qaEntries; n++) {
        const next = yield { kind: 'entry', path };
        if (next === 'unreadable') {
          this.closeDir(path);
          return null;
        }
        if (next === null) return result;
        const entry = next as fs.Dirent;
        if (!/^q[1-9][0-9]{0,3}\.md$/.test(entry.name)) continue;
        if (!entry.isFile()) {
          this.closeDir(path);
          return null;
        }
        const file = join(path, entry.name);
        const q = yield* this.read(file, 64 * 1024);
        if (q.text === null) return null;
        const answer = yield* this.read(join(path, entry.name.replace('.md', '.answer.md')), 16 * 1024 + 1);
        if (answer.text === null && answer.reason !== 'missing') return null;
        // Direct-Pi's existing protocol treats an answer file as written, even empty/stale.
        // Dispatch alone has the nonempty/nonstale eligibility rule.
        const eligible =
          answer.text !== null && (primary === null || (!!answer.text.trim() && answer.mtime! >= q.mtime!));
        result.push({
          id: entry.name.slice(0, -3),
          path: file,
          state: eligible ? 'written_consumption_unconfirmed' : 'unanswered',
          current: primary
            ? primary.state === 'waiting_orchestrator' ||
              (!!primary.helper_pending?.n &&
                helpers.some(
                  (h) =>
                    h.id.endsWith(`:dispatch:${primary.helper_pending!.kind}-${primary.helper_pending!.n}`) &&
                    h.lifecycle === 'waiting_orchestrator' &&
                    h.freshness.reason !== 'helper_status_unreadable' &&
                    !!this.live.match(h.location, this.nowMs)
                ))
            : true,
          respondable: !eligible,
          observedAt: this.nowMs,
        });
        if (result.length >= JOB_BOUNDS.questions) {
          this.budget.incomplete = true;
          this.closeDir(path);
          return result;
        }
      }
      this.budget.incomplete = true;
      this.closeDir(path);
      return result;
    } finally {
      this.closeDir(path);
    }
  }
  private *external(work: Work, file: ReadValue): Generator<Op, void, Value> {
    const a: ExternalAssociation | null = parseExternalAssociation(json(file.text));
    if (!a || basename(work.path) !== `${a.id}.json` || basename(join(work.path, '..')) !== externalRootHash(a.root)) {
      this.stale(work, 'external_invalid_or_unreadable');
      return;
    }
    if (this.root && a.root !== this.root) {
      work.view = undefined;
      return;
    }
    const previous = work.view;
    if (
      previous &&
      (previous.root !== a.root ||
        previous.location.agent !== a.agent ||
        previous.location.pane_id !== a.pane ||
        previous.location.tab_id !== a.tab)
    ) {
      this.stale(work, 'external_target_changed');
      return;
    }
    const location = { agent: a.agent, pane_id: a.pane, tab_id: a.tab, workspace_id: a.workspace };
    const live = this.live.match(location, this.nowMs);
    const base = this.base(
      {
        schema: 1,
        job: a.id,
        root: a.root,
        task_label: a.label,
        role: 'imp',
        phase: null,
        preset: '',
        cwd: '',
        backend: {
          id: 'external-herdr',
          executor: 'herdr',
          harness: null,
          model: null,
          effort: null,
          recipe: null,
          env_profile: null,
        },
        herdr: location,
        report_path: '',
        closed: false,
      },
      file.mtime
    );
    work.view = this.fresh(
      {
        ...base,
        kind: 'external',
        id: `external-herdr:${externalRootHash(a.root)}:${a.id}`,
        role: null,
        preset: null,
        createdAt: time(a.registered_at),
        lifecycle: live?.status ?? 'unknown',
        status: live?.status === 'working' ? 'running' : 'unknown',
        requests: null,
        backend: null,
        diagnostics: ['locator_only_no_instance_discriminator'],
      },
      previous,
      file.mtime,
      !!live,
      live?.deadline ?? null,
      'herdr_uncorroborated'
    );
  }
  refresh(slice: JobReadSlice = {}): Promise<JobSnapshot> {
    if (this.pending) return this.pending;
    this.slice = slice;
    const generation = this.generation;
    this.pending = this.collect(generation).finally(() => {
      this.pending = null;
    });
    return this.pending;
  }
  private async collect(generation: number): Promise<JobSnapshot> {
    this.nowMs = this.options.now?.() ?? Date.now();
    this.budget = { entries: 0, files: 0, bytes: 0, incomplete: false, diagnostics: [] };
    if (this.disposed) return this.snapshot();
    if (this.options.live !== false) this.live.tick(this.nowMs);
    // Reserve discovery work; its cursor never restarts at the first 128 names.
    for (let n = 0; n < 16; n++) {
      if (!this.discoveryOp) {
        const next = this.discovery.next(this.discoveryValue ?? null);
        this.discoveryOp = next.value as Op;
      }
      const read = await this.execute(this.discoveryOp);
      if (!read || generation !== this.generation || this.disposed) return this.snapshot();
      this.discoveryValue = read.value;
      this.discoveryOp = undefined;
      if (!read.value) break;
    }
    const work = [...this.works.values()];
    for (const w of work)
      if (w.done) {
        w.done = false;
        w.iterator = this.observe(w);
        w.op = undefined;
        w.value = undefined;
      }
    const finished = new Set<Work>();
    let steps = 0;
    while (
      work.length &&
      steps++ < 1024 &&
      this.budget.files < JOB_BOUNDS.files &&
      this.budget.entries < JOB_BOUNDS.entries
    ) {
      const w = work[this.round++ % work.length]!;
      if (finished.has(w)) {
        if (finished.size === work.length) break;
        continue;
      }
      if (!w.op) {
        const next = w.iterator.next(w.value ?? null);
        if (next.done) {
          w.done = true;
          finished.add(w);
          continue;
        }
        w.op = next.value;
      }
      const read = await this.execute(w.op);
      if (generation !== this.generation || this.disposed) return this.snapshot();
      if (!read) break;
      w.value = read.value;
      w.op = undefined;
    }
    if (work.some((w) => !w.done)) this.budget.incomplete = true;
    return this.snapshot();
  }
  private snapshot(): JobSnapshot {
    const nowMs = this.options.now?.() ?? Date.now();
    let closed = 0,
      nodes = 0;
    const jobs: JobDisplay[] = [];
    const views = [...this.works.values()]
      .flatMap((w) => (w.view ? [w.view] : []))
      .sort((a, b) => Number(terminal(a)) - Number(terminal(b)) || (b.closedAt ?? 0) - (a.closedAt ?? 0));
    for (const v of views) {
      if (this.root && v.root !== this.root) continue;
      if (
        v.lifecycle === 'closed' &&
        (++closed > JOB_BOUNDS.closed || (v.closedAt !== null && nowMs - v.closedAt > JOB_BOUNDS.historyMs))
      )
        continue;
      if (nodes >= JOB_BOUNDS.nodes) {
        this.budget.incomplete = true;
        break;
      }
      nodes++;
      const helpers = v.helpers.slice(0, JOB_BOUNDS.nodes - nodes);
      nodes += helpers.length;
      const liveView = (job: JobDisplay): JobDisplay => {
        if (terminal(job)) return job;
        const jev = job.backend?.executor === 'jev';
        if (
          jev
            ? job.freshness.liveDeadline !== null && nowMs <= job.freshness.liveDeadline
            : this.live.match(job.location, nowMs)
        )
          return job;
        return {
          ...job,
          status: 'unknown',
          freshness: {
            ...job.freshness,
            state: job.freshness.lastSuccessfulReadAt === null ? 'unavailable' : 'stale',
            reason: jev ? 'runtime_uncorroborated' : 'herdr_uncorroborated',
          },
        };
      };
      jobs.push(immutable({ ...liveView(v), helpers: helpers.map(liveView) }));
    }
    const coverage: JobCoverage = {
      ...this.budget,
      diagnostics: [...this.budget.diagnostics],
      omitted: this.budget.incomplete ? null : 0,
    };
    return immutable({ generation: this.generation, root: this.root, jobs, coverage });
  }
}
