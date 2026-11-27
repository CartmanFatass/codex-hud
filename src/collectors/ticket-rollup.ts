import { basename } from 'node:path';
import { matchArchivedTicket, parseTicketRef, type ArchiveCandidate } from '../tickets/store.js';
import { targetKey } from './ticket-evidence.js';
import type { LedgerSlice, ProjectTicket, TicketFeature } from './project-board.js';

export const SETTLED_JOB_STATES: ReadonlySet<string> = new Set(['done', 'closed', 'complete', 'failed', 'stopped', 'idle_grace']);
/** Without STATUS, a rejected dispatch has failed; otherwise the receipt still claims the work. */
export const ticketJobState = (job: { dispatch_exit_code?: unknown }, status: { state?: unknown }) =>
  typeof status.state === 'string' && status.state ? status.state
    : typeof job.dispatch_exit_code === 'number' && job.dispatch_exit_code !== 0 ? 'failed' : 'working';
const live = (state: string | undefined) => !!state && !SETTLED_JOB_STATES.has(state);
export const ticketSliceState = (state: ProjectTicket['state']): LedgerSlice['state'] => state === 'done' ? 'accepted'
  : state === 'ready' || state === 'queued' || state === 'triage' ? 'todo' : state;

/** Both spellings denote one ticket; a token boundary keeps FEATURE-01 distinct from FEATURE-010 or OTHER-FEATURE-01. */
const key = (feature: string, n: string) => targetKey(`${feature}/${n}`);
export function ticketIds(text: string): string[] {
  return Array.from(text.matchAll(/(?<![\w/-])([a-z0-9]+(?:-[a-z0-9]+)*)[-/](\d+)(?![\w-])/gi), m => key(m[1], m[2]));
}
type RollupFeature = TicketFeature & { source?: 'json' | 'mirror'; unreadable?: string };

