# Workflow engine design (spec §2.1, D-2026-11-25-05/06; council j4ec3122b6f2d69be synthesized by main)

Members: fable (j8cc153d3e27617b5), astra (jd9e30ae6e1b20abd, also wrote `tmp/tasks/WORKFLOW/design.md`), carbon
(jb625557e99949cc8). All three: generalise the batch runner, keep every legacy id/receipt/notice byte-identical,
no resident process, intent persisted before effect, request-key recovery, one notice ledger.

## Converged design

- **Graph**: TOML on disk (`@iarna/toml` already a dependency), JSON at call time, one validator, frozen normalised
  graph stored with the run. Step kinds: `job`, `batch`, `council`, `land`, `check`, `handback`.
- **Edges**: a DAG with `needs`; `when = {step, is}` selects a branch from a hand-back answer. No routing tokens, no
  authored loops, no expressions, no nested fan-out, no shell in `check` (argv or a named project command). Repairs are
  policy (≤ 2 per step, failing step + last 40 lines to the source worker), not edges. (fable + astra; carbon's
  counted loop edges rejected as WF1 scope creep.)
- **References**: `from = [steps]` → `from_jobs` (≤ 16); larger fan-outs pass their `index.json` path. Placeholders
  substitute paths/ids/tokens or one whole typed parameter, never text into a shell. References must be ancestors.
- **Templates**: shipped `packages/hud-mcp/workflows/{batch,prewalk,land,council,ticket-queue}.toml` (names
  reserved); `$HUD_HOME/workflows/`; `<project>/.hud/workflows/` only for registered projects.
- **State**: `$HUD_HOME/flows/<id>.json` small header (superset of each legacy shape: `b…`, `f…[-n]`, `q…`, parent
  `j…`; general runs `w…`) + `<id>/` (frozen graph, index, step outputs, notice markers). `writeJsonPrivate`,
  transitions under `withAbstractLock('flow-state', id)`, one driver per run via `tryAbstractLock('flow-runner', id)`.
  Retention extends `pruneLandFlows`.
- **Lifecycle**: step `waiting → ready → running → done|failed|skipped|cancelled` (+ `asking`); run
  `proposed → working ↔ paused → completed|failed|stopped`. Recovery: keyed effect found → bind, never reissue;
  `land` never replayed; non-idempotent check with unknown outcome pauses for main.
- **Failure policy** (one function from `settleItem`): reasons grouped (300 chars); first failure of a reason wakes
  main once; breaker `rate` (pilot fail/stall, 2 in a row, ≥ 2 failures at ≥ 20 %), `first` (ticket queue), `none`
  (prewalk); a failed required step with no repair left pauses = implicit hand-back `resume | retry_failed | stop`.
- **Hand-back**: run pauses with `{request_id, step, ask, choices, refs}`; one wake line; main answers with
  `hud_respond({job: <run>, request_id, answer})` (same tool as worker questions; no new verb), written once under
  the lock; duplicate answer idempotent; runner never answers or times out a hand-back.
- **Notices**: one `end-<epoch>` per run; individual wakes only for worker questions, first failure of a reason,
  breaker/pause, hand-back, runner error. Children carry a `workflow` receipt field so their DONE/checkpoint lines fold.
  Watcher lists active runs once per pass and parses a header only on mtime change (today `landEvents` parses every
  retained receipt every tick: 0.93 ms over 245 files, grows with retention).
