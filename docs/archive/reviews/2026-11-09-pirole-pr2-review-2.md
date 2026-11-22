Verdict: accept

# PIROLE-PR2-PI — round 2 review

No actionable findings. All three findings from round 1 are fixed; none was declined. No new regression was identified in the fixes.

Reviewed `git diff 856e576c5c2da09a8caea6f48057b93a86f5532d` and all ten untracked source/test files reported by `git status --short`, against the task brief, binding architect/design documents, planning q1–q4 rulings, applicable repository guidance, and PR2 endpoint/runtime rulings. Implementer notes were treated as claims, not acceptance evidence.

## Earlier findings

### 1. Helpers bypass managed-integration preflight — fixed

`src/roles/pi-owned/launch.ts:49–75` exposes the shared `preflightOwned`; `src/roles/pi-owned/helpers.ts:209–219` invokes it before right-pane allocation/retirement and agent start, within the helper's bounded launch deadline. Primary launch uses the same implementation. Process-local discovery, declared path/version matching, cached file identity, and byte revalidation are retained.

The regression **“helpers run process-local managed-integration preflight before pane/start mutations”** invokes the real helper module in a fresh Node process against an outdated integration, then tests byte-identical cached-hook replacement in-process. Both cases assert refusal and unchanged split/start counts. This executes the real subprocess-fake path rather than stubbing preflight or its result.

### 2. Stall recovery normalizes meaningful whitespace — fixed

`src/roles/pi-owned/prompt.ts:32–41` now joins only display lines within the editor region and compares every remaining character exactly. It no longer removes spaces from paths or task text; ambiguous padding refuses recovery.

The regression **“editor matching preserves exact whitespace in paths while accepting only display wraps”** accepts an exact wrapped path containing a space and rejects missing/doubled spaces. The real-orchestration test **“stall unknown session/editor/working evidence never sends Enter”** additionally exercises a whitespace-altered editor after `agent_prompt_stalled` and asserts zero Enter calls.

### 3. Same-key replay restores obsolete initial right pane — fixed

`src/roles/pi-owned/launch.ts:223–225` populates the initial split locator only when `journal.right` is absent, preserving a later recorded replacement.

The extended **“helpers: disappeared right pane is split only inside owned tab; foreign occupant is never adopted”** test creates a replacement, replays the same primary launch, verifies journal and SESSION preservation, then starts another helper in that replacement. It asserts no `helper_split_2` and exactly two remaining panes.

## Verified

- Read the full tracked diff and every untracked implementation/test file, plus the relevant PR1 contract/argv/lifecycle and transport seams. Re-check conclusions focus on the prior findings and their fixes; no previously accepted area was reopened as a finding.
- Shared preflight precedes helper resource mutations without moving helper STATUS ownership into the controller. Failed reservations remain consumed.
- Exact editor comparison retains positive soft-wrap coverage and negative whitespace coverage. The existing one-Enter/lost-ack protection remains in place.
- Same-key replay preserves the latest right-pane locator without creating a replacement resource unnecessarily.
- The subprocess fake records real orchestration requests; synthetic OS workers publish their own owner/session/STATUS/artifact evidence. The four supplied behavioral mutations are killed by assertions.
- No production facade selection, worker-extension, renderer, settings, i18n, or A2 resolver changes are present. Real herdr/pi/provider acceptance and release-artifact qualification remain later gates, not claims of this review.

### Commands and actual results

All requested checks ran with a fresh temporary `HOME` and `HUD_HOME` for each command, with `NO_COLOR` and `FORCE_COLOR` unset. Runtime: Node `v24.22.1`; host: Linux.

| Command | Actual output / result |
| --- | --- |
| `npm run build` | `node ./node_modules/typescript/bin/tsc && node scripts/copy-jev-assets.mjs dist` — exit 0 |
| `npm run build:test` | `node ./node_modules/typescript/bin/tsc -p tsconfig.test.json && node scripts/copy-jev-assets.mjs dist-test` — exit 0 |
| `npm run build:hud-mcp` | `node ./node_modules/typescript/bin/tsc -p packages/hud-mcp/tsconfig.json` — exit 0 |
| `npm run test:unit` | `tests 4142`, `pass 4116`, `fail 0`, `cancelled 0`, `skipped 26` — exit 0 |
| `npm run test:mjs` | `tests 399`, `pass 398`, `fail 0`, `cancelled 0`, `skipped 1` — exit 0 |
| `npm run test:hud-mcp` | `tests 219`, `pass 218`, `fail 0`, `cancelled 0`, `skipped 1` — exit 0 |
| `bash tests/run-main.sh` | `run-main summary: files=113 tests=1176 pass=1176 fail=0`; `run-main: TAP covers every named node:test title` — exit 0 |
| `npm run check:fixtures` | `check-fixtures: OK (tests/fixtures tests/prototypes docs/probes docs/design)` — exit 0 |
| `npm run format:check` | `All matched files use Prettier code style!` — exit 0 |
| `git diff --check` | No output — exit 0 |
| `node tests/pi-owned-mutations.mjs` | `4/4 behavioral mutants killed; original source/build untouched.` — exit 0 |

No requested check failed, so no isolated failure rerun was necessary.

Also ran the following focused subset of the compiled unit suite under another fresh temporary home:

```text
node --test --test-reporter=spec --test-name-pattern='helpers run process-local managed-integration preflight|editor matching preserves exact whitespace|helpers: disappeared right pane|stall unknown session/editor/working evidence|cost: cold fake launch' dist-test/tests/unit/pi-owned-orchestration.test.js
```

Actual result: `tests 5`, `pass 5`, `fail 0`, `cancelled 0`, `skipped 0` — exit 0. Its cost diagnostic was:

```text
host=<host> n=20 warmup=0 cold fake launch p50=874.2ms p95=897.6ms STATUS writes=0; observed atomic journal replacements=11..11
```

These are fake-herdr cold-launch measurements, not real-client qualification. No live-home, real herdr, pi, or provider probe was performed.

Report: `tmp/tasks/PIROLE-PR2-PI/review-2.md` — 0 findings.
