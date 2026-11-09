Verdict: changes-required

# PIROLE-PR2-PI — round 1 review

Reviewed against `856e576c5c2da09a8caea6f48057b93a86f5532d`, including all ten untracked files. Three actionable findings: two major, one minor.

## Findings

### 1. Helpers bypass the managed-integration preflight

**`src/roles/pi-owned/helpers.ts:209–218` — Major.** Helper launch goes directly from contract validation to pane allocation/start without the integration discovery and cached-file identity checks used by `launchOwned`.

**Failure scenario:** An implementer is already running when its managed integration is replaced or becomes outdated, while the file retains the same ID/version header. `readSlotContract` / `persistContract` check that header, but neither establishes that `herdr integration status` still reports the declared integration as current. `callHelper` nevertheless starts another pi with that file. This is particularly relevant because helpers run inside the primary pi process, not the original launcher process: that process never performs its own discovery at all. Matching synthetic owner/session evidence does not establish the integration's provenance or currency.

**Suggested fix:** Share the launch preflight with helpers, performing bounded process-local discovery and cached identity/content revalidation before helper resource mutations. Add helper-path tests for an outdated integration and a replaced cached hook; the existing integration replacement test only invokes `launchOwned`.

### 2. Stall recovery accepts a different prompt when whitespace changes

**`src/roles/pi-owned/prompt.ts:40–44` — Major.** `editorHasPrompt` deletes all whitespace from both strings, so it does not require the complete original prompt before authorizing Enter.

**Failure scenario:** The intended prompt is `Read /tmp/job space/brief.md and do exactly what it asks.`, but the idle editor contains `Read /tmp/jobspace/brief.md and do exactly what it asks.`. The comparison returns true despite the different path. Following `agent_prompt_stalled` with no persisted message, `submitPrompt` can submit this different task by sending Enter. Soft-wrap tolerance must not erase meaningful spaces inside paths or elsewhere in the single-line command.

**Suggested fix:** Match the original characters, allowing only evidenced display wrapping/padding; refuse ambiguous whitespace rather than normalize it away. Test both a legitimately wrapped prompt and a whitespace-altered path. The existing wrong-editor test changes non-whitespace text and misses this case.

### 3. Same-key replay restores the obsolete initial right pane

**`src/roles/pi-owned/launch.ts:221–225` — Minor.** Replaying an acknowledged primary split unconditionally replaces the current journal's right pane with the original split result.

**Failure scenario:** The original right pane disappears; `callHelper` creates and records a replacement through `helper_split_1`. A subsequent `launchOwned` call for the same contract obtains the original `split` acknowledgment from `Runtime.effect`, overwrites `journal.right` with the disappeared pane, and rewrites `SESSION.txt` accordingly. The next helper creates another split even though the recorded replacement was still present and reusable. This corrupts the compatibility projection and creates avoidable resources during recovery.

**Suggested fix:** Preserve the latest recorded right-pane locator when replaying the original split; reconstruct it from that acknowledgment only when no later replacement exists. Extend the disappeared-pane test with same-key replay and another helper, asserting that the replacement and split count remain unchanged.

## Verified

- Read the task/review briefs, implementer notes, full architect design, decided design, planning q1–q4 and answers, PR2 runtime/endpoint approval, and applicable repository agent guidance. Read the tracked diff, every untracked source/test file, and the relevant PR1/transport/process seams.
- No production facade selection, worker-extension, renderer, settings, i18n, or A2 resolver changes are present. Structured argv construction reuses PR1.
- The exercised paths persist sent intent before mutations, avoid retrying ambiguous sent steps, gate initial prompts on worker/session evidence, use the closing fence/resource lock, and leave STATUS ownership with workers. Cleanup uses full process stamps and argv checks for SIGTERM rather than workload SIGKILL.
- The subprocess fake records mutating requests and uses real synthetic worker processes for session/owner/STATUS/artifact publication. The supplied four behavioral mutations are killed by assertions, not loader failures.

### Commands and actual results

Each requested command ran with a fresh temporary `HOME` / `HUD_HOME`, with `NO_COLOR` and `FORCE_COLOR` unset. Runtime: Node `v24.22.1`.

| Command | Actual output / result |
| --- | --- |
| `npm run build` | `node ./node_modules/typescript/bin/tsc && node scripts/copy-jev-assets.mjs dist` — exit 0 |
| `npm run build:test` | `node ./node_modules/typescript/bin/tsc -p tsconfig.test.json && node scripts/copy-jev-assets.mjs dist-test` — exit 0 |
| `npm run build:hud-mcp` | `node ./node_modules/typescript/bin/tsc -p packages/hud-mcp/tsconfig.json` — exit 0 |
| `npm run test:unit` | `tests 4140`, `pass 4114`, `fail 0`, `cancelled 0`, `skipped 26` — exit 0 |
| `npm run test:mjs` | `tests 399`, `pass 398`, `fail 0`, `cancelled 0`, `skipped 1` — exit 0 |
| `npm run test:hud-mcp` | `tests 219`, `pass 218`, `fail 0`, `cancelled 0`, `skipped 1` — exit 0 |
| `bash tests/run-main.sh` | `run-main summary: files=113 tests=1176 pass=1176 fail=0`; `run-main: TAP covers every named node:test title` — exit 0 |
| `npm run check:fixtures` | `check-fixtures: OK (tests/fixtures tests/prototypes docs/probes docs/design)` — exit 0 |
| `npm run format:check` | `All matched files use Prettier code style!` — exit 0 |
| `git diff --check` | No output — exit 0 |
| `node tests/pi-owned-mutations.mjs` | `4/4 behavioral mutants killed; original source/build untouched.` — exit 0 |

No requested check failed, so no isolated failure rerun was needed. The cold-launch cost test is included in the passing unit suite; I do not claim independently captured percentile numbers from its omitted diagnostic output.

### Additional-probe limitation

The orchestrator approved temporary, in-memory probes for helper preflight, right-pane replay, and exact editor matching. The read-only shell guard blocked the combined invocation before execution. Per that approval's instruction, I did not work around the guard. **No behavioral result was obtained for any of these three additional probes:** the findings above are source-traced defects, not claimed reproduced failures. The named checks and supplied mutation runner did execute successfully. No real herdr, pi, or provider acceptance was performed.

Report: `tmp/tasks/PIROLE-PR2-PI/review-1.md` — 3 findings.
