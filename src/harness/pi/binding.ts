import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BindContext } from '../../core/interfaces/harness-adapter.js';
import type { SessionBinding, SurfaceLocator } from '../../core/interfaces/session-binding.js';
import type { ProcessStamp } from '../../core/types/supervision.js';
import type { SessionRef, SourceId } from '../../core/types/identity.js';
import { sameSessionRef, sessionRefKey, validateSessionRef } from '../../core/identity.js';

export interface PiCommandline {
  process: ProcessStamp;
  argv: readonly string[];
}
/** Cmdlines must come from the host's verified current process observation, never transcript text. */
export interface PiBindContext extends BindContext {
  commandlines?: readonly PiCommandline[];
}
const inside = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const sameStamp = (a: ProcessStamp, b: ProcessStamp) =>
  a.pid === b.pid && a.proc_start === b.proc_start && a.boot_id === b.boot_id && a.pid_domain === b.pid_domain;
const validStamp = (s: ProcessStamp) =>
  Number.isSafeInteger(s.pid) &&
  s.pid > 0 &&
  [s.proc_start, s.boot_id, s.pid_domain].every((v) => typeof v === 'string' && v.length > 0);
function sameLocator(a: SurfaceLocator | null, b: SurfaceLocator): boolean {
  return (
    a !== null &&
    a.kind === b.kind &&
    a.server === b.server &&
    a.pane === b.pane &&
    (a.kind === 'tmux'
      ? b.kind === 'tmux' && a.session === b.session
      : b.kind === 'herdr' && a.workspace === b.workspace && a.tab === b.tab) &&
    a.occupantGeneration !== null &&
    a.occupantGeneration === b.occupantGeneration &&
    a.process !== null &&
    b.process !== null &&
    validStamp(a.process) &&
    validStamp(b.process) &&
    sameStamp(a.process, b.process)
  );
}
export class PiTranscriptFiles {
  private files = new Map<string, string>();
  private discoveries = new Map<
    string,
    {
      directories: string[];
      directory: number;
      entries: fs.Dirent[] | null;
      entry: number;
      matches: string[];
      scanned: number;
    }
  >();
  constructor(
    readonly root: string,
    readonly sourceId: SourceId
  ) {}
  validate(ref: SessionRef): SessionRef {
    validateSessionRef(ref);
    if (
      ref.harness !== 'pi' ||
      ref.sourceId !== this.sourceId ||
      ref.threadId !== null ||
      !/^[A-Za-z0-9_-]+$/.test(ref.sessionId)
    )
      throw new Error('invalid_pi_ref');
    return { ...ref };
  }
  contained(file: string): string {
    if (!path.isAbsolute(file) || !inside(this.root, file)) throw new Error('pi_transcript_outside_source');
    const real = fs.realpathSync(file);
    if (!inside(this.root, real) || !fs.statSync(real).isFile()) throw new Error('pi_transcript_outside_source');
    return real;
  }
  header(file: string): { id: string; cwd?: string } {
    const fd = fs.openSync(this.contained(file), 'r');
    try {
      const buffer = Buffer.alloc(64 * 1024);
      const n = fs.readSync(fd, buffer, 0, buffer.length, 0);
      const newline = buffer.subarray(0, n).indexOf(10);
      if (newline < 0 && n === buffer.length) throw new Error('pi_header_too_large');
      const value: unknown = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, newline < 0 ? n : newline))
      );
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_pi_header');
      const row = value as Record<string, unknown>;
      if (row.type !== 'session' || typeof row.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(row.id))
        throw new Error('invalid_pi_header');
      return { id: row.id, ...(typeof row.cwd === 'string' ? { cwd: row.cwd } : {}) };
    } finally {
      fs.closeSync(fd);
    }
  }
  remember(target: SessionRef, file: string): string {
    const ref = this.validate(target);
    const real = this.contained(file);
    if (this.header(real).id !== ref.sessionId) throw new Error('pi_session_mismatch');
    this.files.set(sessionRefKey(ref), file);
    return real;
  }
  /** Metadata-only, bounded discovery. Header identity is checked by the budgeted reader. */
  resolve(target: SessionRef, deadline = Infinity): string | null {
    const ref = this.validate(target);
    if (performance.now() >= deadline) return null;
    const cached = this.files.get(sessionRefKey(ref));
    if (cached) return this.contained(cached);
    const key = sessionRefKey(ref);
    let discovery = this.discoveries.get(key);
    if (!discovery) {
      discovery = { directories: [this.root], directory: 0, entries: null, entry: 0, matches: [], scanned: 0 };
      this.discoveries.set(key, discovery);
    }
    while (discovery.directory < discovery.directories.length) {
      if (performance.now() >= deadline) return null;
      const directory = discovery.directories[discovery.directory];
      // Save the listing before yielding; a slow metadata read must not restart discovery forever.
      discovery.entries ??= fs.readdirSync(directory, { withFileTypes: true });
      while (discovery.entry < discovery.entries.length) {
        if (performance.now() >= deadline) return null;
        const entry = discovery.entries[discovery.entry++];
        if (++discovery.scanned > 4096) {
          this.discoveries.delete(key);
          throw new Error('pi_discovery_budget_exceeded');
        }
        if (discovery.directory === 0 && entry.isDirectory())
          discovery.directories.push(path.join(directory, entry.name));
        if (!entry.isFile() && !entry.isSymbolicLink()) continue;
        if (!entry.name.endsWith(`_${ref.sessionId}.jsonl`) && entry.name !== `${ref.sessionId}.jsonl`) continue;
        try {
          discovery.matches.push(this.contained(path.join(directory, entry.name)));
        } catch {
          /* Escaped or broken paths do not bind. */
        }
      }
      discovery.directory++;
      discovery.entries = null;
      discovery.entry = 0;
    }
    this.discoveries.delete(key);
    if (discovery.matches.length !== 1)
      throw new Error(discovery.matches.length ? 'ambiguous_pi_transcript' : 'pi_transcript_unavailable');
    this.files.set(key, discovery.matches[0]);
    return this.contained(discovery.matches[0]);
  }
}
function argumentsOf(argv: readonly string[]): Map<string, string> | null {
  const values = new Map<string, string>();
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') break;
    const key = arg.split('=', 1)[0];
    if (!['--session', '--session-id', '--session-dir'].includes(key)) continue;
    const value = arg.includes('=') ? arg.slice(key.length + 1) : argv[++i];
    if (!value || value.startsWith('--') || value.includes('\0') || values.has(key)) return null;
    values.set(key, value);
  }
  return values;
}
/** Observation binding only. No caller context, process authority or managed run is manufactured. */
export function bindPi(context: PiBindContext, files: PiTranscriptFiles): SessionBinding | null {
  try {
    const refs = new Map<string, { ref: SessionRef; stamp: ProcessStamp | null }>();
    const add = (ref: SessionRef, stamp: ProcessStamp | null, file?: string) => {
      const checked = files.validate(ref);
      files.remember(checked, file ?? files.resolve(checked)!);
      refs.set(sessionRefKey(checked), { ref: checked, stamp });
    };
    const finish = (): SessionBinding | null => {
      if (refs.size !== 1) return null;
      const { ref, stamp } = [...refs.values()][0];
      return {
        sessionRef: ref,
        harness: stamp,
        managed: null,
        occupantGeneration:
          stamp && context.locator?.process && sameStamp(stamp, context.locator.process)
            ? context.locator.occupantGeneration
            : null,
      };
    };
    if (context.explicitSession) {
      add(context.explicitSession, null);
      return finish();
    }
    // Exact current process arguments precede registry hints for pi (concept §7.3).
    for (const command of context.commandlines ?? []) {
      if (
        !validStamp(command.process) ||
        !context.processes.some((s) => validStamp(s) && sameStamp(s, command.process))
      )
        continue;
      if (context.locator?.process && !sameStamp(context.locator.process, command.process)) continue;
      const args = argumentsOf(command.argv);
      if (!args) return null;
      const directory = args.get('--session-dir');
      if (directory && (!path.isAbsolute(directory) || fs.realpathSync(directory) !== files.root)) return null;
      const session = args.get('--session');
      const id = args.get('--session-id');
      if (!session && !id) continue;
      const file = session && path.isAbsolute(session) ? files.contained(session) : undefined;
      const sessionId = file ? files.header(file).id : (session ?? id!);
      if (id && id !== sessionId) return null;
      add({ harness: 'pi', sourceId: context.sourceId, sessionId, threadId: null }, command.process, file);
    }
    if (refs.size) return finish();
    for (const record of context.registry) {
      const evidence = record.evidence;
      if (
        evidence.validity !== 'current' ||
        evidence.ref.harness !== 'pi' ||
        evidence.ref.sourceId !== context.sourceId ||
        !evidence.value.occupant ||
        !sameSessionRef(evidence.ref, evidence.value.occupant) ||
        (context.locator && !sameLocator(record.locator, context.locator))
      )
        continue;
      add(evidence.ref, null);
    }
    return finish();
  } catch {
    return null;
  }
}
