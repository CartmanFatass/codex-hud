import * as fs from 'node:fs';
import { join } from 'node:path';
import { readDone, readTurn, receiptForTurn, reportSignature, turnToken } from './cli-turn.js';

export const MAX_CHECKS = 5;
export const MAX_CHECK_COMMAND = 4096;
export const CHECKS_FILE = 'checks.json';
export type CheckBinding = { turn: string; report_sig: string };
type Receipt = CheckBinding & {
  state: 'running' | 'done';
  pid?: number;
  start?: string;
  results: { command: string; exit_code: number | null; duration_ms: number; output_tail: string; timed_out?: boolean }[];
};
export type CheckSummary = CheckBinding & {
  state: Receipt['state']; stale: boolean; passed: number; total: number;
  results: { command: string; passed: boolean; output_tail?: string }[];
};
export const sameChecks = (a: CheckBinding | null | undefined, b: CheckBinding | null | undefined) =>
  !!a && !!b && a.turn === b.turn && a.report_sig === b.report_sig;

const signatures = new Map<string, { stamp: string; sig: string | null }>();
function report(dir: string) {
  const st = fs.lstatSync(join(dir, 'report.md'), { throwIfNoEntry: false });
  if (!st?.isFile()) return null;
  const stamp = `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
  let entry = signatures.get(dir);
  if (entry?.stamp !== stamp) {
    if (signatures.size >= 256) signatures.clear();
    entry = { stamp, sig: reportSignature(dir) };
    signatures.set(dir, entry);
  }
  return entry.sig ? { sig: entry.sig, mtime: Math.floor(st.mtimeMs) } : null;
}
function jobTurn(dir: string, job: Record<string, unknown>) {
  const cli = job.cli ? readTurn(dir) : null;
  const sent = cli?.sent_at ?? job.pi_sent_at ?? job.created_at;
  return { cli, sent: typeof sent === 'string' ? Date.parse(sent) : NaN,
    turn: job.cli ? (cli ? turnToken(cli) : null) : typeof sent === 'string' ? sent : null };
}
export function checkBinding(dir: string, job: Record<string, unknown>, status: Record<string, unknown> | null): CheckBinding | null {
  if (!Array.isArray(job.checks) || !job.checks.length || job.bro || job.jev ||
      !status || status.output_written !== true || !['idle_grace', 'closed', 'done'].includes(String(status.state))) return null;
  const { cli, turn, sent } = jobTurn(dir, job), settled = Date.parse(String(status.settled_at));
  if (!turn || !(settled >= sent)) return null;
  const r = report(dir);
  if (!r) return null;
  if (cli) {
    const done = readDone(dir);
    if (!receiptForTurn(cli, done) || done.report_sig !== r.sig || status.declared_report_sig !== r.sig) return null;
  } else if (r.mtime <= sent || r.mtime > settled) return null; // Pi's fresh report must be part of the native settlement.
  return { turn, report_sig: r.sig };
}
export function readCheckReceipt(dir: string): Receipt | null {
  try {
    const file = join(dir, CHECKS_FILE), st = fs.lstatSync(file);
    if (!st.isFile() || st.size > 192 * 1024) return null;
    const r: Receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof r.turn === 'string' && typeof r.report_sig === 'string' &&
      (r.state === 'running' || r.state === 'done') && Array.isArray(r.results) ? r : null;
  } catch { return null; }
}
export function jobChecks(dir: string, job: Record<string, unknown>): CheckSummary | undefined {
  if (!Array.isArray(job.checks) || !job.checks.length) return;
  const r = readCheckReceipt(dir);
  if (!r) return;
  let stale = true;
  try { stale = r.turn !== jobTurn(dir, job).turn || r.report_sig !== report(dir)?.sig; } catch { /* Missing binding. */ }
  const results = r.results.map(({ command, exit_code, output_tail }) => ({ command, passed: exit_code === 0,
    ...(exit_code !== 0 ? { output_tail } : {}) }));
  return { turn: r.turn, report_sig: r.report_sig, state: r.state, stale, results,
    passed: results.filter((item) => item.passed).length, total: job.checks.length };
}
