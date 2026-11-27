import { isTicketQueueId, TICKET_QUEUE_STATES, type TicketQueue } from '../mcp/ticket-queue-state.js';
import type { HeaderPass } from '../workflows/header-scan.js';

/** Hide replaced attempts without rewriting receipts from older HUD versions. */
export function displayTicketQueues(pass: HeaderPass): Map<string, TicketQueue> {
  const queues = new Map<string, TicketQueue>();
  const newest = new Map<string, number>();
  const key = (q: TicketQueue) => `${q.project_root ?? q.root}\0${q.feature}`;
  for (const file of pass.files) {
    if (!file.endsWith('.json') || !isTicketQueueId(file.slice(0, -5))) continue;
    try {
      const q = pass.header<TicketQueue>(file);
      if (!q || `${q.flow}.json` !== file || !TICKET_QUEUE_STATES.includes(q.state)) continue;
      queues.set(file, q);
      if (q.unattended || !(q.project_root ?? q.root) || !q.feature) continue;
      const created = Date.parse(q.created_at);
      const feature = key(q);
      if (created > (newest.get(feature) ?? -Infinity)) newest.set(feature, created);
    } catch { /* An unreadable receipt supplies no evidence of a replacement. */ }
  }
  for (const [file, q] of queues) {
    if (q.state === 'superseded' || q.superseded_by ||
        (!q.unattended && (q.state === 'paused' || q.state === 'failed') &&
          Date.parse(q.created_at) < (newest.get(key(q)) ?? -Infinity))) {
      queues.delete(file);
    }
  }
  return queues;
}
