/** Pure metro-map graph types and 3-lane reduction for Execution workflows. No I/O or render imports. */

import type { Step } from '../workflows/graph.js';

export type MetroStationKind = 'worker' | 'review' | 'accept' | 'synth' | 'pool' | 'summary';

export type MetroStationState =
  | 'waiting'
  | 'working'
  | 'asking'
  | 'held'
  | 'lease'
  | 'stalled'
  | 'done'
  | 'failed'
  | 'stopped'
  | 'unknown';

export interface MetroGate {
  readonly index: number;
  readonly total: number;
  readonly passed: number;
  readonly state: 'working' | 'failed' | 'done';
  readonly command?: string;
}

export interface MetroJobTarget {
  readonly target: { readonly kind: 'worker'; readonly laneId: string; readonly workerId: string };
  readonly dir: string;
  readonly tab: boolean;
}

export interface MetroRepair {
  readonly id: string;
  readonly round: number;
  readonly total: number;
  readonly state: MetroStationState;
  readonly changedAt?: number;
  readonly role?: string;
  readonly label?: string;
  readonly reason?: string;
  readonly jobId?: string;
  readonly execJob?: MetroJobTarget;
}

export interface MetroPoolCounts {
  readonly done?: number;
  readonly working?: number;
  readonly asking?: number;
  readonly held?: number;
  readonly lease?: number;
  readonly stalled?: number;
  readonly failed?: number;
  readonly waiting?: number;
  readonly stopped?: number;
  readonly unknown?: number;
}

export interface MetroStation {
  readonly id: string;
  readonly kind: MetroStationKind;
  /** Original kind for composed steps (e.g. a land step also uses the worker station shape). */
  readonly workflowKind?: Step['kind'];
  readonly state: MetroStationState;
  /** Last state-change timestamp (ms epoch) for "changed last" detail selection and station age. */
  readonly changedAt?: number;
  readonly label?: string;
  readonly title?: string;
  readonly role?: string;
  /** Declared/active blocker station IDs preserved for the detail line. */
  readonly blockers?: readonly string[];
  readonly gate?: MetroGate;
  readonly repair?: MetroRepair;
  /** Ordered repair attempts on this station's repair line (round 1, round 2, ...). */
  readonly repairs?: readonly MetroRepair[];
  /** Present on `pool` stations (batch pools and >3-parallel overflow groups). */
  readonly pool?: MetroPoolCounts;
  /** Item count for `pool` stations. */
  readonly count?: number;
  readonly holdTag?: string;
  readonly reason?: string;
  readonly jobId?: string;
  readonly execJob?: MetroJobTarget;
}

export interface MetroEdge {
  readonly from: string;
  readonly to: string;
}

export interface MetroFlow {
  readonly stations: readonly MetroStation[];
  readonly edges: readonly MetroEdge[];
  /** Station (or repair spur) ID with the newest `changedAt`. */
  readonly lastChangedId?: string;
  /** True when edges were synthesized from wave order for a legacy record lacking per-ticket blockers. */
  readonly waveFallback?: true;
}

export interface MetroLaneStation {
  readonly station: MetroStation;
  readonly column: number;
  readonly lane: number;
  /** Original blocker IDs preserved for the detail line, even after skip/crossing/overflow reduction. */
  readonly blockers?: readonly string[];
  /** Grouped member station IDs when this station is a >maxLanes overflow pool. */
  readonly groupedIds?: readonly string[];
}

export interface MetroLaneEdge {
  readonly from: string;
  readonly to: string;
  readonly fromColumn: number;
  readonly toColumn: number;
  readonly fromLane: number;
  readonly toLane: number;
  /** True when routed through a shared junction to resolve a skip-a-column or crossing dependency. */
  readonly viaJunction?: true;
}

export interface MetroJunction {
  /** Column gap index: between `afterColumn` and `afterColumn + 1`. */
  readonly afterColumn: number;
  /** Lane (0..lanes-1) where the shared junction sits. */
  readonly lane: number;
  /** Incoming station IDs from `afterColumn`. */
  readonly incoming: readonly string[];
  /** Outgoing station IDs into `afterColumn + 1`. */
  readonly outgoing: readonly string[];
  readonly reduced: boolean;
}

