/**
 * What the owner does from the panel to a HUD job. An answer is the file `hud_respond` writes (`qa/qN.answer.md`, once), plus one
 * line in `$HUD_HOME/panel-actions.jsonl` so `hud watch` and the MCP `changes` tell the main session who answered. Append-only, private.
 */
import * as fs from 'node:fs';
import { jobFiles } from '../mcp/paths.js';
import { getJobIndexCache } from '../roles/job-index-cache.js';
import { writePrivateFile } from '../utils/atomic-fs.js';
import { basename, join } from 'node:path';

export const PANEL_ACTIONS_FILE = 'panel-actions.jsonl';
export const JOB = /^j[0-9a-f]{16}$/;
const QID = /^q\d+$/;
const MAX_READ = 256 * 1024;
interface AnswerRecord { at: string; type: 'answer'; job: string; qid: string; role: string | null; answer: string }
type Intent = { type: 'retry'; job: string } | { type: 'land'; root: string; slices: string[] };

export function appendPanelAction(home: string, action: Intent | Omit<AnswerRecord, 'at'>): void {
  fs.mkdirSync(home, { mode: 0o700, recursive: true });
  const fd = fs.openSync(join(home, PANEL_ACTIONS_FILE), fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT |
    fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
  try { fs.appendFileSync(fd, JSON.stringify({ ...action, at: new Date().toISOString() }) + '\n'); } finally { fs.closeSync(fd); }
}

export type AnswerResult = { ok: true; written: boolean } | { ok: false; reason: string };

/** Write one answer for an open question, never over an existing one, then record it. `written: false` means it was already answered. */
export function answerJobQuestion(home: string, job: string, qid: string, answer: string, role: string | null = null): AnswerResult {
  if (!JOB.test(job) || !QID.test(qid)) return { ok: false, reason: 'invalid job or question' };
  const text = answer.trim();
  if (!text) return { ok: false, reason: 'empty answer' };
  const qa = join(home, 'jobs', job, jobFiles.qa);
  try {
    if (!fs.lstatSync(join(qa, `${qid}.md`)).isFile()) return { ok: false, reason: 'no such question' };
    writePrivateFile(join(qa, `${qid}.answer.md`), text, { exclusive: true, mkdir: false });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      getJobIndexCache(home).invalidateQa(job);
      return { ok: true, written: false };
    }
    return { ok: false, reason: code === 'ENOENT' ? 'no such question' : String(code ?? error) };
  }
  getJobIndexCache(home).invalidateQa(job);
  recordPanelAnswer(home, job, qid, text, role);
  return { ok: true, written: true };
}

export function recordPanelAnswer(home: string, job: string, qid: string, text: string, role: string | null) {
  try { appendPanelAction(home, { type: 'answer', job, qid, role, answer: text.slice(0, 400) }); }
  catch { /* The job's own answer receipt remains authoritative. */ }
}

const oneLine = (s: string) => s.replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ').replace(/\s+/g, ' ').trim();
/** Format only decisions for the reader's project or jobs; an intent is never a command. */
export function panelActionLine(line: string, owns: (id: string) => boolean, root?: string): string | undefined {
  try {
    const r: Intent | AnswerRecord = JSON.parse(line);
    if (r.type === 'land') {
      if ((root === undefined || root === r.root) && Array.isArray(r.slices) && r.slices.every(id => typeof id === 'string'))
        return oneLine(`Land requested from panel: ${basename(r.root)}: ${r.slices.join(', ')}`);
    } else if (JOB.test(r.job) && owns(r.job)) {
      if (r.type === 'retry') return `[${r.job}] Retry requested from panel`;
      if (r.type === 'answer' && QID.test(r.qid) && typeof r.answer === 'string')
        return `[${oneLine(`${r.role ?? 'job'}@${r.job}`)}] ANSWERED ${r.qid} from panel: ${oneLine(r.answer).slice(0, 200)}`;
    }
  } catch { /* Malformed record. */ }
}

/** Lines for the actions made since this reader started. */
export class PanelActionLog {
  offset: number; // Live reader cursor; carried across an MCP rebuild.
  constructor(private home: string) {
    this.offset = this.size() ?? 0;
  }
  private size(): number | undefined {
    try {
      const st = fs.lstatSync(join(this.home, PANEL_ACTIONS_FILE));
      return st.isFile() ? st.size : undefined;
    } catch { return undefined; }
  }
  changes(jobs: ReadonlySet<string>, root?: string): string[] {
    const size = this.size();
    if (size === undefined || size === this.offset) return [];
    if (size < this.offset || size - this.offset > MAX_READ) { this.offset = size; return []; }
    let text = '';
    try {
      const fd = fs.openSync(join(this.home, PANEL_ACTIONS_FILE), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try {
        const buffer = Buffer.alloc(size - this.offset);
        text = buffer.subarray(0, fs.readSync(fd, buffer, 0, buffer.length, this.offset)).toString('utf8');
      } finally { fs.closeSync(fd); }
    } catch { return []; }
    // A line still being appended waits for its newline.
    const end = text.lastIndexOf('\n') + 1;
    this.offset += Buffer.byteLength(text.slice(0, end));
    return text.slice(0, end).split('\n').flatMap((line) => {
      return panelActionLine(line, id => jobs.has(id), root) ?? [];
    });
  }
}
