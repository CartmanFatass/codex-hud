import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BindContext } from '../../core/interfaces/harness-adapter.js';
import type { SessionBinding, SurfaceLocator } from '../../core/interfaces/session-binding.js';
import type { SessionRef, SourceId } from '../../core/types/identity.js';
import type { ProcessStamp } from '../../core/types/supervision.js';
import { sameSessionRef, sessionRefKey, validateSessionRef } from '../../core/identity.js';
import type { ClaudeStatusline } from './reader.js';

export interface ClaudeBindContext extends BindContext {
  statusline?: ClaudeStatusline | null;
}

const component = (value: string) => /^[A-Za-z0-9_-]+$/.test(value);
const inside = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const sameStamp = (a: ProcessStamp, b: ProcessStamp) =>
  a.pid === b.pid && a.proc_start === b.proc_start && a.boot_id === b.boot_id && a.pid_domain === b.pid_domain;
const validStamp = (stamp: ProcessStamp) =>
  Number.isSafeInteger(stamp.pid) &&
  stamp.pid > 0 &&
  typeof stamp.proc_start === 'string' &&
  stamp.proc_start.length > 0 &&
  typeof stamp.boot_id === 'string' &&
  stamp.boot_id.length > 0 &&
  typeof stamp.pid_domain === 'string' &&
  stamp.pid_domain.length > 0;

class ResolutionDeferred extends Error {}
const checkDeadline = (deadline: number) => {
  if (performance.now() >= deadline) throw new ResolutionDeferred();
};

interface Discovery {
  projects: string[];
  cursor: number;
  matches: string[];
}

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

/** A bounded header probe supplies candidate cwd only; it never publishes workspace provenance. */
function transcriptHeader(file: string): { sessionId?: string; cwd?: string; agentId?: string } {
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(128 * 1024);
    const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, size).toString('utf8');
    const lines = text.split('\n');
    if (size === buffer.length) lines.pop();
    const result: { sessionId?: string; cwd?: string; agentId?: string } = {};
    for (const line of lines.slice(0, 64)) {
      try {
        const row = JSON.parse(line);
        if (typeof row?.sessionId === 'string') {
          if (result.sessionId && result.sessionId !== row.sessionId) throw new Error('claude_session_mismatch');
          result.sessionId = row.sessionId;
        }
        if (typeof row?.cwd === 'string' && path.isAbsolute(row.cwd)) result.cwd ??= row.cwd;
        if (typeof row?.agentId === 'string') result.agentId ??= row.agentId;
      } catch (error) {
        if (error instanceof Error && error.message === 'claude_session_mismatch') throw error;
      }
    }
    return result;
  } finally {
    fs.closeSync(fd);
  }
}

/** Logical paths are cached, then realpath-checked again on every read to detect symlink replacement. */
export class ClaudeTranscriptFiles {
  private files = new Map<string, string>();
  private discoveries = new Map<string, Discovery>();
  constructor(
    readonly root: string,
    readonly sourceId: SourceId
  ) {}

  validate(ref: SessionRef): SessionRef {
    validateSessionRef(ref);
    if (
      ref.harness !== 'claude' ||
      ref.sourceId !== this.sourceId ||
      !component(ref.sessionId) ||
      (ref.threadId !== null && ref.threadId !== '' && !component(ref.threadId))
    )
      throw new Error('unknown_claude_source');
    return { ...ref, threadId: ref.threadId || null };
  }

  private contained(file: string, deadline = Infinity): string {
    checkDeadline(deadline);
    if (!path.isAbsolute(file) || !inside(path.join(this.root, 'projects'), path.resolve(file)))
      throw new Error('claude_transcript_outside_source');
    const real = fs.realpathSync(file);
    if (!inside(this.root, real)) throw new Error('claude_transcript_outside_source');
    const projects = fs.realpathSync(path.join(this.root, 'projects'));
    if (!inside(projects, real)) throw new Error('claude_transcript_outside_source');
    if (!fs.statSync(real).isFile()) throw new Error('claude_transcript_outside_source');
    // Finish this bounded path validation even if metadata I/O consumed the soft slice.
    // Discovery checks the clock between candidates and keeps its saved cursor.
    return real;
  }

