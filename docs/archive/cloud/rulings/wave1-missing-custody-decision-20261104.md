# Wave 1 C3: unavailable historical archives and the remaining acceptance decision

Date: 2026-11-04 UTC. Fresh read-only Oracle consultation. No project execution or repository mutation.

## Decision

**Keep the exact C3 candidate on HOLD under the present rules. No available substitute satisfies the four historical full-archive custody/read-back requirement. Recommend one explicit, narrowly scoped owner decision accepting that historical custody gap as non-blocking for C3, followed by the already required fresh joint Oracle verdict and actual merged-tree checks.**

This is a recommendation to change an engineering evidence-delivery gate, not a finding that its missing evidence exists or that the gate has been met. No acceptance, merge or source repair is granted by this report.

The distinction is practical and important:

- The current candidate's prescribed runtime qualification has been completed and independently reviewed.
- The four older archives are historical provenance and failure/negative-control records that have not been recovered for durable delivery and full read-back.
- Fresh C3 success supports current behavior. It cannot restore old bytes, prove every old observation again, or erase old failures.
- The original archives are **not currently located in the checked sources**. They are not established to be permanently lost.

More candidate tests, another benchmark, replaying the KILL campaign, or manufacturing replacement archives would not resolve that distinction. With no concrete new recovery lead, the shortest useful action is the bounded owner decision below, not another broad search or execution campaign.

## 1. Scope, authority and verified inputs

The candidate remains C3 **36d3fd584bd403ed7ada95d1d863a8f63e96588b**, tree **0c8c67ede1f13122987802d9a0346cd6e6ecf73b**, containing the defined HYG2/NODE22-PROXY, MCP-ANCESTOR and RUNZ1/RUNZ1-KILL dependent set. The documentary successor H is **87ef8d1f59177badeebf8c863a5ad29abdc20ba1**. The owner evidence commit is **d769dc8b5b1faf87e1c30f356ae0223795f202c6**.

I read the project workflow, binding integration ruling and addendum, C3 final review, owner verification report, previous package archive/negative-control reviews, closure consultation, ancestor-deferral ruling and bounded custody-attempt record. I independently retrieved the published ancestor-deferral ruling and final C3 review, whose text exactly matches the supplied local copies. The owner report was also retrieved at its immutable evidence commit; the supplied local text differs only by one extra trailing newline, not substantive content.

Observed remote identities:

- `universal-hud` at **c9f64e5534a855b636bf70398aa4b66d9d0d4374** contains the ancestor-deferral ruling, blob **1329243a260f1a15c47351a2bd430f8109f756e8**.
- `dots/wave1-compat-integration` at **10617b0379a749639c9fdc7871251244a94d00b8** contains the final C3 review, blob **268e12e3f1ccc8acc9a59aa896991bd9c91d4b49**.
- The owner report at the immutable evidence commit has blob **8c52c7670b965bc6f239e7eafd0a55705e0c5847**.

These current documentary ref reads are not a new complete drift audit or a claim that an integration has occurred. The merger must still compare the then-current target and preserve intervening authorized changes.

