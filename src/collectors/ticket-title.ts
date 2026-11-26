/** Ticket headlines for job rows, using the same collector cache as Project. */
import { scanTicketStore } from './ticket-store.js';

function titleFrom(scan: typeof scanTicketStore, root: string | null | undefined, ticket: string | null | undefined, pkg = '') {
  const id = ticket?.trim();
  if (!root || !id || (!/^[a-z0-9-]+\/\d+$/i.test(id) && !(pkg && /^\d+$/.test(id)))) return;
  return scan(root).lookup(id, pkg.trim())?.title.slice(0, 120);
}

export function ticketTitle(root: string | null | undefined, ticket: string | null | undefined, pkg = '') {
  return titleFrom(scanTicketStore, root, ticket, pkg);
}

/** Reuse a single lookup per project within a multi-job collection. */
export function ticketTitleReader() {
  const scans = new Map<string, ReturnType<typeof scanTicketStore>>();
  return (root: string | null | undefined, ticket: string | null | undefined, pkg = '') => titleFrom((root) => {
    let scan = scans.get(root);
    if (!scan) { scan = scanTicketStore(root); scans.set(root, scan); }
    return scan;
  }, root, ticket, pkg);
}
