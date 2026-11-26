/** Mechanical citation verification for settled sonic reports. No model calls or network. */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Job, JobStatus } from '../mcp/job-contracts.js';
import { jobFiles } from '../mcp/paths.js';
import { readFileBounded } from '../utils/atomic-fs.js';
import { SAFE_GIT_ARGS, safeGitEnv } from '../utils/git-safety.js';
import { count, record, text } from './job-usage.js';

export const MAX_CITATION_REPORT_BYTES = 256 * 1024;
export const MAX_CITATIONS = 200;
export const MAX_CITATION_FAILURES = 20;
const MAX_TARGET_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TRACKED_FILES_BYTES = 8 * 1024 * 1024;
const GIT_LS_FILES_TIMEOUT_MS = 2000;
const QUOTE_WINDOW_LINES = 3;
const MAX_REF_LENGTH = 260;
const MAX_REASON_LENGTH = 64;

export type CitationFailure = { ref: string; reason: string };
export type JobCitations = { total: number; verified: number; failed: CitationFailure[] };

type ParsedCitation = {
  start: number;
  end: number;
  ref: string;
  path: string;
  lineStart: number;
  lineEnd: number;
};

type CachedFile =
  | { ok: true; lines: string[]; normLines: string[]; truncated: boolean }
  | { ok: false; reason: string };

const CITATION_RE =
  /(?:^|(?<=[^A-Za-z0-9_.+/@:-]))([A-Za-z0-9_./][A-Za-z0-9_.+/@-]*):(\d+)(?:-(\d+))?(?![A-Za-z0-9_/]|-\d)/g;

const normalizeWs = (value: string) => value.replace(/\s+/g, ' ').trim();

function trimUtf8Prefix(bytes: Buffer): string {
  let end = bytes.length;
  if (end === 0) return '';
  let start = end - 1;
  const min = Math.max(0, end - 4);
  while (start > min && (bytes[start]! & 0xc0) === 0x80) start--;
  const lead = bytes[start]!;
  if (lead >= 0x80) {
    const needed = (lead & 0xe0) === 0xc0 ? 2 : (lead & 0xf0) === 0xe0 ? 3 : (lead & 0xf8) === 0xf0 ? 4 : 0;
    if (needed === 0 || start + needed > end) end = start;
  }
  return bytes.toString('utf8', 0, end);
}

function splitLines(content: string): string[] {
  if (!content) return [];
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function backtickSpans(line: string): { start: number; end: number; text: string }[] {
  const spans: { start: number; end: number; text: string }[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] !== '`') { i++; continue; }
    let ticks = 0;
    while (i + ticks < line.length && line[i + ticks] === '`') ticks++;
    const openEnd = i + ticks;
    let j = openEnd;
    let closeStart = -1;
    while (j < line.length) {
      if (line[j] !== '`') { j++; continue; }
      let run = 0;
      while (j + run < line.length && line[j + run] === '`') run++;
      if (run === ticks) { closeStart = j; break; }
      j += run;
    }
    if (closeStart === -1) { i = openEnd; continue; }
    let body = line.slice(openEnd, closeStart);
    if (body.length >= 2 && body.startsWith(' ') && body.endsWith(' ') && /[^ ]/.test(body)) {
      body = body.slice(1, -1);
    }
    spans.push({ start: i, end: closeStart + ticks, text: body });
    i = closeStart + ticks;
  }
  return spans;
}

function extractLineCitations(line: string): ParsedCitation[] {
  const out: ParsedCitation[] = [];
  CITATION_RE.lastIndex = 0;
  for (let match = CITATION_RE.exec(line); match; match = CITATION_RE.exec(line)) {
    const path = match[1]!;
    if ((!path.includes('/') && !path.includes('.')) || !/[A-Za-z]/.test(path)) continue;
    if (path.includes('//') || path.startsWith('...') || /[./]$/.test(path)) continue;
    const lineStart = Number(match[2]!);
    const lineEnd = match[3] !== undefined ? Number(match[3]) : lineStart;
    out.push({
      start: match.index,
      end: match.index + match[0].length,
      ref: match[0].slice(0, MAX_REF_LENGTH),
      path,
      lineStart,
      lineEnd,
    });
  }
  return out;
}

function collectRoots(cwd: string, worktreeRoot?: string, projectRoot?: string) {
  const rawRoots: string[] = [];
  const realRoots: string[] = [];
  for (const dir of [cwd, worktreeRoot, projectRoot]) {
    if (typeof dir !== 'string' || !dir) continue;
    const resolved = resolve(dir);
    if (!rawRoots.includes(resolved)) rawRoots.push(resolved);
    try {
      const real = fs.realpathSync(resolved);
      if (fs.statSync(real).isDirectory() && !realRoots.includes(real)) realRoots.push(real);
    } catch { /* Missing or unreadable root; citations against it will fail cleanly. */ }
  }
  return { rawRoots, realRoots };
}

