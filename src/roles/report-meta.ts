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

export function writeReportMeta(
  dir: string,
  reportSig: string,
  { summary, files }: ReportMetaFields,
  at = new Date().toISOString()
): void {
  const file = join(dir, META_FILE);
  if (!summary && !files?.length) {
    fs.rmSync(file, { force: true });
    return;
  }
  const body = JSON.stringify({
    v: 1,
    report_sig: reportSig,
    at,
    ...(summary ? { summary } : {}),
    ...(files?.length ? { files } : {}),
  });
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
    const { at, report_sig, summary, files } = meta;
    return { v: 1, at, report_sig, ...(summary ? { summary } : {}), ...(files?.length ? { files } : {}) };
  } catch {
    return null;
  }
}
