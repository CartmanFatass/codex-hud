# Cloud run 2 summary (2026-11-03)

Orchestrator: the cloud session. Run 2 used new roles:
- **Oracle:** Opus, max effort.
- **Core implementer:** Opus, high effort.
- **Frontend implementer:** Sonnet, xhigh effort.

The roles and the briefs are on `cloud/briefs-2`.

Nothing is merged. The owner's local orchestrator merges after its own acceptance.

## Branches

| Branch | Base | State | Handoff |
|---|---|---|---|
| `cloud/b12m` (run 1) | `universal-hud` | accepted | `handoff/b12m.md` on that branch |
| `cloud/b10b-s2` (run 1) | `universal-hud` | accepted | `handoff/b10b-s2.md` on that branch |
| `cloud/briefs-2` | `universal-hud` | docs | run-2 roles, the B10B-s3 and HYG1 briefs, known flakes, this summary |
| `cloud/hyg1` | `universal-hud` | accepted | `handoff/hyg1.md` on that branch |
| `cloud/b10b-s3` | `cloud/b10b-s2` | _pending the final review_ | `handoff/b10b-s3.md` on that branch |
| `cloud/hyg1-wip`, `cloud/b10b-s3-wip` | — | snapshots pushed while work was in flight | superseded by the final branches; safe to delete |

**Suggested merge order:**
1. `cloud/b12m` and `cloud/hyg1`. They are independent and touch disjoint files.
2. `cloud/b10b-s2`.
3. `cloud/b10b-s3`, which contains `cloud/b10b-s2`.

## Run 2 packages

### HYG1: a clean cloud test baseline (tests only)

**Status: accepted.**
- One final review.
- One fix round.
- A re-check by a fresh Opus max Oracle.

**Result.** The base's 7 failing and 7 cancelled tests are down to 1 deliberate failure.

| File | Cause | Fix |
|---|---|---|
| `hud-link-export` | Node 22 prints a SQLite warning on stderr. | Filtered on Node 22 only. |
| `b45-launch` | The test awaited an unref'd child; Node 22's runner cancelled it. | Race against a rejecting 10 s timer. |
| `b12-store` | A dead helper hung the IPC calls. | It now fails fast with the helper's stderr. |

**Product defect for the owner** (left failing):
- `run-control`: `proveGroupGone` never proves a zombie-only group gone. This is against contract 04 ScopeCheck and T-04-5, T-04-11 and T-02-14.
- The implementer's one-scan patch is **withdrawn as unsafe**. The review reproduced two races that would end a run while a live process remains.
- The handoff describes a corroborated direction.

### B10B-s3: delegation panel, segment 3 (selection, navigation, control bar)

_Filled in after the final review._

## Decisions waiting for the owner

1. **Merge and local acceptance** of the four accepted branches. Rerun the performance gates locally; the cloud host is noisy.
2. **Design-doc amendments from the B10B-s2 rulings:**
   - the delegation line grammar (Q3);
   - the summary row's drop order and the `2▸ 1✗ 1✓` count (Q4);
   - always drawing a root card (Q10);
   - omitting lines the data cannot fill (Q2).
3. **Design-doc wording from the B10B-s3 rulings:**
   - §3.7's Log row means headless, active or ended;
   - §2's "trouble" means §3.2's first bucket;
   - "⇢ 只有 Reconcile" in §3.3 and §4.8;
   - §4.13's bar sample.
4. **`proveGroupGone`:** a fix with corroboration (HYG1 handoff).
5. **P-06-5 scope:** does the 30 ms budget include the pre-lock preparation I/O? This drives the `ledger_busy` flake family.
6. **`src/tree-page.ts` (with B10D):**
   - the dispatcher for the B10B-s3 actions: `delegation-open`, `-log`, `-copy`, `-diagnostic`, and the Switch label;
   - passing the view model to the three `reconcileMonitor` calls;
   - the activity hub's `target` action.
7. **B10B-s2's `factsEqual`** uses `new Function`. The guard was widened in B10B-s3. Keep it, or switch to a static unrolled comparator.
8. **The cold tick** (every node changed) is printed but not gated; it runs about 14–18 ms p99 on the cloud host.

## Next packages

- **B10B-s4, the Inspector (§4.11).** Delegation keys, greyed-Open reasons, the Resume diagnostic, Coverage with `omittedConflictRows`.
- **The data layer (B9/B16):**
  - action, brief and rate fields, and the native digest;
  - `node.parent` for the viewpoint root;
  - a reconcile descriptor per conflict relation;
  - picker-label inputs;
  - the real resume gate after B14.
- **The `proveGroupGone` fix, with race tests.**
