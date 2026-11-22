Verdict: changes-required

# PIROLE-PR3 — round 1 review

Reviewed `git diff 23917e2d113f0099680af5631f0f69cfed25b52a` and all seven untracked source/test files reported by `git status --short`. One actionable finding, major. No additional required fix was identified in the reviewed settlement/grace, nested-sonic ownership, autoclose or trusted-release paths.

## Findings

### 1. Review instructions still require the superseded full-suite rerun policy

**`src/roles/pi-owned/helpers.ts:146` — Major.** `reviewTaskText` tells every round to run any missing, failing or stale check itself, without distinguishing full-suite logs from focused-check logs; this contradicts the binding `2e4b650` follow-up.

**Failure scenario:** Round 1 reports a defect, the implementer fixes a source file and runs its focused regression tests, and `call_reviewer` starts round 2. The earlier full-suite logs are now necessarily older than that source file. The generated brief instructs the reviewer to rerun those full suites itself, despite the explicit decision that stale full-suite logs in round 2+ are expected and noted, never rerun by the reviewer. In round 1, the same wording substitutes a reviewer rerun for the required finding about missing/failing/stale full-suite evidence. The general “do not rerun” sentence does not resolve the contradictory specific instruction.

The same outdated instruction appears in `integrations/pi/roles/reviewer.md:10`, `integrations/pi/skills/helper-pane/SKILL.md:8`, and the new architecture/reference documentation. `tests/unit/pi-owned-worker.test.ts:376–388` explicitly requires `run that check yourself` in both rounds, so the passing test currently preserves the defect.

**Suggested fix:** Apply `2e4b650` consistently to the generated brief, reviewer role, helper skill, documentation and per-round tests: never rerun full suites; round 1 reports missing/failing/stale full-suite evidence as a finding; round 2+ notes expected stale full-suite evidence. Rerun missing/failing/stale focused checks, plus the prescribed round-specific focused/regression tests.

**Ruling:** The orchestrator confirmed this interpretation in this task's `qa/q4.answer.md`: the final section of `design-after-pr2.md` supersedes brief item 4.

## Verified

### Source and test review

- Read the task/review briefs, implementation notes, binding architect/design/amendment documents, planning q1–q4 answers, task q1–q3 answers, PR2 review rounds 1–2, and applicable repository guidance. Resolved the conflicting review/log instructions through `ask_orchestrator` (task q4).
- Inspected the full tracked change and every untracked implementation/test file, including the worker entry/adapter, trusted release loader, installed-pi loader fixture, release staging fixture and package discovery helper. CodeGraph was tried because the local directory entry exists; its server reported that this worktree is not indexed, so subsequent inspection used read/grep.
- The worker entry composes only the owned role installer. No facade launch selection, ordinary HUD owner, panel/footer, renderer, settings, i18n or A2 resolver change is present. The packaging inventory now includes the worker, four role texts, helper skill, built owned-runtime modules and finite reaper.
- Settlement is subscribed to `agent_settled`, not `agent_end`, and uses deferred generation/idle/queue/helper/QA/output checks. Changed/nonempty output, failure/abort handling, fixed grace deadlines, shorter/unknown TTL, continuation and shutdown behavior have direct WorkerSession tests.
- Non-sonic helper eligibility, implementer-only reviewer calls, report-only read-only sonic grants, shared numbering/caps, nested pane placement and borrowed helper-reviewer reservations are exercised through the real orchestration modules and subprocess fake herdr. Child-first cleanup and unresolved-reservation retention have success/failure/crash/unknown coverage.
- Autoclose eligibility distinguishes unused implementer grace expiry from quit, used continuation and failure. One-attempt markers, trusted A1 inventory, dead process stamps, explicit-close races and replaced release bytes have focused coverage. Prompt recovery checks exact editor text, exact persisted prompt/header and the returned agent identity.
- QA tests execute the real filesystem allocator/poller with synthetic files and fake clocks. Semantic STATUS publication checks retain inode/mtime across unchanged publishing/reads. Inspected all eleven mutation witnesses in the current mutation log: they are assertion failures, not missing-module or syntax failures.
- Loader evidence is **PASS on installed pi 1.5.0**, with zero focused skips: the actual staged worker is loaded through pi's installed extension loader alongside one synthetic herdr reporter, using the real SessionManager and native write tool. Event/context driving is synthetic; this is not real interactive/herdr/provider qualification. Live terminal/cache/provider acceptance remains deferred.

