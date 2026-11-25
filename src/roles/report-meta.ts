import { writePrivateFile } from '../utils/atomic-fs.js';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { reportSignature } from './cli-turn.js';
import { jobFiles } from '../mcp/paths.js';

const MAX_META_BYTES = 16 * 1024;
export const REPORT_LINE_LIMIT = 160;
const signatures = new Map<string, { stamp: string; sig: string | null }>();

/** The existing mtime:size:sha256 signature, shared with report-bound checks. */
export function cachedReportSignature(dir: string): string | null {
  const st = fs.lstatSync(join(dir, jobFiles.report), { throwIfNoEntry: false });
  if (!st?.isFile()) return null;
  const stamp = `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
  const entry = signatures.get(dir);
  if (entry?.stamp === stamp) return entry.sig;
  const sig = reportSignature(dir);
  if (signatures.size >= 256) signatures.clear();
  signatures.set(dir, { stamp, sig });
  return sig;
}

/** Display metadata only. The caller supplies normalized fields and the signature of its report. */
export type PreviewReceipt = { source: string; path?: string; stamp?: string; error?: string };
export type ReportMetaFields = { summary?: string; files?: readonly string[]; skip_checks_reason?: string; preview?: PreviewReceipt };

/** Structured reviewer report declarations recorded on job.json and archived unchanged. */
export type ReviewFindings = { blocker: number; major: number; minor: number };
export type ReviewedRange = { base: string; head: string };

const HEX40 = /^[0-9a-f]{40}$/;
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const isNonNegInt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export function parseReviewFindings(value: unknown): ReviewFindings | undefined {
  if (!isPlainObject(value)) return undefined;
  if (Object.keys(value).length !== 3 || !Object.hasOwn(value, 'blocker') || !Object.hasOwn(value, 'major') || !Object.hasOwn(value, 'minor')) {
    return undefined;
  }
  const { blocker, major, minor } = value;
  if (!isNonNegInt(blocker) || !isNonNegInt(major) || !isNonNegInt(minor)) return undefined;
  return { blocker: blocker + 0, major: major + 0, minor: minor + 0 };
}

export function parseReviewedRange(value: unknown): ReviewedRange | undefined {
  if (!isPlainObject(value)) return undefined;
  if (Object.keys(value).length !== 2 || !Object.hasOwn(value, 'base') || !Object.hasOwn(value, 'head')) return undefined;
  const { base, head } = value;
  if (typeof base !== 'string' || typeof head !== 'string' || !HEX40.test(base) || !HEX40.test(head)) return undefined;
  return { base, head };
}

export function extractReviewDeclaration(
  role: string,
  input: { findings?: unknown; reviewed?: unknown },
): { findings?: ReviewFindings; reviewed?: ReviewedRange; warnings: string[] } {
  const warnings: string[] = [];
  if (role !== 'reviewer') {
    if (input.findings !== undefined) warnings.push('hud_report: dropped findings (reviewer role only)');
    if (input.reviewed !== undefined) warnings.push('hud_report: dropped reviewed (reviewer role only)');
    return { warnings };
  }
  let findings: ReviewFindings | undefined;
  if (input.findings !== undefined) {
    findings = parseReviewFindings(input.findings);
    if (!findings) warnings.push('hud_report: dropped invalid findings');
  }
  let reviewed: ReviewedRange | undefined;
  if (input.reviewed !== undefined) {
    reviewed = parseReviewedRange(input.reviewed);
    if (!reviewed) warnings.push('hud_report: dropped invalid reviewed');
  }
  return { ...(findings ? { findings } : {}), ...(reviewed ? { reviewed } : {}), warnings };
}
export const validPreviewPath = (value: unknown): value is string => typeof value === 'string' &&
  value.length <= 260 && !/^\//u.test(value) && !/[\\:\p{Cc}\p{Bidi_Control}\u2028\u2029]/u.test(value) &&
  !value.split('/').includes('..') && /\.html?$/iu.test(value);
export const previewNotice = (preview?: PreviewReceipt): string => preview?.path
  ? `Preview: ${preview.path}${preview.error ? ` (${preview.error})` : ''}` : preview?.error ?? '';
export type ReportMeta = ReportMetaFields & { v: 1; report_sig: string; at: string };

// Terminal control strings (including OSC), CSI, and other ESC sequences.
const ansi = /(?:\x1b[\]PX^_]|[\x90\x98\x9d\x9e\x9f])[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)|(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]|\x1b[ -/]*[0-~]/gu;
const controls = /[\p{Cc}\p{Bidi_Control}]/gu;
const invalidField = (field: keyof ReportMetaFields): never => {
  throw Object.assign(new Error(`invalid_arguments: ${field}`), { code: 'invalid_arguments' });
};

function plainLine(text: string): string {
  const line = text.replace(ansi, '').replace(/[\r\n\u2028\u2029]+/gu, ' ').replace(controls, '')
    .trim().replace(/\s+/gu, ' ').replace(/^(?:#{1,6}|[-*•]) /u, '');
  const points = [...line];
  return points.length > REPORT_LINE_LIMIT ? `${points.slice(0, REPORT_LINE_LIMIT - 1).join('')}…` : line;
}

export function normalizeReportMeta({ summary, files, skip_checks_reason }: { summary?: unknown; files?: unknown; skip_checks_reason?: unknown }): ReportMetaFields {
  const fields: ReportMetaFields = {};
  if (summary !== undefined) {
    if (typeof summary !== 'string') return invalidField('summary');
    const line = plainLine(summary);
    if (line) fields.summary = line;
  }
  if (skip_checks_reason !== undefined) {
    if (typeof skip_checks_reason !== 'string') return invalidField('skip_checks_reason');
    const reason = plainLine(skip_checks_reason);
    if (!reason) return invalidField('skip_checks_reason');
    fields.skip_checks_reason = reason;
  }
  if (files !== undefined) {
    if (!Array.isArray(files) || files.some((file) => typeof file !== 'string')) return invalidField('files');
    const paths = new Set<string>();
    for (const raw of files) {
      if (/[\0\r\n\u2028\u2029]/u.test(raw)) continue;
      const file = raw.replace(controls, '').trim().replace(/^(?:\.[\\/])+/u, '');
      if (!file || file === '.' || /^(?:[\\/]|[a-z]:)/iu.test(file) || file.split(/[\\/]/u).includes('..')) continue;
      if ([...file].length > 260) continue;
      paths.add(file);
      if (paths.size === 50) break;
    }
    if (paths.size) fields.files = [...paths];
  }
  return fields;
}

export function writeReportMeta(
  dir: string,
  reportSig: string,
  { files, ...fields }: ReportMetaFields,
  at = new Date().toISOString()
): void {
  const file = join(dir, jobFiles.reportMeta);
  const meta: ReportMeta = { v: 1, report_sig: reportSig, at, ...fields };
  // Valid paths can still exceed the read cap when JSON-escaped or encoded as UTF-8.
  const paths: string[] = [];
  let remaining = MAX_META_BYTES - Buffer.byteLength(JSON.stringify(meta)) - ',"files":[]'.length;
  for (const path of files ?? []) {
    remaining -= Buffer.byteLength(JSON.stringify(path)) + (paths.length ? 1 : 0);
    if (remaining < 0) break;
    paths.push(path);
  }
  if (!fields.summary && !fields.skip_checks_reason && !fields.preview && !paths.length) {
    fs.rmSync(file, { force: true });
    return;
  }
  const body = JSON.stringify({ ...meta, ...(paths.length ? { files: paths } : {}) });
  if (Buffer.byteLength(body) > MAX_META_BYTES) throw new Error('report metadata exceeds 16 KiB');
  writePrivateFile(file, body, { mkdir: false });
}

/** Pass false only to recover the previous preview declaration while publishing a new report. */
export function readReportMeta(dir: string, expectedSig?: string | null | false): ReportMeta | null {
  const file = join(dir, jobFiles.reportMeta);
  try {
    const before = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!before?.isFile() || before.size > MAX_META_BYTES) return null;
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    let body: string;
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.ino !== before.ino || st.dev !== before.dev || st.size > MAX_META_BYTES) return null;
      const buffer = Buffer.alloc(MAX_META_BYTES + 1);
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
      if (bytes > MAX_META_BYTES) return null;
      body = buffer.toString('utf8', 0, bytes);
    } finally {
      fs.closeSync(fd);
    }
    const meta = JSON.parse(body);
    if (
      meta?.v !== 1 ||
      typeof meta.at !== 'string' ||
      typeof meta.report_sig !== 'string' ||
      (meta.summary !== undefined && typeof meta.summary !== 'string') ||
      (meta.skip_checks_reason !== undefined && typeof meta.skip_checks_reason !== 'string') ||
      (meta.files !== undefined &&
        (!Array.isArray(meta.files) || !meta.files.every((p: unknown) => typeof p === 'string')))
    )
      return null;
    if (expectedSig !== false && meta.report_sig !== (expectedSig === undefined ? cachedReportSignature(dir) : expectedSig)) return null;
    const { at, report_sig, preview } = meta;
    const fields = normalizeReportMeta(meta);
    if (validPreviewPath(preview?.source) && [preview.path, preview.stamp, preview.error].every(v => v === undefined || typeof v === 'string')) fields.preview = preview;
    return fields.summary || fields.files || fields.skip_checks_reason || fields.preview ? { v: 1, at, report_sig, ...fields } : null;
  } catch {
    return null;
  }
}
