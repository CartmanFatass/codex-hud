# B10D fairness documentation propagation: fresh Oracle review

Date: 2026-11-04 UTC  
Repository: CartmanFatass/codex-hud  
Reviewed commit: [79202b69ac9882737a9cb7b094f790e816f871ef](https://github.com/CartmanFatass/codex-hud/commit/79202b69ac9882737a9cb7b094f790e816f871ef)  
Sole parent: c9f64e5534a855b636bf70398aa4b66d9d0d4374  
Tree: 236e40d6eeca883f8b5e50418dc4150c65564428

## Verdict

**ACCEPT, strictly for the four-file documentation propagation.**

No P0–P3 defect or required correction was found in this delta. The commit records the already approved, bounded fairness amendment accurately. It does not implement, release, accept or authorize merging B10D, LEG1 or RCP1, and does not grant a compute window.

This verdict is not an implementation acceptance, performance qualification, green-check claim or waiver of a later package's existing review and merged-tree check requirements.

## Verified scope and exact text

The GitHub commit object confirms the sole parent above. The [exact comparison](https://github.com/CartmanFatass/codex-hud/compare/c9f64e5534a855b636bf70398aa4b66d9d0d4374...79202b69ac9882737a9cb7b094f790e816f871ef) is one commit ahead, zero behind, with exactly four modified Markdown files, 28 additions and 8 deletions. No implementation, tests, configuration, dependency, workflow, plan-status or additional file changed.

Each complete head file was compared with its exact parent content after applying only the specified insertions/replacements from the supplied B10D fairness propagation preparation. All four matched exactly, including whitespace. This verifies preservation of unrelated content, rather than only matching the added fragments.

| File | Parent blob | Reviewed blob | Change |
|---|---|---|---|
| docs/contracts/06-observation.md | db22cfecc25280afc8bda425ca08dcfc192ccdf6 | 95b3dab8250a97f64c7b348a78cbcba4c344c879 | +15 / -1 |
| docs/design/hud-information-design.md | e6e60dafedb37b657e22256556c9d72b91e03b8a | 68674711a3a38855e9bb69fbdc5bbfcf9a03e452 | +5 / -0 |
| docs/universal-hud-concept.md | eac96271a8d5f26d2861400d541584655ede2e5e | 06da17d1ea79cccc54e0d0b72eb3faa7ca0ee019 | +1 / -0 |
| docs/handoff/STATE.md | 23e88a175620bcf5071db2f219a1206610e3205e | 83b6dd34ef64ea31f88e712e2e66c05df9aea9f7 | +7 / -7 |

At the final branch read, universal-hud pointed to the reviewed commit and b10d-worker still pointed to 4f2c4aced878e5750e66292ed7c552ffb421165d. The authoritative route ruling remained blob 3c000582ffcf1628f238e6243bc5c2539401fcef.

## Verified semantics

Binding basis: [route §4](https://github.com/CartmanFatass/codex-hud/blob/79202b69ac9882737a9cb7b094f790e816f871ef/docs/cloud/rulings/b10d-route.md#L124-L156), [route §8](https://github.com/CartmanFatass/codex-hud/blob/79202b69ac9882737a9cb7b094f790e816f871ef/docs/cloud/rulings/b10d-route.md#L240-L246), and the supplied exact propagation preparation.

- **Minting is narrow.** Only ordinary fair admission with completed, verified exact recovery, an exhausted granted slice and no first native result can create a ticket. Null, unfinished or mismatched recovery and ordinary native continuation do not qualify.
- **One use of an existing opportunity.** The ticket consumes the next already-authorized ordinary opportunity's sole reader grant and that operation's existing shared deadline/remaining allowance. It creates no operation, timer, root budget, reader/publication grant or independent renewal.
- **Identity and invalidation are complete.** Full SessionRef, scope/source generation, exact accepted recovery target, authority generation and compatible run/binding context are preserved. Incompatible scope/source/head/context, authority expiry/loss/follower state or completed capture invalidates the ticket. Consumed, refused and unusable attempts are spent; immediate rearming from the same recovered state is forbidden.
- **The approved bound is explicit and limited.** For a fixed continuously eligible N-target set, regular traversal takes at most 2N ordinary opportunities, with at most one inserted continuation per regular visit. Ordinary cursor order resumes. This is not a wall-clock I/O completion or settlement guarantee. Blocked targets remain in backlog/age accounting.
- **Original ages and adverse outcomes remain visible.** Creating, attempting, refusing or spending a ticket does not reset original debt, pending-request or latency ages. Regular visits and inserted attempts are recorded separately. Missed deadlines, refused, continued, failed and incomplete work remain evidence, not settled publication. Existing no-ops are not converted into commits or update-success samples.
- **Existing budgets and durable semantics are unchanged.** Shared 8 MiB, one reader grant/at most one selected publication, the 200-node/20,000-header profile, 16 residents, worker/external-buffer/RSS/transport/queue limits, 15 s TTL, renewal at most every 5 s for selected work, latency gates and stage shares remain intact. WAL + FULL, fencing, atomic ObservationCommit, durable reader ACK, B16 continuity/notices and §18 protections remain intact. Repeated loss of valid recovery, hidden retirement debt or broader eviction are not authorized.

These requirements are present in [contract 06 lines 280–292](https://github.com/CartmanFatass/codex-hud/blob/79202b69ac9882737a9cb7b094f790e816f871ef/docs/contracts/06-observation.md#L280-L292), faithfully condensed in [design §6 item 13](https://github.com/CartmanFatass/codex-hud/blob/79202b69ac9882737a9cb7b094f790e816f871ef/docs/design/hud-information-design.md#L875-L879), [concept §15](https://github.com/CartmanFatass/codex-hud/blob/79202b69ac9882737a9cb7b094f790e816f871ef/docs/universal-hud-concept.md#L649), and [STATE](https://github.com/CartmanFatass/codex-hud/blob/79202b69ac9882737a9cb7b094f790e816f871ef/docs/handoff/STATE.md#L93-L99).

## Six required focused tests remain obligations, not results

All six focused requirements in route §4 remain explicit in contract 06's new subsection:

1. Verified exact recovery consumes the first slice; the next ordinary opportunity performs a real native read without repeating the recovery fetch.
2. Spent/refused tickets cannot monopolize later opportunities or rearm the same priority chain.
3. Scope ABA, source/head replacement, expiry and follower takeover reject stale tickets. The propagated text also preserves incompatible context and completed-capture invalidation.
4. The regular 200-target traversal meets the ≤400-opportunity ordering bound at both normal cadences, C=1 s and C=5 s, with separate regular/inserted/blocked/continued accounting.
5. Real native capture is followed through normal durable publication/ACK settlement, rather than treated as success at ticket consumption or reader allocation.
6. A useless next deadline remains failed/continued work and cannot become a renewed priority loop.

The preparation's FT1–FT6 trace details remain future implementation requirements, including no-rescue settlement, the invalidation matrix, B12M shared accounting/lifetime preservation and separate authority-housekeeping negatives. The documentary summary does not claim these fixtures exist or passed.

[T-06-5](https://github.com/CartmanFatass/codex-hud/blob/79202b69ac9882737a9cb7b094f790e816f871ef/docs/contracts/06-observation.md#L382) retains its A9 designation and every preexisting topology/large-record obligation. Its appended text explicitly assigns the new evidence to B and does not replace T-06-16/B14. The full final-image correctness, timing, resource, follower, 30-minute soak/no-rescue drain and B14 requirements remain open.

## No hidden implementation or scope release

[STATE lines 97–99](https://github.com/CartmanFatass/codex-hud/blob/79202b69ac9882737a9cb7b094f790e816f871ef/docs/handoff/STATE.md#L97-L99) explicitly say implementation and focused evidence are pending, the next worker work needs separate admission, and this documentation starts no work or compute window. Incorporating the current base into b10d-worker, consuming B12M and preserving the retained-order cursor correction are future prerequisites, not completed actions.

B10D remains frozen, NOT ACCEPTED and NOT MERGEABLE. Measured failures and retirement-recapture debt are retained. LEG1/RCP1 still need separately resolved and recorded package scope/ownership release. No historical ruling, resource gate, unrelated P065/B19/DOC2 content, queue status or concept §16 content was overwritten.

## Verification limits and actions

Performed only read-only connector retrievals, local source-document reads and in-memory text comparisons. No build, test, probe, benchmark, repository edit, Git mutation, deployment or external write was performed by this reviewer. The sole local write is this requested review artifact outside the repository. No runtime behavior or performance was requalified.

