# LEG1: owner acceptance of the bounded-freshness direction

Date: 2026-11-04 UTC. Role: fresh read-only Oracle.

Inspected repository image: `CartmanFatass/codex-hud`, `universal-hud@4d0b7f146a55cbd631a31a8ce6b6ca9f33ee6dd2`.

## 1. Decision and exact scope

**Record the bounded inactive-file discovery policy as an owner-accepted future direction, subject to measurement and a concrete recorded qualification envelope. Retain the current strict production collection behavior.**

The answer resolves whether the bounded-delay direction is acceptable to investigate and develop toward. It does not establish the eventual delay, guaranteed service quotas, resource fit, successful qualification or permission to change production now.

The previous F1 impossibility result is unchanged: without examining every relevant inactive file or having an authoritative complete mutation source, bounded polling cannot guarantee the strict baseline’s next-collection detection of every otherwise-unhinted, stat-visible same-path mutation.

Status after this decision:

- Direction-level owner question: **answered, accepted conditionally on measurement and explicit limits**.
- Concrete inactive-discovery policy and finite service envelope: **not yet established**.
- Strict production behavior: **retained**.
- LEG1 implementation/ownership/compute release: **not granted**.
- LEG1 or B10D acceptance, merge readiness and production qualification: **not granted**.

This is a decision record, not a final package review or an `accept` verdict.

## 2. Owner evidence

The initial question was sent at 09:53:03 UTC. The dispatcher subsequently disambiguated the two pending matters at 10:40:42 UTC, and the owner answered at 10:40:49 UTC.

<transcript_evidence>
Assistant:

LEG1 的刷新权衡已有结论：对任意未提示的旧文件改写，**不全量检查又保证下一轮必然发现**，在现有信息来源下无法同时做到；文件监听也不能作为完全可靠的替代。

Oracle 建议：暂时保留现有严格行为。未来可以考虑“优先文件立即检查、其他文件在明确上限内发现”的模式，但必须先测出并写明实际延迟、资源上限和落后状态，不能先承诺 30 秒。你是否接受把这种**有界延迟模式作为后续可行方向**？这次不会立即改变生产行为，具体数值仍需验证后确定。

Assistant:

收到。为避免把两个待确认事项混淆，请问你确认接受的是 C3 历史证据归档例外，还是 LEG1 有界发现延迟方向，还是两项都接受？

User:

both
</transcript_evidence>

The C3 decision is separate and receives no disposition in this LEG1 ruling. Approval of one does not supply evidence or waive gates for the other.

## 3. Consequences for the existing LEG1 ruling

The new owner answer supersedes only the “no specific acceptance of a slower LEG1 discovery direction has been supplied” premise in the earlier freshness disposition.

Preserve its technical analysis, baseline limitations, finite-service requirements, truthful coverage requirements and execution restrictions. Do not rewrite its historical decision as if production had already changed.

In particular:

1. Immediate verification of priority/current paths and strict selection APIs remain required. “Immediate” is the existing applicable collection behavior, not a new zero-latency wall-clock promise.
2. Bounded inactive repair must include duplicate losers, negative entries and independent directory discovery. Watching only the currently reachable tree does not solve undiscovered membership.
3. Watchers remain hints. All-hints-dropped recovery is required.
4. Equal-observation-boundary data parity, cross-opportunity discovery parity, fixed-input convergence and production qualification remain separate claims.
5. The supported 200-node/20,000-header profile and existing latency, memory, reader, publication and durability limits remain unchanged.
6. Thirty seconds remains a header revalidation eligibility age in the existing implementation, not an accepted full-inventory discovery bound.
7. The proposed catalog caps are not proven sufficient. Capacity failure within a supported case is not permission to reclassify it as unsupported.
8. A warning or degraded label cannot substitute for progress or establish that the measured delay is acceptable.
9. Existing strict public APIs **and their actual production callers** remain unchanged. Keeping an unused strict API while switching its caller to stale catalog results would violate this disposition.

## 4. Concrete envelope still required

Before production replacement can be qualified, record and prove the envelope required by the prior freshness ruling §§7C–8:

- Admitted file count, directory count and actual directory-entry work: `N`, `D`, `E`.
- Minimum successful signature and directory service per ordinary opportunity, plus maximum work ceilings: `q_s`, `q_e`.
- Guaranteed header completion and/or actual byte progress, including verification, parsing and assembly: `q_h`, `b_h`.
- Maximum gap between repair-service grants: `K_gap`.
- Bounded propagation from verified changes through duplicate/dependency updates into a complete visible tree: `K_tree`.
- Eligibility rules, fair order, overdue-work retention, overload/failure behavior and truthful age/coverage reporting.

For example, a fixed readable inventory can support a signature-sweep bound of:

`K_detect <= K_gap * ceil(N / q_s)`

only when `q_s` is a guaranteed successful service floor under stated preconditions, not merely a configured maximum. Visible convergence also includes directory discovery where applicable, header work and complete-tree propagation.

C=1 s and C=5 s are nominal cadences. They do not by themselves prove a wall-clock bound under stalls, suspension, missing grants or failures. Record ordinary opportunities, missed grants and elapsed time separately.

