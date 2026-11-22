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
  let description = id && readReportMeta(dir)?.summary;
  if (!ticket && !description) return;
  const files = statePaths(root).map(path => relative(root, path));
  const issues = ticket ? `.scratch/${ticket[1]}/issues` : '';
  const tracked = (await git(root, ['ls-files', '-z', '--', ...files, ...(issues ? [issues] : [])])).split('\0').filter(Boolean);
  const filters = await neutralizeFilters(git, root), paths: string[] = [];
  async function update(path: string, transform: (text: string) => string) {
    const full = join(root, path), st = fs.lstatSync(full);
    if (!st.isFile() || fs.realpathSync(full) !== full || await git(root, [...filters, 'status', '--porcelain', '--', path]))
      throw Error(`Landing record is redirected or changed by the gate: ${path}`);
    const original = fs.readFileSync(full, 'utf8'), updated = transform(original);
    if (original === updated) return;
    writeFileAtomic(full, updated, st.mode & 0o777); paths.push(path);
  }
  if (ticket) {
    const matches = tracked.filter(path => dirname(path) === issues && Number(/^(\d+)-.+\.md$/.exec(basename(path))?.[1]) === Number(ticket[2]));
    if (matches.length > 1) throw Error(`Ambiguous landing ticket: ${job.ticket}`);
    if (matches.length) {
      scanScratch(join(root, '.scratch'), true);
      await update(matches[0], body => {
        const heading = /^# (\d+): ([^\r\n]+)\r?$/m.exec(body);
        if (heading && Number(heading[1]) === Number(ticket[2])) description = heading[2].trim() || description;
        return landedTicket(body, Number(ticket[2]), `Landed ${sha}; gate ${gates}/${gates} passed.`);
      });
    }
  }
  const ledger = files.find(path => tracked.includes(path));
  if (ledger && id && description) await update(ledger, text => {
    const header = /^## Slices[ \t]*\r?\n(?:[ \t]*\r?\n|[ \t]*<!--[\s\S]*?-->[ \t]*\r?\n)*/m.exec(text);
    if (!header) return text; // A STATE file isn't necessarily a slice ledger.
    const tag = (ticket ? ticket[1].toUpperCase() : undefined) ?? parseLedger(text).find(row => row.id === id)?.milestone ??
      ledgerField(job.package)?.match(/^(.+)-\d+$/)?.[1]?.toUpperCase() ?? /^Milestone:[ \t]*([^·\r\n]+)/m.exec(text)?.[1].trim() ?? id;
    const pos = header.index + header[0].length;
    return text.slice(0, pos) + `- try · ${tag} · ${id} · ${description} (${sha.slice(0, 8)})\n` + text.slice(pos);
  });
  if (paths.length) {
    await git(root, [...identity, ...filters, 'commit', '--no-gpg-sign', '--only', '-m', `Record landing ${sha.slice(0, 12)}`, '--', ...paths]);
    return (await git(root, ['rev-parse', 'HEAD'])).trim();
  }
}
