import fs from 'node:fs';
import { dirname, join } from 'node:path';

const AT = '2026-11-12T10:00:00.000Z';
export const ticketRecord = (number, fields = {}) => ({
  number, title: `Synthetic ticket ${number}`, status: 'ready-for-agent', owner_try: false,
  live_try: 'none', approved_removals: [], blocked_by: [], what: 'Implement the synthetic feature.',
  acceptance: [], comments: [], created_at: AT, updated_at: AT, ...fields,
});

export function putTicketFeature(root, feature, tickets, fields = {}) {
  const path = join(root, '.hud', 'tickets', `${feature}.json`);
  fs.mkdirSync(dirname(path), { recursive: true });
  fs.writeFileSync(path, JSON.stringify({ version: 1, feature, tickets, ...fields }));
  return path;
}