  remember(target: SessionRef, file: string, cache = true, probeHeader = true, deadline = Infinity): string {
    const ref = this.validate(target);
    const real = this.contained(file, deadline);
    const expected = ref.threadId ? `agent-${ref.threadId}.jsonl` : `${ref.sessionId}.jsonl`;
    if (path.basename(file) !== expected) throw new Error('claude_session_mismatch');
    const relative = path.relative(path.join(this.root, 'projects'), path.resolve(file)).split(path.sep);
    if (
      ref.threadId
        ? relative.length !== 4 || relative[1] !== ref.sessionId || relative[2] !== 'subagents'
        : relative.length !== 2
    )
      throw new Error('claude_session_mismatch');
    if (probeHeader) {
      const header = transcriptHeader(real);
      if (
        (header.sessionId && header.sessionId !== ref.sessionId) ||
        (ref.threadId && header.agentId && header.agentId !== ref.threadId)
      )
        throw new Error('claude_session_mismatch');
    }
    if (cache) {
      this.files.set(sessionRefKey(ref), file);
      this.discoveries.delete(sessionRefKey(ref));
    }
    return real;
  }

  private projects(): string[] {
    const projects = path.join(this.root, 'projects');
    try {
      if (!inside(this.root, fs.realpathSync(projects))) return [];
      return fs.readdirSync(projects, { withFileTypes: true }).flatMap((entry) => {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) return [];
        const directory = path.join(projects, entry.name);
        try {
          return inside(this.root, fs.realpathSync(directory)) && fs.statSync(directory).isDirectory()
            ? [directory]
            : [];
        } catch {
          return [];
        }
      });
    } catch {
      return [];
    }
  }

  resolve(target: SessionRef, deadline = Infinity): string | null {
    const ref = this.validate(target);
    const key = sessionRefKey(ref);
    try {
      checkDeadline(deadline);
      const cached = this.files.get(key);
      if (cached) return this.contained(cached, deadline);
      let discovery = this.discoveries.get(key);
      if (!discovery) {
        const projects = path.join(this.root, 'projects');
        checkDeadline(deadline);
        const real = fs.realpathSync(projects);
        if (!inside(this.root, real)) throw new Error('claude_transcript_outside_source');
        // Complete this initial metadata step and save its cursor before yielding.
        // Otherwise a slow realpath can prevent discovery from ever being created.
        const entries = fs.readdirSync(projects, { withFileTypes: true });
        discovery = {
          projects: entries
            .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
            .map((entry) => path.join(projects, entry.name)),
          cursor: 0,
          matches: [],
        };
        // Persist the directory listing before checking elapsed time, so a slow readdir is not repeated.
        this.discoveries.set(key, discovery);
      }
      while (discovery.cursor < discovery.projects.length) {
        checkDeadline(deadline);
        const project = discovery.projects[discovery.cursor];
        const file = ref.threadId
          ? path.join(project, ref.sessionId, 'subagents', `agent-${ref.threadId}.jsonl`)
          : path.join(project, `${ref.sessionId}.jsonl`);
        try {
          // The reader validates record identity within its byte budget; discovery reads metadata only.
          this.remember(ref, file, false, false, deadline);
          discovery.matches.push(file);
        } catch (error) {
          if (error instanceof ResolutionDeferred) throw error;
          /* Missing or escaped files are not candidates. */
        }
        discovery.cursor++;
      }
      checkDeadline(deadline);
      if (discovery.matches.length !== 1) {
        this.discoveries.delete(key);
        throw new Error(discovery.matches.length ? 'ambiguous_claude_transcript' : 'claude_transcript_unavailable');
      }
      const file = discovery.matches[0];
      const real = this.contained(file, deadline);
      this.files.set(key, file);
      this.discoveries.delete(key);
      return real;
    } catch (error) {
      if (error instanceof ResolutionDeferred) return null;
      throw error;
    }
  }

  candidates(cwd: string): SessionRef[] {
    const refs: SessionRef[] = [];
    for (const project of this.projects()) {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(project, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.name.endsWith('.jsonl') || (!entry.isFile() && !entry.isSymbolicLink())) continue;
        const ref: SessionRef = {
          harness: 'claude',
          sourceId: this.sourceId,
          sessionId: entry.name.slice(0, -6),
          threadId: null,
        };
        try {
          const real = this.remember(ref, path.join(project, entry.name), false);
          if (transcriptHeader(real).cwd === cwd) refs.push(ref);
        } catch {
          /* Broken, escaped or mismatched transcripts cannot bind. */
        }
      }
    }
    return refs;
  }
}

