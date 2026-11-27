/** Pre-fast-forward validation and post-fast-forward landing record update + HUD ticket-write sweep in main. */
import * as fs from 'node:fs';
import { join } from 'node:path';
import { targetKey } from '../collectors/ticket-evidence.js';
import { ticketIds } from '../collectors/ticket-rollup.js';
import { worktreeGit } from '../collectors/worktrees.js';
import { planTicketEdit } from '../tickets/archive.js';
import { checkArchiveFiles, commitArchiveFiles, isHandEditedInMain, type GitRunner } from '../tickets/commit.js';
import {
  parseTicketRef, readTicketWrites, storedTicket, TicketFeatureFull, ticketRef, ticketWriteRelPath,
  withTicketStoreLock, type TicketFeatureDoc,
} from '../tickets/store.js';
import { readFileBounded, readJsonFile } from '../utils/atomic-fs.js';
import type { Job } from './job-contracts.js';
import { landReportJob, type LandFlow } from './land-state.js';
import { withObjectiveLock, type ObjectiveFileInput } from './local-objectives.js';
import { registeredTicketRepo, unfinishedAcceptance, unregisteredRepoReason } from './local-tickets.js';
import { jobFiles } from './paths.js';
import { REPORT_MARKDOWN_HEADING_PREFIX } from './report-notes.js';
import { readTicketQueue } from './ticket-queue-state.js';

const notDoneHeader = new RegExp(
  `^(?:${REPORT_MARKDOWN_HEADING_PREFIX}|[-*][ \\t]+|(\\d+\\.)[ \\t]+)?(?:\\*\\*)?(?:Not done|Anything in the brief you did not do, and why\\.?)(?:\\*\\*)?(?::(?:\\*\\*)?[ \\t]*(.*))?$`,
  'i',
);

