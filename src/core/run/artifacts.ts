import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { inspectReceipt, receiptEligibility, sameProcessStamp, scopeUpdateAllowed } from '../supervision.js';
import type { FinalExitReceipt, RunMeta } from '../types/supervision.js';

type ObjectValue = Record<string, unknown>;
const object = (v: unknown): v is ObjectValue => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const uint = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const positive = (v: unknown): v is number => uint(v) && v > 0;
const nullable = (v: unknown, check: (v: unknown) => boolean): boolean => v === null || check(v);
const oneOf = (v: unknown, values: readonly string[]): boolean => typeof v === 'string' && values.includes(v);
const strings = (v: unknown): boolean => Array.isArray(v) && v.every(text);
const digest = (v: unknown): boolean => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const stamp = (v: unknown): boolean =>
  object(v) &&
  positive(v.pid) &&
  typeof v.proc_start === 'string' &&
  /^\d+$/.test(v.proc_start) &&
  text(v.boot_id) &&
  text(v.pid_domain);
const scope = (v: unknown): boolean =>
  object(v) &&
  text(v.scope_id) &&
  v.scope_kind === 'pgid' &&
  text(v.pid_domain) &&
  text(v.boot_id) &&
  positive(v.pgid) &&
  positive(v.sid) &&
  stamp(v.group_leader) &&
  object(v.group_leader) &&
  v.group_leader.boot_id === v.boot_id &&
  v.group_leader.pid_domain === v.pid_domain;
const capture = (v: unknown): boolean => oneOf(v, ['file', 'tty_passthrough', 'unavailable']);
const common = (v: ObjectValue): boolean =>
  v.schema_version === 1 &&
  text(v.run_id) &&
  text(v.link_id) &&
  text(v.source_id) &&
  positive(v.binding_generation) &&
  oneOf(v.mode, ['visible', 'headless']) &&
  nullable(v.supervisor, stamp) &&
  nullable(v.command_leader, stamp) &&
  nullable(v.harness, stamp) &&
  nullable(v.scope, scope) &&
  uint(v.created_at);

function isMeta(v: unknown): v is RunMeta {
  return (
    object(v) &&
    common(v) &&
    oneOf(v.supervision_strategy, ['headless', 'wrapper']) &&
    digest(v.launch_digest) &&
    digest(v.profile_digest) &&
    text(v.launch_call_id) &&
    text(v.launch_correlation_id) &&
    oneOf(v.stdin_mode, ['brief', 'closed', 'tty', 'protocol']) &&
    capture(v.capture) &&
    text(v.launch_cwd) &&
    isAbsolute(v.launch_cwd) &&
    nullable(v.project_origin, (p) => object(p) && text(p.repoId) && p.basis === 'declared' && uint(p.declaredAt))
  );
}

function observation(v: unknown): boolean {
  return (
    object(v) &&
    stamp(v.process) &&
    oneOf(v.subject, ['command_leader', 'harness']) &&
    uint(v.observed_at) &&
    oneOf(v.status_source, ['wait_status', 'trusted_harness_result']) &&
    text(v.evidence_id) &&
    ((uint(v.exit_code) && v.signal === null) || (v.exit_code === null && text(v.signal)))
  );
}