- **Cost/grant**: class = max over reachable steps against the resolved registry (incl. fallback places). Costly:
  `council`, `pro`/`flow`, any `bro` place, large fan-out. Cheap: everything else incl. reviewer/oracle/general/
  frontend-imp. Grant generalises `council-grant.ts` (owner-only issue, 30 min, single use, reserve → spend on first
  input → release if nothing started). Unbound grant (today's `/council`) covers only a standalone council; any other
  costly run needs a grant bound to the proposed run id/hash so the owner approves the plan they saw.
- **Entry points unchanged**: `hud_create items|scouts|council`, `hud_land`, `hud_tickets run` stay one call (the call
  is main's confirmation, scale returned as today). New `hud_workflow` (plan/start/status/control) only in the last
  slice; `hud_create` schema stays < 3300 bytes.

## Disagreements and decisions

| Topic | Positions | Decision |
|---|---|---|
| Hosts | fable: prewalk + council inline in MCP; carbon: all detached; astra: one driver per run | Detached runner for batch, land, ticket queue **and council** (2026-11-25: an MCP restart at 17:40 orphaned council j84ec…; members finished, parent stuck `working`). Prewalk stays inline (seconds, per create; runner cold start 0.11–0.15 s and ~100 MB RSS), with `host: "mcp"` recorded and the watcher adopting an orphaned inline run into a detached runner. |
| Loops | carbon counted edges; fable/astra none | None (above). |
| Hand-back answer verb | fable `hud_workflow answer`; carbon `hud_respond`; astra `hud_workflow respond` | `hud_respond` (one answer tool). |
| Land shape | all: one sealed `land` step wrapping today's helper | Same; publish is never split into replayable steps. |
| Ticket queue | batch with ticket source + `each = job → land`, policy `first` | Same; keep `q…`, new id on resume, auto-resume after answer. |
| Large-batch threshold | astra ≥ 32 aggregate; carbon Sonic > 50 or > 2 MiB, others > 12; fable open | Owner: Sonic > 50 or > 2 MiB, others > 12 (D-2026-11-25-06). |
| Scale confirmation on plain `hud_create items` | astra: a second confirm call would be an API change | Keep one call (unchanged behaviour). |

## Spec

`docs/spec.md` §3 updated (D-2026-11-25-06): the runner is short-lived per run, no resident process. Large batch
= more than 50 Sonic items or 2 MiB Sonic input, or more than 12 items of another role.

## Slices (each revertable; legacy records stay readable after a revert)

1. **Engine core + batch template**: store, driver, DAG scheduler, policy, notice ledger, validator, detached host,
   `batch` kind; `hud_create items` / `batch=` controls unchanged; `batch-runner` replaced by `workflow-runner`.
   Golden notice strings captured before the change; `thin-mcp-fixed-batch` untouched; crash/duplicate-start probes.
2. **Prewalk template**: `job` kind, inline host + watcher adoption, `optional`, reserved target id; both launch paths
   call the engine; `thin-mcp-prewalk`/`scout` untouched; measure added ms per scouted create.
3. **Council template on the detached host** (moved ahead of land because of the observed orphaning): member fan-out,
   quorum ≥ 2, main/pro/fable synthesis, grant reserve/spend/release unchanged; council suite untouched + MCP-exit test.
4. **Land**: sealed step; engine owns record/wake/stop/notices/repair bound; six land suites untouched; kill tests.
5. **Ticket queue**: ticket source + `job → land`; queue suite untouched.
6. **Ad-hoc composition**: `check` + `handback` kinds, `hud_workflow`, template loading, cost class + bound grant,
   reference docs; build-review recipe end to end; validation and grant refusals.

## Acceptance (owner 2026-11-25, D-2026-11-25-07)

Hand-backs default to a project-lead acceptance session (new role `lead`: Claude Code on Claude Opus 5.5 high with
the HUD MCP tools, like main), not main. Project-lead acceptance, not code review: reports, checks, live try, judged
against the goal; the independent `reviewer` runs as a template step before the lead where the convention
requires; the lead acts on its findings. A lead lives for one decision (packet from the run record → answer →
closed); none stays alive.
It chooses finish / repair / continue with reasons; uncertain items go to the run's todo; escalates to main only
blocking owner matters. The ticket-queue template ends with a lead acceptance step. Main starts runs and gets the one end notice. Ticket 07.
