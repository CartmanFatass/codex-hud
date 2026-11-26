/** Local tracker writes share land's lease and commit only their own ticket paths. */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { dirname, relative } from 'node:path';
import { writeFileAtomic } from '../cli/tickets.js';
import { worktreeGit } from '../collectors/worktrees.js';
import { takeLease } from '../roles/lease.js';
import { neutralizeFilters } from '../utils/git-safety.js';

type Edit = { ticket: string; path: string; before?: string; after: string; mode?: number };
export type TicketEdits = {
  read(path: string): string;
  stage(edit: Edit): Promise<void>;
};

export async function ticketCheckout(cwd: string) {
  const top = await worktreeGit(cwd, ['rev-parse', '--show-toplevel']).catch((error: Error) => {
    if (/^fatal: not a git repository/m.test(error.message)) return '';
    throw error;
  });
  return top ? fs.realpathSync(top.trimEnd()) : undefined;
}

export const ticketLease = (cwd: string, home: string) => ({ home, cwd, holder: `tickets-${randomUUID()}` });

export async function withTicketEdits<T>(cwd: string, home: string, op: string, plan: (edits: TicketEdits) => Promise<T>): Promise<T> {
  const root = await ticketCheckout(cwd);
  if (!root) return applyTicketEdits(cwd, false, op, plan);
  const lease = ticketLease(root, home);
  for (;;) {
    const result = await takeLease({ name: 'main-checkout', wait_s: 300 }, lease);
    if ('granted' in result && result.granted) break;
  }
  try { return await applyTicketEdits(root, true, op, plan); }
  finally { await takeLease({ name: 'main-checkout', release: true }, lease); }
}

export const ticketEditMarker = (id: string) => `HUD-Ticket-Edit: ${id}`;

/** The caller already holds the checkout lease, if this is a Git tracker. */
export async function applyTicketEdits<T>(root: string, checkout: boolean, op: string, plan: (edits: TicketEdits) => Promise<T>,
  receipt?: { id: string; beforeWrite: (result: T) => void }): Promise<T> {
  const filters = checkout ? await neutralizeFilters(worktreeGit, root) : [];
  const git = (args: string[]) => worktreeGit(root, [...filters, ...args]);
  const edits = new Map<string, Edit>();
  const result = await plan({
    read: path => edits.get(path)?.after ?? fs.readFileSync(path, 'utf8'),
    async stage(edit) {
      if (edit.before === edit.after) return;
      const prior = edits.get(edit.path);
      if (prior) { prior.after = edit.after; return; }
      if (checkout) {
        const path = relative(root, edit.path);
        const status = await git(['status', '--porcelain=v1', '--ignored', '--untracked-files=all', '--', path]);
        const hidden = (await git(['ls-files', '-v', '-z', '--', path])).split('\0').some(row => /^[a-zS] /.test(row));
        if (status || hidden) throw Error(`Ticket has uncommitted or hidden changes; resolve them before editing: ${path}`);
        if (edit.before === undefined) {
          // Check ignores before creating a file (status cannot report a path that doesn't exist yet).
          const ignored = await git(['--no-literal-pathspecs', 'check-ignore', '--', `./${path}`]).catch((error: NodeJS.ErrnoException) => {
            if (Number(error.code) === 1) return '';
            throw error;
          });
          if (ignored) throw Error(`Ticket path is ignored by Git: ${path}`);
        }
      }
      edits.set(edit.path, edit);
    },
  });
  const changes = [...edits.values()].filter(({ before, after }) => before !== after);
  if (!changes.length) return result;
  const written: Edit[] = [];
  const newPaths = changes.filter(({ before }) => before === undefined).map(({ path }) => relative(root, path));
  const head = () => git(['rev-parse', '--verify', '--quiet', 'HEAD']).catch((error: NodeJS.ErrnoException) => {
    if (Number(error.code) === 1) return '';
    throw error;
  });
  const base = checkout ? await head() : '';
  receipt?.beforeWrite(result);
  let adding = false;
  try {
    for (const edit of changes) {
      const { path, before, after, mode } = edit;
      if (before === undefined) {
        fs.mkdirSync(dirname(path), { recursive: true });
        fs.writeFileSync(path, after, { flag: 'wx' });
      } else {
        if (fs.readFileSync(path, 'utf8') !== before) throw Error(`Ticket changed during edit: ${path}`);
        writeFileAtomic(path, after, mode);
      }
      written.push(edit);
    }
    if (checkout) {
      if (newPaths.length) {
        await git(['add', '--intent-to-add', '--', ...newPaths]);
        adding = true;
      }
      await git(['commit', '--no-gpg-sign', '--only', '-m', `tickets: ${changes[0].ticket} ${op}`,
        ...(receipt ? ['-m', ticketEditMarker(receipt.id)] : []), '--', ...changes.map(({ path }) => relative(root, path))]);
    }
    return result;
  } catch (error) {
    // A failed write/commit must not leave our changes for a later land to trip over.
    // Do not undo a commit whose outcome is uncertain, or overwrite a concurrent hand edit.
    if (!checkout || await head() === base) {
      const restore = written.filter(({ path, after }) =>
        fs.lstatSync(path, { throwIfNoEntry: false })?.isFile() && fs.readFileSync(path, 'utf8') === after);
      for (const { path, before, mode } of restore) {
        if (before === undefined) fs.unlinkSync(path);
        else writeFileAtomic(path, before, mode);
      }
      if (adding) {
        const staged = restore.filter(({ before }) => before === undefined).map(({ path }) => relative(root, path));
        if (staged.length) await git(['reset', '-q', '--', ...staged]);
      }
    }
    throw error;
  }
}
