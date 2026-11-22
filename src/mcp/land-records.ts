/** Amend the tested tip in the detached checkout with only the landed ticket update, before fast-forward. */
import * as fs from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { scanScratch, writeFileAtomic } from '../cli/tickets.js';
import { worktreeGit as git } from '../collectors/worktrees.js';
import { neutralizeFilters } from '../utils/git-safety.js';
import { readJsonFile } from '../utils/atomic-fs.js';
import type { Job } from './job-contracts.js';
import { jobFiles } from './paths.js';
import { landedTicket } from './local-tickets.js';

export async function recordLanding(root: string, dir: string, sha: string, gates: number, identity: string[]) {
  const job = readJsonFile(join(dir, jobFiles.job)) as Job;
  const ticket = typeof job.ticket === 'string' && /^([a-z0-9-]+)\/(\d+)$/.exec(job.ticket);
  if (!ticket) return;
  const issues = `.scratch/${ticket[1]}/issues`;
  const tracked = (await git(root, ['ls-files', '-z', '--', issues])).split('\0').filter(Boolean);
  const matches = tracked.filter(path => dirname(path) === issues && Number(/^(\d+)-.+\.md$/.exec(basename(path))?.[1]) === Number(ticket[2]));
  if (matches.length > 1) throw Error(`Ambiguous landing ticket: ${job.ticket}`);
  if (!matches.length) return;
  scanScratch(join(root, '.scratch'), true);
  const filters = await neutralizeFilters(git, root), path = matches[0], full = join(root, path), st = fs.lstatSync(full);
  if (!st.isFile() || fs.realpathSync(full) !== full || await git(root, [...filters, 'status', '--porcelain', '--', path]))
    throw Error(`Landing record is redirected or changed by the gate: ${path}`);
  const original = fs.readFileSync(full, 'utf8');
  const updated = landedTicket(original, Number(ticket[2]), `Landed ${sha}; gate ${gates}/${gates} passed.`);
  if (original === updated) return;
  writeFileAtomic(full, updated, st.mode & 0o777);
  await git(root, [...identity, ...filters, 'commit', '--amend', '--no-edit', '--no-gpg-sign', '--only', '--', path]);
  return (await git(root, ['rev-parse', 'HEAD'])).trim();
}
