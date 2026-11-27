import type { ExecutionRun, MetroRepair, MetroStation, MetroStationState } from './execution-runs.js';
import type { OwnerWorker } from './workboard-types.js';
import type { HomePortfolio } from './home-portfolio.js';
import { ROLE_GLYPHS, roleIcon } from '../render/model-glyphs.js';
import { monitorText } from '../render/monitor-text.js';
import { compactAge } from '../render/workboard-rows.js';

const MAX_ROWS = 64;
const MAX_PROJECTION_BYTES = 32 * 1024;
const KIND_WORDS = new Set(['review', 'lead', 'accept', 'land']);
const ROLE_NAMES = Object.keys(ROLE_GLYPHS).filter((role) => role !== 'other');
const escapeRe = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const states = {
  waiting: 'queued', working: 'running', asking: 'asked', held: 'blocked', lease: 'queued',
  stalled: 'blocked', done: 'done', failed: 'blocked', stopped: 'unknown', unknown: 'unknown',
} as const satisfies Record<MetroStationState, string>;

type Step = {
  id: string;
  label: string;
  title?: string;
  state: (typeof states)[MetroStationState];
  role?: string;
  pane_id?: string;
};
type Run = { hud_group: string; hud_subgroup: string; name: string; age: string; steps: Step[]; edges?: [string, string][] };
export interface SidebarProjection {
  requests?: { count: number; project: string; age: string; sentence: string };
  launcher: { execution: number };
  extra_projects?: number;
  runs?: Run[];
}
export type SidebarRunTarget = { root: string; flow: string; steps: ReadonlySet<string> };
export const sidebarRunKey = (group: string, subgroup: string) => JSON.stringify([group, subgroup]);

function text(raw: string, limit = 128): string {
  const clean = monitorText(raw.replace(/\s+/g, ' ')).replace(/\p{Cc}/gu, '').trim();
  if (Buffer.byteLength(clean) <= limit) return clean;
  let out = '', bytes = 0;
  for (const char of clean) {
    bytes += Buffer.byteLength(char);
    if (bytes > limit) break;
    out += char;
  }
  return out.trimEnd();
}
const validId = (id: string) => id.trim() && !/\p{Cc}/u.test(id) && Buffer.byteLength(id) <= 128;

function ticketNumber(id: string): string {
  const trimmed = id.trim();
  const match = /(?:^|\/)#?(\d+)$/.exec(trimmed);
  return match ? match[1]!.padStart(2, '0') : trimmed.split('/').at(-1) || trimmed;
}

function stripRolePrefix(raw: string, role?: string): string {
  const names = [...new Set([...(role && role !== 'other' ? [role] : []), ...ROLE_NAMES])]
    .sort((a, b) => b.length - a.length);
  if (!names.length) return raw;
  const re = new RegExp(`^(?:${names.map(escapeRe).join('|')})(?::\\s*|\\s*[·–—]\\s*|\\s+|[-_/])(.+)$`, 'i');
  const match = re.exec(raw);
  return match ? match[1]!.trim() : raw;
}

function stationShortLabel(run: ExecutionRun, station: MetroStation, ticketIds: ReadonlySet<string>): string {
  if (run.kind === 'queue' && ticketIds.has(station.id)) return text(ticketNumber(station.id)) || station.id;
  if (station.kind === 'review') return 'review';
  if (station.kind === 'accept') return 'accept';
  if (station.workflowKind === 'land') return 'land';
  if (station.role === 'lead' && (station.workflowKind === 'job' || station.kind === 'synth')) return 'lead';
  if (KIND_WORDS.has(station.id)) return station.id;
  const rawLabel = station.label ? text(station.label) : '';
  const isBareRole = (value: string) => Boolean(value) && (
    (station.role && value.toLowerCase() === station.role.toLowerCase()) ||
    ROLE_NAMES.some((r) => r.toLowerCase() === value.toLowerCase())
  );
  const candidate = rawLabel && !isBareRole(rawLabel) ? rawLabel : text(station.id);
  return text(stripRolePrefix(candidate, station.role)) || text(station.id) || station.id;
}

function repairShortLabel(stationLabel: string, repair: MetroRepair): string {
  return text(repair.round > 1 ? `${stationLabel}↻${repair.round}` : `${stationLabel}↻`) || repair.id;
}

function stepHasWorker(run: ExecutionRun, station: MetroStation, step: MetroStation | MetroRepair): boolean {
  if (step.state === 'waiting' || step.state === 'done' || step.state === 'stopped') return false;
  if (step.jobId) return true;
  return step === station && run.kind === 'batch' && (station.kind === 'pool' || station.id === 'pilot');
}

