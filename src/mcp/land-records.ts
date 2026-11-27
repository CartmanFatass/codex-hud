/** Pre-fast-forward validation and post-fast-forward landing record update + HUD ticket-write sweep in main. */
import * as fs from 'node:fs';
import { join, relative } from 'node:path';
import { scanScratch } from '../cli/tickets.js';
import { worktreeGit } from '../collectors/worktrees.js';
import { isHandEditedInMain, sweepTicketWrites, type GitRunner } from '../tickets/commit.js';
import {
  legacyTicketPaths, parseTicketRef, readJsonTicketFeature, readTicketWrites, serializeTicketFeature, sha256Bytes,
  withTicketStoreLock, writeLegacyTicket, writeTicketFeature, type TicketFeatureDoc,
} from '../tickets/store.js';
import { readJsonFile } from '../utils/atomic-fs.js';
import type { Job } from './job-contracts.js';
import { landedTicket } from './local-tickets.js';
import { jobFiles } from './paths.js';

export interface LandRecordEntry {
  job: string;
  flow: string;
}

export interface LandRecordsOptions {
  locked?: boolean;
  expectedTip?: string;
}

function handEditError(rel: string) {
  return new Error(`Cannot record landing in ${rel}: uncommitted hand edit present; commit or revert it and retry hud_land`);
}

function readEntryTicketRef(home: string, entry: LandRecordEntry) {
  let job: Job;
  try {
    job = readJsonFile(join(home, 'jobs', entry.job, jobFiles.job)) as Job;
  } catch {
    return undefined;
  }
  return parseTicketRef(job.ticket);
}

function applyJsonLanding(doc: TicketFeatureDoc, number: number, entry: LandRecordEntry, replayBase: string, gates: number, at: string) {
  const ticket = doc.tickets.find(t => t.number === number);
  if (!ticket) return false;
  ticket.status = ticket.owner_try ? 'ready-for-human' : 'done';
  delete ticket.claimed_at;
  for (const item of ticket.acceptance) item.done = true;
  ticket.landing = { at, job: entry.job, flow: entry.flow, replay_base: replayBase, gates };
  ticket.updated_at = at;
  return true;
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
      const ref = readEntryTicketRef(home, entry);
      if (!ref) continue;

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
          if (applyJsonLanding(doc, ref.number, entry, replayBase, gates, at)) {
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
        landedTicket(original, ref.number, `Landed in this commit (replay base ${replayBase}); gate ${gates}/${gates} passed.`);
      } catch (error) {
        throw new Error(`Cannot record landing in ${legacyRel}: ${(error as Error).message}`, { cause: error });
      }
    }
  };
  if (opts?.locked) await run();
  else await withTicketStoreLock(realMain, run);
}

/**
 * Caller already holds `main-checkout` lease and just fast-forwarded `main` to the landed commit.
 * Takes `withTicketStoreLock(mainRoot)` (unless `opts.locked`), writes landing records into the
 * newest main-checkout ticket files (refusing on hand edits or unreadable JSON), and amends the
 * landed commit with only swept HUD-written files whose hash matches `ticket-writes.json`.
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
    for (const entry of entries) {
      const ref = readEntryTicketRef(home, entry);
      if (!ref) continue;

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
          if (!applyJsonLanding(doc, ref.number, entry, replayBase, gates, at)) continue;
          try { writeTicketFeature(realMain, home, doc); }
          catch (error) {
            throw new Error(`Cannot record landing in ${rel}: ${(error as Error).message}`, { cause: error });
          }
          writes[ref.feature] = sha256Bytes(fs.readFileSync(join(realMain, rel)));
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
      const updated = landedTicket(original, ref.number, `Landed in this commit (replay base ${replayBase}); gate ${gates}/${gates} passed.`);
      if (original === updated) continue;
      writeLegacyTicket(realMain, home, legacyRel, updated, legacySt.mode & 0o777);
      writes[legacyRel] = sha256Bytes(updated);
    }

    const swept = await sweepTicketWrites(realMain, home, git, { mode: 'amend', identity, expectedTip: opts?.expectedTip });
    return swept.committed ? swept.sha : undefined;
  };
  return opts?.locked ? run() : withTicketStoreLock(realMain, run);
}
