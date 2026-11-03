/**
 * Where the selection of the delegation view is, and where it goes (design §3.2 "选中跟着节点走而不是跟着行号走";
 * rulings B10B-s3 Q2, Q7).
 *
 * The destinations are the plan's rows; in rich a card's sub-rows past the fifth live in its `+N (…)` line and are
 * none. One rule, applied by the reconcile every frame and by every key:
 *
 *  1. a destination stays selected;
 *  2. a key `tree.selectionMap` maps (intent → session) continues as the mapped key;
 *  3. a node still in the projection that is no destination (put away, under a collapsed `+N`, a sub-row past the
 *     fifth) goes to its nearest destination ancestor, or to that ancestor's `⊕N` row when its branch was put away
 *     into it;
 *  4. a `⊕N` row is identified by its parent, not by its place: it stays selected while that parent has one,
 *     wherever the row moves (the selection is rewritten to its current key); with the parent's row gone, a hidden
 *     parent resolves by rule 3 and a shown parent takes the row now at the old place, clamped;
 *  5. otherwise the first destination, or none.
 *
 * A hit is one map lookup (the plan's own index); the ancestor walks run only on a miss. Pure.
 */

import { drawnRows } from './cards.js';
import type { DelegationProjection, PNode } from './projection.js';
import { parsePutKey, type PlannedRow, type RowPlan } from './rows.js';

export type PanelStyle = 'rich' | 'compact';

/** The rows the selection can stand on, in screen order, and where each is. */
export interface Destinations {
  rows: readonly PlannedRow[];
  index: ReadonlyMap<string, number>;
}

const destinationMemo = new WeakMap<RowPlan, Partial<Record<PanelStyle, Destinations>>>();

/**
 * The plan's destinations in a style, in screen order: all its rows in compact; in rich the rows as the cards draw them
 * (a native sub-row sits inside its ancestor card, the sub-rows past a card’s fifth are folded away and are none).
 */
export function destinationsOf(plan: RowPlan, style: PanelStyle): Destinations {
  let byStyle = destinationMemo.get(plan);
  if (!byStyle) destinationMemo.set(plan, (byStyle = {}));
  let hit = byStyle[style];
  if (!hit) {
    if (style === 'compact') hit = { rows: plan.rows, index: plan.index };
    else {
      const rows = drawnRows(plan);
      hit = { rows, index: new Map(rows.map((row, i) => [row.key, i])) };
    }
    byStyle[style] = hit;
  }
  return hit;
}

const nodeMemo = new WeakMap<DelegationProjection, Map<string, PNode>>();
/** Every projected node by key, the conflict rows of their own included (they are not in `byKey`). */
function nodeOf(proj: DelegationProjection, key: string): PNode | undefined {
  const direct = proj.byKey.get(key);
  if (direct) return direct;
  let all = nodeMemo.get(proj);
  if (!all) {
    all = new Map();
    for (const pn of proj.nodes) all.set(pn.key, pn);
    nodeMemo.set(proj, all);
  }
  return all.get(key);
}

/** A node that is no destination: its nearest destination ancestor, or the `⊕N` row that took its branch. */
function hiddenTo(key: string, proj: DelegationProjection, plan: RowPlan, dest: Destinations): string | null {
  let child = nodeOf(proj, key);
  for (let at = child?.parent ?? null; child && at; child = at, at = at.parent) {
    if (!dest.index.has(at.key)) continue;
    const put = plan.away.get(child.key);
    return put !== undefined && dest.index.has(put) ? put : at.key;
  }
  return dest.rows[0]?.key ?? null;
}

/**
 * The key the selection stands on after this frame: `selected` itself while it is a destination, else where rules 2-5
 * send it. `map` is the view model's `tree.selectionMap`.
 */
export function resolveSelection(
  selected: string | null,
  proj: DelegationProjection,
  plan: RowPlan,
  dest: Destinations,
  map: Readonly<Record<string, string>> = proj.vm.tree.selectionMap
): string | null {
  const first = dest.rows[0]?.key ?? null;
  let key = selected;
  for (let hops = 0; hops < 16 && key !== null; hops++) {
    if (dest.index.has(key)) return key;
    const put = parsePutKey(key);
    if (put) {
      const row = plan.putRows.get(put.parentKey);
      // The parent still has a `⊕N` row: the same row, at its current place.
      if (row !== undefined) return plan.rows[row].key;
      const parent = nodeOf(proj, put.parentKey);
      if (!parent) return first;
      if (!dest.index.has(parent.key)) return hiddenTo(parent.key, proj, plan, dest);
      // The parent is shown and its row is gone (`a` brought the rows back): the row now at the old place.
      const at = plan.rows[Math.min(put.index, plan.rows.length - 1)];
      if (!at) return first;
      return dest.index.has(at.key) ? at.key : hiddenTo(at.key, proj, plan, dest);
    }
    const mapped = Object.hasOwn(map, key) ? map[key] : undefined;
    if (mapped !== undefined && mapped !== key) {
      key = mapped;
      continue;
    }
    return nodeOf(proj, key) ? hiddenTo(key, proj, plan, dest) : first;
  }
  return first;
}

// ---------------------------------------------------------------------------
// `n` / `N` (rulings B10B-s3 Q7)

const stopMemo = new WeakMap<Destinations, readonly number[]>();

/**
 * The places, in screen order, `n` and `N` stop at: a destination whose own marker is in the first bucket (`rank` 0:
 * `⚑`, a live `!`, `⚠`, and `?` that is uncertain, supervisor lost, stale or unknown), the viewpoint root's own
 * marker excluded; and a destination that stands for a stop it hides (a collapsed row over a `⚑`, a card whose sixth
 * sub-row is one), which is why they never unfold anything. A conflict claim past the node budget has no node and no
 * row: the summary row counts it (`N not loaded`), and it makes no row a stop (orchestrator decision after review 1).
 */
export function stopsOf(proj: DelegationProjection, dest: Destinations): readonly number[] {
  let hit = stopMemo.get(dest);
  if (hit) return hit;
  const marked = new Set<number>();
  const represent = (pn: PNode | null) => {
    for (let at = pn; at; at = at.parent) {
      const place = dest.index.get(at.key);
      if (place !== undefined) {
        marked.add(place);
        return;
      }
    }
  };
  const stop = (pn: PNode) => pn.proj.marker.rank === 0 && !pn.proj.isRoot;
  for (const pn of proj.nodes) {
    if (!stop(pn)) continue;
    // A stop that is a destination stands for itself, one that is not for its nearest destination ancestor.
    represent(pn);
  }
  hit = [...marked].sort((a, b) => a - b);
  stopMemo.set(dest, hit);
  return hit;
}

/** The place `n` (`delta` 1) or `N` (-1) goes to from `from`, wrapping; null when there is no stop. */
export function stepStop(stops: readonly number[], from: number, delta: 1 | -1): number | null {
  if (stops.length === 0) return null;
  if (delta > 0) return stops.find((place) => place > from) ?? stops[0];
  for (let i = stops.length - 1; i >= 0; i--) if (stops[i] < from) return stops[i];
  return stops[stops.length - 1];
}
