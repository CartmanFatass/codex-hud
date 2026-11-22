/** The heading of the ticket file a job works on (`.scratch/<feature>/issues/NN-*.md`), for Home's job rows. Read-only, bounded and cached. */
import * as fs from 'node:fs';
import { join } from 'node:path';
import { readFileBounded } from '../utils/atomic-fs.js';

const TTL_MS = 30_000, MAX_ENTRIES = 200, HEAD_BYTES = 512, TITLE_CHARS = 120;
const cache = new Map<string, { at: number; title: string | undefined }>();

/** `feature/NN`, or a package with a bare number (`pkg` + `4`), as the feature directory and ticket number. */
function ticketId(ticket: string, pkg: string): RegExpExecArray | null {
  return /^([a-z0-9]+(?:-[a-z0-9]+)*)\/(\d+)$/.exec(/^\d+$/.test(ticket) && pkg ? `${pkg.toLowerCase()}/${ticket}` : ticket);
}

/** The ticket's first heading with its `NN:` prefix off; `undefined` when the job has no ticket file or it cannot be read. */
export function ticketTitle(root: string | null | undefined, ticket: string | null | undefined, pkg = '', now = Date.now()): string | undefined {
  const id = root && ticket ? ticketId(ticket.trim(), pkg.trim()) : null;
  if (!root || !id) return undefined;
  const key = `${root}\0${id[0]}`, hit = cache.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.title;
  let title: string | undefined;
  try {
    const dir = join(fs.realpathSync(root), '.scratch', id[1], 'issues');
    if (fs.realpathSync(dir) === dir) {
      const files = fs.readdirSync(dir).filter((name) => /^\d+-.+\.md$/.test(name) && Number(name.split('-')[0]) === Number(id[2]));
      const head = files.length === 1 ? readFileBounded(join(dir, files[0]), HEAD_BYTES).bytes.toString('utf8') : '';
      title = /^#{1,6}[ \t]+(?:\d+[ \t]*[:.-][ \t]*)?(\S.*)$/m.exec(head)?.[1]?.trim().slice(0, TITLE_CHARS) || undefined;
    }
  } catch { /* A missing, unsafe or unreadable ticket is no title: Home falls back to the brief heading. */ }
  cache.delete(key);
  cache.set(key, { at: now, title });
  if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  return title;
}
