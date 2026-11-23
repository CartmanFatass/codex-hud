import { basename } from 'node:path';
import { targetKey } from './ticket-evidence.js';
import type { LedgerSlice, ProjectTicket, TicketFeature } from './project-board.js';

export const SETTLED_JOB_STATES: ReadonlySet<string> = new Set(['done', 'closed', 'complete', 'failed', 'stopped', 'idle_grace']);
/** Without STATUS, a rejected dispatch has failed; otherwise the receipt still claims the work. */
export const ticketJobState = (job: { dispatch_exit_code?: unknown }, status: { state?: unknown }) =>
  typeof status.state === 'string' && status.state ? status.state
    : typeof job.dispatch_exit_code === 'number' && job.dispatch_exit_code !== 0 ? 'failed' : 'working';
const live = (state: string | undefined) => !!state && !SETTLED_JOB_STATES.has(state);

/** Both spellings denote one ticket; a token boundary keeps FEATURE-01 distinct from FEATURE-010 or OTHER-FEATURE-01. */
const key = (feature: string, n: string) => targetKey(`${feature}/${n}`);
export function ticketIds(text: string): string[] {
  return Array.from(text.matchAll(/(?<![\w/-])([a-z0-9]+(?:-[a-z0-9]+)*)[-/](\d+)(?![\w-])/gi), m => key(m[1], m[2]));
}
export class TicketRollup {
  private index = new Map<string, ProjectTicket>();
  private linkedSlices = new Map<ProjectTicket, string>();
  private trees = new Set<ProjectTicket>();
  hasTicket(label: string) { return ticketIds(label).some(id => this.index.has(id)); }
  worktree(label: string) {
    for (const id of ticketIds(label)) { const t = this.index.get(id); if (t) this.trees.add(t); }
  }
  constructor(private features: TicketFeature[]) {
    for (const { slug, tickets } of features) for (const t of tickets) this.index.set(key(slug, t.number), t);
  }
  link(job: { ticket?: string | number; slice?: string; package?: string; target_hint?: string }, material: string, receipt: NonNullable<ProjectTicket['job']>) {
    const pkg = typeof job.package === 'string' ? job.package : '';
    const explicit = job.ticket != null ? String(job.ticket) : typeof job.slice === 'string' ? job.slice : undefined;
    let targets = explicit ? [targetKey(explicit)] : ticketIds(`${pkg}\n${job.target_hint ?? ''}\n${material.split('\n', 1)[0]}`);
    if (pkg && explicit && /^\d+$/.test(explicit)) targets = [key(pkg, explicit)];
    if (!targets.length && pkg && !explicit) {
      const feature = this.features.find(f => f.slug === pkg);
      targets = (feature?.tickets ?? []).filter(t => material.includes(basename(t.path)) ||
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
  derive(ledger: LedgerSlice[], landed: Set<string>, now: number, marks: ReadonlyMap<string, string>,
    ticketCommits: ReadonlyMap<string, { sha: string; at: number }> = new Map()) {
    const slices = new Map(ledger.map(r => [targetKey(r.id), r]));
    const commitSlices = new Map<string, LedgerSlice>();
    for (const r of ledger) if (r.commit) commitSlices.set(r.commit.slice(0, 7).toLowerCase(), r);
    const milestoneFor = (feature: string) => ledger.find(r => r.milestone.toLowerCase() === feature.toLowerCase())?.milestone ?? feature;
    const accepted = new Set([...marks].filter(([, mark]) => mark === 'accept').map(([id]) => targetKey(id)));
    const running: LedgerSlice[] = [];
    // Emit oldest features first so tie-broken ledger order treats newer features/tickets as more recent.
    for (const { slug: feature, tickets } of [...this.features].reverse()) for (const t of tickets) {
      const id = key(feature, t.number);
      const alias = this.linkedSlices.get(t);
      const aliasKey = targetKey(alias ?? ''), gitCommit = ticketCommits.get(id);
      const linked = slices.get(aliasKey), numbered = slices.get(id);
      const byCommit = (t.commit ? commitSlices.get(t.commit.slice(0, 7).toLowerCase()) : undefined)
        ?? (gitCommit ? commitSlices.get(gitCommit.sha.slice(0, 7).toLowerCase()) : undefined);
      const slice = linked ?? numbered ?? byCommit, states = [linked?.state, numbered?.state, byCommit?.state];
      const ticketPath = `.scratch/${feature}/issues/${basename(t.path)}`;
      const fileState = t.state;
      if (t.state === 'done' || t.state === 'dropped') {
        if (t.state === 'done' && !slice && (t.commit || t.recordedLanding)) {
          const commit = gitCommit?.sha ?? t.commit;
          running.push({ id: alias ?? `${feature.toUpperCase()}-${t.number}`, state: 'accepted', milestone: milestoneFor(feature),
            text: commit ? `${t.title} (${commit.slice(0, 8)})` : t.title, ...(commit ? { commit } : {}),
            ...(gitCommit ? { at: gitCommit.at } : {}), ticketPath, path: t.path });
        }
        continue;
      }
      const state = slice?.state, job = t.job?.state, claimed = live(job);
      if (states.includes('accepted') || accepted.has(id) || accepted.has(aliasKey)) t.state = 'done';
      else if (states.includes('dropped')) t.state = 'dropped';
      else if (states.includes('try') || landed.has(id) || t.state === 'try') t.state = 'try';
      else if (state === 'blocked' || job === 'failed' || job === 'blocked' || job === 'waiting_orchestrator') t.state = 'blocked';
      else if (claimed || this.trees.has(t) || state === 'working') t.state = 'working';
      else if (/^claimed\b/i.test(t.status)) t.state = !job && now - t.at < 7200000 ? 'working' : 'blocked';
      else if (/^needs-(info|triage)\b/i.test(t.status)) t.state = 'blocked';
      if ((t.state === 'working' || t.state === 'blocked') && (claimed || this.trees.has(t))) {
        if (claimed && /^ready-for-agent$/i.test(t.status)) t.status = 'claimed';
        // Legacy dispatches sometimes already have a working feature-level row rather than a numbered slice.
        if (!slice && !alias && slices.get(feature)?.state === 'working') continue;
        running.push({ id: slice?.id ?? alias ?? `${feature.toUpperCase()}-${t.number}`, state: t.state,
          milestone: milestoneFor(feature), text: t.title, ticketPath, path: t.path });
      } else if (!slice && fileState === 'try' && (t.state === 'try' || t.state === 'done')) {
        const commit = gitCommit?.sha ?? t.commit;
        const text = t.commit ? `${t.title} (${t.commit.slice(0, 8)})` : t.title;
        running.push({ id: alias ?? `${feature.toUpperCase()}-${t.number}`, state: t.state === 'done' ? 'accepted' : 'try',
          milestone: milestoneFor(feature), text, ...(commit ? { commit } : {}), ...(gitCommit ? { at: gitCommit.at } : {}),
          ticketPath, path: t.path });
      }
    }
    const dependencies = new Map<ProjectTicket, (ProjectTicket | undefined)[]>();
    for (const { slug, tickets } of this.features) for (const t of tickets) {
      const raw = t.blockers[0] ?? '', title = (ref: string) => tickets.find(x => x.title.toLowerCase() === ref.trim().toLowerCase());
      const refs = title(raw) ? [raw] : raw.replace(/\([^()]*\)/g, '').split(/[,;]|\s+and\s+/i);
      t.blockers = [];
      const deps = [];
      for (const ref of refs.map(s => s.trim()).filter(Boolean)) {
        const m = /^(?:([\w.-]+)\/|#?)(\d+)\b/.exec(ref);
        const target = m ? this.index.get(key(m[1] ?? slug, m[2])) : title(ref);
        if (target && ['done', 'dropped', 'try'].includes(target.state)) continue;
        deps.push(target);
        t.blockers.push(m?.[1] ? ref : target?.number ?? ref);
      }
      if (t.state === 'ready' && deps.length) dependencies.set(t, deps);
    }
    // Resolve after every feature has been indexed. A missing predecessor or dependency cycle cannot start by itself.
    const visit = (t: ProjectTicket): ProjectTicket['state'] => {
      const deps = dependencies.get(t);
      if (!deps) return t.state;
      dependencies.delete(t);
      t.state = 'blocked';
      if (deps.every(p => p && visit(p) !== 'blocked')) t.state = 'queued';
      return t.state;
    };
    for (const t of dependencies.keys()) visit(t);
    const resolved = (t: ProjectTicket) => t.state === 'done' || t.state === 'dropped';
    const open = (f: TicketFeature) => !f.tickets.every(resolved);
    const doneFeatures = this.features.filter(f => !open(f)).length;
    const totals = { doneTickets: [...this.index.values()].filter(resolved).length, totalTickets: this.index.size,
      doneFeatures, totalFeatures: this.features.length };
    let room = 16 - (totals.totalFeatures - doneFeatures);
    return { totals, running, visible: this.features.filter(f => open(f) || room-- > 0) };
  }
}