export interface ReducedMetroMap {
  readonly lanes: number;
  readonly trunk: number;
  readonly columns: readonly (readonly MetroLaneStation[])[];
  readonly stations: readonly MetroLaneStation[];
  readonly edges: readonly MetroLaneEdge[];
  readonly junctions: readonly MetroJunction[];
  /** True when overflow grouping, skip-a-column reduction, crossing merge, or cycle trimming occurred. */
  readonly reduced: boolean;
}

const URGENCY: Record<MetroStationState, number> = {
  asking: 0,
  held: 0,
  failed: 1,
  stalled: 2,
  working: 3,
  lease: 3,
  unknown: 4,
  waiting: 5,
  stopped: 6,
  done: 7,
};

function stationRepairs(station: MetroStation): readonly MetroRepair[] {
  if (station.repairs?.length) return station.repairs;
  return station.repair ? [station.repair] : [];
}

/** Pick the station (or repair spur) that changed most recently. */
export function lastChangedStationId(stations: readonly MetroStation[]): string | undefined {
  let bestId: string | undefined;
  let bestAt = -Infinity;
  for (const station of stations) {
    if (station.changedAt !== undefined && Number.isFinite(station.changedAt) && station.changedAt >= bestAt) {
      bestAt = station.changedAt;
      bestId = station.id;
    }
    for (const repair of stationRepairs(station)) {
      const repairAt = repair.changedAt;
      if (repairAt !== undefined && Number.isFinite(repairAt) && repairAt >= bestAt) {
        bestAt = repairAt;
        bestId = repair.id;
      }
    }
  }
  return bestId;
}

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

/** Cycle-safe topological column leveling: roots in 0, dependents in 1 + max(parent column). */
function assignColumns(
  stations: readonly MetroStation[],
  depsById: ReadonlyMap<string, readonly string[]>,
): Map<string, number> {
  const indeg = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const s of stations) {
    const deps = depsById.get(s.id) ?? [];
    indeg.set(s.id, deps.length);
    for (const d of deps) {
      let list = children.get(d);
      if (!list) children.set(d, list = []);
      list.push(s.id);
    }
  }
  const col = new Map<string, number>();
  let frontier = stations.filter((s) => (indeg.get(s.id) ?? 0) === 0).map((s) => s.id);
  let depth = 0;
  while (frontier.length) {
    const next: string[] = [];
    for (const id of frontier) {
      col.set(id, depth);
      for (const child of children.get(id) ?? []) {
        const rem = (indeg.get(child) ?? 1) - 1;
        indeg.set(child, rem);
        if (rem === 0) next.push(child);
      }
    }
    frontier = next;
    depth++;
  }
  // Damaged cycles land in one final column instead of hanging or dropping stations.
  for (const s of stations) {
    if (!col.has(s.id)) col.set(s.id, depth);
  }
  return col;
}

/** Generate all ordered placements of `k` distinct lanes chosen from `0..height-1`. */
function lanePlacements(k: number, height: number): number[][] {
  if (k === 0) return [[]];
  const out: number[][] = [];
  const used = new Array<boolean>(height).fill(false);
  const current: number[] = [];
  const dfs = () => {
    if (current.length === k) {
      out.push([...current]);
      return;
    }
    for (let l = 0; l < height; l++) {
      if (used[l]) continue;
      used[l] = true;
      current.push(l);
      dfs();
      current.pop();
      used[l] = false;
    }
  };
  dfs();
  return out;
}

interface InternalEdge {
  from: string;
  to: string;
  viaJunction?: true;
}

/**
 * Pure lane reduction for Execution metro maps (at most `maxLanes`, default 3):
 * - Chains, fan-out and fan-in stay direct with zero crossings.
 * - Columns wider than `maxLanes` keep the `maxLanes - 1` most urgent stations and group the rest into a `pool` station.
 * - Skip-a-column edges (`col(to) - col(from) > 1`) drop if transitively implied or route through intermediate shared junctions keeping order.
 * - Unavoidable edge crossings between adjacent columns merge at a shared junction on the trunk; original blockers stay on each station for the detail line.
 */