export class TicketRollup {
  private index = new Map<string, ProjectTicket>();
  private slugs = new Map<ProjectTicket, string>();
  private linkedSlices = new Map<ProjectTicket, string>();
  private trees = new Set<ProjectTicket>();
  hasTicket(label: string) { return ticketIds(label).some(id => this.index.has(id)); }
  worktree(label: string) {
    for (const id of ticketIds(label)) { const t = this.index.get(id); if (t) this.trees.add(t); }
  }
  constructor(private features: RollupFeature[]) {
    for (const { slug, tickets } of features) for (const t of tickets) {
      this.index.set(key(slug, t.number), t);
      this.slugs.set(t, slug);
    }
  }
  /** Resolve replacement references using only the loaded board, with direct tickets taking precedence. */
  resolveReplacement(id: string): string | undefined {
    if (this.index.has(id)) return id;
    const ref = parseTicketRef(id);
    if (!ref) return;
    const sourceBlocked = this.features.some(f => f.slug === ref.feature && (f.source === 'mirror' || !!f.unreadable));
    const match = matchArchivedTicket<string>(ref.feature, this.features.flatMap(({ slug, source, unreadable }): ArchiveCandidate<string>[] => {
      if (unreadable) return [{ slug, unreadable: true }];
      if (source !== 'json') return [];
      const candidate = `${slug}/${ref.number}`;
      return [{ slug, value: this.index.has(candidate) ? candidate : undefined }];
    }), sourceBlocked);
    return match.status === 'matched' ? match.value : undefined;
  }
  link(job: { ticket?: string | number; slice?: string; package?: string; target_hint?: string }, material: string, receipt: NonNullable<ProjectTicket['job']>) {
    const pkg = typeof job.package === 'string' ? job.package : '';
    const explicit = job.ticket != null ? String(job.ticket) : typeof job.slice === 'string' ? job.slice : undefined;
    let targets = explicit ? [targetKey(explicit)] : ticketIds(`${pkg}\n${job.target_hint ?? ''}\n${material.split('\n', 1)[0]}`);
    if (pkg && explicit && /^\d+$/.test(explicit)) targets = [key(pkg, explicit)];
    if (!targets.length && pkg && !explicit) {
      const feature = this.features.find(f => f.slug === pkg);
      targets = (feature?.tickets ?? []).filter(t => (!t.sourcePath && material.includes(basename(t.path))) ||
        new RegExp(`(?:\\bticket\\s+#?|#)0*${Number(t.number)}\\b`, 'i').test(material)).map(t => key(pkg, t.number));
    }
    for (const id of targets) {
      const t = this.index.get(id);
      if (!t) continue;
      // A newer settled attempt does not release another attempt's live claim.
      const currentLive = live(t.job?.state), incomingLive = live(receipt.state);
      if (currentLive !== incomingLive ? currentLive : (t.job?.created ?? -Infinity) >= receipt.created) continue;
      t.job = receipt;
      if (typeof job.slice === 'string') this.linkedSlices.set(t, job.slice); else this.linkedSlices.delete(t);
    }
  }
  derive(now: number, readMarks?: (rows: LedgerSlice[]) => ReadonlyMap<string, string>,
    blockedTickets?: ReadonlySet<string>, admission?: {
      replacements: ReadonlyMap<string, ReadonlySet<string>>;
      landedInRun?: ReadonlySet<string>;
    }) {
    const entries: { ticket: ProjectTicket; row: LedgerSlice }[] = [];
    // Oldest features first; later rows win ties when showing the newest landings.
    for (const { slug, tickets } of [...this.features].reverse()) for (const t of tickets) {
      const id = key(slug, t.number), job = t.job?.state, claimed = live(job);
      if (t.state !== 'done' && t.state !== 'dropped' && t.state !== 'try') {
        if (blockedTickets?.has(id)) t.state = 'blocked';
        else if (job === 'failed' || job === 'blocked' || job === 'waiting_orchestrator') t.state = 'blocked';
        else if (claimed || this.trees.has(t)) t.state = 'working';
        else if (/^claimed\b/i.test(t.status)) t.state = !job && now - (t.claimedAt ?? t.at) < 7200000 ? 'working' : 'blocked';
        else if (/^needs-info\b/i.test(t.status)) t.state = 'blocked';
        else if (/^needs-triage\b/i.test(t.status)) t.state = 'triage';
      }
      if ((t.state === 'working' || t.state === 'blocked') && claimed && /^ready-for-agent$/i.test(t.status)) t.status = 'claimed';
      const hasLand = t.state === 'done' || t.state === 'try';
      const commit = hasLand ? t.commit : undefined;
      entries.push({ ticket: t, row: { id: `${slug.toUpperCase()}-${t.number}`, state: ticketSliceState(t.state), milestone: slug,
        text: commit ? `${t.title} (${commit.slice(0, 8)})` : t.title,
        ...(commit ? { commit } : {}), ...(t.landingAt !== undefined ? { at: t.landingAt } : {}),
        ...(t.recordedLanding || t.state === 'try' ? { landed: true } : {}),
        ticketPath: t.sourcePath ?? `.scratch/${slug}/issues/${basename(t.path)}`, path: t.path } });
    }
    // Keep old try records for explicitly linked slice IDs readable, but write new accepts against the ticket ID.
    const marks = readMarks?.(entries.flatMap(({ ticket, row }) => {
      const alias = this.linkedSlices.get(ticket);
      return alias && targetKey(alias) !== targetKey(row.id) ? [row, { ...row, id: alias }] : [row];
    })) ?? new Map<string, string>();
    for (const { ticket, row } of entries) {
      const alias = this.linkedSlices.get(ticket);
      if (ticket.state === 'try' && (marks.get(row.id) === 'accept' || (alias && marks.get(alias) === 'accept'))) ticket.state = 'done';
    }
    const dependencies = new Map<ProjectTicket, (ProjectTicket | undefined)[]>();
    const declaredBlockers = new Map<ProjectTicket, string[]>();
    const crossBlockers = new Map<ProjectTicket, string[]>(), missingCrossBlockers = new Map<ProjectTicket, string>();
    for (const { slug, tickets } of this.features) for (const t of tickets) {
      const title = (ref: string) => tickets.find(x => x.title.toLowerCase() === ref.trim().toLowerCase());
      const refs = t.blockers.flatMap((raw) => title(raw) ? [raw] : raw.replace(/\([^()]*\)/g, '').split(/[,;]|\s+and\s+/i));
      t.blockers = [];
      const deps: (ProjectTicket | undefined)[] = [];
      const waitOn = (target: ProjectTicket | undefined, cross: string | undefined, label: string) => {
        if (cross && target && !blockedTickets?.has(targetKey(cross))) {
          // A known external dependency is a queue wait, not a local stall (unless held/failed).
          const waiting = crossBlockers.get(t) ?? [];
          waiting.push(cross);
          crossBlockers.set(t, waiting);
        } else deps.push(target);
        if (!t.blockers.includes(label)) t.blockers.push(label);
      };
      const declared: string[] = [];
      for (const ref of refs.map(s => s.trim()).filter(Boolean)) {
        const m = /^(?:([\w.-]+)\/|#?)(\d+)\b/.exec(ref);
        const target = m ? this.index.get(key(m[1] ?? slug, m[2])) : title(ref);
        const cross = m?.[1] && m[1].toLowerCase() !== slug.toLowerCase() ? `${m[1]}/${m[2]}` : undefined;
        const targetSlug = target ? this.slugs.get(target) : undefined;
        const canonical = target && targetSlug ? `${targetSlug}/${target.number}` : cross ?? ref;
        if (!declared.includes(canonical)) declared.push(canonical);
        if (target?.state === 'done') continue;
        // An unattended run accepts at the end, so its landed owner tries can release ordinary local blockers.
        if (target?.state === 'try' && !cross) {
          const blockerKey = targetKey(canonical);
          if (!admission || (admission.landedInRun?.has(blockerKey) && !blockedTickets?.has(blockerKey))) continue;
        }
        if (target?.state === 'dropped') {
          if (!admission) continue; // Display rollups retain the historical closed-ticket view.
          const replacements = [...(admission.replacements.get(targetKey(canonical)) ?? [])]
            .flatMap(id => this.index.get(this.resolveReplacement(id) ?? id) ?? []).filter(r => r !== t && r.state !== 'dropped');
          if (replacements.some(r => r.state === 'done')) continue;
          if (!replacements.length) {
            waitOn(undefined, undefined, `${canonical} is wontfix with no usable replacement; update blocked_by`);
          } else for (const replacement of replacements) {
            const replacementSlug = this.slugs.get(replacement)!;
            const replacementRef = `${replacementSlug}/${replacement.number}`;
            waitOn(replacement, replacementSlug !== slug ? replacementRef : undefined, replacementRef);
          }
          continue;
        }
        waitOn(target, cross, cross || (admission && m?.[1]) ? ref : target?.number ?? ref);
        if (cross && !target) missingCrossBlockers.set(t, cross);
      }
      if (declared.length) declaredBlockers.set(t, declared);
      if (t.state === 'triage' && t.blockers.length) t.state = 'blocked';
      if (t.state === 'ready' && (deps.length || crossBlockers.has(t))) dependencies.set(t, deps);
    }
    // Resolve after every feature has been indexed. A missing predecessor or dependency cycle cannot start by itself.
    const visit = (t: ProjectTicket): ProjectTicket['state'] => {
      const deps = dependencies.get(t);
      if (!deps) return t.state;
      dependencies.delete(t);
      t.state = 'blocked';
      // Triage does not block the ticket itself, but local dependents still need the prerequisite triaged.
      if (deps.every(p => {
        const state = p && visit(p);
        return state && state !== 'blocked' && state !== 'triage';
      })) t.state = 'queued';
      return t.state;
    };
    for (const t of dependencies.keys()) visit(t);
    const resolved = (t: ProjectTicket) => t.state === 'done' || t.state === 'dropped';
    const doneFeatures = this.features.filter((f) => f.tickets.length > 0 && f.tickets.every(resolved)).length;
    const totals = { doneTickets: [...this.index.values()].filter(resolved).length, totalTickets: this.index.size,
      doneFeatures, totalFeatures: this.features.length };
    const rows = entries.map(({ ticket, row }) => ({ ...row, state: ticketSliceState(ticket.state) }));
    return { totals, rows, marks, declaredBlockers, crossBlockers, missingCrossBlockers };
  }
}