The legacy first-line reader currently compares decoded JavaScript string length against `MAX_FIRST_LINE_BYTES`. It does not establish a 1 MiB actual-read bound. Multibyte input, chunk overread, parsed objects and continuations must be accounted for. Do not silently narrow accepted legacy header behavior to make the measurement fit.

No numerical quota or wall-clock SLO is selected by this ruling.

## 5. Next permissible work

### Now

The dispatcher may:

1. Archive this ruling and the exact owner decision under `docs/handoff/questions/LEG1-freshness.md`.
2. Add a factual status note to STATE and the concept decision log, clearly distinguishing direction acceptance from implementation and qualification.
3. Continue already authorized queue work.
4. Commission a fresh **read-only** Oracle preparation task to reconcile the conditional LEG1 brief with this answer and produce an exact future measurement/qualification plan.

That preparation may inventory source behavior, define evidence fields, identify unresolved service allocation and compare ownership. It must leave unmeasured numerical claims marked unqualified. It must not start an implementation, benchmark or production change.

There is no need to ask the owner again whether the general direction is acceptable.

### Before implementation or measurement

The existing ordered prerequisites remain:

- Finish the earlier waves and the B10D route’s serial prerequisites.
- Pin the actual accepted integration base.
- Reconcile the exact LEG1 whitelist against accepted data-producer work, RCP1 and B10D ownership.
- Record any required interface/design amendment and exclusive file handoff.
- Assign a collision-checked branch/worktree and a bounded execution window with authoritative lifecycle/cleanup prerequisites satisfied.

A new read-only brief is not any of these releases. Different tool processes on the same executor do not constitute independent execution environments.

If a staged engine-only implementation is later proposed to obtain measurements, it needs an explicit separately released brief. It must keep optimized adapters unadopted, retain strict callers and label its outcome **engine-only, no production freshness qualification**. This ruling does not release that stage early.

### Before production adoption

The resulting actual service envelope and user-visible delay must be explicitly recorded and accepted for the production policy, with supported-runtime evidence and the prescribed fresh Oracle review. The present answer cannot be used as acceptance of whatever delay is eventually observed.

LEG1 engine evidence does not replace later B10D-2 actual-entry tests, simultaneous bar/panel populations, fairness/publication checks, soak/drain or B14 formal qualification.

## 6. Verified source facts and method

The four collector files at the inspected image still have these blob identities:

- `src/collectors/session-finder.ts`: `30ed4c4d805a492ff49b410311ee11f0ab206fce`
- `src/collectors/subagent-tree.ts`: `a040d7e0f9220344715c92b5c0bc7d2d6e113160`
- `src/collectors/hud-status.ts`: `06c67217cf19b04267feea96cc511dd6982e6619`
- `src/collectors/tree-scan-store.ts`: `67aa8f4704786b64cd8cf8c300a21da6b4b9e042`

Source inspection reconfirmed:

- The synchronous finder stats every listed rollout.
- The tree builder re-peeks stat-visible non-append changes and handles scheduled same-signature revalidation separately.
- `HudStatus` still invokes the synchronous tree builder when no supplied tree exists.
- The first-line reader’s limit is checked using decoded string length.

No tests, builds, probes, dependency changes, branch mutations, production changes or repository publication were performed by this Oracle.

## 7. Sources

- [LEG1 freshness disposition](https://github.com/CartmanFatass/codex-hud/blob/4d0b7f146a55cbd631a31a8ce6b6ca9f33ee6dd2/docs/cloud/rulings/leg1-freshness-disposition-20261104.md)
- [LEG1 conditional brief](https://github.com/CartmanFatass/codex-hud/blob/4d0b7f146a55cbd631a31a8ce6b6ca9f33ee6dd2/docs/cloud/rulings/leg1-conditional-brief-20261104.md)
- [B10D route and package order](https://github.com/CartmanFatass/codex-hud/blob/4d0b7f146a55cbd631a31a8ce6b6ca9f33ee6dd2/docs/cloud/rulings/b10d-route.md)
- [Queue ruling](https://github.com/CartmanFatass/codex-hud/blob/4d0b7f146a55cbd631a31a8ce6b6ca9f33ee6dd2/docs/cloud/rulings/queue-progress-20261103.md)
- [RCP1 conditional scope](https://github.com/CartmanFatass/codex-hud/blob/4d0b7f146a55cbd631a31a8ce6b6ca9f33ee6dd2/docs/cloud/rulings/rcp1-conditional-brief-20261104.md)
- [dots workflow](https://github.com/CartmanFatass/codex-hud/blob/4d0b7f146a55cbd631a31a8ce6b6ca9f33ee6dd2/docs/cloud/dots.md)
- [Contract 06](https://github.com/CartmanFatass/codex-hud/blob/4d0b7f146a55cbd631a31a8ce6b6ca9f33ee6dd2/docs/contracts/06-observation.md)
- [Design §6](https://github.com/CartmanFatass/codex-hud/blob/4d0b7f146a55cbd631a31a8ce6b6ca9f33ee6dd2/docs/design/hud-information-design.md#6-性能规则g13)

**Final disposition: record the accepted future direction; retain strict production behavior; prepare the bounded evidence plan without releasing execution or declaring F1 qualified.**
