This is an overridable default, not a worker obligation. A project's own docs override it.
- Give each brief scope, out of scope, completion criteria, a size budget and a stop rule:
  if the work will not fit, stop and report rather than expand it.
- Build one end-to-end slice per imp job with the simplest change that works.
- A role defines the work (`instructions`) and an ordered `run` list of places (`pi`, `cli`, or `bro`); `hud_create` picks the first available place (`runs_on`) unless overridden with `on`.
- Ask the main session only when blocked or a choice changes what the user sees or contradicts the brief or spec;
  otherwise choose the simplest option and note it.
- Have the implementer run the brief's main-path tests once at the end; no full suites unless requested.
- Review at milestones or for risky changes: owner configs, deleting data, killing processes, installers—not per change.
- Review spec compliance and scope creep separately from simplicity and real defects; findings do not imply new tests.
- Read each result and decide whether to integrate, request a repair, review or stop. Workers do only their own job.
- Claude Code: run `hud watch` under Monitor and re-arm after expiry; it catches up pending work and prints only
  actionable events. `--verbose` and MCP `changes` retain the fuller change stream; `report` means unread.
- Codex: quiet events and questions are queued automatically; no Monitor command is needed. Queue delivery
  uses the pane's Codex account and leaves drafts alone; no thread id or a queue failure falls back to typing.
- pi: the HUD package automatically sends actionable events as native follow-up messages without touching the
  draft. No Monitor or panel is needed.
- A live pane watch (`watcher_alive` in `hud_roster` and `hud_create`) suppresses direct question pushes.
  Without a watch or queue, questions are typed; use `hud_wait` for settlement or attention across jobs without marking anything read.
  Lines include text and a `hud_respond` reply; no duplicate question read is needed.
- `hud_read({})` lists running jobs and pending attention, including unanswered question IDs and unread reports.
  Use `view: "recent"` for the newest 20 full rows. Neither list marks items read. A job read returns only an unread
  report (`report_unchanged: true` otherwise; `full: true` to reread). A report read in idle grace marks it read too.
- Use `hud_peek` to inspect a worker's recent pane and optional `hud-progress` milestones without marking the job read or closing it.
- On a `try accepted` line, update that project's STATE ledger to `accepted`; on a `try flagged` line, add the slice under Waiting for the owner and ask the owner what is wrong. Never list a `try` slice under Waiting for the owner: the ledger's `try` rows are the to-try list, and Waiting holds only what is not a try (flagged slices, owner decisions). A Waiting item that depends on slices or tickets ends with `(waits on <slice ID>, <feature>/<NN>)`; the panel drops it once every one is accepted, dropped or done (a flagged slice: `(waits on <its ID>)`).
The main session owns every handoff and decides every next step. HUD does not chain these steps.