The [published ancestor ruling](https://github.com/CartmanFatass/codex-hud/blob/c9f64e5534a855b636bf70398aa4b66d9d0d4374/docs/cloud/rulings/wave1-ancestor-deferral-20261104.md) already removes I1/R2's pre-integration blocking effect by explicit owner decision. The natural PID > 1 denial remains NOT OBSERVED / UNVERIFIED, with its event-triggered post-integration follow-up. Do not ask for that same decision again.

That ruling expressly leaves I2 unchanged. Its cited owner approval includes publishing the four archives, not accepting their non-delivery. The dispatcher likewise reports that public publication and the stopped NODE22 resumption are approved. **Publication permission is therefore not the present blocker. It is not permission to replace the required historical evidence with a claim of completeness.**

AGENTS.md lines 26–35 and dots.md reserve changes to gates for the owner. The integration ruling §6.4, final review I2 and later ancestor ruling explicitly retain full historical custody. General Oracle discretion cannot silently supersede this specific, still-binding requirement.

## 2. What the C3 evidence already establishes

Credit the [final C3 review](https://github.com/CartmanFatass/codex-hud/blob/10617b0379a749639c9fdc7871251244a94d00b8/docs/cloud/handoff/wave1-compat-integration/oracle-c3-final-integration-review-20261104.md) and [owner report](https://github.com/CartmanFatass/codex-hud/blob/d769dc8b5b1faf87e1c30f356ae0223795f202c6/docs/cloud/handoff/local-verification/20261103/wave1-composite-20261104T031916Z-680937/REPORT.md), without repeating their completed work:

- The exact composition was independently checked: all 26 owned entries match their pinned sources, with the remaining implementation/configuration/dependency entries unchanged from U.
- The complete README matrix and prescribed focused commands passed on node22-envproxy, node22-noenvproxy-control and node24-envproxy. All 50 assigned matrix/focused invocations exited 0.
- Existing physical/logical authority controls, strict output/profile checks and K1/K2 proof controls remain in the reviewed sources and executed check set. The old combined Node 22 fixture failures pass on C3.
- All six C3 benchmark processes meet the unchanged absolute gates. The comparison remains **11/12 exit 0** because U's Node 24 cold p95 of **208.678213 ms** failed once. That is a retained baseline failure, not a C3 failure and not twelve green exits.
- The published C3 evidence directory has 4,049 files. Its prior reviewer retrieved 1,022 selected files covering every command's key records, all benchmark records, all 22 KILL captures and the selected proxy captures; all 1,021 applicable published SHA-256 values matched. This is not a claim that this consultation, or that review, independently downloaded and hashed all 4,049 files.
- Published redacted C3 evidence and private originals are distinct. No new raw-to-published transformation audit or protected-original backup is claimed here.

This is strong current-candidate evidence. It is not a historical archive substitution. The owner report expressly excludes the old mutation archive, old diagnostic burst and missing 15:57 snapshot from its new execution. Historical failing-before controls remain supported by attributed prior independent reviews, not by newly recovered raw historical bytes.

## 3. Exact unavailable historical material

The four required publication archives total **1,187,881 bytes**. Sizes/hashes below are prior independently audited identities, not fresh hashes recomputed from recovered files:

| Historical publication material | Bytes | SHA-256 |
| --- | ---: | --- |
| NODE22-PROXY full archive | 545,457 | bf22a3540b29458741609aa8e811917ec4ff48774f3df1a662e0d085727d45fc |
| MCP original sanitized archive | 308,455 | b1b01d2683500441c23f0544eb5ac3546b290a7c563145515c318cddd6bde395 |
| MCP R1 sanitized archive | 43,345 | d96a6dcd0374fc886f7ad992eec11db6b1de27e1f2096a80b437e03e07989070 |
| RUNZ1 corrected sanitized archive | 290,624 | 43afcc2f9bfc464e745b001246b86cac51d0e0c55f1a45f994c4bd0265b31180 |

The preserved package reviews describe meaningful historical material, not merely redundant green logs:

- NODE22-PROXY: 1,588 manifest entries plus the manifest, including original failures, behavioral mutations, strict warning/stream controls, route captures, source/build identities and inherited HYG2 provenance. Its 706-file courier is only a selected subset.
- MCP original: 116 publication members, including negative controls and the twelve old failed benchmark processes. The original production negative-control suites recorded 32 pass / 8 fail versus the original candidate's 40 pass. Those facts remain historical review findings.
- MCP R1: 42 members for the separate close-boundary correction, recorded commands, streams and sanitization metadata.
- RUNZ1 corrected sanitized: 212 regular members, including all 124 original archive members plus fix-1 material and metadata. The prior review independently checked capture proof relations and identity-preserving sanitization. It did not establish durable delivery.

The custody-attempt record documents missing files in the checked workspace/tmp locations and Space export, absent approved evidence directories in the inspected complete package branch trees, and report-only responses from known custodians. The dispatcher additionally reports bounded Drive and cloud-history searches without locating the original bytes or original executor. I did not repeat those searches or independently inspect all those external histories. This consultation treats their bounded negative results as reported search evidence, not proof of universal absence.

## 4. What can and cannot substitute

### A. Exact recovery closes the existing requirement without changing it

A copy from an original executor, a verified export, an immutable remote object, or a lossless encoded/multipart representation is acceptable **if its fully reconstructed archive bytes match the required size and SHA-256**. Then perform authorized durable publication and complete byte read-back, with destination and immutable object identities recorded.

The storage representation may differ while the underlying archive bytes remain identical. Part checksums, an upload receipt, or a filename alone are insufficient. No new permission is needed for the already approved unchanged action, but a new recipient, sensitive content or changed scope still requires its applicable approval.

### B. Complete original payload recovery can reduce the deficit, but is not currently established

If every original sanitized member and the full contemporaneous membership/checksum manifest are later recovered, a reviewer can verify path-by-path bytes, completeness and relevant metadata. This may establish preservation of the historical evidence payload even if tar/gzip container metadata cannot be recovered.

That is not automatically the audited archive. A new container has a new identity and must be labeled as a later repack, with exact recovered coverage and limitations. Under the current explicit exact-archive/read-back gate, accepting payload equivalence instead of the four exact archives requires an explicit amended disposition by the owner, followed by review. No such complete payload recovery is established now. Do not begin speculative repacking to create the appearance of closure.

### C. Presently available secondary evidence is useful but not custody

| Available or proposed material | Legitimate use | What it cannot establish |
| --- | --- | --- |
| Prior independent reviews and recorded hashes | Attributed historical findings; exact recovery targets; preserve old failure chronology | Present possession, complete retrievability or a new raw-byte audit |
| Source commits, source snapshots and build manifests | Bind reviewed implementation/assertion versions | Actual old runtime output, execution chronology or complete negative-control records |
| A recovered NODE22 706-file courier | Preserve and verify exactly that subset | The missing full archive or unrepresented members |
| Fresh C3 logs and captures | Current-candidate qualification and currently executed controls | Historical delivery, all old mutations, old redaction verification or an explanation of the missing 15:57 snapshot |
| A later rerun or newly generated archive | A distinctly dated new experiment, if separately justified and authorized | Reconstruction of the old run or its original bytes |
| A checksum/manifest with absent files | Describe expected identity and membership | Recover those files from their digests or prove current custody |

There is **no present evidence-equivalent replacement** for the complete four historical archives. The practical route below accepts a disclosed deficit; it does not pretend that another artifact fills it.

Never substitute the old unsanitized RUNZ1 archive, private alias maps, protected raw identities or private C3 originals. Public archive authorization covers the named sanitized publication material, not arbitrary raw data. Acquiring new private storage is not an additional C3 gate.

## 5. Risk and recommendation

**Recommend the bounded owner exception.** On the established record this is proportionate for development integration of the exact C3 dependent set because the combined implementation and full required current matrix have passed, substantive fixes remain verified, relevant current safety/proof controls execute, and no new implementation defect was identified.

The risk being accepted is reduced historical auditability and reproducibility: a later reviewer cannot presently inspect all old failures, confirm every historical behavioral mutation from raw output, or independently recheck the historical raw-to-sanitized mapping. Prior review reports preserve their conclusions and exact identities, but not all underlying bytes. A later contradiction may therefore be harder to resolve. The gap does not prove that the old reviewers were wrong; current green results do not prove they were right in every historical detail either.

This is distinct from the already accepted ancestor deferral's real-host uncertainty. Both limitations must remain separately visible. Do not claim universal safety, formal WSL qualification, external/TLS proxy coverage, historical native-wait recovery, or zero residual risk.

No test, identity boundary, privacy rule, runtime/profile requirement, benchmark threshold, source ownership or merged-tree requirement should change. The exception must not automatically extend to another candidate or future missing evidence.

### Exact proposed owner decision

For the frozen C3 commit/tree and the three named dependent packages only:

> Accept the currently unavailable four historical publication archives as a disclosed historical custody gap, and remove their exact recovery/full-archive read-back as a prerequisite to C3's joint acceptance. Permit the final Oracle to rely on the existing attributed historical reviews together with the independently reviewed C3 evidence, without claiming the missing archives were recovered, republished, fully re-audited or replaced. Preserve their exact identities, old failures, prior findings and bounded recovery record. Recover and verify them if a concrete new source becomes available. Retain the separate natural-ancestor deferral, all safety/privacy boundaries, fresh explicit joint Oracle acceptance and the complete three-profile gate on the actual merged tree before push/status promotion. This exception applies only to this unchanged C3 decision.

Suggested single owner question:

> 四份历史测试归档目前仍未找回，已有旧审查记录和精确哈希，但缺少可完整回读的原始归档。这会限制以后复核旧失败和负向对照；本次 C3 的完整测试与现有证据已经通过审查。Oracle 建议仅对这个 C3 候选接受这一历史证据缺口，保留所有旧失败与缺失记录，找到原件后再补齐，随后仍须正式联合验收及完整合并后测试。是否同意取消这四份旧归档作为本次集成前的阻塞条件？

This is a new, specific gate decision. The previous approval to publish four archives does not answer it. If approval is absent or declined, retain HOLD and do not merge. Do not repeatedly seek the same decision without changed facts.

## 6. Shortest authorized route and stopping conditions

1. **Keep C3 frozen.** Retain all completed candidate check credit and the mixed benchmark disposition. Do not rerun the shared matrix, old mutation archives, KILL burst or benchmark merely to compensate for unavailable records.
2. **Preserve one factual gap record.** Keep the four identities, prior review links, confirmed search scope/results, current unavailable/not-read-back status and privacy exclusions. An additive record is enough; it is not a substitute archive or new execution result. Follow the existing serialized documentation writer and authorized destination rules.
3. **Ask once for the exact owner exception above.** Suggested question-record location: `docs/handoff/questions/wave1-historical-custody-exception-20261104.md`. This consultation itself makes no external write.
4. **If approved, record the decision and obtain a fresh explicit joint integration verdict.** The reviewer should reuse unchanged completed C3 rows and issue package-by-package dispositions. It should explicitly say historical custody was excepted by owner decision, not completed. Reopen work only for actual drift, material contradictory evidence or a new relevant failure. This report is not that final accept verdict.
5. **Only after joint acceptance, perform the existing integration workflow.** The sole merger checks then-current target drift and exact implementation identities, performs the history-preserving `--no-ff` integration, and obtains the complete three-profile README checks on the actual merged tree before push/status promotion. Keep failures and the allowed known-flake handling. Candidate results cannot replace that gate.
6. **Recovery remains lead-driven.** Resume bounded archival work if an identified custodian, executable environment, verified export/object locator or complete original payload becomes available. Verify actual bytes before crediting anything. No endless same-source polling, speculative search of private sessions, or permission bypass is justified. Preserve any subsequently found contradictory evidence and send it to a fresh Oracle; do not bury it because integration has happened.

If a concrete archive source appears before the owner decision, ordinary exact recovery is preferable and may make the exception unnecessary for those recovered archives. If no source appears and the owner does not approve the exception, pause dependent integration while continuing unrelated authorized work. The action requiring owner input is the gate change, not another generic project approval.

Even after an approved exception, the archival task must not be reported as successfully delivered. Integration may close under an explicitly accepted historical gap; actual archive recovery remains incomplete unless the real bytes are recovered and read back.

## 7. Resulting ledger

| Item | Current status | If the exact owner exception is approved |
| --- | --- | --- |
| C3 composition and prescribed candidate checks | Completed; retain prior review credit | Unchanged |
| C3 benchmark | Completed; all six candidate gates pass, real U-only failure retained | Unchanged |
| I1 / MCP R2 natural denial | Owner-deferred; non-blocking; still unverified | Unchanged |
| I2 four historical archives | BLOCKED: exact bytes not located; no full read-back | OWNER-ACCEPTED HISTORICAL CUSTODY GAP; non-blocking for exact C3; not recovered/not delivered |
| HYG2/NODE22-PROXY, MCP-ANCESTOR, RUNZ1/RUNZ1-KILL | Joint HOLD under current gate | Eligible for fresh joint accept review, not automatically accepted |
| Actual merged-tree full checks | Not supplied by this consultation | Still mandatory before push/status promotion |

## Sources and method

- [Binding integration ruling, particularly §§5B, 6.4 and 7](https://github.com/CartmanFatass/codex-hud/blob/87ef8d1f59177badeebf8c863a5ad29abdc20ba1/docs/cloud/rulings/wave1-compat-integration-20261103.md).
- [Owner-approved ancestor deferral, particularly the decision and §§5–7](https://github.com/CartmanFatass/codex-hud/blob/c9f64e5534a855b636bf70398aa4b66d9d0d4374/docs/cloud/rulings/wave1-ancestor-deferral-20261104.md).
- [Final C3 review, particularly publication audit and I2](https://github.com/CartmanFatass/codex-hud/blob/10617b0379a749639c9fdc7871251244a94d00b8/docs/cloud/handoff/wave1-compat-integration/oracle-c3-final-integration-review-20261104.md).
- [Owner verification report, particularly §§3–9](https://github.com/CartmanFatass/codex-hud/blob/d769dc8b5b1faf87e1c30f356ae0223795f202c6/docs/cloud/handoff/local-verification/20261103/wave1-composite-20261104T031916Z-680937/REPORT.md).
- [NODE22 archive and negative-control review](https://github.com/CartmanFatass/codex-hud/blob/65b26a914bc0f54d2a4318ebf461a52140238872/docs/cloud/handoff/node22-proxy/review-1.md).
- [MCP original/R1 review](https://github.com/CartmanFatass/codex-hud/blob/dc4b96b8b3e224736cf0aeee4062184a433a023e/docs/cloud/handoff/mcp-ancestor-review-2.md).
- [RUNZ1 corrected-archive and K1/K2 review](https://github.com/CartmanFatass/codex-hud/blob/00d3317303d40a357bf7b3219911e40372631c6d/docs/cloud/handoff/runz1-kill/review-2.md).
- Dispatcher-supplied closure consultation and historical custody-attempt record dated 2026-11-04, plus its reported bounded Drive/cloud-history checks. Search conclusions remain scoped to those reports.

Method: read-only connected GitHub retrieval and local inspection of supplied reports/inventories. No repository build, test, benchmark, topology/capability probe, process control, source edit, Git mutation, external publication, owner-computer action or further delegation. The sole filesystem write is this requested report. The current consultation did not retrieve the four historical archives and does not claim new historical byte/privacy verification.

**Final Oracle disposition: no valid present substitute; I2 still blocks under the existing rule; recommend a specific owner-accepted historical-custody exception for unchanged C3, without false completion claims, redundant testing or relaxed safety boundaries.**