/** Reuse Home's already ordered requests and Execution's open-run stations; do not reinterpret worker questions. */
export function buildSidebarProjection(portfolio: HomePortfolio,
  openRuns: readonly { root: string; group: string; run: ExecutionRun; workers?: ReadonlyMap<string, OwnerWorker> }[],
  represented: ReadonlySet<string> | undefined,
  paneForJob: (id: string) => string | undefined,
  now: number,
  iconForRole: (role: string) => string = roleIcon,
) {
  const [first] = portfolio.requests;
  const projection: SidebarProjection = { launcher: { execution: openRuns.length } };
  if (first) projection.requests = {
    count: portfolio.requests.length,
    project: text(first.project.name) || '·',
    age: compactAge(first.item.at, now) || '·',
    sentence: text(first.item.sentence ?? first.item.value, 512) || '·',
  };
  if (represented) {
    const extra = portfolio.projects.filter((p) => !represented.has(p.root)).length;
    if (extra) projection.extra_projects = extra;
  }
  const targets = new Map<string, SidebarRunTarget>();
  const starts: (number | null)[] = [];
  const runs: Run[] = [];
  for (const { root, group, run, workers } of openRuns) {
    if (runs.length === MAX_ROWS) break;
    const hud_group = text(group) || '·';
    let hud_subgroup = text(run.feature ?? run.label) || run.flow;
    if (targets.has(sidebarRunKey(hud_group, hud_subgroup))) hud_subgroup = run.flow;
    const key = sidebarRunKey(hud_group, hud_subgroup);
    if (targets.has(key)) continue;
    const steps: Step[] = [], ids = new Set<string>();
    const ticketIds = new Set(run.tickets.map(ticket => ticket.ticket));
    const blocked = new Set(run.tickets.filter(ticket => ticket.stage === 'blocked').map(ticket => ticket.ticket));
    const edges: [string, string][] = [];
    const edgeKeys = new Set<string>();
    const addEdge = (from: string, to: string) => {
      if (from === to || !ids.has(from) || !ids.has(to)) return;
      const edgeKey = `${from}\0${to}`;
      if (edgeKeys.has(edgeKey)) return;
      edgeKeys.add(edgeKey);
      edges.push([from, to]);
    };
    for (const station of run.metro?.stations ?? []) {
      const baseLabel = stationShortLabel(run, station, ticketIds);
      for (const step of [station, ...(station.repairs ?? (station.repair ? [station.repair] : []))]) {
        if (steps.length === MAX_ROWS) break;
        if (!validId(step.id) || ids.has(step.id)) continue;
        ids.add(step.id);
        const state = step === station && blocked.has(step.id) ? 'blocked' : states[step.state];
        const pane = step.jobId && ['working', 'asking', 'held', 'stalled'].includes(step.state) ? paneForJob(step.jobId) : undefined;
        const label = 'round' in step ? repairShortLabel(baseLabel, step) : baseLabel;
        const worker = step.jobId ? workers?.get(step.jobId) : undefined;
        const fullTitle = text(('title' in step && step.title) || worker?.ticketTitle || worker?.briefTitle || worker?.task || '');
        const roleName = step.role || worker?.role;
        const role = roleName && stepHasWorker(run, station, step) ? iconForRole(roleName) : undefined;
        steps.push({
          id: step.id,
          label,
          ...(fullTitle && fullTitle !== label && { title: fullTitle }),
          state,
          ...(role && { role }),
          ...(pane && validId(pane) && { pane_id: pane }),
        });
        if (step !== station) addEdge(station.id, step.id);
      }
    }
    for (const { from, to } of run.metro?.edges ?? []) addEdge(from, to);
    for (const station of run.metro?.stations ?? []) {
      for (const dep of station.blockers ?? []) addEdge(dep, station.id);
    }
    const entry = { hud_group, hud_subgroup, name: text(run.label) || run.flow,
      age: compactAge(run.createdAt ?? undefined, now) || '·', steps,
      ...(edges.length && { edges: edges.slice(0, 128) }) };
    if (Buffer.byteLength(JSON.stringify({ ...projection, runs: [...runs, entry] })) > MAX_PROJECTION_BYTES) break;
    runs.push(entry);
    targets.set(key, { root, flow: run.flow, steps: ids });
    starts.push(run.createdAt);
  }
  if (runs.length) projection.runs = runs;
  // A change hint at a later wall clock is not new evidence. Compare age sources, not formatted ages.
  const revision = JSON.stringify({ ...projection,
    requests: projection.requests && { ...projection.requests, age: first.item.at ?? null },
    runs: runs.map((run, i) => ({ ...run, age: starts[i] })),
    targets: [...targets].map(([key, { root, flow }]) => [key, root, flow]),
  });
  return { projection, revision, targets };
}
export type SidebarFacts = ReturnType<typeof buildSidebarProjection>;
