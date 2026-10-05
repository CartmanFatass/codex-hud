/**
 * The goal set in Codex for a session (`/goal`): its objective and status,
 * from Codex's own database, `$CODEX_HOME/goals_1.sqlite`, table
 * `thread_goals`. The recap is told it as a fact of the main session, where
 * otherwise it has only the first request to go on.
 *
 * Optional, and never in the way. Codex's schema is its own and changes
 * without notice, so the file is opened read only and immutable (no lock
 * taken, nothing written), at most once a minute; no file, a Node without
 * `node:sqlite`, another schema or any other failure reads as no goal.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sqliteDatabase } from './daemon-binding.js';

export interface CodexGoal {
  objective: string;
  /** `active`, `paused`, `blocked`, `complete` and the like, as Codex has it. */
  status: string;
}

const READ_EVERY_MS = 60_000;
const OBJECTIVE_CHARS = 500;
let memo: { file: string; thread: string; at: number; goal: CodexGoal | null } | undefined;

export function codexGoal(codexHome: string, threadId: string, now: number = Date.now()): CodexGoal | null {
  if (!threadId) return null;
  const file = path.join(codexHome, 'goals_1.sqlite');
  if (memo && memo.file === file && memo.thread === threadId && now - memo.at < READ_EVERY_MS) return memo.goal;
  let goal: CodexGoal | null = null;
  try {
    const Database = sqliteDatabase();
    if (Database && fs.existsSync(file)) {
      const db = new Database(`${pathToFileURL(file).href}?mode=ro&immutable=1`, { readOnly: true, timeout: 200 });
      try {
        const row = db.prepare('SELECT objective, status FROM thread_goals WHERE thread_id = ?').all(threadId)[0];
        const objective = typeof row?.objective === 'string' ? row.objective.replace(/\s+/g, ' ').trim() : '';
        if (objective) goal = { objective: objective.slice(0, OBJECTIVE_CHARS), status: typeof row?.status === 'string' ? row.status : '' };
      } finally { db.close(); }
    }
  } catch { goal = null; }
  memo = { file, thread: threadId, at: now, goal };
  return goal;
}