function notDoneNotes(dir: string): string[] {
  let report: string;
  try {
    const { bytes, truncated } = readFileBounded(join(dir, jobFiles.report), 1024 * 1024);
    if (truncated) throw Error('Landing report exceeds 1 MiB');
    report = bytes.toString('utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const notes: string[] = [];
  let open = false, numberedIndent: number | undefined;
  for (const raw of report.split(/\r?\n/)) {
    const line = raw.trim();
    // Accept Not done headings (including numbered Markdown headings) and numbered report items.
    const header = notDoneHeader.exec(line);
    if (header) {
      open = true;
      numberedIndent = header[1] ? raw.length - raw.trimStart().length : undefined;
      if (header[2]) notes.push(header[2]);
    } else if (/^#{1,6}\s|^(?:[-*]\s+)?(?:\*\*)?(?:Blockers|Try|Assumed|Removes|Todo)(?:\*\*)?:/i.test(line) ||
               (numberedIndent !== undefined && /^\d+\.\s/.test(line) && raw.length - raw.trimStart().length <= numberedIndent)) {
      open = false;
    } else if (open && line) {
      notes.push(line);
    }
  }
  return notes;
}

function leadNotes(home: string, flow: LandFlow, job: Job, ticket: string): string[] {
  const queueId = flow.ticket_queue ?? job.ticket_queue;
  const queue = queueId && readTicketQueue(home, queueId);
  if (!queue) return [];
  const sources = new Set(queue.decisions?.filter(d => d.worker_job === job.job).map(d => `lead (${d.job})`));
  const key = targetKey(ticket);
  return (queue.todo ?? []).flatMap(todo => {
    if (todo.kind !== 'lead') return [];
    // An explicit `ticket:` prefix takes precedence over references in the rationale.
    const prefix = /^([a-z0-9-]+\/\d+):\s*/i.exec(todo.text);
    if (prefix) return targetKey(prefix[1]) === key ? [todo.text.slice(prefix[0].length)] : [];
    if (sources.has(todo.source)) return [todo.text];
    const refs = new Set(ticketIds(todo.text));
    return (refs.size === 1 ? refs.has(key) : !refs.size && queue.tickets.length === 1) ? [todo.text] : [];
  });
}

type LandRecordEntry = { row: LandFlow; ref: NonNullable<ReturnType<typeof parseTicketRef>>; notes: string[]; commit?: string };

/** Read report evidence before fast-forward. Always sweep target writes, but group records by tracker. */
export function prepareLandRecords(mainRoot: string, home: string, members: readonly LandFlow[]) {
  const main = fs.realpathSync(mainRoot);
  const groups = new Map<string, LandRecordEntry[]>([[main, []]]);
  for (const row of members) {
    const dir = join(home, 'jobs', row.job);
    let job: Job;
    try { job = readJsonFile(join(dir, jobFiles.job)) as Job; } catch { continue; }
    if (!job.ticket) continue;
    const ref = parseTicketRef(job.ticket);
    if (!ref) continue;
    const tracker = job.ticket_root ?? main;
    let group = groups.get(tracker);
    if (!group) {
      if (registeredTicketRepo(home, tracker) !== tracker) throw Error(unregisteredRepoReason(tracker));
      groups.set(tracker, group = []);
    }
    group.push({ row, ref, notes: [...notDoneNotes(join(home, 'jobs', landReportJob(row))), ...leadNotes(home, row, job, job.ticket)] });
  }
  return groups;
}

export interface LandRecordsOptions {
  locked?: boolean;
  expectedTip?: string;
  sweep?: false;
}

function handEditError(rel: string) {
  return new Error(`Cannot record landing in ${rel}: uncommitted hand edit present; commit or revert it and retry hud_land`);
}

function partialLandingComment(row: LandFlow, unfinished: readonly { id: number; text: string }[]): string {
  const items = unfinished.map(({ id, text }) => `#${id} ${text.replace(/\s+/g, ' ').trim()}`).join('; ');
  return `Partial landing (${row.flow}, job ${row.job}): acceptance left unticked: ${items}`;
}

function hasPartialLandingComment(comments: readonly { author: string; text: string }[], row: LandFlow, text: string): boolean {
  return comments.some(c =>
    c.author === 'land' && (c.text === text || c.text.startsWith(`Partial landing (${row.flow},`) || c.text.includes(`job ${row.job}):`)),
  );
}

function applyJsonLanding(doc: TicketFeatureDoc, { row, ref, notes, commit }: LandRecordEntry, replayBase: string, gates: number, at: string) {
  const ticket = doc.tickets.find(t => t.number === ref.number);
  if (!ticket) return;
  const unfinished = unfinishedAcceptance(ticket.acceptance, notes);
  const skip = new Set(unfinished.map(({ id }) => id));
  ticket.status = ticket.owner_try ? 'ready-for-human' : unfinished.length ? 'ready-for-agent' : 'done';
  delete ticket.claimed_at;
  for (const item of ticket.acceptance) if (!skip.has(item.id)) item.done = true;
  if (unfinished.length) {
    const comment = partialLandingComment(row, unfinished);
    if (!hasPartialLandingComment(ticket.comments, row, comment)) {
      ticket.comments.push({ at, author: 'land', text: comment });
    }
  }
  ticket.landing = { at, job: row.job, flow: row.flow, replay_base: replayBase, gates, ...(commit && { commit }) };
  ticket.updated_at = at;
  return unfinished;
}

async function planLanding(
  main: string,
  home: string,
  entries: readonly LandRecordEntry[],
  replayBase: string,
  gates: number,
  at: string,
  git: GitRunner,
  opts?: { objectiveFile?: ObjectiveFileInput | (() => ObjectiveFileInput); allowArchive?: boolean },
) {
  const writes = readTicketWrites(home, main);
  const docs = new Map<string, TicketFeatureDoc>();
  const checked = new Set<string>();
  const pending: { row: LandFlow; ticket: string; items: ReturnType<typeof unfinishedAcceptance> }[] = [];
  const check = async (key: string) => {
    if (checked.has(key)) return;
    const rel = ticketWriteRelPath(key);
    if (await isHandEditedInMain(main, rel, writes[key], git)) throw handEditError(rel);
    checked.add(key);
  };
  for (const entry of entries) {
    const { ref } = entry;
    let stored;
    try { stored = storedTicket(main, ticketRef(ref.feature, ref.number)); }
    catch (error) {
      throw new Error(`Cannot record landing in ${ticketWriteRelPath(ref.feature)}: ${(error as Error).message}`, { cause: error });
    }
    if (stored?.doc.mirror) continue;
    const feature = stored?.doc.feature ?? ref.feature;
    await check(feature);
    if (!stored?.record) continue;
    const doc = docs.get(feature) ?? stored.doc;
    const unfinished = applyJsonLanding(doc, entry, replayBase, gates, at)!;
    docs.set(feature, doc);
    if (unfinished.length) pending.push({ row: entry.row, ticket: ticketRef(feature, ref.number), items: unfinished });
  }
  try { return { ...planTicketEdit(main, home, [...docs.values()], undefined, opts), pending }; }
  catch (error) {
    if (error instanceof TicketFeatureFull) {
      throw new Error(`Cannot record landing in ${ticketWriteRelPath(error.feature)}: ${error.message}`, { cause: error });
    }
    throw error;
  }
}

/** Verify that all landing records (including any archive write set) fit and can be swept before moving main. */
export async function checkLandingRecords(
  mainRoot: string,
  home: string,
  entries: readonly LandRecordEntry[],
  replayBase: string,
  gates: number,
  filters: string[],
  at: string,
  opts?: { locked?: boolean; objectiveFile?: ObjectiveFileInput | (() => ObjectiveFileInput); sweep?: false },
): Promise<{ archived: boolean; objectiveEdited: boolean }> {
  const realMain = fs.realpathSync(mainRoot);
  const git: GitRunner = (args) => worktreeGit(realMain, [...filters, ...args]);
  const run = async () => {
    const plan = await planLanding(realMain, home, entries, replayBase, gates, at, git, {
      objectiveFile: opts?.objectiveFile,
      allowArchive: opts?.sweep !== false,
    });
    if (plan.archived.length) await checkArchiveFiles(realMain, home, plan.files, git, handEditError);
    return { archived: plan.moved.size > 0, objectiveEdited: plan.objectiveEdited };
  };
  return opts?.locked ? run() : withTicketStoreLock(realMain, () => withObjectiveLock(realMain, run));
}

/**
 * Write landing records after fast-forward. For the target checkout (under its `main-checkout`
 * lease), amend the landed commit with digest-matched HUD writes. External tracker writes are
 * staged in the ticket store only: no Git ref in that checkout is moved.
 */
export async function recordLanding(
  mainRoot: string,
  home: string,
  entries: readonly LandRecordEntry[],
  replayBase: string,
  gates: number,
  identity: string[],
  filters: string[],
  at: string,
  opts?: LandRecordsOptions,
): Promise<string | undefined> {
  const realMain = fs.realpathSync(mainRoot);
  const git: GitRunner = (args) => worktreeGit(realMain, [...filters, ...args]);
  const run = async () => {
    const { files, moved, publish, pending } = await planLanding(realMain, home, entries, replayBase, gates, at, git, {
      allowArchive: opts?.sweep !== false,
    });
    const swept = opts?.sweep === false
      ? (publish(), undefined)
      : await commitArchiveFiles(realMain, home, files, git, {
          mode: 'amend',
          identity,
          expectedTip: opts?.expectedTip,
          sweepPending: true,
          handEditError,
        });
    for (const { row, ticket, items } of pending) {
      const path = ticketWriteRelPath(parseTicketRef(moved.get(ticket) ?? ticket)!.feature);
      if (!swept || swept.paths.includes(path)) row.unfinished_acceptance = items;
    }
    return swept?.committed ? swept.sha : undefined;
  };
  return opts?.locked ? run() : withTicketStoreLock(realMain, () => withObjectiveLock(realMain, run));
}
