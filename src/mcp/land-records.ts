/** Prepare only tracked landing records in the detached checkout, before publishing either commit. */
import * as fs from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { scanScratch, writeFileAtomic } from '../cli/tickets.js';
import { parseLedger, statePaths } from '../collectors/state-ledger.js';
import { worktreeGit as git } from '../collectors/worktrees.js';
import { readReportMeta } from '../roles/report-meta.js';
import { neutralizeFilters } from '../utils/git-safety.js';
import { landedTicket } from './local-tickets.js';

function ledgerField(value: unknown): string | undefined {
  return typeof value === 'string' && !/[·\p{Cc}\p{Zl}\p{Zp}]/u.test(value) ? value.trim() || undefined : undefined;
}

export async function recordLanding(root: string, dir: string, sha: string, gates: number, identity: string[]) {
  const job = JSON.parse(fs.readFileSync(join(dir, 'job.json'), 'utf8'));
  const ticket = typeof job.ticket === 'string' && /^([a-z0-9-]+)\/(\d+)$/.exec(job.ticket);
  const id = ledgerField(job.slice) ?? ledgerField(job.package);
  const summary = id && readReportMeta(dir)?.summary;
  if (!ticket && !summary) return;
  const files = statePaths(root).map(path => relative(root, path));
  const issues = ticket ? `.scratch/${ticket[1]}/issues` : '';
  const tracked = (await git(root, ['ls-files', '-z', '--', ...files, ...(issues ? [issues] : [])])).split('\0').filter(Boolean);
  const changes = new Map<string, (text: string) => string>();
  if (ticket) {
    const matches = tracked.filter(path => dirname(path) === issues && Number(/^(\d+)-.+\.md$/.exec(basename(path))?.[1]) === Number(ticket[2]));
    if (matches.length > 1) throw Error(`Ambiguous landing ticket: ${job.ticket}`);
    if (matches.length) {
      scanScratch(join(root, '.scratch'), true);
      changes.set(matches[0], body => landedTicket(body, Number(ticket[2]), `Landed ${sha}; gate ${gates}/${gates} passed.`));
    }
  }
  const ledger = files.find(path => tracked.includes(path));
  if (ledger && id && summary) changes.set(ledger, text => {
    const header = /^## Slices[ \t]*\r?\n(?:[ \t]*\r?\n|[ \t]*<!--[\s\S]*?-->[ \t]*\r?\n)*/m.exec(text);
    if (!header) return text; // A STATE file isn't necessarily a slice ledger.
    const tag = (ticket ? ticket[1].toUpperCase() : undefined) ?? parseLedger(text).find(row => row.id === id)?.milestone ??
      ledgerField(job.package)?.match(/^(.+)-\d+$/)?.[1]?.toUpperCase() ?? /^Milestone:[ \t]*([^·\r\n]+)/m.exec(text)?.[1].trim() ?? id;
    const pos = header.index + header[0].length;
    return text.slice(0, pos) + `- try · ${tag} · ${id} · ${summary} (${sha})\n` + text.slice(pos);
  });
  if (!changes.size) return;
  const filters = await neutralizeFilters(git, root), paths: string[] = [];
  for (const [path, transform] of changes) {
    const full = join(root, path), st = fs.lstatSync(full);
    if (!st.isFile() || fs.realpathSync(full) !== full || await git(root, [...filters, 'status', '--porcelain', '--', path]))
      throw Error(`Landing record is redirected or changed by the gate: ${path}`);
    const original = fs.readFileSync(full, 'utf8'), updated = transform(original);
    if (original === updated) continue;
    writeFileAtomic(full, updated, st.mode & 0o777); paths.push(path);
  }
  if (paths.length) {
    await git(root, [...identity, ...filters, 'commit', '--no-gpg-sign', '--only', '-m', `Record landing ${sha.slice(0, 12)}`, '--', ...paths]);
    return (await git(root, ['rev-parse', 'HEAD'])).trim();
  }
}
