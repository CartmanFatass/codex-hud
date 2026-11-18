/**
 * What the owner does from the panel to a HUD job. An answer is the file `hud_respond` writes (`qa/qN.answer.md`, once), plus one
 * line in `$HUD_HOME/panel-actions.jsonl` so `hud watch` and the MCP `changes` tell the main session who answered. Append-only, private.
 */
import * as fs from 'node:fs';
import { join } from 'node:path';

export const PANEL_ACTIONS_FILE = 'panel-actions.jsonl';
const JOB = /^j[0-9a-f]{16}$/, QID = /^q\d+$/;
const MAX_READ = 256 * 1024;
interface AnswerRecord { at: string; type: 'answer'; job: string; qid: string; role: string | null; answer: string }
export type AnswerResult = { ok: true; written: boolean } | { ok: false; reason: string };

/** Write one answer for an open question, never over an existing one, then record it. `written: false` means it was already answered. */
export function answerJobQuestion(home: string, job: string, qid: string, answer: string, role: string | null = null): AnswerResult {
  if (!JOB.test(job) || !QID.test(qid)) return { ok: false, reason: 'invalid job or question' };
  const text = answer.trim();
  if (!text) return { ok: false, reason: 'empty answer' };
  const qa = join(home, 'jobs', job, 'qa');
  try {
    if (!fs.lstatSync(join(qa, `${qid}.md`)).isFile()) return { ok: false, reason: 'no such question' };
    fs.writeFileSync(join(qa, `${qid}.answer.md`), text, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return { ok: true, written: false };
    return { ok: false, reason: code === 'ENOENT' ? 'no such question' : String(code ?? error) };
  }
  const record: AnswerRecord = { at: new Date().toISOString(), type: 'answer', job, qid, role, answer: text.slice(0, 400) };
  try {
    // The answer stands even when its notice cannot be logged.
    const fd = fs.openSync(join(home, PANEL_ACTIONS_FILE), fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT |
      fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
    try { fs.appendFileSync(fd, JSON.stringify(record) + '\n'); } finally { fs.closeSync(fd); }
  } catch { /* Logged next time, or heard from the job's own state. */ }
  return { ok: true, written: true };
}

const oneLine = (s: string) => s.replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ').replace(/\s+/g, ' ').trim();
/** Lines for the answers made since this reader started, for the jobs it watches: `[imp@j…] ANSWERED q1 from panel: <answer>`. */
export class PanelActionLog {
  private offset: number;
  constructor(private home: string) {
    this.offset = this.size() ?? 0;
  }
  private size(): number | undefined {
    try {
      const st = fs.lstatSync(join(this.home, PANEL_ACTIONS_FILE));
      return st.isFile() ? st.size : undefined;
    } catch { return undefined; }
  }
  changes(jobs: ReadonlySet<string>): string[] {
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
      try {
        const r: AnswerRecord = JSON.parse(line);
        return r.type === 'answer' && JOB.test(r.job) && QID.test(r.qid) && typeof r.answer === 'string' && jobs.has(r.job)
          ? [`[${oneLine(`${r.role ?? 'job'}@${r.job}`)}] ANSWERED ${r.qid} from panel: ${oneLine(r.answer).slice(0, 200)}`] : [];
      } catch { return []; }
    });
  }
}
