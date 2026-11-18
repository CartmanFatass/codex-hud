# 02: Any worker starts sonic with `hud-sonic`

**Status:** done (cf98727b); pi parent gating moved to 03; live check pending
**Blocked by:** 01

**What to build:** `.scratch/worker-unify/spec.md` decision 1 and the "sonic path" design: one command every
harness can run, so a worker hands a simple sub-task to sonic at the thinking it chooses.

- [ ] `packages/hud-mcp/bin/hud-sonic.mjs start --dir <own job dir> --task-file <file> [--thinking off|low|medium|high]`
      creates a sonic job through the same dispatch function `hud_create` uses (extract it; no second dispatcher) and
      prints the job id. `parent_job` is recorded in the child's `job.json`; its dispatching pane is the parent's
      `job.json` `herdr_pane` (the main session). Model and harness come from sonic's role place; `--thinking`
      overrides only thinking. It works with `HUD_JOB_DIR` set (ticket 01's refusal is for the MCP tools only).
- [ ] `hud-sonic.mjs wait --dir <own job dir> --job <id> [--timeout <s>]` waits on the job's STATUS for at most
      `--timeout` seconds (default 480, `0` = check once); settled: prints the report path and report text, exit 0;
      failed: prints the reason, exit 1; still open: prints `still working: run wait again`, exit 3. It only waits on
      a job whose `parent_job` is this `--dir`. `start` never waits: several sonic jobs may run side by side.
- [ ] A parent with an open sonic child is not settled, gets no quiet-job decision and is not closed (CLI judge and
      the pi path alike). When the parent ends its turn with a sonic report it has not collected through `wait`, it
      gets one fixed prompt naming the job ids to collect (pi: queued follow-up as `hud_send` does; CLI: the fixed
      report-prompt path).
- [ ] `start` refuses when the parent job's role is sonic, and when `--dir` is not a job directory under `HUD_HOME`.
- [ ] Every HUD instruction file a worker role uses (`packages/hud-mcp/instructions/*.md` except sonic's own) tells
      the worker it may hand a simple, fully specified sub-task to sonic with this command, picks the thinking by the
      sub-task, starts it early and keeps working, collects the report with `wait` when it needs it and checks sonic's
      result before building on it; and that it starts no other role. The generated brief (`thin-main.ts`, near the `hud-ask` path) names the absolute `hud-sonic.mjs` path.
- [ ] The panel nests a job with `parent_job` under its parent's card (one indent), like native subagents.
- [ ] Tests (temp homes): start/wait happy path with a fake sonic place; two children side by side; thinking
      override; failed child; `--timeout 0` and timeout exit 3; open child keeps the parent unsettled; uncollected
      report gets one prompt; sonic-parent refusal; foreign job refusal; nested card render frame test.
- [ ] `hud_read` from a marked worker (`HUD_JOB_DIR` set) never marks a report read or closes a worker (see Comments).
- [ ] Live check by the main session after landing: an agy imp job and a pi imp job each start one sonic sub-task
      and use its report.

## Comments

- Main session, 2026-11-17, from 01's landing: a marked worker may still call `hud_read`, and reading a settled
  report marks it read and closes that job's worker. In this ticket, `hud_read` from a marked worker never marks a
  report read and never closes a worker (it may read only; the main session's unread state stays).
