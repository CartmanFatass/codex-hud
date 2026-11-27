/** Post-fast-forward landing record update and HUD ticket-write sweep in main, under the tickets lock. */
import * as fs from 'node:fs';
import { join, relative } from 'node:path';
import { scanScratch } from '../cli/tickets.js';
import { worktreeGit } from '../collectors/worktrees.js';
import { isHandEditedInMain, sweepTicketWrites, type GitRunner } from '../tickets/commit.js';
import {
  legacyTicketPaths, parseTicketRef, readJsonTicketFeature, readTicketWrites, sha256Bytes,
  withTicketStoreLock, writeLegacyTicket, writeTicketFeature,
} from '../tickets/store.js';
import { readJsonFile } from '../utils/atomic-fs.js';
import type { Job } from './job-contracts.js';
import { landedTicket } from './local-tickets.js';
import { jobFiles } from './paths.js';

export interface LandRecordEntry {
  job: string;
  flow: string;
}

/**
 * Caller already holds `main-checkout` lease and just fast-forwarded `main` to the landed commit.
 * Takes `withTicketStoreLock(mainRoot)` (lock order: main-checkout -> tickets), writes landing records
 * into the newest main-checkout ticket files (skipping any file with an owner hand edit), and amends
 * the landed commit with only swept HUD-written files whose hash matches `ticket-writes.json`.
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
): Promise<string | undefined> {
  const realMain = fs.realpathSync(mainRoot);
  const git: GitRunner = (args) => worktreeGit(realMain, [...filters, ...args]);
  return withTicketStoreLock(realMain, async () => {
    const writes = readTicketWrites(home, realMain);
    for (const entry of entries) {
      let job: Job;
      try {
        job = readJsonFile(join(home, 'jobs', entry.job, jobFiles.job)) as Job;
      } catch {
        continue;
      }
      const ref = parseTicketRef(job.ticket);
      if (!ref) continue;

      const doc = readJsonTicketFeature(realMain, ref.feature);
      if (doc) {
        if (doc.mirror) continue;
        const rel = `.hud/tickets/${ref.feature}.json`;
        if (await isHandEditedInMain(realMain, rel, writes[ref.feature], git)) continue;
        const ticket = doc.tickets.find(t => t.number === ref.number);
        if (!ticket) continue;
        ticket.status = ticket.owner_try ? 'ready-for-human' : 'done';
        delete ticket.claimed_at;
        for (const item of ticket.acceptance) item.done = true;
        ticket.landing = { at, job: entry.job, flow: entry.flow, replay_base: replayBase, gates };
        ticket.updated_at = at;
        writeTicketFeature(realMain, home, doc);
        writes[ref.feature] = sha256Bytes(fs.readFileSync(join(realMain, rel)));
        continue;
      }

      // Legacy unmigrated Markdown ticket fallback.
      const matches = legacyTicketPaths(realMain, ref.feature).filter(t => t.number === ref.number);
      if (matches.length !== 1) continue;
      try { scanScratch(join(realMain, '.scratch'), true); } catch { continue; }
      const full = matches[0].path;
      const st = fs.lstatSync(full, { throwIfNoEntry: false });
      if (!st || !st.isFile() || fs.realpathSync(full) !== full) continue;
      const rel = relative(realMain, full);
      if (await isHandEditedInMain(realMain, rel, writes[rel], git)) continue;
      const original = fs.readFileSync(full, 'utf8');
      const updated = landedTicket(original, ref.number, `Landed in this commit (replay base ${replayBase}); gate ${gates}/${gates} passed.`);
      if (original === updated) continue;
      writeLegacyTicket(realMain, home, rel, updated, st.mode & 0o777);
      writes[rel] = sha256Bytes(updated);
    }

    const swept = await sweepTicketWrites(realMain, home, git, { mode: 'amend', identity });
    return swept.committed ? swept.sha : undefined;
  });
}
