import type { LinkTreeInput } from './types.js';

export const LINK_TREE_LIMITS = Object.freeze({ maxNodes: 200, maxBytes: 8 * 1024 * 1024, maxCrossHarnessDepth: 4 });

export function linkTreeBudget(budget: LinkTreeInput['budget'] = {}): {
  maxNodes: number;
  maxBytes: number;
  maxCrossHarnessDepth: number;
} {
  const bounded = (value: number | undefined, cap: number) => {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new TypeError('invalid_link_budget');
    return Math.min(value ?? cap, cap);
  };
  return {
    maxNodes: bounded(budget.maxNodes, LINK_TREE_LIMITS.maxNodes),
    maxBytes: bounded(budget.maxBytes, LINK_TREE_LIMITS.maxBytes),
    maxCrossHarnessDepth: bounded(budget.maxCrossHarnessDepth, LINK_TREE_LIMITS.maxCrossHarnessDepth),
  };
}