function listTrackedByBasename(root: string): Map<string, string[]> | null {
  try {
    const git = spawnSync('git', [...SAFE_GIT_ARGS, 'ls-files', '-z'], {
      cwd: root,
      encoding: 'utf8',
      env: safeGitEnv(process.env),
      maxBuffer: MAX_TRACKED_FILES_BYTES,
      timeout: GIT_LS_FILES_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (git.status !== 0 || git.error || typeof git.stdout !== 'string') return null;
    const byBasename = new Map<string, string[]>();
    for (const entry of git.stdout.split('\0')) {
      if (!entry) continue;
      const slash = entry.lastIndexOf('/');
      const base = slash === -1 ? entry : entry.slice(slash + 1);
      const bucket = byBasename.get(base);
      if (bucket) bucket.push(entry);
      else byBasename.set(base, [entry]);
    }
    return byBasename;
  } catch {
    return null;
  }
}

function matchTrackedSuffix(
  byBasename: Map<string, string[]> | null,
  citedPath: string,
): { kind: 'unique'; path: string } | { kind: 'ambiguous' } | null {
  if (!byBasename) return null;
  const normalized = citedPath.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
  if (!normalized || normalized.startsWith('/')) return null;
  const segments = normalized.split('/');
  if (segments.some((seg) => !seg || seg === '.' || seg === '..')) return null;
  const base = segments[segments.length - 1]!;
  const candidates = byBasename.get(base);
  if (!candidates?.length) return null;
  const matches = segments.length === 1
    ? candidates
    : candidates.filter((file) => file === normalized || file.endsWith(`/${normalized}`));
  if (matches.length === 1) return { kind: 'unique', path: matches[0]! };
  if (matches.length > 1) return { kind: 'ambiguous' };
  return null;
}

export function checkReportCitations(
  reportText: string,
  roots: { cwd: string; worktreeRoot?: string; projectRoot?: string },
): JobCitations {
  const bounded = Buffer.byteLength(reportText, 'utf8') > MAX_CITATION_REPORT_BYTES
    ? trimUtf8Prefix(Buffer.from(reportText, 'utf8').subarray(0, MAX_CITATION_REPORT_BYTES))
    : reportText;
  const { rawRoots, realRoots } = collectRoots(roots.cwd, roots.worktreeRoot, roots.projectRoot);
  const fileCache = new Map<string, CachedFile>();
  const pathCache = new Map<string, { ok: true; realPath: string } | { ok: false; reason: string }>();
  const trackedCache = new Map<string, Map<string, string[]> | null>();

  const getTracked = (root: string): Map<string, string[]> | null => {
    if (trackedCache.has(root)) return trackedCache.get(root)!;
    const index = listTrackedByBasename(root);
    trackedCache.set(root, index);
    return index;
  };

  const resolveCitedPath = (citedPath: string): { ok: true; realPath: string } | { ok: false; reason: string } => {
    const prior = pathCache.get(citedPath);
    if (prior) return prior;
    let outcome: { ok: true; realPath: string } | { ok: false; reason: string };
    if (isAbsolute(citedPath)) {
      const candidate = resolve(citedPath);
      try {
        const realPath = fs.realpathSync(candidate);
        outcome = realRoots.some((root) => isWithin(root, realPath))
          ? { ok: true, realPath }
          : { ok: false, reason: 'outside_root' };
      } catch {
        const lexicallyInside = rawRoots.some((root) => isWithin(root, candidate)) ||
          realRoots.some((root) => isWithin(root, candidate));
        outcome = { ok: false, reason: lexicallyInside ? 'missing_file' : 'outside_root' };
      }
      pathCache.set(citedPath, outcome);
      return outcome;
    }

    const lexicalBase = realRoots[0] ?? rawRoots[0] ?? resolve(roots.cwd);
    if (!isWithin(lexicalBase, resolve(lexicalBase, citedPath))) {
      outcome = { ok: false, reason: 'outside_root' };
      pathCache.set(citedPath, outcome);
      return outcome;
    }

    outcome = { ok: false, reason: 'missing_file' };
    for (const root of realRoots) {
      const direct = resolve(root, citedPath);
      try {
        const realPath = fs.realpathSync(direct);
        outcome = realRoots.some((allowed) => isWithin(allowed, realPath))
          ? { ok: true, realPath }
          : { ok: false, reason: 'outside_root' };
        break;
      } catch { /* Fall through to unique tracked-file resolution in this root. */ }

      const suffix = matchTrackedSuffix(getTracked(root), citedPath);
      if (suffix?.kind === 'ambiguous') {
        outcome = { ok: false, reason: 'ambiguous_path' };
        break;
      }
      if (suffix?.kind === 'unique') {
        try {
          const realPath = fs.realpathSync(resolve(root, suffix.path));
          outcome = realRoots.some((allowed) => isWithin(allowed, realPath))
            ? { ok: true, realPath }
            : { ok: false, reason: 'outside_root' };
        } catch {
          outcome = { ok: false, reason: 'missing_file' };
        }
        break;
      }
    }
    pathCache.set(citedPath, outcome);
    return outcome;
  };

  const loadFile = (realPath: string): CachedFile => {
    const prior = fileCache.get(realPath);
    if (prior) return prior;
    let loaded: CachedFile;
    try {
      const { bytes, truncated } = readFileBounded(realPath, MAX_TARGET_FILE_BYTES, { followSymlinks: false });
      const lines = splitLines(bytes.toString('utf8'));
      loaded = { ok: true, lines, normLines: lines.map(normalizeWs), truncated };
    } catch {
      loaded = { ok: false, reason: 'missing_file' };
    }
    fileCache.set(realPath, loaded);
    return loaded;
  };

  let total = 0;
  let verified = 0;
  const failed: CitationFailure[] = [];
  const recordFailure = (ref: string, reason: string) => {
    if (failed.length < MAX_CITATION_FAILURES) failed.push({ ref, reason });
  };

  let fence: string | null = null;
  for (const line of bounded.split(/\r?\n/)) {
    const fenceMatch = /^[\t ]*(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      if (!fence) fence = marker[0]!.repeat(marker.length);
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;

    const citations = extractLineCitations(line);
    if (!citations.length) continue;

    const quotesByIndex: string[][] = citations.map(() => []);
    if (line.includes('`')) {
      for (const span of backtickSpans(line)) {
        if (citations.some((c) => c.start >= span.start && c.end <= span.end)) continue;
        const normalized = normalizeWs(span.text);
        if (!normalized) continue;
        let owner = 0;
        if (citations.length > 1) {
          for (let i = 0; i < citations.length; i++) {
            if (citations[i]!.end <= span.start) owner = i;
          }
        }
        quotesByIndex[owner]!.push(normalized);
      }
    }

    for (let i = 0; i < citations.length; i++) {
      if (total >= MAX_CITATIONS) return { total, verified, failed };
      const citation = citations[i]!;
      const quotes = quotesByIndex[i]!;
      total += 1;

      const resolved = resolveCitedPath(citation.path);
      if (!resolved.ok) {
        recordFailure(citation.ref, resolved.reason);
        continue;
      }
      const file = loadFile(resolved.realPath);
      if (!file.ok) {
        recordFailure(citation.ref, file.reason);
        continue;
      }
      if (!Number.isSafeInteger(citation.lineStart) || !Number.isSafeInteger(citation.lineEnd) ||
          citation.lineStart < 1 || citation.lineEnd < citation.lineStart) {
        recordFailure(citation.ref, 'invalid_line_range');
        continue;
      }
      if (citation.lineEnd > file.lines.length) {
        recordFailure(citation.ref, file.truncated ? 'file_too_large' : 'line_out_of_range');
        continue;
      }
      if (quotes.length > 0) {
        const winStart = Math.max(0, citation.lineStart - 1 - QUOTE_WINDOW_LINES);
        const winEnd = Math.min(file.lines.length, citation.lineEnd + QUOTE_WINDOW_LINES);
        const haystack = file.normLines.slice(winStart, winEnd).filter(Boolean).join(' ');
        if (quotes.some((quote) => !haystack.includes(quote))) {
          recordFailure(citation.ref, 'quote_not_found');
          continue;
        }
      }
      verified += 1;
    }
  }

  return { total, verified, failed };
}

export function shouldCheckSonicCitations(job: Partial<Job>, status: Partial<JobStatus>): boolean {
  return job.role === 'sonic' &&
    !job.citations &&
    !job.reaped_at &&
    (status.state === 'closed' || status.state === 'done') &&
    status.output_written !== false;
}

export function checkSonicReportCitations(
  dir: string,
  job: Pick<Job, 'role' | 'cwd' | 'worktree' | 'project_root'>,
): JobCitations | undefined {
  if (job.role !== 'sonic') return undefined;
  try {
    const { bytes, truncated } = readFileBounded(join(dir, jobFiles.report), MAX_CITATION_REPORT_BYTES);
    const body = truncated ? trimUtf8Prefix(bytes) : bytes.toString('utf8');
    return checkReportCitations(body, {
      cwd: job.cwd,
      worktreeRoot: job.worktree?.root,
      projectRoot: job.project_root ?? job.worktree?.main_root,
    });
  } catch {
    return undefined;
  }
}

export function jobCitations(value: unknown): JobCitations | undefined {
  const raw = record(value);
  const total = count(raw.total), verified = count(raw.verified);
  if (total === undefined || verified === undefined || verified > total || !Array.isArray(raw.failed)) return undefined;
  const failed: CitationFailure[] = [];
  for (const item of raw.failed) {
    if (failed.length >= MAX_CITATION_FAILURES) break;
    const entry = record(item);
    const ref = text(entry.ref), reason = text(entry.reason);
    if (ref && reason) failed.push({ ref: ref.slice(0, MAX_REF_LENGTH), reason: reason.slice(0, MAX_REASON_LENGTH) });
  }
  return { total, verified, failed };
}