/** Observation binding only: this never creates an MCP context, managed run, or authorization. */
export function bindClaude(context: ClaudeBindContext, files: ClaudeTranscriptFiles): SessionBinding | null {
  const refs = new Map<string, SessionRef>();
  const add = (target: SessionRef) => {
    const ref = files.validate(target);
    refs.set(sessionRefKey(ref), ref);
  };
  const locatorStamp = context.locator?.process;
  const knownLocator =
    locatorStamp &&
    validStamp(locatorStamp) &&
    context.processes.some((stamp) => validStamp(stamp) && sameStamp(stamp, locatorStamp))
      ? locatorStamp
      : null;
  const finish = (stamp: ProcessStamp | null = null): SessionBinding | null => {
    if (refs.size !== 1) return null;
    return {
      sessionRef: [...refs.values()][0],
      harness: stamp,
      occupantGeneration:
        stamp && knownLocator && sameStamp(stamp, knownLocator) ? context.locator!.occupantGeneration : null,
      managed: null,
    };
  };
  try {
    if (context.explicitSession) add(context.explicitSession);
    if (context.statusline) {
      const ref: SessionRef = {
        harness: 'claude',
        sourceId: context.sourceId,
        sessionId: context.statusline.session_id,
        threadId: context.statusline.agent_id || null,
      };
      files.remember(ref, context.statusline.transcript_path);
      add(ref);
    }
    if (refs.size) return finish(knownLocator);
    for (const record of context.registry) {
      const evidence = record.evidence;
      if (
        evidence.validity !== 'current' ||
        evidence.ref.sourceId !== context.sourceId ||
        evidence.ref.harness !== 'claude' ||
        evidence.value.occupant === null ||
        !sameSessionRef(evidence.ref, evidence.value.occupant) ||
        (context.locator !== null && !sameLocator(record.locator, context.locator))
      )
        continue;
      add(evidence.ref);
    }
    if (refs.size) return finish(knownLocator);
    const stamps: ProcessStamp[] = [];
    const processes = context.processes.filter(
      (stamp) => validStamp(stamp) && (context.locator?.process ? sameStamp(context.locator.process, stamp) : true)
    );
    for (const stamp of processes) {
      let row;
      try {
        const file = path.join(files.root, 'sessions', `${stamp.pid}.json`);
        const real = fs.realpathSync(file);
        const stat = fs.statSync(real);
        if (!inside(files.root, real) || !stat.isFile() || stat.size > 64 * 1024) continue;
        row = JSON.parse(fs.readFileSync(real, 'utf8'));
      } catch {
        continue;
      }
      if (
        row?.pid !== stamp.pid ||
        row.procStart !== stamp.proc_start ||
        row.pidDomain !== stamp.pid_domain ||
        (row.bootId !== undefined && row.bootId !== stamp.boot_id) ||
        typeof row.sessionId !== 'string' ||
        (row.agentId !== undefined && row.agentId !== null && typeof row.agentId !== 'string')
      )
        continue;
      add({
        harness: 'claude',
        sourceId: context.sourceId,
        sessionId: row.sessionId,
        threadId: typeof row.agentId === 'string' ? row.agentId : null,
      });
      if (!stamps.some((previous) => sameStamp(previous, stamp))) stamps.push(stamp);
    }
    if (refs.size) return finish(stamps.length === 1 ? stamps[0] : null);
  } catch {
    return null;
  }
  if (!context.cwd) return null;
  const candidates = files.candidates(context.cwd);
  if (candidates.length !== 1) return null;
  refs.set(sessionRefKey(candidates[0]), candidates[0]);
  return finish();
}