### Implementer check-log verification

All current `gate1d-*` check logs are newer than the newest changed file, `tests/unit/pi-owned-orchestration.test.ts` (2026-11-09 15:48:50 -0800). Inspected command headers, completion summaries and final `exit=<code>` records. The isolation wrapper unsets `NO_COLOR`, `FORCE_COLOR` and inherited `HUD_HOME`, then assigns fresh temporary `HOME`, `HUD_HOME` and `CODEX_HOME` per command.

Logs below are under `<task-root>/PIROLE-PR3/checks/`:

| Command / log | Actual result |
| --- | --- |
| `npm run build` — `gate1d-build.log` | TypeScript and asset copy completed; `exit=0` |
| `npm run build:test` — `gate1d-build-test.log` | Test TypeScript and asset copy completed; `exit=0` |
| `npm run build:hud-mcp` — `gate1d-build-hud-mcp.log` | TypeScript completed; `exit=0` |
| `npm run test:unit` — `gate1d-unit.log` | `tests 4262`, `pass 4235`, `fail 1`, `skipped 26`, `cancelled 0`; `exit=1` |
| Known B6 rerun — `before-review-b6-alone.log` | `tests 15`, `pass 15`, `fail 0`, `skipped 0`; `exit=0` |
| `npm run test:mjs` — `gate1d-mjs.log` | `tests 467`, `pass 465`, `fail 0`, `skipped 2`; `exit=0` |
| `npm run test:hud-mcp` — `gate1d-hud-mcp.log` | `tests 219`, `pass 218`, `fail 0`, `skipped 1`; `exit=0` |
| `bash tests/run-main.sh` — `gate1d-main.log` | `files=113 tests=1176 pass=1176 fail=0`; TAP covers every named title; `exit=0` |
| `npm run check:fixtures` — `gate1d-fixtures.log` | `check-fixtures: OK (tests/fixtures tests/prototypes docs/probes docs/design)`; `exit=0` |
| `npm run format:check` — `gate1d-format.log` | `All matched files use Prettier code style!`; `exit=0` |
| `git diff --check` — `gate1d-diff.log` | No diagnostic; `exit=0` |
| `node tests/pi-owned-mutations.mjs` — `gate1d-mutations.log` | `11/11 behavioral mutants killed; original source/build untouched.`; `exit=0` |

The sole current full-unit failure is the known **“B6 idle wait has zero writes, no polling, and timeout leaves empty cursor/state unchanged”** assertion (`4 !== 3`). Its fresh isolated file rerun passes 15/15. Under task q4 and the repository's known-flake rule, this recorded pair satisfies round-1 evidence and is **not a finding**. The raw full run remains failed; it is not represented as a first-pass green gate. The orchestrator still reruns the acceptance gate.

### Commands run independently

Both focused-test attempts used fresh temporary `HOME`, `HUD_HOME` and `CODEX_HOME`, with inherited `NO_COLOR`, `FORCE_COLOR` and `HUD_HOME` unset. No full suite was rerun.

```text
node --test dist-test/tests/unit/pi-owned-worker.test.js dist-test/tests/unit/pi-owned-orchestration.test.js
```

- First attempt: the shell tool's 180-second ceiling expired partway through the orchestration file; no complete-suite result was obtained. Completed tests shown before the timeout passed.
- Repeated the same focused command with a sufficient 420-second tool ceiling: **79 tests, 79 pass, 0 fail, 0 cancelled, 0 skipped**, duration **269635.70482 ms**, exit 0.
- Cost diagnostics from that completed run (host `<host>`, n=20, warmup=0): fake-herdr launch p50 **899.1 ms**, p95 **925.8 ms**, launcher STATUS writes **0**; fake-herdr/real-pi-1.5.0-loader worker startup p50 **1180.5 ms**, p95 **1231.2 ms**, startup STATUS writes **1..1**, unchanged reads **0 writes**. These are synthetic launch/loader measurements, not live-client performance qualification.
- `git diff --check`: no diagnostics, exit 0. `git status --short`: the expected 22 modified tracked files and seven untracked files; no review edits to repository files.

Report: `<task-root>/PIROLE-PR3/review-1.md` — 1 finding.
