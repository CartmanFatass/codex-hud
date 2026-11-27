/** Pre-fast-forward validation and post-fast-forward landing record update + HUD ticket-write sweep in main. */
import * as fs from 'node:fs';
import { join, relative } from 'node:path';
import { scanScratch } from '../cli/tickets.js';
import { targetKey } from '../collectors/ticket-evidence.js';
import { ticketIds } from '../collectors/ticket-rollup.js';
import { worktreeGit } from '../collectors/worktrees.js';
import { isHandEditedInMain, sweepTicketWrites, type GitRunner } from '../tickets/commit.js';
import {
  legacyTicketPaths, parseTicketRef, readJsonTicketFeature, readTicketWrites, serializeTicketFeature, sha256Bytes,
  withTicketStoreLock, writeLegacyTicket, writeTicketFeature, type TicketFeatureDoc,
} from '../tickets/store.js';
import { readFileBounded, readJsonFile } from '../utils/atomic-fs.js';
import type { Job } from './job-contracts.js';
import type { LandFlow } from './land-state.js';
import { landedTicket, registeredTicketRepo, unfinishedAcceptance, unregisteredRepoReason } from './local-tickets.js';
import { jobFiles } from './paths.js';
import { readTicketQueue } from './ticket-queue-state.js';

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
    // Accept both a Not done heading and item 3 of the existing worker report template.
    const header = /^(?:(?:#{1,6}|[-*]|(\d+\.))\s+)?(?:\*\*)?(?:Not done|Anything in the brief you did not do, and why\.?)(?:\*\*)?(?::(?:\*\*)?\s*(.*))?$/i.exec(line);
    if (header) {
      open = true;
      numberedIndent = header[1] ? raw.length - raw.trimStart().length : undefined;
      if (header[2]) notes.push(header[2]);
    } else if (/^#{1,6}\s|^(?:\*\*)?(?:Blockers|Try|Assumed|Removes|Todo)(?:\*\*)?:/i.test(line) ||
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
    group.push({ row, ref, notes: [...notDoneNotes(dir), ...leadNotes(home, row, job, job.ticket)] });
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

const landingComment = (entry: LandRecordEntry, replayBase: string, gates: number) =>
  `Landed in ${entry.commit ?? 'this commit'} (replay base ${replayBase}); gate ${gates}/${gates} passed.`;

function applyJsonLanding(doc: TicketFeatureDoc, { row, ref, notes, commit }: LandRecordEntry, replayBase: string, gates: number, at: string) {
  const ticket = doc.tickets.find(t => t.number === ref.number);
  if (!ticket) return;
  const unfinished = unfinishedAcceptance(ticket.acceptance, notes);
  const skip = new Set(unfinished.map(({ id }) => id));
  ticket.status = ticket.owner_try ? 'ready-for-human' : unfinished.length ? 'ready-for-agent' : 'done';
  delete ticket.claimed_at;
  for (const item of ticket.acceptance) if (!skip.has(item.id)) item.done = true;
  ticket.landing = { at, job: row.job, flow: row.flow, replay_base: replayBase, gates, ...(commit && { commit }) };
  ticket.updated_at = at;
  return unfinished;
}

/**
 * Verify every landing ticket file can be read, updated, and swept before moving `main`.
 * Refuses with an error naming the file if a landing feature has an uncommitted hand edit,
 * malformed JSON, or would exceed the 64 KiB store limit.
 */
export async function checkLandingRecords(
  mainRoot: string,
  home: string,
  entries: readonly LandRecordEntry[],
  replayBase: string,
  gates: number,
  filters: string[],
  at: string,
  opts?: { locked?: boolean },
): Promise<void> {
  const realMain = fs.realpathSync(mainRoot);
  const git: GitRunner = (args) => worktreeGit(realMain, [...filters, ...args]);
  const run = async () => {
    const writes = readTicketWrites(home, realMain);
    const checkedFeatures = new Map<string, TicketFeatureDoc | null>();
    for (const entry of entries) {
      const { ref, notes } = entry;
      const rel = `.hud/tickets/${ref.feature}.json`;
      const full = join(realMain, rel);
      const st = fs.lstatSync(full, { throwIfNoEntry: false });
      if (st) {
        let doc = checkedFeatures.get(ref.feature);
        if (doc === undefined) {
          try {
            doc = readJsonTicketFeature(realMain, ref.feature) ?? null;
          } catch (error) {
            throw new Error(`Cannot record landing in ${rel}: ${(error as Error).message}`, { cause: error });
          }
          if (doc && !doc.mirror && await isHandEditedInMain(realMain, rel, writes[ref.feature], git)) {
            throw handEditError(rel);
          }
          checkedFeatures.set(ref.feature, doc);
        }
        if (doc) {
          if (doc.mirror) continue;
          if (applyJsonLanding(doc, entry, replayBase, gates, at)) {
            try { serializeTicketFeature(doc); }
            catch (error) {
              throw new Error(`Cannot record landing in ${rel}: ${(error as Error).message}`, { cause: error });
            }
          }
          continue;
        }
      } else if (await isHandEditedInMain(realMain, rel, writes[ref.feature], git)) {
        throw handEditError(rel);
      }

      // Legacy unmigrated Markdown ticket fallback.
      const matches = legacyTicketPaths(realMain, ref.feature).filter(t => t.number === ref.number);
      if (matches.length !== 1) continue;
      try { scanScratch(join(realMain, '.scratch'), true); } catch { continue; }
      const legacyFull = matches[0].path;
      const legacySt = fs.lstatSync(legacyFull, { throwIfNoEntry: false });
      if (!legacySt || !legacySt.isFile() || fs.realpathSync(legacyFull) !== legacyFull) continue;
      const legacyRel = relative(realMain, legacyFull);
      if (await isHandEditedInMain(realMain, legacyRel, writes[legacyRel], git)) {
        throw handEditError(legacyRel);
      }
      try {
        const original = fs.readFileSync(legacyFull, 'utf8');
        landedTicket(original, ref.number, landingComment(entry, replayBase, gates), notes);
      } catch (error) {
        throw new Error(`Cannot record landing in ${legacyRel}: ${(error as Error).message}`, { cause: error });
      }
    }
  };
  if (opts?.locked) await run();
  else await withTicketStoreLock(realMain, run);
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
    const writes = readTicketWrites(home, realMain);
    const pending: { row: LandFlow; path: string; items: ReturnType<typeof unfinishedAcceptance> }[] = [];
    for (const entry of entries) {
      const { row, ref, notes } = entry;
      const rel = `.hud/tickets/${ref.feature}.json`;
      const full = join(realMain, rel);
      const st = fs.lstatSync(full, { throwIfNoEntry: false });
      if (st) {
        let doc: TicketFeatureDoc | undefined;
        try {
          doc = readJsonTicketFeature(realMain, ref.feature);
        } catch (error) {
          throw new Error(`Cannot record landing in ${rel}: ${(error as Error).message}`, { cause: error });
        }
        if (doc) {
          if (doc.mirror) continue;
          if (await isHandEditedInMain(realMain, rel, writes[ref.feature], git)) {
            throw handEditError(rel);
          }
          const unfinished = applyJsonLanding(doc, entry, replayBase, gates, at);
          if (!unfinished) continue;
          try { writeTicketFeature(realMain, home, doc); }
          catch (error) {
            throw new Error(`Cannot record landing in ${rel}: ${(error as Error).message}`, { cause: error });
          }
          writes[ref.feature] = sha256Bytes(fs.readFileSync(full));
          if (unfinished.length) pending.push({ row, path: rel, items: unfinished });
          continue;
        }
      } else if (await isHandEditedInMain(realMain, rel, writes[ref.feature], git)) {
        throw handEditError(rel);
      }

      // Legacy unmigrated Markdown ticket fallback.
      const matches = legacyTicketPaths(realMain, ref.feature).filter(t => t.number === ref.number);
      if (matches.length !== 1) continue;
      try { scanScratch(join(realMain, '.scratch'), true); } catch { continue; }
      const legacyFull = matches[0].path;
      const legacySt = fs.lstatSync(legacyFull, { throwIfNoEntry: false });
      if (!legacySt || !legacySt.isFile() || fs.realpathSync(legacyFull) !== legacyFull) continue;
      const legacyRel = relative(realMain, legacyFull);
      if (await isHandEditedInMain(realMain, legacyRel, writes[legacyRel], git)) {
        throw handEditError(legacyRel);
      }
      const original = fs.readFileSync(legacyFull, 'utf8');
      const { body, unfinished } = landedTicket(original, ref.number, landingComment(entry, replayBase, gates), notes);
      if (original === body) continue;
      writeLegacyTicket(realMain, home, legacyRel, body, legacySt.mode & 0o777);
      writes[legacyRel] = sha256Bytes(body);
      if (unfinished.length) pending.push({ row, path: legacyRel, items: unfinished });
    }

    const swept = opts?.sweep === false ? undefined
      : await sweepTicketWrites(realMain, home, git, { mode: 'amend', identity, expectedTip: opts?.expectedTip });
    for (const { row, path, items } of pending) if (!swept || swept.paths.includes(path)) row.unfinished_acceptance = items;
    return swept?.committed ? swept.sha : undefined;
  };
  return opts?.locked ? run() : withTicketStoreLock(realMain, run);
}
