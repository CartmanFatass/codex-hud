/** Bounded, inert job-card extraction. This is not the native Pi transcript reader. */
import * as path from 'node:path';
import { parseDispatchStatus } from '../roles/pi-dispatch-status.js';
import {
  JobMaterialAuthority,
  JobBudgetPending,
  currentJobBudget,
  withJobBudget,
  rethrowJobBudget,
  freezeJobValue,
  jobFileStamp,
  readJobFile,
  safeJobPath,
  type JobFragment,
  type JobIdentity,
  type JobMaterialSubject,
  type JobReadBudget,
  type JobHelperIdentity,
} from '../core/materials/job.js';
import type { ResolvedRecipient } from '../core/materials/index.js';
import type { Coverage } from '../core/types/observation.js';

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const clip = (s: string, n: number) => Array.from(s).slice(0, n).join('');
const safeText = (s: string) => !s.includes('gAAAAA') && !/[\x00-\x08\x0b-\x1f\x7f]/.test(s);
export interface JobOutputSelection {
  /** Current episode-compatible artifacts selected by the reduced observer, never discovered here. */
  questions?: readonly string[];
  review?: string;
  report?: boolean;
}
export interface JobOutputResult {
  fragments: JobFragment[];
  coverage: Coverage;
}
interface Cached {
  signature: string;
  done: Set<string>;
  fragments: JobFragment[];
  gaps: string[];
  helper?: JobHelperIdentity;
  reportHead?: { text: string; truncated: boolean };
  sessionId?: string;
  result?: JobOutputResult;
  files?: Record<string, string>;
}
export class JobPublicOutputAdapter {
  private readonly cache = new Map<string, Cached>();
  readonly reads = { files: 0, bytes: 0, parses: 0 };
  private readonly unsubscribe: () => void;
  constructor(private readonly authority: JobMaterialAuthority) {
    this.unsubscribe = authority.subscribe(() => {
      this.cache.clear();
    });
  }
  subject(
    identity: JobIdentity,
    recipient: ResolvedRecipient,
    selection: JobOutputSelection = {},
    budget?: JobReadBudget
  ): JobMaterialSubject {
    return {
      kind: 'job',
      identity: { ...identity },
      budget,
      read: () => withJobBudget(budget, () => this.extract(identity, recipient, selection)),
    };
  }
  dispose(): void {
    this.unsubscribe();
    this.cache.clear();
  }
  private extract(identity: JobIdentity, recipient: ResolvedRecipient, selection: JobOutputSelection): JobOutputResult {
    const authorization = this.authority.authorize(identity, recipient);
    if (!authorization) {
      this.cache.clear();
      throw new Error('requires_authorization');
    }
    const directory = this.authority.directory(identity);
    const source = this.authority.publicSource(identity);
    if (!directory || !source) throw new Error('source_missing');
    const budget = currentJobBudget(),
      startFiles = budget.files,
      startBytes = budget.bytes;
    const files = [
      'brief.md',
      ...(selection.report && source.reportEligible ? ['report.md'] : []),
      ...(!source.continuationPending && selection.review && /^review-[1-9][0-9]{0,5}\.md$/.test(selection.review)
        ? [selection.review, `.dispatch/${selection.review.slice(0, -3)}/STATUS.json`]
        : []),
      ...(source.continuationPending ? [] : (selection.questions ?? []))
        .slice(0, 2)
        .filter((q) => /^qa\/q[1-9][0-9]{0,3}\.md$/.test(q)),
    ];
    const stamps: string[] = [];
    for (const relative of files) {
      try {
        const s = safeJobPath(path.join(directory, relative));
        stamps.push(relative + s.chain + jobFileStamp(s.stat));
      } catch (error) {
        rethrowJobBudget(error);
        stamps.push(relative + ':missing');
      }
    }
    const read = (relative: string, cap: number, tail = false) => {
      if (budget.files - startFiles >= 8 || budget.bytes - startBytes >= 256 * 1024) throw new JobBudgetPending();
      if (!this.authority.pinFile(identity, relative)) throw new Error('source_replaced');
      return readJobFile(
        path.join(directory, relative),
        Math.min(cap, 256 * 1024 - (budget.bytes - startBytes)),
        budget,
        tail
      );
    };
    try {
      let sessionFile: string | undefined,
        sessionId = source.sessionId ?? undefined;
      if (source.sessionFile) {
        try {
          const s = safeJobPath(source.sessionFile);
          if (s.stat.isFile() && s.stat.dev === safeJobPath(directory).stat.dev && s.stat.size <= 64 * 1024 * 1024) {
            sessionFile = path.relative(directory, source.sessionFile);
            stamps.push(sessionFile + s.chain + jobFileStamp(s.stat));
          }
        } catch (error) {
          rethrowJobBudget(error);
        }
      }
      if (!source.continuationPending && source.directSession) {
        try {
          const s = safeJobPath(source.directSession);
          if (s.stat.isFile() && s.stat.dev === safeJobPath(directory).stat.dev && s.stat.size <= 64 * 1024 * 1024) {
            sessionFile = path.relative(directory, source.directSession);
            stamps.push(sessionFile + s.chain + jobFileStamp(s.stat));
          }
        } catch (error) {
          rethrowJobBudget(error);
        }
      }
      if (source.continuationPending) sessionFile = undefined;
      const key = JSON.stringify([identity, selection]),
        signature = JSON.stringify([authorization, stamps]);
      let state = this.cache.get(key);
      if (state?.signature !== signature) {
        state = { signature, done: new Set(), fragments: [], gaps: [] };
        this.cache.set(key, state);
        while (this.cache.size > 3) this.cache.delete(this.cache.keys().next().value!);
      }
      if (state.result) {
        for (const [relative, chain] of Object.entries(state.files!))
          if (!this.authority.pinFile(identity, relative, chain)) throw new Error('source_replaced');
        return state.result;
      }
      const progress = state;
      const add = (field: JobFragment['field'], text: string, locator: string, truncated = false) => {
        if (text.trim() && safeText(text))
          progress.fragments.push({
            id: `e${progress.fragments.length + 1}`,
            field,
            text,
            locator,
            truncated,
            ...(field === 'review' && progress.helper ? { helper: progress.helper } : {}),
          });
      };
      // Only completed reductions survive a deferral; raw JSONL tails/bodies never do.
      const step = (id: string, gap: string, action: () => void) => {
        if (progress.done.has(id)) return;
        try {
          action();
        } catch (error) {
          rethrowJobBudget(error);
          progress.gaps.push(gap);
        }
        progress.done.add(id);
        this.reads.parses++;
      };
      for (const q of files.filter((f) => f.startsWith('qa/')))
        step(q, 'question_unavailable', () => {
          const r = read(q, 32768);
          add('question', clip(r.text, 2000), q, r.truncated || Array.from(r.text).length > 2000);
        });
      if (selection.report && source.reportEligible) {
        step('report-head', 'report_unavailable', () => {
          const r = read('report.md', 16384),
            complete = !r.truncated && Array.from(r.text).length <= 4000;
          progress.reportHead = { text: clip(r.text, complete ? 4000 : 1950), truncated: !complete };
          if (complete) add('report', progress.reportHead.text, 'report.md');
        });
        if (progress.reportHead?.truncated)
          step('report-tail', 'report_unavailable', () => {
            const r = read('report.md', 16384, true);
            add(
              'report',
              `${progress.reportHead!.text}\n[truncated]\n${Array.from(r.text).slice(-1950).join('')}`,
              'report.md',
              true
            );
          });
      }
      if (selection.review && files.includes(selection.review)) {
        step('review-helper', 'review_unavailable', () => {
          const slot = selection.review!.slice(0, -3),
            statusLocator = `.dispatch/${slot}/STATUS.json`;
          const r = read(statusLocator, 65536);
          if (r.truncated) throw new Error('helper_status');
          const helper = parseDispatchStatus(
            JSON.parse(r.text),
            directory,
            slot,
            'reviewer',
            path.join(directory, selection.review!)
          );
          if (!helper?.output_written) throw new Error('helper_status');
          progress.helper = { slot, sessionId: helper.session_id, statusLocator };
        });
        if (progress.helper)
          step('review-body', 'review_unavailable', () => {
            const r = read(selection.review!, 16384),
              lines = r.text.split(/\r?\n/);
            if (!/^Verdict: (accept|changes-required)$/.test(lines[0]) || Buffer.byteLength(lines[0]) > 512)
              throw new Error('verdict');
            add('review', lines[0], selection.review!);
            for (const title of lines
              .slice(1)
              .filter((s) => /^#{2,4} (?:P[0-3]\b|Finding\b|Blocker\b|Major\b)/.test(s))
              .slice(0, 8))
              add('review', clip(title, 120), selection.review!, Array.from(title).length > 120);
          });
      }
      step('brief', 'brief_unavailable', () => {
        const r = read('brief.md', 32768),
          lines = r.text.split(/\r?\n/);
        let section = '',
          goal = '',
          headings = 0,
          owned = 0,
          fenced = false;
        for (const line of lines) {
          if (/^\s*(```|~~~)/.test(line)) {
            fenced = !fenced;
            continue;
          }
          if (fenced) continue;
          const heading = /^(#{1,6})\s+(.+)$/.exec(line);
          if (heading) {
            if (heading[1].length <= 2) section = heading[2].toLowerCase().replace(/:$/, '');
            else if (/^test(?:s| plan)?$/.test(section) && headings++ < 12)
              add('test_heading', clip(heading[2], 80), 'brief.md');
            continue;
          }
          if (section === 'goal' && line.trim()) goal += (goal ? '\n' : '') + line.trim();
          if (['owned files', 'owned-file list', 'files owned'].includes(section) && owned < 64) {
            const match = /^\s*[-*]\s+`([^`]+)`\s*$/.exec(line);
            if (match && match[1].length <= 160 && !path.isAbsolute(match[1]) && !match[1].split('/').includes('..')) {
              add('owned_path', match[1], 'brief.md');
              owned++;
            }
          }
        }
        add('goal', clip(goal, 1000), 'brief.md', r.truncated || Array.from(goal).length > 1000);
      });
      if (sessionFile) {
        step('pi-header', 'public_output_unavailable', () => {
          const r = read(sessionFile!, 4096),
            end = r.text.indexOf('\n');
          if (end < 0) throw new Error('header');
          const raw: unknown = JSON.parse(r.text.slice(0, end));
          if (
            !object(raw) ||
            raw.type !== 'session' ||
            typeof raw.id !== 'string' ||
            !/^[a-zA-Z0-9_-]{1,256}$/.test(raw.id) ||
            (sessionId !== undefined && raw.id !== sessionId) ||
            raw.version !== 3
          )
            throw new Error('header');
          progress.sessionId = raw.id;
        });
        if (progress.sessionId)
          step('pi-tail', 'public_output_unavailable', () => {
            const tail = read(sessionFile!, 65536, true),
              output = publicPiText(tail.text, tail.truncated, progress.sessionId!);
            if (!output) throw new Error('branch');
            for (const text of output)
              add(
                'public_output',
                clip(text.text, 600),
                `${sessionFile}#${text.id}`,
                Array.from(text.text).length > 600
              );
          });
      } else progress.gaps.push('public_output_unavailable');
      if (this.authority.authorize(identity, recipient) !== authorization) throw new Error('revoked');
      progress.files = this.authority.sourceIdentities(
        identity,
        progress.fragments.flatMap((f) => [f.locator, ...(f.helper ? [f.helper.statusLocator] : [])])
      );
      progress.result = freezeJobValue({
        fragments: progress.fragments,
        coverage: {
          state: 'partial',
          loaded: true,
          skipped: {},
          gaps: [...new Set(['bounded_job_excerpts', ...progress.gaps])],
        },
      });
      return progress.result;
    } finally {
      this.reads.files += budget.files - startFiles;
      this.reads.bytes += budget.bytes - startBytes;
    }
  }
}
/** Actual Pi v3 record envelope. A branch change/unknown record invalidates the whole tail. */
export function publicPiText(
  text: string,
  truncated: boolean,
  sessionId: string
): { id: string; text: string }[] | null {
  let lines = text.split('\n');
  if (truncated) lines = lines.slice(1);
  lines.pop();
  if (lines.length > 256) lines = lines.slice(-256);
  const output: { id: string; text: string }[] = [];
  let previous: string | null | undefined;
  const ids = new Set<string>();
  for (const line of lines) {
    if (!line.trim()) continue;
    if (Buffer.byteLength(line) > 65536) return null;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      return null;
    }
    if (!object(row)) return null;
    if (row.type === 'session') {
      if (truncated || previous !== undefined || row.id !== sessionId) return null;
      previous = null;
      continue;
    }
    if (!['message', 'model_change', 'thinking_level_change'].includes(String(row.type))) return null;
    if (
      typeof row.id !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,256}$/.test(row.id) ||
      ids.has(row.id) ||
      !(row.parentId === null || typeof row.parentId === 'string') ||
      (previous !== undefined && row.parentId !== previous)
    )
      return null;
    ids.add(row.id);
    previous = row.id;
    if (row.type !== 'message' || !object(row.message)) continue;
    const m = row.message;
    if (
      m.role !== 'assistant' ||
      m.channel !== undefined ||
      !Array.isArray(m.content) ||
      !Object.keys(m).every((key) =>
        ['role', 'content', 'api', 'provider', 'model', 'usage', 'stopReason', 'errorMessage', 'timestamp'].includes(
          key
        )
      )
    )
      continue;
    const blocks = m.content.filter(
      (b) =>
        object(b) &&
        b.type === 'text' &&
        typeof b.text === 'string' &&
        Object.keys(b).every((k) => ['type', 'text', 'textSignature'].includes(k))
    );
    const value = blocks.map((b) => String(b.text)).join('\n');
    if (value.trim() && safeText(value)) output.push({ id: row.id, text: value });
  }
  return output.slice(-4);
}
