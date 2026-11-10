Verdict: changes-required

# TEST-SLIM-0 — round 2

## Findings

### 1. Major — Round-1 finding 1 is only partially fixed: explicit associations still route to unrelated proofs

**Locations:** external `file-map.py:27`, `file-map.py:114`, `inventory.json:108804`; `docs/testing.md:211`. External paths here are under `<repo-parent>/MyHUD/tmp/tasks/TEST-SLIM-0/`.

Replacing the filename fallback with literal assignments fixes the mechanism, but several assignments and an owning-test row still do not describe the boundaries their tests exercise:

- **`native-call-display.test.ts` is associated only with C07/C17**, both native-wake behaviours. Its seven cases exercise `NativeCallCollector`, relation discovery, raw-state rendering, unavailable-source handling, terminal-escape sanitization, selection preservation and resumed-connection filtering. They do not exercise native wake delivery, failed wake transport or pointer-only notifications. For example, its case at line 178 proves that a resumed connection excludes the old connection's events, not either mapped wake invariant.
- **`b11-cli.test.ts` is associated only with H01/H06/H07**, respectively MCP schemas, stdio framing and delegate configuration. H01/H06 do not describe its CLI parser/handler proofs. Its cases at lines 413 and 607 prove durable cancellation after a failed refresh and local resume replay/stale/active checks; those behaviours are absent from its associations. The proposal's process-audit row repeats these misleading IDs. Frozen membership forbids editing the test, not correcting its routing metadata.
- **R01 still claims apply/restore recovery ownership through `runtime-install.test.mjs:205`**, but that named case runs only default/help/preview and checks that the directories remain empty. It never applies or restores a release. The actual interruption proof at line 173 is now separately owned by R09; the ordinary apply/restore proof is at line 220. The compound R01 text was not narrowed to its actual named proof.

**Failure scenario:** a brief author changing resumed native-call display follows the inventory to a wake test rather than the existing collector/render proof; an activation-recovery author follows R01 to a preview-only test. These are ordinary uses of the routing guide, and preserve the substantive problem from the earlier major finding despite the corrected original examples.

**Suggested fix:** review the remaining literal associations against their assertions, route the display and CLI cases to matching existing or newly registered behaviour owners, and narrow compound rows such as R01 to what the named case actually proves. Regenerate inventory/proposal references without modifying frozen tests; the structural validator alone cannot establish these semantic associations.

## Verified

### Earlier findings and scope

- **Round-1 finding 1: partially fixed.** Source-body inspection confirms C08 now owns the derived source-union/relabelling/cloning proof at `materials.test.ts:316`; C11 owns cache reauthorization at `:452`; C12 owns truncation at `model-jobs.test.ts:187`. H01/H06/H07 correctly identify schema, framing and configuration proofs at `skeleton.test.ts:427/:564/:124`. Snapshot associations are now exactly B10/B11/B12 and match its actual assertions. The remaining problems are listed above, not a repetition of those repaired examples.
- **Round-1 finding 2: fixed.** Map §4 and proposal §3b explicitly retain `tests/fakes/pi-package.mjs` as real installed-package/loader discovery. Consolidation inputs now name the inline package API/context stand-ins and real-host adapter, without replacing loader/discovery proofs. Inventory separates installed discovery from fake-pi references.
- Full tracked diff against `f1d086ed3c7d1b5668c95685d87015ae5d323346` is empty; the complete untracked `docs/testing.md` was read. Status is only `?? docs/testing.md`. No product, test, WP0 or visual-baseline edits are present.
- Read the briefs, prior review, revised notes/report, QA q1/q5/q6, map, proposal and association/validation helpers. CodeGraph reported this worktree unindexed; subsequent inspection used source reads/searches.

### Consolidation and coverage spot-checks

Independently spot-checked five clusters against actual source bodies, without executing tests:

- **C1:** replacement-root/helper QA cases retain physical-proof versus content-novelty distinctions, answer anchors and stall timing through the real fixture draw path.
- **C2:** primary-output cases retain actual write/start/continuation-floor checks and the existing absence of an mtime-at-or-before-settlement upper bound.
- **C3:** helper-review output separately retains the stricter mtime-at-or-before-settlement requirement.
- **C4:** compose/queued/running revocations execute real `submitJob` paths, assert no transport, and preserve the distinct running-phase reservation accounting; atomic cache revocation retains cache-byte assertions.
- **C12:** both mutation drivers contain the same control-module guard replacement and select `panel intent precedes split`. The proposal removes only the duplicate variant, retaining its target test and the other driver. No other unconditional ordinary-case deletion is proposed.

The coverage plan still requires source-mapped covered-line/branch set subtraction, selected-case execution checks, explicit handling of missing child/emitted mappings, and specific exceptions for any loss. It does not treat suite-union percentages as per-test uniqueness. Implementation of that comparator and closure of attribution gaps remain later-slice work.

### Commands and saved evidence

- `python3 <repo-parent>/MyHUD/tmp/tasks/TEST-SLIM-0/validate.py` — **exit 0**: 400 paths/source hashes, 138,126 scoped lines, 167 owner handles, 4,493 historical unit cases, 5,473 measured default results and no frozen perf migration. This is structural validation, not proof against the semantic finding.
- Absolute-path inventory `JSON.parse` command — **exit 0**.
- `npx --no-install prettier --check --ignore-path /dev/null docs/testing.md` — **exit 0**, “All matched files use Prettier code style!”
- Independent read-only owner/source, snapshot, discovery-classification, frozen-perf and check-log assertions — **exit 0**. An initial reviewer assertion incorrectly expected the discovery reference in `pi-package.test.mjs`; inspection located its actual consumer, `pi-owned-orchestration.test.ts`, and the corrected check passed. This was a reviewer-check error, not a product failure.
- Independent filesystem census — **320 unit TS + 43 direct mjs + 22 hud-mcp TS = 385 default files**.
- All six round-2 static logs are fresh relative to the revised artifacts and end in **`exit=0`**: review-fixes, prettier, inventory, validation, scope and diff.
- Saved full-suite/coverage evidence predates the documentation fixes, so it is not a fresh post-fix gate. QA q6 expressly permits this design-stage exception; no build/test/benchmark/coverage rerun was performed. Saved metadata, raw result summaries and driver exits agree: unit **4,466 pass / 1 fail / 26 skip, exit 1**; mjs **759 / 0 / 2, exit 0**; MCP **218 / 0 / 1, exit 0**. Baseline wall is **801.123 s**, peak waited-child RSS **1,212,828 KiB**, not simultaneous tree RSS.
- The unit failure remains the recorded P2 timing assertion, **quiet p95 4.329968 ms > 2 ms**. QA q5 waived its isolated rerun. This is not a green merge/performance baseline, and is not a new finding.
- `git diff --check` — **exit 0**; final worktree status remains only the new Markdown file.

Report: `<repo-parent>/MyHUD/tmp/tasks/TEST-SLIM-0/review-2.md` — 1 finding (1 major; earlier finding partially unresolved).