function isReceipt(v: unknown): v is FinalExitReceipt {
  if (
    !object(v) ||
    !common(v) ||
    !text(v.receipt_id) ||
    !oneOf(v.strategy, ['headless', 'wrapper']) ||
    !oneOf(v.coverage, ['scope', 'not_submitted']) ||
    !nullable(v.started_at, uint) ||
    !uint(v.ended_at) ||
    !uint(v.recorded_at) ||
    !nullable(v.duration_ms, uint) ||
    !nullable(v.native_exit, observation) ||
    !nullable(v.shell_exit, observation) ||
    !oneOf(v.reason, [
      'scope_ended',
      'normal_exit',
      'nonzero_exit',
      'signal_exit',
      'cancel_confirmed',
      'preflight_failure',
    ]) ||
    !nullable(v.cancel_request_seq, positive) ||
    !object(v.submission_fence) ||
    !positive(v.submission_fence.event_seq) ||
    !uint(v.submission_fence.at) ||
    !strings(v.submission_fence.proof_ids) ||
    !object(v.logs) ||
    !nullable(v.logs.stdout, text) ||
    !nullable(v.logs.stderr, text) ||
    !capture(v.logs.capture)
  )
    return false;
  if (
    !nullable(
      v.scope_check,
      (c) =>
        object(c) &&
        text(c.scope_id) &&
        uint(c.checked_at) &&
        oneOf(c.result, ['alive', 'gone', 'unknown']) &&
        oneOf(c.visibility, ['complete', 'partial']) &&
        strings(c.member_evidence_ids) &&
        strings(c.zombie_evidence_ids) &&
        strings(c.launcher_seal_evidence_ids) &&
        strings(c.harness_termination_evidence_ids)
    )
  )
    return false;
  const receipt = v as unknown as FinalExitReceipt;
  return (
    receiptEligibility(receipt) === null &&
    (receipt.shell_exit === null || sameProcessStamp(receipt.shell_exit.process, receipt.command_leader))
  );
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const fileFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const fdPath = (fd: number, name: string): string => `/proc/self/fd/${fd}/${name}`;

/** Only the ticket winner may call create; recovery receives an explicitly read-only handle. */
export class RunArtifacts {
  readonly directory: string;
  private identity: { dev: number; ino: number };

  private constructor(
    private readonly hudHome: string,
    readonly runId: string,
    private readonly writable: boolean
  ) {
    this.directory = join(hudHome, 'runs', runId);
    this.identity = { dev: -1, ino: -1 };
  }

  static create(hudHome: string, runId: string): RunArtifacts {
    return RunArtifacts.initialize(hudHome, runId, true);
  }

  static open(hudHome: string, runId: string): RunArtifacts {
    return RunArtifacts.initialize(hudHome, runId, false);
  }

  private static initialize(hudHome: string, runId: string, writable: boolean): RunArtifacts {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(runId)) throw new Error('invalid_run_id');
    if (!isAbsolute(hudHome) || resolve(hudHome) !== hudHome) throw new Error('invalid_hud_home');
    if (process.platform !== 'linux' || !process.getuid) throw new Error('unsupported_artifact_platform');
    const artifacts = new RunArtifacts(hudHome, runId, writable);
    artifacts.withDirectory((fd) => {
      const stat = fstatSync(fd);
      artifacts.identity = { dev: stat.dev, ino: stat.ino };
    }, writable);
    return artifacts;
  }

  /** A scoped descriptor for private local endpoints; public pathname is never an authority. */
  pinDirectory(): { path: string; check(): void; close(): void } {
    const held = this.withDirectory((fd) =>
      openSync(`/proc/self/fd/${fd}`, constants.O_RDONLY | constants.O_DIRECTORY)
    );
    const initial = fstatSync(held);
    let closed = false;
    return {
      path: `/proc/self/fd/${held}`,
      check: () => {
        if (closed) throw new Error('run_directory_closed');
        this.withDirectory((fd) => {
          const current = fstatSync(fd);
          if (current.dev !== initial.dev || current.ino !== initial.ino) throw new Error('run_directory_replaced');
        });
      },
      close: () => {
        if (!closed) {
          closed = true;
          closeSync(held);
        }
      },
    };
  }

  /** Open each component relative to a held parent descriptor; no unverified ancestor is followed. */
  private withDirectory<T>(fn: (fd: number) => T, create = false): T {
    const homeParts = this.hudHome.split('/').filter(Boolean);
    const parts = [...homeParts, 'runs', this.runId];
    let fd = openSync('/', directoryFlags);
    try {
      for (let index = 0; index < parts.length; index++) {
        const path = fdPath(fd, parts[index]);
        const managed = index >= homeParts.length - 1;
        if (create && managed) {
          try {
            mkdirSync(path, 0o700);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || index === parts.length - 1) throw error;
          }
        }
        const next = openSync(path, directoryFlags);
        try {
          const stat = fstatSync(next);
          if (managed && (stat.uid !== process.getuid!() || (stat.mode & 0o7777) !== 0o700)) {
            throw new Error('unsafe_run_directory');
          }
          if (
            index === parts.length - 1 &&
            this.identity.ino !== -1 &&
            (stat.ino !== this.identity.ino || stat.dev !== this.identity.dev)
          )
            throw new Error('run_directory_replaced');
        } catch (error) {
          closeSync(next);
          throw error;
        }
        closeSync(fd);
        fd = next;
      }
      return fn(fd);
    } finally {
      closeSync(fd);
    }
  }

  private assertWritable(): void {
    if (!this.writable) throw new Error('read_only_run_artifacts');
  }

  private readBytes(fd: number, name: string): Buffer | null {
    let file: number;
    try {
      file = openSync(fdPath(fd, name), fileFlags);
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
    try {
      this.assertFile(file);
      return readFileSync(file);
    } finally {
      closeSync(file);
    }
  }

  private assertFile(fd: number): void {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid!() || (stat.mode & 0o7777) !== 0o600 || stat.nlink !== 1) {
      throw new Error('unsafe_run_file');
    }
  }

  private parse<T>(bytes: Buffer | null, check: (v: unknown) => v is T): T | null {
    if (!bytes) return null;
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString('utf8'));
    } catch {
      return null;
    }
    return check(value) ? value : null;
  }

  private metaAt(fd: number): RunMeta | null {
    const meta = this.parse(this.readBytes(fd, 'meta.json'), isMeta);
    return meta?.run_id === this.runId ? meta : null;
  }

  private atomicWrite(fd: number, name: string, bytes: Buffer): void {
    const temporary = fdPath(fd, `.${name}.${randomUUID()}.tmp`);
    const file = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
    try {
      try {
        writeFileSync(file, bytes);
        fsyncSync(file);
      } finally {
        closeSync(file);
      }
      renameSync(temporary, fdPath(fd, name));
      fsyncSync(fd);
    } finally {
      try {
        unlinkSync(temporary);
      } catch (error) {
        if (!missing(error)) throw error;
      }
    }
  }

  writeMeta(meta: RunMeta): void {
    this.assertWritable();
    if (!isMeta(meta) || meta.run_id !== this.runId) throw new Error('invalid_run_meta');
    this.withDirectory((fd) => {
      const oldBytes = this.readBytes(fd, 'meta.json');
      const old = this.parse(oldBytes, isMeta);
      if (oldBytes && !old) throw new Error('invalid_existing_meta');
      if (old) {
        for (const key of Object.keys(old) as (keyof RunMeta)[]) {
          if (key === 'supervisor' || key === 'command_leader' || key === 'harness') {
            if (old[key] !== null && !sameProcessStamp(old[key], meta[key])) throw new Error('immutable_meta_identity');
          } else if (key === 'scope') {
            if (!scopeUpdateAllowed(old.scope, meta.scope)) throw new Error('immutable_meta_scope');
          } else if (!isDeepStrictEqual(old[key], meta[key])) throw new Error('immutable_meta_field');
        }
      }
      if (this.readBytes(fd, 'exit.json')) throw new Error('final_receipt_already_committed');
      this.atomicWrite(fd, 'meta.json', Buffer.from(JSON.stringify(meta) + '\n'));
    });
  }

  commitExit(receipt: FinalExitReceipt): void {
    this.assertWritable();
    if (!isReceipt(receipt) || receipt.run_id !== this.runId) throw new Error('invalid_exit_receipt');
    const bytes = Buffer.from(JSON.stringify(receipt) + '\n');
    this.withDirectory((fd) => {
      const existing = this.readBytes(fd, 'exit.json');
      if (existing) {
        if (!existing.equals(bytes)) throw new Error('receipt_conflict');
        return;
      }
      const metaBytes = this.readBytes(fd, 'meta.json');
      const meta = this.parse(metaBytes, isMeta);
      if (metaBytes && !meta) throw new Error('invalid_existing_meta');
      if (meta) {
        const result = inspectReceipt(
          { final: true, complete: true, fingerprint: createHash('sha256').update(bytes).digest('hex'), receipt },
          meta,
          new Map()
        );
        if (result.decision !== 'adopt') throw new Error(result.reason ?? 'receipt_rejected');
      }
      this.atomicWrite(fd, 'exit.json', bytes);
    });
  }

  openLogs(): { stdout: number; stderr: number } {
    this.assertWritable();
    return this.withDirectory((fd) => {
      if (this.readBytes(fd, 'exit.json')) throw new Error('final_receipt_already_committed');
      const flags =
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_APPEND;
      const stdout = openSync(fdPath(fd, 'stdout.log'), flags, 0o600);
      let stderr: number | undefined;
      try {
        stderr = openSync(fdPath(fd, 'stderr.log'), flags, 0o600);
        fsyncSync(fd);
        return { stdout, stderr };
      } catch (error) {
        closeSync(stdout);
        if (stderr !== undefined) closeSync(stderr);
        throw error;
      }
    });
  }

  readMeta(): RunMeta | null {
    return this.withDirectory((fd) => this.metaAt(fd));
  }

  readExit(): FinalExitReceipt | null {
    return this.withDirectory((fd) => {
      const receipt = this.parse(this.readBytes(fd, 'exit.json'), isReceipt);
      if (!receipt || receipt.run_id !== this.runId) return null;
      const meta = this.metaAt(fd);
      if (
        meta &&
        inspectReceipt(
          {
            final: true,
            complete: true,
            fingerprint: createHash('sha256').update(JSON.stringify(receipt)).digest('hex'),
            receipt,
          },
          meta,
          new Map()
        ).decision !== 'adopt'
      )
        return null;
      return receipt;
    });
  }

  readLog(stream: 'stdout' | 'stderr', offset: number, limit = 64 * 1024): { data: Buffer; nextOffset: number } {
    if (!oneOf(stream, ['stdout', 'stderr']) || !uint(offset) || !uint(limit) || limit > 16 * 1024 * 1024)
      throw new Error('invalid_log_range');
    return this.withDirectory((fd) => {
      let file: number;
      try {
        file = openSync(fdPath(fd, `${stream}.log`), fileFlags);
      } catch (error) {
        if (missing(error)) return { data: Buffer.alloc(0), nextOffset: offset };
        throw error;
      }
      try {
        this.assertFile(file);
        const data = Buffer.alloc(Math.min(limit, Math.max(0, fstatSync(file).size - offset)));
        const count = data.length ? readSync(file, data, 0, data.length, offset) : 0;
        return { data: data.subarray(0, count), nextOffset: offset + count };
      } finally {
        closeSync(file);
      }
    });
  }
}
