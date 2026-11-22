import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { reportSignature } from './cli-turn.js';

const META_FILE = 'report-meta.json';
const MAX_META_BYTES = 16 * 1024;
const signatures = new Map<string, { stamp: string; sig: string | null }>();

/** The existing mtime:size:sha256 signature, shared with report-bound checks. */
export function cachedReportSignature(dir: string): string | null {
  const st = fs.lstatSync(join(dir, 'report.md'), { throwIfNoEntry: false });
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
export type ReportMetaFields = { summary?: string; files?: readonly string[] };
export type ReportMeta = ReportMetaFields & { v: 1; report_sig: string; at: string };

// Terminal control strings (including OSC), CSI, and other ESC sequences.
const ansi = /(?:\x1b[\]PX^_]|[\x90\x98\x9d\x9e\x9f])[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)|(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]|\x1b[ -/]*[0-~]/gu;
const controls = /[\p{Cc}\p{Bidi_Control}]/gu;
const invalidField = (field: keyof ReportMetaFields): never => {
  throw Object.assign(new Error(`invalid_arguments: ${field}`), { code: 'invalid_arguments' });
};

export function normalizeReportMeta({ summary, files }: { summary?: unknown; files?: unknown }): ReportMetaFields {
  const fields: ReportMetaFields = {};
  if (summary !== undefined) {
    if (typeof summary !== 'string') return invalidField('summary');
    const line = summary
      .replace(ansi, '')
      .replace(/[\r\n\u2028\u2029]+/gu, ' ')
      .replace(controls, '')
      .trim()
      .replace(/\s+/gu, ' ')
      .replace(/^(?:#{1,6}|[-*•]) /u, '');
    const points = [...line];
    if (line) fields.summary = points.length > 160 ? `${points.slice(0, 159).join('')}…` : line;
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
  { summary, files }: ReportMetaFields,
  at = new Date().toISOString()
): void {
  const file = join(dir, META_FILE);
  const meta = { v: 1, report_sig: reportSig, at, ...(summary ? { summary } : {}) };
  // Valid paths can still exceed the read cap when JSON-escaped or encoded as UTF-8.
  const paths: string[] = [];
  let remaining = MAX_META_BYTES - Buffer.byteLength(JSON.stringify(meta)) - ',"files":[]'.length;
  for (const path of files ?? []) {
    remaining -= Buffer.byteLength(JSON.stringify(path)) + (paths.length ? 1 : 0);
    if (remaining < 0) break;
    paths.push(path);
  }
  if (!summary && !paths.length) {
    fs.rmSync(file, { force: true });
    return;
  }
  const body = JSON.stringify({ ...meta, ...(paths.length ? { files: paths } : {}) });
  if (Buffer.byteLength(body) > MAX_META_BYTES) throw new Error('report metadata exceeds 16 KiB');
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, body, { flag: 'wx', mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** If supplied, expectedSig is a signature the caller has already read for the current report. */
export function readReportMeta(dir: string, expectedSig?: string | null): ReportMeta | null {
  const file = join(dir, META_FILE);
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
      (meta.files !== undefined &&
        (!Array.isArray(meta.files) || !meta.files.every((p: unknown) => typeof p === 'string')))
    )
      return null;
    if (meta.report_sig !== (expectedSig === undefined ? cachedReportSignature(dir) : expectedSig)) return null;
    const { at, report_sig } = meta;
    const fields = normalizeReportMeta(meta);
    return fields.summary || fields.files ? { v: 1, at, report_sig, ...fields } : null;
  } catch {
    return null;
  }
}