export function reduceMetroLanes(
  flow: Pick<MetroFlow, 'stations' | 'edges'>,
  maxLanes = 3,
): ReducedMetroMap {
  const limit = Math.max(1, Math.floor(maxLanes));
  if (!flow.stations.length) {
    return { lanes: 0, trunk: 0, columns: [], stations: [], edges: [], junctions: [], reduced: false };
  }

  const order = new Map<string, number>();
  const stationById = new Map<string, MetroStation>();
  const stations: MetroStation[] = [];
  for (const s of flow.stations) {
    if (stationById.has(s.id)) continue;
    order.set(s.id, stations.length);
    stationById.set(s.id, s);
    stations.push(s);
  }

  // Normalize edges and capture each station's original blockers for the detail line.
  const depsById = new Map<string, string[]>(stations.map((s) => [s.id, []]));
  const rawEdges: MetroEdge[] = [];
  const edgeKeys = new Set<string>();
  for (const e of flow.edges) {
    if (e.from === e.to || !stationById.has(e.from) || !stationById.has(e.to)) continue;
    const key = `${e.from}\0${e.to}`;
    if (edgeKeys.has(key)) continue;
    edgeKeys.add(key);
    rawEdges.push({ from: e.from, to: e.to });
    depsById.get(e.to)!.push(e.from);
  }

  const originalBlockers = new Map<string, readonly string[] | undefined>();
  for (const s of stations) {
    const deps = depsById.get(s.id)!;
    const declared = s.blockers?.length ? s.blockers : deps.length ? deps : undefined;
    originalBlockers.set(s.id, declared);
  }

  let reduced = false;
  const colOf = assignColumns(stations, depsById);
  const colCount = Math.max(...colOf.values()) + 1;
  const rawCols: MetroStation[][] = Array.from({ length: colCount }, () => []);
  for (const s of stations) rawCols[colOf.get(s.id)!].push(s);

  // Step 1: Limit parallel width per column to `limit`.
  const remap = new Map<string, string>();
  const groupedIdsById = new Map<string, readonly string[]>();
  const workCols: MetroStation[][] = [];
  const usedIds = new Set(stations.map((s) => s.id));
  const uniqueOverflowId = (c: number) => {
    let id = `overflow-${c}`;
    let n = 1;
    while (usedIds.has(id)) id = `overflow-${c}-${n++}`;
    usedIds.add(id);
    return id;
  };

  for (let c = 0; c < rawCols.length; c++) {
    const col = rawCols[c];
    if (col.length <= limit) {
      workCols.push([...col]);
      continue;
    }
    reduced = true;
    const keepCount = Math.max(0, limit - 1);
    const ranked = [...col].sort(
      (a, b) => (URGENCY[a.state] - URGENCY[b.state]) || ((order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)),
    );
    const kept = ranked.slice(0, keepCount);
    const grouped = ranked.slice(keepCount);
    const groupedSet = new Set(grouped.map((s) => s.id));
    const counts: Record<string, number> = {};
    let maxChanged: number | undefined;
    for (const s of grouped) {
      counts[s.state] = (counts[s.state] ?? 0) + 1;
      let at = s.changedAt ?? -Infinity;
      for (const r of stationRepairs(s)) {
        if (r.changedAt !== undefined && r.changedAt > at) at = r.changedAt;
      }
      if (Number.isFinite(at) && (maxChanged === undefined || at > maxChanged)) maxChanged = at;
    }
    const groupId = uniqueOverflowId(c);
    const groupBlockers = unique(
      grouped.flatMap((s) => originalBlockers.get(s.id) ?? []).filter((b) => !groupedSet.has(b)),
    );
    const groupStation: MetroStation = {
      id: groupId,
      kind: 'pool',
      state: grouped[0].state,
      ...(maxChanged !== undefined ? { changedAt: maxChanged } : {}),
      pool: counts as MetroPoolCounts,
      count: grouped.length,
      ...(groupBlockers.length ? { blockers: groupBlockers } : {}),
    };
    for (const s of grouped) remap.set(s.id, groupId);
    groupedIdsById.set(groupId, grouped.map((s) => s.id));
    originalBlockers.set(groupId, groupBlockers.length ? groupBlockers : undefined);
    order.set(groupId, stations.length + c);
    // Keep original order among kept stations, with the overflow pool last.
    kept.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    workCols.push([...kept, groupStation]);
  }

  // Rebuild column lookup and rewired edges after overflow grouping.
  const workColOf = new Map<string, number>();
  for (let c = 0; c < workCols.length; c++) {
    for (const s of workCols[c]) workColOf.set(s.id, c);
  }

  const rewired: MetroEdge[] = [];
  const rewiredKeys = new Set<string>();
  for (const e of rawEdges) {
    const from = remap.get(e.from) ?? e.from;
    const to = remap.get(e.to) ?? e.to;
    if (from === to) continue;
    const key = `${from}\0${to}`;
    if (rewiredKeys.has(key)) continue;
    rewiredKeys.add(key);
    rewired.push({ from, to });
  }

  // Step 2: Reduce skip-a-column edges (col(to) - col(from) > 1) and drop cycle back-edges.
  const adjEdges: InternalEdge[] = [];
  const adjKeys = new Set<string>();
  const skipEdges: MetroEdge[] = [];
  const addAdj = (from: string, to: string, viaJunction?: true) => {
    const key = `${from}\0${to}`;
    if (adjKeys.has(key)) {
      if (viaJunction) {
        const existing = adjEdges.find((e) => e.from === from && e.to === to);
        if (existing) existing.viaJunction = true;
      }
      return;
    }
    adjKeys.add(key);
    adjEdges.push(viaJunction ? { from, to, viaJunction: true } : { from, to });
  };

  for (const e of rewired) {
    const fc = workColOf.get(e.from)!, tc = workColOf.get(e.to)!;
    if (tc === fc + 1) addAdj(e.from, e.to);
    else if (tc > fc + 1) skipEdges.push(e);
    else reduced = true; // Damaged cycle back/same-column edge dropped from drawn lanes.
  }

  if (skipEdges.length) {
    reduced = true;
    // Precompute ancestors of each node in the rewired forward DAG for relay selection.
    const revForward = new Map<string, string[]>();
    for (const e of rewired) {
      if (workColOf.get(e.to)! > workColOf.get(e.from)!) {
        let list = revForward.get(e.to);
        if (!list) revForward.set(e.to, list = []);
        list.push(e.from);
      }
    }
    const ancestorsOf = (target: string): Set<string> => {
      const seen = new Set<string>();
      const stack = [...(revForward.get(target) ?? [])];
      while (stack.length) {
        const cur = stack.pop()!;
        if (seen.has(cur)) continue;
        seen.add(cur);
        for (const p of revForward.get(cur) ?? []) stack.push(p);
      }
      return seen;
    };
    const canReachAdj = (src: string, dst: string): boolean => {
      const targetCol = workColOf.get(dst)!;
      const seen = new Set<string>([src]);
      const queue = [src];
      while (queue.length) {
        const cur = queue.shift()!;
        if (cur === dst) return true;
        if (workColOf.get(cur)! >= targetCol) continue;
        for (const e of adjEdges) {
          if (e.from === cur && !seen.has(e.to)) {
            seen.add(e.to);
            queue.push(e.to);
          }
        }
      }
      return false;
    };

    for (const skip of skipEdges) {
      if (canReachAdj(skip.from, skip.to)) continue; // Already implied in topological order.
      const anc = ancestorsOf(skip.to);
      let prev = skip.from;
      const fc = workColOf.get(skip.from)!, tc = workColOf.get(skip.to)!;
      for (let c = fc + 1; c < tc; c++) {
        const candidates = workCols[c];
        const mid = Math.floor((candidates.length - 1) / 2);
        const alreadyLinked = (id: string) => adjKeys.has(`${prev}\0${id}`);
        const relay =
          candidates.find((s) => alreadyLinked(s.id) && anc.has(s.id)) ??
          candidates.find((s) => anc.has(s.id)) ??
          candidates.find((s) => alreadyLinked(s.id)) ??
          candidates[mid];
        if (!alreadyLinked(relay.id)) addAdj(prev, relay.id, true);
        prev = relay.id;
      }
      if (!adjKeys.has(`${prev}\0${skip.to}`)) addAdj(prev, skip.to, true);
    }
  }

  // Step 3: Assign lanes (0..height-1) per column minimizing crossings, keeping repair lowest.
  const height = Math.min(limit, Math.max(1, ...workCols.map((c) => c.length)));
  const trunk = Math.floor((height - 1) / 2);
  const laneOf = new Map<string, number>();

  for (let c = 0; c < workCols.length; c++) {
    const col = workCols[c];
    const parents = col.map((s) =>
      adjEdges.filter((e) => e.to === s.id).map((e) => laneOf.get(e.from)!),
    );
    const prefs = col.map((_, i) => (parents[i].length === 1 ? parents[i][0] : trunk));
    const hasRepair = col.map((s) => stationRepairs(s).length > 0);
    const repairCount = hasRepair.filter(Boolean).length;
    const placements = lanePlacements(col.length, height);

    let best: number[] | undefined;
    let bestScore: [number, number, number, number] | undefined;

    for (const lanes of placements) {
      // Rule: a station with a repair round sits lowest among stations in its column.
      let repairViolation = 0;
      if (repairCount > 0 && repairCount < col.length) {
        const sortedLanes = [...lanes].sort((a, b) => a - b);
        const minRepairLane = sortedLanes[sortedLanes.length - repairCount];
        for (let i = 0; i < col.length; i++) {
          if (hasRepair[i] && lanes[i] < minRepairLane) repairViolation++;
        }
      }

      // Count crossings among edges entering this column from c - 1.
      let crossings = 0;
      if (c > 0) {
        const segs: [number, number][] = [];
        for (let i = 0; i < col.length; i++) {
          for (const pl of parents[i]) segs.push([pl, lanes[i]]);
        }
        for (let a = 0; a < segs.length; a++) {
          for (let b = a + 1; b < segs.length; b++) {
            const df = segs[a][0] - segs[b][0];
            const dt = segs[a][1] - segs[b][1];
            if (df * dt < 0) crossings++;
          }
        }
      }

      let prefCost = 0;
      for (let i = 0; i < col.length; i++) prefCost += Math.abs(lanes[i] - prefs[i]);

      let inversions = 0;
      for (let i = 0; i < col.length; i++) {
        for (let j = i + 1; j < col.length; j++) {
          if (lanes[i] > lanes[j]) inversions++;
        }
      }

      const score: [number, number, number, number] = [repairViolation, crossings, prefCost, inversions];
      if (!bestScore ||
          score[0] < bestScore[0] ||
          (score[0] === bestScore[0] && score[1] < bestScore[1]) ||
          (score[0] === bestScore[0] && score[1] === bestScore[1] && score[2] < bestScore[2]) ||
          (score[0] === bestScore[0] && score[1] === bestScore[1] && score[2] === bestScore[2] && score[3] < bestScore[3])) {
        bestScore = score;
        best = lanes;
      }
    }

    col.forEach((s, i) => laneOf.set(s.id, best![i]));
    // Order stations in each column top-to-bottom by assigned lane.
    col.sort((a, b) => laneOf.get(a.id)! - laneOf.get(b.id)!);
  }

  // Step 4: Detect unavoidable crossings per gap and emit shared junctions.
  const junctions: MetroJunction[] = [];
  for (let c = 0; c < workCols.length - 1; c++) {
    const gapEdges = adjEdges.filter((e) => workColOf.get(e.from) === c && workColOf.get(e.to) === c + 1);
    if (!gapEdges.length) continue;

    // Find all edges involved in at least one strict crossing.
    const crossingIdx = new Set<number>();
    for (let i = 0; i < gapEdges.length; i++) {
      for (let j = i + 1; j < gapEdges.length; j++) {
        const df = laneOf.get(gapEdges[i].from)! - laneOf.get(gapEdges[j].from)!;
        const dt = laneOf.get(gapEdges[i].to)! - laneOf.get(gapEdges[j].to)!;
        if (df * dt < 0) {
          crossingIdx.add(i);
          crossingIdx.add(j);
        }
      }
    }

    const coveredByJunction = new Set<number>();
    if (crossingIdx.size) {
      reduced = true;
      // Merge overlapping vertical lane intervals around crossing edges so no visual wire crosses a junction.
      const spanOf = (e: InternalEdge): [number, number] => {
        const a = laneOf.get(e.from)!, b = laneOf.get(e.to)!;
        return a <= b ? [a, b] : [b, a];
      };
      const intervals: { min: number; max: number; members: Set<number> }[] = [];
      for (const idx of crossingIdx) {
        const [min, max] = spanOf(gapEdges[idx]);
        intervals.push({ min, max, members: new Set([idx]) });
      }
      // Merge overlapping intervals and absorb any gap edge whose vertical span intersects a crossing interval.
      let changed = true;
      while (changed) {
        changed = false;
        for (let i = 0; i < intervals.length; i++) {
          for (let j = i + 1; j < intervals.length; j++) {
            if (intervals[i].min <= intervals[j].max && intervals[j].min <= intervals[i].max) {
              intervals[i].min = Math.min(intervals[i].min, intervals[j].min);
              intervals[i].max = Math.max(intervals[i].max, intervals[j].max);
              for (const m of intervals[j].members) intervals[i].members.add(m);
              intervals.splice(j, 1);
              changed = true;
              break;
            }
          }
          if (changed) break;
        }
        for (let eIdx = 0; eIdx < gapEdges.length; eIdx++) {
          const [emin, emax] = spanOf(gapEdges[eIdx]);
          for (const iv of intervals) {
            if (!iv.members.has(eIdx) && emin <= iv.max && iv.min <= emax) {
              iv.members.add(eIdx);
              iv.min = Math.min(iv.min, emin);
              iv.max = Math.max(iv.max, emax);
              changed = true;
            }
          }
        }
      }
      for (const iv of intervals) {
        const incoming: string[] = [];
        const outgoing: string[] = [];
        for (const idx of iv.members) {
          coveredByJunction.add(idx);
          gapEdges[idx].viaJunction = true;
          incoming.push(gapEdges[idx].from);
          outgoing.push(gapEdges[idx].to);
        }
        const jLane = trunk >= iv.min && trunk <= iv.max ? trunk : iv.min;
        junctions.push({
          afterColumn: c,
          lane: jLane,
          incoming: unique(incoming).sort((a, b) => laneOf.get(a)! - laneOf.get(b)!),
          outgoing: unique(outgoing).sort((a, b) => laneOf.get(a)! - laneOf.get(b)!),
          reduced: true,
        });
      }
    }

    // Any remaining skip-reduced `viaJunction` edge in this gap forms a shared junction with sibling edges sharing its endpoint.
    const remainingSkip = gapEdges
      .map((e, idx) => ({ e, idx }))
      .filter(({ e, idx }) => e.viaJunction && !coveredByJunction.has(idx));
    if (remainingSkip.length) {
      const grouped = new Set<number>(remainingSkip.map((x) => x.idx));
      const touchedTargets = new Set(remainingSkip.map((x) => x.e.to));
      const touchedSources = new Set(remainingSkip.map((x) => x.e.from));
      for (let idx = 0; idx < gapEdges.length; idx++) {
        if (coveredByJunction.has(idx)) continue;
        if (touchedTargets.has(gapEdges[idx].to) || touchedSources.has(gapEdges[idx].from)) {
          grouped.add(idx);
          gapEdges[idx].viaJunction = true;
        }
      }
      const incoming = unique([...grouped].map((idx) => gapEdges[idx].from)).sort((a, b) => laneOf.get(a)! - laneOf.get(b)!);
      const outgoing = unique([...grouped].map((idx) => gapEdges[idx].to)).sort((a, b) => laneOf.get(a)! - laneOf.get(b)!);
      const allLanes = [...incoming, ...outgoing].map((id) => laneOf.get(id)!);
      const minL = Math.min(...allLanes), maxL = Math.max(...allLanes);
      const jLane = trunk >= minL && trunk <= maxL ? trunk : minL;
      junctions.push({ afterColumn: c, lane: jLane, incoming, outgoing, reduced: true });
    }
  }

  const columns: MetroLaneStation[][] = workCols.map((col, c) =>
    col.map((station) => {
      const blockers = originalBlockers.get(station.id);
      const groupedIds = groupedIdsById.get(station.id);
      return {
        station,
        column: c,
        lane: laneOf.get(station.id)!,
        ...(blockers?.length ? { blockers } : {}),
        ...(groupedIds?.length ? { groupedIds } : {}),
      };
    }),
  );

  const flatStations = columns.flat();
  const outEdges: MetroLaneEdge[] = adjEdges.map((e) => ({
    from: e.from,
    to: e.to,
    fromColumn: workColOf.get(e.from)!,
    toColumn: workColOf.get(e.to)!,
    fromLane: laneOf.get(e.from)!,
    toLane: laneOf.get(e.to)!,
    ...(e.viaJunction ? { viaJunction: true } : {}),
  }));

  return {
    lanes: height,
    trunk,
    columns,
    stations: flatStations,
    edges: outEdges,
    junctions,
    reduced,
  };
}
