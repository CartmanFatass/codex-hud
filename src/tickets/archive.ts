import { planFeatureLinks, withObjectiveLock, type ObjectiveFileInput } from '../mcp/local-objectives.js';
import { inspectObjectives, objectivePath, readObjectives } from '../collectors/objectives.js';
import { writeFileAtomic } from '../utils/atomic-fs.js';
import {
  extendsPendingWriteGroup, isTicketArchive, matchArchivedTicket, OBJECTIVE_WRITE_KEY, parseTicketRef, prepareTicketWrites,
  readJsonTicketFeature, readTicketFeature, serializeTicketFeature, TicketFeatureFull, ticketFeatureSlugs, ticketRef,
  validateTicketFeature, type TicketFeatureDoc, type TicketRecord, type TicketWrite,
} from './store.js';

const closed = (ticket: TicketRecord) => ticket.status === 'done' || ticket.status === 'wontfix';
function fits(doc: TicketFeatureDoc): boolean {
  try { serializeTicketFeature(doc); return true; }
  catch (error) { if (error instanceof TicketFeatureFull) return false; throw error; }
}

/** Plan before publishing anything, including indirect ref rewrites and the Features line. */
export function planTicketEdit(
  root: string,
  home: string,
  edited: readonly TicketFeatureDoc[],
  links: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
  objectiveFile?: ObjectiveFileInput | (() => ObjectiveFileInput),
) {
  let docs = new Map(edited.map(doc => [doc.feature, validateTicketFeature(doc)]));
  const changed = new Set(docs.keys());
  const overfull = new Set([...docs.values()].filter(doc => !fits(doc)).map(doc => doc.feature));
  const moved = new Map<string, string>();
  const archives = new Map<string, Set<string>>();
  let objectiveLoaded = false;
  let resolvedObjectiveFile: ObjectiveFileInput | undefined;
  const getObjectiveFile = () => {
    if (!objectiveLoaded) {
      objectiveLoaded = true;
      resolvedObjectiveFile = typeof objectiveFile === 'function' ? objectiveFile() : objectiveFile;
    }
    return resolvedObjectiveFile;
  };
  if (overfull.size) {
    const legacy = new Set<string>();
    for (const slug of ticketFeatureSlugs(root)) if (!docs.has(slug)) {
      const json = readJsonTicketFeature(root, slug), doc = json ?? readTicketFeature(root, slug);
      if (!doc) continue;
      docs.set(slug, doc);
      if (!json) legacy.add(slug);
    }
    const archiveCandidates = (state: ReadonlyMap<string, TicketFeatureDoc>, number: number) =>
      [...state].flatMap(([key, doc]) =>
        legacy.has(key) ? [] : [{ slug: key, mirror: !!doc.mirror, value: doc.tickets.some(t => t.number === number) ? key : undefined }],
      );
    const loadedObjective = getObjectiveFile();
    const objectives = (loadedObjective === undefined
      ? readObjectives(root)
      : loadedObjective ? inspectObjectives(loadedObjective.text).record : undefined)?.objectives ?? [];
    for (const feature of overfull) {
      const source = docs.get(feature)!;
      if (source.mirror) throw new TicketFeatureFull(feature);
      const linked = objectives.filter(o => o.features.includes(feature) || links.get(o.id)?.has(feature)).map(o => o.id);
      const defaultObjective = source.objective ?? (linked.length === 1 ? linked[0] : undefined);
      const highest = source.tickets.at(-1)?.number;
      for (const ticket of source.tickets) {
        if (!closed(ticket) || ticket.number === highest) continue;
        if (matchArchivedTicket(feature, archiveCandidates(docs, ticket.number)).status !== 'missing') continue;
        const ref = ticketRef(feature, ticket.number);
        const namesTicket = (value: string) => {
          if (value === ref) return true;
          const parsed = parseTicketRef(value);
          if (!parsed || parsed.number !== ticket.number || !isTicketArchive(parsed.feature, feature)) return false;
          const origin = docs.get(parsed.feature);
          if (origin?.tickets.some(t => t.number === parsed.number)) return false;
          const match = matchArchivedTicket(parsed.feature, archiveCandidates(docs, parsed.number), !!origin?.mirror);
          return match.status === 'matched' && match.slug === feature;
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
          const destMatch = matchArchivedTicket(feature, archiveCandidates(trial, ticket.number));
          if (destMatch.status !== 'matched' || destMatch.slug !== slug) break;
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
  const files: TicketWrite[] = [...changed].map(key => {
    const doc = docs.get(key)!;
    return { key, bytes: serializeTicketFeature(doc), mirror: !!doc.mirror };
  });
  const objective = links.size || archives.size ? planFeatureLinks(root, links, archives, getObjectiveFile()) : undefined;
  const extendPendingObjective = Boolean(objective && !archives.size && extendsPendingWriteGroup(root, home, OBJECTIVE_WRITE_KEY));
  if (objective && (archives.size || extendPendingObjective)) files.push({ key: OBJECTIVE_WRITE_KEY, ...objective });
  const publish = prepareTicketWrites(root, home, files, archives.size > 0);
  return {
    moved,
    publish,
    objective: archives.size || extendPendingObjective ? undefined : objective,
    objectiveEdited: Boolean(objective && archives.size),
  };
}

/** Caller holds the tickets lock across the read, edit and write. */
export function writeTicketEdit(root: string, home: string, docs: readonly TicketFeatureDoc[], links?: ReadonlyMap<string, ReadonlySet<string>>) {
  return withObjectiveLock(root, () => {
    const plan = planTicketEdit(root, home, docs, links);
    if (plan.objective) writeFileAtomic(objectivePath(root), plan.objective.bytes, { mode: plan.objective.mode });
    plan.publish();
    return plan.moved;
  });
}
