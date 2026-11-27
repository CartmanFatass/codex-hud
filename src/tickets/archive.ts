import { planFeatureLinks, withObjectiveLock } from '../mcp/local-objectives.js';
import { objectivePath, readObjectives } from '../collectors/objectives.js';
import { writeFileAtomic } from '../utils/atomic-fs.js';
import {
  isTicketArchive, OBJECTIVE_WRITE_KEY, parseTicketRef, prepareTicketWrites, readJsonTicketFeature, readTicketFeature,
  serializeTicketFeature, TicketFeatureFull, ticketFeatureSlugs, ticketRef, validateTicketFeature,
  type TicketFeatureDoc, type TicketRecord, type TicketWrite,
} from './store.js';

const closed = (ticket: TicketRecord) => ticket.status === 'done' || ticket.status === 'wontfix';
function fits(doc: TicketFeatureDoc): boolean {
  try { serializeTicketFeature(doc); return true; }
  catch (error) { if (error instanceof TicketFeatureFull) return false; throw error; }
}

/** Plan before publishing anything, including indirect ref rewrites and the Features line. */
export function planTicketEdit(
  root: string, home: string, edited: readonly TicketFeatureDoc[], links: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
) {
  let docs = new Map(edited.map(doc => [doc.feature, validateTicketFeature(doc)]));
  const changed = new Set(docs.keys());
  const overfull = new Set([...docs.values()].filter(doc => !fits(doc)).map(doc => doc.feature));
  const moved = new Map<string, string>();
  const archives = new Map<string, Set<string>>();
  if (overfull.size) {
    const legacy = new Set<string>();
    for (const slug of ticketFeatureSlugs(root)) if (!docs.has(slug)) {
      const json = readJsonTicketFeature(root, slug), doc = json ?? readTicketFeature(root, slug);
      if (!doc) continue;
      docs.set(slug, doc);
      if (!json) legacy.add(slug);
    }
    const objectives = readObjectives(root)?.objectives ?? [];
    for (const feature of overfull) {
      const source = docs.get(feature)!;
      if (source.mirror) throw new TicketFeatureFull(feature);
      const linked = objectives.filter(o => o.features.includes(feature) || links.get(o.id)?.has(feature)).map(o => o.id);
      const defaultObjective = source.objective ?? (linked.length === 1 ? linked[0] : undefined);
      const highest = source.tickets.at(-1)?.number;
      for (const ticket of source.tickets) {
        if (fits(docs.get(feature)!)) break;
        if (!closed(ticket) || ticket.number === highest) continue;
        const ref = ticketRef(feature, ticket.number);
        const namesTicket = (value: string) => {
          const parsed = parseTicketRef(value)!;
          return value === ref || (parsed.number === ticket.number && isTicketArchive(parsed.feature, feature) &&
            !docs.get(parsed.feature)?.tickets.some(t => t.number === parsed.number));
        };
        // Legacy and GitHub features are read-only. Leave their references valid in place.
        if ([...docs.values()].some(doc => doc.tickets.some(record =>
          ((!closed(record) || legacy.has(doc.feature) || doc.mirror) && record.blocked_by.some(namesTicket)) ||
          ((legacy.has(doc.feature) || doc.mirror) && record.repairs?.some(namesTicket))))) continue;
        const current = docs.get(feature)!;
        const record = current.tickets.find(t => t.number === ticket.number)!;
        for (let n = 1; ; n++) {
          const slug = `${feature}-done${n === 1 ? '' : `-${n}`}`;
          const existing = docs.get(slug);
          if (existing && (legacy.has(slug) || existing.mirror || existing.tickets.some(t => t.number === ticket.number) ||
            (existing.spec_path && existing.spec_path !== source.spec_path) ||
            (existing.objective && existing.objective !== defaultObjective))) continue;
          const dest: TicketFeatureDoc = existing ?? { version: 1, feature: slug, objective: source.objective, spec_path: source.spec_path, tickets: [] };
          const trial = new Map(docs);
          trial.set(feature, { ...current, tickets: current.tickets.filter(t => t !== record) });
          const archived = !record.objective && source.objective && dest.objective !== source.objective
            ? { ...record, objective: source.objective } : record;
          trial.set(slug, { ...dest, spec_path: dest.spec_path ?? source.spec_path, tickets: [...dest.tickets, archived] });
          const touched = new Set([feature, slug]);
          for (const [key, doc] of trial) {
            if (legacy.has(key) || doc.mirror) continue;
            const rewrite = (refs: string[]) => refs.some(namesTicket) ? refs.map(value => namesTicket(value) ? ticketRef(slug, ticket.number) : value) : refs;
            const tickets = doc.tickets.map(t => {
              const blocked_by = rewrite(t.blocked_by), repairs = t.repairs && rewrite(t.repairs);
              return blocked_by === t.blocked_by && repairs === t.repairs ? t : { ...t, blocked_by, repairs };
            });
            if (tickets.some((t, i) => t !== doc.tickets[i])) { trial.set(key, { ...doc, tickets }); touched.add(key); }
          }
          if (!fits(trial.get(slug)!)) {
            if (existing) continue;
            break; // This ticket cannot fit even in an empty shard.
          }
          if ([...touched].some(key => key !== feature && key !== slug && !overfull.has(key) && !fits(trial.get(key)!))) break;
          docs = trial;
          for (const key of touched) changed.add(key);
          for (const [old, currentRef] of moved) if (currentRef === ref) moved.set(old, ticketRef(slug, ticket.number));
          moved.set(ref, ticketRef(slug, ticket.number));
          const owners = archives.get(slug) ?? new Set();
          for (const id of [...linked, defaultObjective, record.objective]) if (id) owners.add(id);
          archives.set(slug, owners);
          break;
        }
      }
      if (!fits(docs.get(feature)!)) throw new TicketFeatureFull(feature);
      overfull.delete(feature);
    }
  }
  const files: TicketWrite[] = [...changed].map(key => ({ key, bytes: serializeTicketFeature(docs.get(key)!) }));
  const objective = planFeatureLinks(root, links, archives);
  if (objective && archives.size) files.push({ key: OBJECTIVE_WRITE_KEY, ...objective });
  const publish = prepareTicketWrites(root, home, files, archives.size > 0);
  return { moved, publish, objective: archives.size ? undefined : objective };
}

/** Local MCP add/update holds the tickets lock; objective links also use the objective lock. */
export function writeTicketEdit(root: string, home: string, doc: TicketFeatureDoc, links?: ReadonlyMap<string, ReadonlySet<string>>) {
  return withObjectiveLock(root, () => {
    const plan = planTicketEdit(root, home, [doc], links);
    if (plan.objective) writeFileAtomic(objectivePath(root), plan.objective.bytes, { mode: plan.objective.mode });
    plan.publish();
    return plan.moved;
  });
}
