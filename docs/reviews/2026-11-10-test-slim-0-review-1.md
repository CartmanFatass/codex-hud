Verdict: changes-required

# TEST-SLIM-0 — round 1

## Findings

### 1. Major — Behaviour-to-test associations do not consistently describe the actual proofs

**Locations:** `docs/testing.md:92`, `docs/testing.md:182`; external `inventory.json:140214`.

Several associations point to tests that never exercise the stated behaviour, so the map is not yet a reliable project-level routing guide.

- **C08** claims ownership of summary provenance and cache semantics, but its named owner, `model-jobs.test.ts:187`, only calls `headTail` and `tail` and checks truncation. It creates no summary, material envelope or cache. Existing actual provenance/cache proofs include `materials.test.ts:316` (derived source union) and `materials.test.ts:452` (reauthorization before cache hits).
- **H01** claims MCP protocol/tool/schema/error ownership, but its named owner, `skeleton.test.ts:124`, only validates/loads `delegate.json`. The same file has actual protocol/schema tests at lines 427 and 564 that the row does not identify.
- The inventory has the same semantic problem: `snapshot.test.ts` is associated only with **P08** (Work visual modes/hitboxes) and **P11** (explicit Inspector interaction). Its actual assertions concern public JSON, missing-versus-zero fields, bar segment coordinates and atomic/private snapshot publication; it exercises neither mapped panel behaviour. The filename-family fallback in `build-deliverables.py` explains this result, but labelling these associations as navigation does not satisfy the requested inventory of behaviours each file tests.

**Failure scenario:** a future brief changing inherited-summary cache authorization or MCP input schemas follows C08/H01 and extends a truncation/configuration test rather than the existing boundary proof. Conversely, a snapshot change cannot find its actual owning behaviour in the inventory. This perpetuates the package-local testing problem this stage is meant to resolve.

**Suggested fix:** inspect and correct the semantic associations, splitting compound behaviours where their proofs belong to different owners. Name existing cases that execute each claimed boundary, and regenerate the inventory from those reviewed associations rather than assigning unrelated catch-all IDs. Keep frozen tests unchanged and identify them as routing pointers.

### 2. Minor — follow-up: the pi consolidation plan mistakes an installed-package locator for a fake protocol

**Locations:** `docs/testing.md:234`; external `proposal.md:243`.

`tests/fakes/pi-package.mjs` is listed as scenario handling to absorb into the shared pi fake/package profile, but its entire implementation discovers the real installed pi package and verifies the loader's presence; it provides no event, UI, tool or lifecycle simulation.

**Failure scenario:** the foundation slice follows that migration row looking for package scenarios in this file, or replaces real package discovery with fake availability, while the actual package API stand-ins remain inline in `pi-package.test.mjs` and `tests/fixtures/pi-package-host.mjs`. The separate requirement to retain real loader proofs makes this nonblocking, but the migration source is incorrect.

**Suggested fix:** retain this helper explicitly as real installed-package discovery, and name the actual inline/host API stand-ins as the package-profile consolidation inputs. Do not treat discovery as a fourth fake wire protocol.

## Verified

### Scope and substantive review

- Read the task/review briefs, implementation notes/report, the complete new `docs/testing.md`, inventory generation/validation helpers, proposal sections 3a–3h, applicable project guidance, architecture/reference material and contract supersession boundaries.
- `git diff f1d086ed3c7d1b5668c95685d87015ae5d323346` is empty; `git status --short` lists only `?? docs/testing.md`. No product, test, WP0 or visual-baseline changes are present.
- Independently checked **five clusters against actual test bodies**:
  - **C1:** the six QA cases retain distinct helper/primary authority, absent versus negative Task evidence, identical physical rewrites, proof-loss anchors and exact answer/stall timing.
  - **C2:** primary output folds retain physical write/start/continuation-floor checks and the existing absence of a report-mtime upper bound at settlement.
  - **C3:** helper review folds preserve the stricter output-mtime-at-or-before-settlement rule, helper epoch checks and current primary authority. Distinct Inspector cases remain kept.
  - **C4:** proposed rows retain real compose, queue, running, cache-hit, response-validation, telemetry and settlement callback paths. Pending expiry, revocation precedence and post-reservation accounting remain separate kept cases.
  - **C12:** parsed both mutation variants and confirmed the identical emitted control module, before/after replacement and selected `panel intent precedes split` assertion. Removing only this duplicate variant does not remove its target test or sole guard proof. No other unconditional ordinary-case deletion is proposed.
- Frozen membership independently agrees with `main-features.json`: **121 mapped scoped files plus 2 visual-only files**. The proposed perf selection contains no frozen file.
- Proposal 3h specifies candidate/retained per-test before/after coverage, covered-line/branch set subtraction, source-map and emitted-identity checks, and explicit failure/manual resolution for missing mappings or child-only coverage. That design detects a lost uniquely covered line once attribution is complete; aggregate percentages are not accepted as substitutes. The current summary correctly disclaims per-test attribution. The actual source-mapped comparator and gap closure still belong to later slices, not this completed stage.

### Commands and saved evidence

- `npx --no-install prettier --check docs/testing.md` — **exit 0**, “All matched files use Prettier code style!”
- `npx --no-install prettier --check --ignore-path /dev/null docs/testing.md` — **exit 0**; checks the Markdown despite repository ignore rules.
- Required absolute-path inventory `JSON.parse` command — **exit 0**.
- `python3 <repo-parent>/MyHUD/tmp/tasks/TEST-SLIM-0/validate.py` — **exit 0**: 400 paths/source hashes, 138,126 lines, 99 owner handles, 4,493 historical cases, 5,473 measured default cases and no frozen perf migrations. Its structural checks do not establish the semantic associations raised in finding 1.
- Independent `ls` census — **320 unit TS / 43 direct mjs / 22 hud-mcp files**.
- Independent read-only parsing of the historical gate log — **4,493 results**, excluding the three embedded B21 child results; **1,332.547345958 summed seconds**, **180 cases over 1 s**, **52 over 5 s**. Reported wall time is **350.680374122 s**.
- Saved baseline logs/driver exits and metadata agree: unit **4,466 pass / 1 fail / 26 skip**, mjs **759 / 0 / 2**, MCP **218 / 0 / 1**. Whole-driver wall **801.123 s**, peak waited-child RSS **1,212,828 KiB**. All three builds passed. All **1,831 lcov SF records** have closing records.
- The baseline failure is the reported P2 render timing assertion, **quiet p95 4.329968 ms > 2 ms**. QA q5 waived its isolated rerun; QA q6 explicitly confirmed the design-stage freshness exception and static-only review. I did not report that authorized exception as a new defect or rerun builds/tests/coverage. No test file was added or touched, so there are no changed-code focused tests to execute.
- An initial reviewer census script exited 1 because it incorrectly required the shared mutation test selector to occur only once across the entire driver; the corrected variant-scoped check passed. This was a reviewer-check error, not a repository failure.
- `git diff --check` — **exit 0**. Final status remains only the new Markdown file.

Report: `<repo-parent>/MyHUD/tmp/tasks/TEST-SLIM-0/review-1.md` — 2 findings (1 major, 1 minor follow-up).
