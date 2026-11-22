# B10D §19 fairness amendment propagation
Date: 2026-11-04 UTC. Fresh read-only Oracle preparation.

## Decision

The already approved §19 fairness exception is ready for **documentation-only propagation** to contract 06, design §6, concept §15 and STATE, using the exact insertions below. This is a transcription and traceability decision, **not** acceptance of the worker, a new implementation release, a compute window, a test result, or permission to implement LEG1/RCP1.

The authoritative limit is **one use of the next already-authorized normal collection opportunity, with one regular N-target traversal taking at most 2N ordinary collection opportunities**. It is not an additional operation, grant, publication stream, deadline, resource budget, lease extension, or whole-tree wall-clock freshness guarantee.

## 1. Source identity and current comparison

Read from GitHub on 2026-11-04 at approximately 09:29–09:33 UTC; all three branch heads rechecked unchanged at 09:38 UTC:

- [universal-hud exact head](https://github.com/CartmanFatass/codex-hud/commit/c9f64e5534a855b636bf70398aa4b66d9d0d4374): `c9f64e5534a855b636bf70398aa4b66d9d0d4374`.
- [frozen b10d-worker exact head](https://github.com/CartmanFatass/codex-hud/commit/4f2c4aced878e5750e66292ed7c552ffb421165d): `4f2c4aced878e5750e66292ed7c552ffb421165d`.
- [integration exact head](https://github.com/CartmanFatass/codex-hud/commit/10617b0379a749639c9fdc7871251244a94d00b8): `10617b0379a749639c9fdc7871251244a94d00b8`.
- [universal-hud versus worker comparison](https://github.com/CartmanFatass/codex-hud/compare/c9f64e5534a855b636bf70398aa4b66d9d0d4374...4f2c4aced878e5750e66292ed7c552ffb421165d): diverged; worker ahead by 1, behind by 102; merge base `6fcf08aef34e2cefa8c7c5ee766b001993e88db9`. The comparison is read-only and does not establish a conflict-free merge.

The four intended files have identical blobs on current universal-hud and the integration head:

| File | Blob SHA on both refs |
|---|---|
| docs/contracts/06-observation.md | db22cfecc25280afc8bda425ca08dcfc192ccdf6 |
| docs/design/hud-information-design.md | e6e60dafedb37b657e22256556c9d72b91e03b8a |
| docs/universal-hud-concept.md | eac96271a8d5f26d2861400d541584655ede2e5e |
| docs/handoff/STATE.md | 23e88a175620bcf5071db2f219a1206610e3205e |

The route ruling also matches on both refs (blob `3c000582ffcf1628f238e6243bc5c2539401fcef`). These identities permit one narrow amendment, not replacement of whole files from the old worker. The worker lacks current STATE/remote orchestration documents and has older contract/concept content.

### What is actually unsynchronized

- [Route §4 and §8](https://github.com/CartmanFatass/codex-hud/blob/c9f64e5534a855b636bf70398aa4b66d9d0d4374/docs/cloud/rulings/b10d-route.md#L124-L156) already contain the one-use rule and exact ≤2N limit.
- [Contract 06 B10C supplement](https://github.com/CartmanFatass/codex-hud/blob/c9f64e5534a855b636bf70398aa4b66d9d0d4374/docs/contracts/06-observation.md#L270-L278) still contains execution/resource/timing rules without the new ticket exception.
- [Design §6 item 13](https://github.com/CartmanFatass/codex-hud/blob/c9f64e5534a855b636bf70398aa4b66d9d0d4374/docs/design/hud-information-design.md#L849-L878) says one grant/shared deadline, but does not state the approved ordering exception.
- [Concept §15](https://github.com/CartmanFatass/codex-hud/blob/c9f64e5534a855b636bf70398aa4b66d9d0d4374/docs/universal-hud-concept.md#L590-L664) has the B10C decision and later remote/P065 decisions, but no B10D fairness entry.
- [STATE](https://github.com/CartmanFatass/codex-hud/blob/c9f64e5534a855b636bf70398aa4b66d9d0d4374/docs/handoff/STATE.md#L93-L99) records authorization only briefly and still calls the answered route consultation the “next Oracle” question.

The earlier one-full-traversal promise is explicit in [the approved B10C ruling line 74](https://github.com/CartmanFatass/codex-hud/blob/c9f64e5534a855b636bf70398aa4b66d9d0d4374/docs/reviews/2026-11-02-astra-b10c-worker.md#L70-L76). Do not claim the existing four files already contain a literal N-opportunity equation. The new normative subsection states precisely the later amendment to that earlier promise.

### Authorization provenance and limits

The [owner-decision record](https://github.com/CartmanFatass/codex-hud/blob/c9f64e5534a855b636bf70398aa4b66d9d0d4374/docs/handoff/questions/B10D-route.md#L72-L80) records the fairness instruction and a later general delegation to follow Oracle recommendations. The specific fairness interpretation is already confirmed in route §4. No fresh owner question is needed merely to record that same interpretation.

Route §8 still separately marks LEG1/RCP1 approval as required. This preparation does not resolve that later general delegation into a new bounded package release, silently edit that register, or commission their implementation. Their separate scope/ownership release must be resolved and recorded independently. The present handoff expressly excludes both.

## 2. Exact normative changes, limited to the four requested sources

Use these locations on the pinned current universal-hud source. Re-read the head/blob leases before any future write and preserve unrelated P065, B19, DOC2 or other content. No historical ruling is overwritten.

### 2.1 Contract 06

Insert the following complete subsection **after** the B10C timing paragraph ending “even when paint passes.” (current line 278), **before** “### B14 观测证据清单”.

```markdown
### B10D 公平续读增补（§19，2026-11-03）

所有者批准并经 Oracle 确认的窄调度例外，见 [B10D route §4、§8](../cloud/rulings/b10d-route.md#4-confirmed-fairness-exception)；它修订 [B10C ruling](../reviews/2026-11-02-astra-b10c-worker.md) 的一轮普通公平机会顺序，不修改资源、延迟或发布吞吐门禁。

1. 仅当一次普通公平准入已完成并核验精确恢复，但该次授予的 slice 已耗尽、尚未取得第一个真实 native result 时，才可为该次准入建立一次性 recovery continuation ticket。null、未完成或不匹配的 recovery 不能建立票据；普通 native continuation 本身也不产生此优先权。
2. 票据必须绑定完整 SessionRef、scope/source generation、精确 accepted recovery target 及 authority generation，并保持 run/binding 等当前上下文相容。它只可使用下一次已经获准的普通 collection opportunity 的单一 reader grant；使用该次操作原有共享 deadline 和剩余预算。
3. 票据不得自发排队、建立 timer、增加操作、取得第二份 root budget、增加 reader grant 或 publication opportunity，亦不得自行续租。保留最初 debt、pending request 和 latency 的起点与年龄，不因建立、尝试、拒绝或消费票据而重置。
4. scope/source/head/context 不相容、authority 过期/丢失/成为 follower 或完成 native capture 时，票据失效。一次已消费、被拒绝或不可用的优先尝试即已用尽；同一已恢复状态不得立即重装成无限优先链。之后恢复普通 cursor 的顺序；真正较后的新一次普通公平准入可建立新工作，但不能伪装成立即重装。
5. 对固定、持续 eligible 的 N 个目标，一轮普通遍历最多占用 2N 次普通 collection opportunities：N 次 regular visits，每次 regular visit 最多插入一次 recovery continuation。普通 cursor 顺序不变；被资源或其他条件阻塞的目标仍保留在 backlog/age 统计中。此为机会顺序上界，不承诺 stalled I/O 的墙钟完成期限，也不把一次获得机会等同于已成功读取或发布。
6. 分别记录 regular visits 与 inserted continuation attempts。missed deadline、refused admission、continued、failed 和 incomplete 结果必须保留；只有真实 capture 经正常持久 publication/ACK 结算后才可报告相应成功，不能以票据消费、reader 分配或旧显示视图代替。既有合法 no-op 保持 no-op，不额外制造新 commit，亦不充当发生更新的成功样本。实际 full-operation interval、原始请求年龄、失败样本和 burst-drain time 都保留。
7. 单次共享 8 MiB、每操作一个 reader grant/至多一个选中 publication、200-node/20,000-header 支持档案、16-reader 上限、worker/外部缓冲/RSS/transport/queue 上限、15 s TTL、至多每 5 s 且仅选中工作续租、三道 latency gates 与各 stage shares 均不变。B12 WAL + FULL、fencing、原子 ObservationCommit、durable reader ACK、B16 notices/continuity 和 §18 accepted-history/partial-tail 保护均不变。不得通过反复丢弃有效恢复、遗漏 retirement debt 或扩大可驱逐条件制造公平或资源通过。

聚焦证据属于 B 阶段，并与 T-06-5/T-06-16 一起追踪：真实精确 recovery 耗尽首个 slice 后，下一普通机会进入真实 native read，且不重取同一 recovery；spent/refused/useless-deadline 票据不垄断或重装；scope ABA、source/head/context 替换、expiry 与 follower takeover 拒绝旧票据；200 个目标在 C=1 s 和 C=5 s 的普通 cadence 下满足 ≤400 次机会的完整 regular traversal，并单列 regular/inserted/blocked/continued；保留原 debt/request ages，最终验证真实持久发布结算。最大合法记录、未接受 capture、失效与失败 accounting 仍有独立反例。聚焦通过不代替最终 image 的完整正确性、性能、资源、follower propagation、30 分钟 soak/no-rescue drain 或 B14 资格；B10D 仍未接受、未合并。
```

Also append this sentence to the **existing T-06-5 acceptance cell** (current line 368), without replacing its existing topology/large-record obligations or its A9 designation:

```text
；B 阶段另按「B10D 公平续读增补」验证一次性 next-normal-opportunity ticket、regular/inserted 分列、固定 N 的 ≤2N 机会顺序及 C=1/5 的真实恢复→native capture→持久结算；此后续证据不改本行原 A9 范围，也不替代 T-06-16/B14 的完整资格
```

This is an acceptance cross-reference, not a new test-number allocation or promotion of B10D implementation into A9.

### 2.2 Design §6

Append the following two indented paragraphs **to item 13**, after its current sentence ending “不是各自 20 ms 相加。” (line 875), before item 14. Preserve all existing cache/memo keys and items 1–16.

```markdown

    （B10D §19 增补，2026-11-03）仅普通公平准入完成并核验精确 recovery、但该 slice 已耗尽且尚无第一个真实 native result 时，可建立一次性 continuation ticket；完整绑定 SessionRef、scope/source generation、accepted recovery target、authority generation 和相容上下文，只消费下一次已经获准的普通 collection opportunity 的单一 reader grant及原共享 deadline/剩余预算。不得另排操作/timer、增 root allowance/reader grant/publication，或由票据自行续租。scope/source/head/context 不相容、authority 过期/丢失/follower 或完成 capture 即失效；消费、拒绝或不可用的优先尝试即用尽，不从同一 recovered state 无限重装，随后恢复普通 cursor 顺序。

    对固定、持续 eligible 的 N 个目标，一轮 regular traversal 从原一轮机会承诺明确修订为最多 2N 次普通 collection opportunities，每次 regular visit 最多插入一次 continuation；regular visits/inserted attempts 分列，被阻塞目标不从 backlog/age 隐去，最初 debt、pending-request 和 latency ages 不重置。它不是墙钟完成期限，missed/continued/refused 不算 settled publication。完整规范与 C=1/5 的恢复→读取→持久结算证据见契约 06「B10D 公平续读增补」及 [route §4](../cloud/rulings/b10d-route.md#4-confirmed-fairness-exception)。§6 #6/B10C 三道门禁与全部资源上限、cadence、lease、B12/B16 持久语义不变；不放宽 §18、不代替 retirement recapture/LEG1/RCP1，也不表示 B10D 已接受或可合并。
```

### 2.3 Concept §15 decision log

Insert this complete table row immediately after the 2026-11-03 remote-orchestration row (current line 648), before the P065 entries:

```markdown
| 2026-11-03 | B10D §19 公平例外：仅普通公平准入完成核验的精确 recovery、slice 耗尽而尚无首个 native result 时，建立绑定完整身份、scope/source、accepted target、authority generation 及相容上下文的一次性 ticket，消费下一已授权普通机会的单一 reader grant。消费/拒绝/不可用即用尽，旧 scope/source/head/context、过期/丢失/follower authority 或完成 capture 使其失效；不自排操作/timer、不增预算/发布、不自行续租、不重置原 debt/request/latency ages。同一恢复状态不可无限重装，之后恢复普通 cursor；固定持续 eligible 的 N 目标一轮明确允许最多 2N 次普通机会，regular/inserted 分报、blocked backlog/age 不隐藏；不是墙钟完成保证。200-node/20,000-header、16 readers、全部数值门禁/lease/B12/B16/§18 约束不变。须有 C=1/5、旧票拒绝、真实恢复→native capture→持久结算证据；不等于完成 LEG1/RCP1/retirement 或接受/合并 B10D | 所有者批准；Oracle [B10D route §4、§8](./cloud/rulings/b10d-route.md#4-confirmed-fairness-exception) 确认；契约 06「B10D 公平续读增补」、设计 §6 #13 |
```

Preserve every existing P065 amendment and §16. The date records the original approval, not an assertion that implementation happened on that date.

### 2.4 STATE

Replace only the current two paragraphs beginning “The owner authorized the fairness exception…” and “The route question for the next Oracle…” (lines 93–99) with:

```markdown
The owner-authorized §19 fairness exception is Oracle-confirmed in [B10D route §4 and §8](../cloud/rulings/b10d-route.md#4-confirmed-fairness-exception) and recorded in contract 06 “B10D 公平续读增补”, design §6 #13 and concept §15. A normal fair admission that completes verified exact recovery but has no first native result because its granted slice ended may create one ticket for the next already-authorized ordinary collection opportunity's single reader grant. Bind it to full session identity, scope/source generation, exact accepted target and authority generation/current compatible context. Spent, refused or unusable attempts cannot rearm an immediate priority chain; stale context/head/source/scope, expired/lost/follower authority or completed capture invalidates the ticket, and the ordinary cursor resumes.

For a fixed continuously eligible set of N, a regular traversal may consume at most 2N ordinary opportunities, with regular visits and inserted attempts reported separately. Keep blocked targets and original debt/pending-request/latency ages visible. No new operation, timer, root allowance, read/publication grant, authority renewal, numeric-gate waiver or §18 exception is granted. This is opportunity ordering, not a wall-clock completion guarantee.

Implementation and focused evidence remain pending. The next separately admitted B10D work must first incorporate current universal-hud into b10d-worker, adopt B12M's metered recovery handoff, preserve the retained-order cursor correction, and implement/test the bounded ticket and authority housekeeping serially with overlapping collector/link work. It must show actual next-opportunity native progress without repeating the exact recovery, one-use/refusal/expiry/ABA safety, ≤400-opportunity regular traversal for 200 targets at C=1 s and C=5 s, unchanged age/accounting and real publication settlement. This documentation does not start that work or grant a compute window.

B10D remains frozen at 4f2c4ac, NOT ACCEPTED and NOT MERGEABLE. The measured failures and retirement-recapture gap above remain open. LEG1/RCP1 need their own separately resolved and recorded package scope/ownership release; this fairness amendment neither implements nor releases them. The full route is already recorded in docs/cloud/rulings/b10d-route.md, with the owner-decision record in docs/handoff/questions/B10D-route.md.
```

Replace only the short B10D bullet under “Decisions recorded on 2026-11-03” (current line 159) with:

```markdown
- B10D fairness exception: owner-approved and Oracle-confirmed; contract 06, design §6 #13 and concept §15 record one-use next-normal-opportunity continuation and the explicit fixed-N ≤2N ordering bound. Original debt/request ages, blocked backlog, one-reader/one-publication limits and all numeric/durable-semantics gates remain unchanged. Implementation/evidence are pending and B10D remains NOT ACCEPTED / NOT MERGEABLE. See questions/B10D-route.md and ../cloud/rulings/b10d-route.md.
```

Do not update the package queue to “implemented”, “accepted”, or “released”; do not edit the plan status to imply a package merge.

## 3. Current source and existing test trace

These are source inspections, not executed tests.

| Concern | Exact current source | Finding relevant to the amendment |
|---|---|---|
| Ordinary read cursor | [worker read-plan.ts L15–60](https://github.com/CartmanFatass/codex-hud/blob/4f2c4aced878e5750e66292ed7c552ffb421165d/src/core/link/read-plan.ts#L15-L60) | Already finds the cursor in full retained order, then selects the eligible subset. Preserve this correction. It has no one-use ticket input or lifecycle. |
| Current base cursor difference | [universal-hud read-plan.ts L24–36](https://github.com/CartmanFatass/codex-hud/blob/c9f64e5534a855b636bf70398aa4b66d9d0d4374/src/core/link/read-plan.ts#L24-L36) | Still finds the previous cursor in the filtered eligible array. A future base merge must not erase the worker's retained-order correction. |
| Opportunity accounting/ages | [worker tick.ts L405–451](https://github.com/CartmanFatass/codex-hud/blob/4f2c4aced878e5750e66292ed7c552ffb421165d/src/core/link/tick.ts#L405-L451) | One selected target; ordinary cursor advances and eligibleSince is reset at each grant. A new ticket path cannot reuse this to silently reset original demand/request latency. Distinguish “since last regular service” from unresolved demand age. Current stats do not distinguish regular versus ticket attempts. |
| Exact checkpoint-only recovery gap | [worker delegation.ts L982–1077](https://github.com/CartmanFatass/codex-hud/blob/4f2c4aced878e5750e66292ed7c552ffb421165d/src/collectors/delegation.ts#L982-L1077) | claim/admit → readRecovery → acceptRecovery → retained checkpoint → recoveryPending=false → exhausted-slice return before adapter.open/read. This is the narrow minting point. Other refusals, unfinished recovery and ordinary native continuations are not the same condition. |
| Recovery proof and authority | [publisher.ts L37–85](https://github.com/CartmanFatass/codex-hud/blob/4f2c4aced878e5750e66292ed7c552ffb421165d/src/core/link/publisher.ts#L37-L85), [L114–139](https://github.com/CartmanFatass/codex-hud/blob/4f2c4aced878e5750e66292ed7c552ffb421165d/src/core/link/publisher.ts#L114-L139), [L199–209](https://github.com/CartmanFatass/codex-hud/blob/4f2c4aced878e5750e66292ed7c552ffb421165d/src/core/link/publisher.ts#L199-L209), [L343–362](https://github.com/CartmanFatass/codex-hud/blob/4f2c4aced878e5750e66292ed7c552ffb421165d/src/core/link/publisher.ts#L343-L362) | Existing exact target/provenance validation and claim/forget semantics must remain. A ticket cannot turn claim reacquisition into continuity of an expired authority or make the previous accepted marker valid under a new context. |
| Pending/blocked and original debt | [delegation.ts L404–418](https://github.com/CartmanFatass/codex-hud/blob/4f2c4aced878e5750e66292ed7c552ffb421165d/src/collectors/delegation.ts#L404-L418), [L852–918](https://github.com/CartmanFatass/codex-hud/blob/4f2c4aced878e5750e66292ed7c552ffb421165d/src/collectors/delegation.ts#L852-L918) | owedSince retains initial debt. pending() returns null on spent deadline and excludes retiring/retirementBlocked. Neither is proof of settlement; new traces must not lose those ages. Retirement integration is separately still open. |
| Resident bounds and accepted pins | [delegation.ts L275–363](https://github.com/CartmanFatass/codex-hud/blob/4f2c4aced878e5750e66292ed7c552ffb421165d/src/collectors/delegation.ts#L275-L363) | Checkpoint-only recovery already counts as resident. Preserve its state while valid; do not remove accepted-history/partial-tail guards to reduce the counter. |
| Expired checkpoint-only cleanup hole | [delegation.ts L477–490](https://github.com/CartmanFatass/codex-hud/blob/4f2c4aced878e5750e66292ed7c552ffb421165d/src/collectors/delegation.ts#L477-L490), [L598–633](https://github.com/CartmanFatass/codex-hud/blob/4f2c4aced878e5750e66292ed7c552ffb421165d/src/collectors/delegation.ts#L598-L633) | publishOne skips entries without hasReading before validity cleanup. Adding a ticket alone is not proof expired checkpoint-only residents are reclaimed correctly. |
| Metered recovery prerequisite | [current PreparedObservationStore L42–60](https://github.com/CartmanFatass/codex-hud/blob/c9f64e5534a855b636bf70398aa4b66d9d0d4374/src/core/interfaces/observation-store.ts#L42-L60), [B12M handoff](https://github.com/CartmanFatass/codex-hud/blob/c9f64e5534a855b636bf70398aa4b66d9d0d4374/docs/cloud/handoff/b12m.md) | readRecoveryMetered/activateRecoveryGrant are already on current base. Both inspected collector variants still call legacy readRecovery. Merging B12M source is not adoption; the later collector must consume metering and charge lazy use after ACK to the current grant exactly once. |

### Existing coverage does not prove the new exception

1. [unit b10d-fairness.test.ts](https://github.com/CartmanFatass/codex-hud/blob/4f2c4aced878e5750e66292ed7c552ffb421165d/tests/unit/b10d-fairness.test.ts#L15-L24) and [integration b10d-fairness.test.mjs](https://github.com/CartmanFatass/codex-hud/blob/4f2c4aced878e5750e66292ed7c552ffb421165d/tests/int/b10d-fairness.test.mjs#L9-L45) prove the retained-cursor/follower-prefix correction; the integration test uses a mock port. Neither exercises a ticket.
2. [“dormant recovery survives a spent slice”](https://github.com/CartmanFatass/codex-hud/blob/4f2c4aced878e5750e66292ed7c552ffb421165d/tests/int/b10d-worker.test.mjs#L241-L279) uses real worker/store, a 45 ms gate and 20 targets. It permits up to 120 rapid harness steps before a changed commit and checks recovery fetched once. It is useful retention/max-record coverage, **not** proof of progress on the immediately next normal opportunity, C=1/5 cadence or a 200-target ≤400 ordering trace.
3. [exact recovery provenance](https://github.com/CartmanFatass/codex-hud/blob/4f2c4aced878e5750e66292ed7c552ffb421165d/tests/int/b10d-review-fixes.test.mjs#L788-L815) already varies SessionRef, seqDomain, commitSeq, sourceGeneration, content identity, runId, bindingGeneration and inputLedgerSeq. Extend the *ticket* lifecycle coverage rather than weakening this accepted-boundary proof.
4. [null/continued recovery](https://github.com/CartmanFatass/codex-hud/blob/4f2c4aced878e5750e66292ed7c552ffb421165d/tests/int/b10d-review-fixes.test.mjs#L817-L855) already prevents a marker/native-boundary advance on incomplete recovery. Add “no ticket minted” assertions.
5. [expired owner/follower](https://github.com/CartmanFatass/codex-hud/blob/4f2c4aced878e5750e66292ed7c552ffb421165d/tests/int/b10d-review-fixes.test.mjs#L514-L595) has a controlled Date.now clock. It is semantic evidence only, not a real-elapsed cadence/TTL qualification.
6. [worker/queue/root-budget regressions](https://github.com/CartmanFatass/codex-hud/blob/4f2c4aced878e5750e66292ed7c552ffb421165d/tests/int/b10d-worker.test.mjs#L21-L217) protect no extra grants and bounded coalescing; preserve them for ticket insertion.
7. [B12M metered tests](https://github.com/CartmanFatass/codex-hud/blob/c9f64e5534a855b636bf70398aa4b66d9d0d4374/tests/unit/b12m-metered.test.ts) cover size/deadline/stale/error accounting. Those do not by themselves establish worker integration.

## 4. Required implementation test trace, for a future separately admitted package

The following are acceptance specifications, not tests run or code added now.

### Trace vocabulary

One row per authorized ordinary collection opportunity, including refused, spent-deadline and incomplete opportunities. Record:

- monotonic operation identity and original request enqueue time; normal cadence and actual arrival/start/end times; coalesced-pending oldest enqueue time;
- regular cursor before/after, selected target, selection class `regular` or `recovery_continuation` (or explicit no-grant reason), and the ordinary admission identity that minted a ticket;
- full synthetic SessionRef, scope epoch (including ABA), source generation, exact accepted target tuple (ref, seqDomain, commitSeq, sourceGeneration, checkpoint identity), run/binding context, holder/lease generation and observed expiry validity;
- recovery started/completed/continued/refused, exact-recovery fetch count, remaining shared bytes/records/deadline, native read started/result captured, failure/continuation reason;
- ticket created/attempted/spent/invalidated and reason; no automatic rearm on the same admission;
- reader-grant and publication-attempt counts, residency, resource-block reason, backlog, initial debt/request age and last regular service age separately;
- selected publication's exact target/demand, durable COMMIT result, reader ACK, accepted settlement, known incomplete/failed outcome; compatible paint when measured.

Diagnostic IDs and events must remain bounded and synthetic. Trace visibility is not a license for a new production queue or persistence format.

### FT1. Successful next-opportunity continuation

Declare a real accepted target A, ordinary retained order [A,B,C], unchanged authority and source/context, and a test-only deterministic point at which **verified exact recovery completes but consumes the first granted slice**.

- Opportunity 1: regular A; recovery target verified exactly once; no native result; ticket minted; ordinary cursor becomes A; original demand/enqueue ages retained.
- Opportunity 2: A's ticket consumes that opportunity's one normal reader grant; no repeated exact recovery fetch; actual adapter read/capture occurs when a legal remaining slice exists. The regular cursor still resumes after A, not after a priority queue.
- Opportunity 3: regular B, even if A still owes publication or its next native result is continued.
- Publication is selected only by the existing single-publication path. Follow A through durable publication/ACK and exact demand settlement, without an added input event. Do not require publication to occur in opportunity 2 if the independent fair publication order selects a different target.

The test must fail if the priority path is removed: ordinary B would be selected at opportunity 2. Merely showing A eventually progresses within 120 steps is insufficient.

### FT2. Spend-on-attempt, unusable deadlines and no priority chain

Repeat FT1 with opportunity 2 refused by admission, with zero remaining legal slice, with a thrown read, and with a continued native result. The attempt is recorded and spent; opportunity 3 resumes regular B; A cannot immediately rearm the same admission. Keep A's unresolved original debt/latency age. No manufactured success, duplicate root allowance, second read/publication or self-enqueued operation.

A normal opportunity whose budget is already unusable remains explicitly failed/continued in the full operation trace; do not delete it from the report to produce a favorable ordering or latency statistic. The ≤2N statement is about the regular-plus-inserted scheduling order, not a promise of I/O success in an unusable grant. If an implementation cannot substantiate the approved opportunity-count claim without excluding blocked attempts, it must return that discrepancy to a fresh Oracle rather than redefine the denominator.

### FT3. Complete invalidation matrix

Mint a ticket, then change one condition before its due opportunity: scope A→B→A with a new epoch; source replacement/reset; accepted head/commit/content identity replacement; run/binding context replacement; lease expiry; follower takeover or changed authority generation; completed capture. Assert no old recovery/native state crosses the boundary, no old-generation renewal/publication/ACK, ticket spent/invalidated exactly once, original known debt/outcomes retained as appropriate, and regular cursor continues. Null/continued/mismatched recovery never mints a ticket.

Use real store/readers for proof. Controlled clocks can prove semantic branches, but cannot substitute for the real-cadence evidence below.

### FT4. Fixed 200-target fairness, both normal cadences

Predeclare a fixed continuously eligible 200-target set and stable retained order, with controlled cases producing zero, some and one eligible ticket per regular visit. Run at **real normal C=1 s and C=5 s**, without accelerated production cadence or lease-clock manipulation for this qualification.

For each complete regular traversal, count regular visits and inserted attempts separately: 200 regular visits, 0–200 inserted attempts, at most 400 ordinary opportunities in the regular-plus-inserted order. Each continuously eligible target receives its next regular opportunity by that bound; no resource-blocked target disappears from backlog/age accounting. Preserve all skipped/no-grant/refused/deadline rows and actual elapsed/drain time separately. Cursor order must match the retained order even after preceding targets stop being eligible, including the permanent follower-prefix regression.

This test is an **ordering** assertion. It must not assert all 200 publications settle within 400 opportunities merely from the ordering bound. Settlement requires its own exact final-demand result and predeclared drain bound. N=1, small N and traversal wraparound should have deterministic unit coverage as well.

### FT5. Budget, large-record and lifetime preservation

Use the real B12M grant for completed recovery and subsequent lazy lookups, including use after ACK. Combine native and recovery charges once under the single operation allowance, preserving the original deadline. Cover maximum legal record including LF/signatures, thrown/continued recovery/read, valid checkpoint retention between recovery and first read, spent ticket after a native continuation, and unaccepted captures/pending publication. Keep ≤16 residents and all existing hard-memory qualification requirements; an observed lower reader count is not proof of external-buffer/disposal compliance.

### FT6. Housekeeping safety and separation from wider liveness

Independently test pure admission-readiness checks before doomed claim I/O, and genuinely expired/lost checkpoint-only authority cleanup with no competitor release, timer/renewal loop, deletion of debt, ACK fabrication or erased known outcome. Show that valid checkpoint-only recovery is not discarded merely to free a slot.

Retain the separate §18 nonempty approval/ended-history/partial-tail negatives and the evicted-owed retirement regression. Tickets do not make those states evictable or implement retirement recapture. The route's complete no-rescue liveness, real 30-minute simultaneous bar/panel soak, final-image timing/resource and follower evidence remain required before B10D acceptance.

## 5. Ownership and sequencing

1. **Now: source-linked documentation preparation only.** The Oracle owns the exact interpretation/trace map in this artifact; the main dispatcher may archive a ruling and serialize approved documentation changes by the repository's [AGENTS.md](https://github.com/CartmanFatass/codex-hud/blob/c9f64e5534a855b636bf70398aa4b66d9d0d4374/AGENTS.md#L21-L40) and [dots.md](https://github.com/CartmanFatass/codex-hud/blob/c9f64e5534a855b636bf70398aa4b66d9d0d4374/docs/cloud/dots.md#L9-L43) rules. This consultation has not applied them.
2. **Four-file propagation should be one narrow, serialized transaction.** Review exact current refs/blobs first; preserve P065 amendments and unrelated decisions. Do not copy old worker versions over current docs. A document-only recording does not import worker code or satisfy merged-tree checks.
3. **Respect shared-document ownership.** STATE/plan/shared docs remain single-writer dispatcher-serialized under the [resource-window ruling](https://github.com/CartmanFatass/codex-hud/blob/c9f64e5534a855b636bf70398aa4b66d9d0d4374/docs/cloud/rulings/wave1-resource-windows-20261103.md#L15-L28). DOC2 owns its existing design-document task; coordinate this exact §6 insertion rather than starting simultaneous whole-file edits or silently expanding DOC2's brief. DOC2/TPD1 readiness still follows the actual B10B-S3F merge prerequisite, not this text.
4. **Future worker implementation requires a named package and valid compute admission.** First merge then-current universal-hud **into** b10d-worker, preserving B10B-s2, current panel/TPD1 changes and the worker's retained-cursor correction. This is not a worker merge into universal-hud, and it is not performed now.
5. **B10D-owned overlapping changes stay serial:** collector/link ticket lifecycle, planner/age accounting, admitted authority housekeeping, B12M consumption and retirement recapture. Candidate files for the ticket slice are `src/collectors/delegation.ts`, `src/core/link/tick.ts`, `src/core/link/read-plan.ts`, and narrowly necessary existing publisher lifecycle access/tests. Any additional interface or worker-protocol changes require a bounded brief; this map does not automatically release all these paths.
6. **Other owners retain their boundaries.** B12M owns the existing recovery meter APIs; fairness consumes them. LEG1 owns its separately released legacy catalog/tree scope. RCP1 native/checkpoint/B16 owners own exact durable continuation and allocation/disposal expansion. The ticket must not implement a private RCP1 in the collector. Entry wiring remains a later coordinated integration with TPD1.
7. **No test/compute permission is inferred.** Existing lifecycle/custody and resource-window restrictions remain. Preparation does not establish that the shared executor is quiescent or authorize replaying any interrupted command.
8. **Acceptance remains unchanged:** fresh final Oracle review on exact final source, all named correctness/liveness/resource/latency evidence, full green merged-tree check set, then only the established `--no-ff` merge rule. No main writes, force-push, history rewrite, local-only tests or live-home access.

## 6. Verification performed and remaining outcome

Performed: connector reads of exact refs/trees/files and compare metadata; static source/test inspection; local read-only text searches; saved this report and source snapshots outside any repository. No repository file was changed, no Git mutation occurred, no code/build/test/probe/benchmark ran, and no subagent was started.

**Outcome:** accept the above exact text as the narrow documentation propagation plan. **No verdict of accept for B10D implementation.** The next safe deliverable is the four-file documentary synchronization, if the parent chooses to execute its existing recording authority under current serialization constraints. Worker/LEG1/RCP1 implementation remains outside this consultation.

