# WORKER-UNIFY: one worker form on every harness

Inside `docs/spec.md` §2.1 ("Workers are neutral", owner 2026-11-17). Background: oracle report and addendum in
`docs/reviews/2026-11-17-worker-unify-oracle.md` (inventory §2 A1–A5 is still accurate; its prompt-delivery parts
§4 and the ORACLE-SKILL first slice are superseded by MATT-OFF and SKILL-ROLES).

## Owner decisions (2026-11-17)

1. A worker on any harness (pi, Claude, Codex, Grok, Antigravity) may start **sonic** on its own for a simple, fully
   specified sub-task whenever it judges that useful, and chooses sonic's thinking for that sub-task. It waits for
   sonic's report and stays responsible for what sonic produced.
2. A worker starts no other role. The HUD refuses any dispatch from a worker other than this sonic path (option B of
   the hud-delegate misfire risk; option A, `--disable-slash-commands`, is not taken, so the CLI launch flags stay
   model, effort and bypass only).
3. One role has one instruction text whatever harness runs it: HUD-run pi jobs use the HUD instruction files, not a
   second pi-roles body. pi's `call_reviewer` is not offered to HUD-run jobs (review is the milestone review the main
   session starts); `call_sonic` is replaced by the common sonic path.
4. Unanswered questions: `ask_orchestrator`/`hud-ask` stay as they are (the main session normally answers; decisions
   that change the spec go to the owner through the main session). After the 20-minute wait a worker proceeds on its
   default only when that default is reversible and inside the brief; otherwise it leaves that part and names it as
   blocked in its report.
5. Dead execution code from the report's §A5 goes; live display readers (assoc, native-host, old receipts) stay.

## Design (main session, 2026-11-17)

- **Worker marker.** Every worker tab the HUD opens (pi, CLI, browser) gets `HUD_JOB_DIR=<job dir>` through herdr's
  tab `--env`. It is not a CLI flag. Codex's MCP entry forwards it (`env_vars`, set by `install.d/codex.sh`). It is
  trusted-local routing, not identity proof (spec §3, §4).
- **Refusal.** `hud_create` called with `HUD_JOB_DIR` set refuses with `worker_cannot_dispatch` before any tab or
  quota mark. `hud_send`, `hud_close` and `hud_respond` from a worker refuse the same way. `hud_roster` and
  `hud_read` stay readable.
- **The sonic path is a command, not the MCP**, because Grok and Antigravity workers have no HUD MCP and pi workers
  run with `-ne`. Like `hud-ask`, it is named by absolute path in every brief:
  `node <hud>/bin/hud-sonic.mjs start --dir <own job dir> --task-file <file> [--thinking off|low|medium|high]`
  prints the sonic job id at once; `node <hud>/bin/hud-sonic.mjs wait --dir <own job dir> --job <id>` blocks up to
  8 minutes (under Claude's and Codex's 10-minute tool limit), then prints the report path and text, or
  `still working: run wait again`; a failed job prints its reason and exits non-zero.
- The sonic job is an ordinary HUD job created by the same dispatch code as `hud_create` (shared function, not a
  second dispatcher), with `parent_job` in its `job.json`. Its dispatching pane is the **main session's** pane taken
  from the parent's `job.json`, so its questions, changes and `hud watch` lines reach the main session like any job.
  Model and harness come from sonic's role place; only thinking is the worker's choice.
- **Not blocking** (owner, 2026-11-17: pi's `call_sonic` blocks the worker until sonic ends). `start` returns at once;
  the worker keeps working and may start several sonic jobs side by side; it runs `wait` only when it needs a result,
  and `wait --timeout 0` just checks. The role text says so: hand off early, do your own part, collect later.
- A parent job with an open sonic child is still working: it is not settled, gets no quiet-job decision and is not
  closed, the way a live child process counts under WORKER-CLOSE. A parent that ends its turn with unread sonic
  reports gets one fixed prompt to collect them (pi: a queued follow-up as `hud_send` does; CLI: the same prompt
  path as the fixed report prompt).
- A sonic worker cannot start sonic (`hud-sonic` refuses when the parent role is sonic). No count cap.
- The panel shows a sonic job nested under its parent job's card, the way native subagents nest.

## Out of scope

No MCP skill delivery, no caller classification beyond the marker, no new launch flags, no change to pi-roles'
standalone behaviour outside HUD-run jobs, no removal of live display readers.
