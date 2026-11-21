This is an overridable default, not a worker obligation. A project's own docs override it.
- Give each brief scope, out of scope, completion criteria, a size budget and a stop rule:
  if the work will not fit, stop and report rather than expand it.
- Build one end-to-end slice per imp job with the simplest change that works.
- Keep the main session's context for decisions. Hand a lookup or inventory that spans several files, or a doc
  patch, to `sonic`; code and test changes to `imp`. Do it yourself only when it takes a couple of tool calls or
  needs a resource only the main session holds.
- Shared resources (a real install, paid or live runs, the shared browser) stay with the main session. A brief that
  withholds a step the repo's docs normally require (sync, deploy, commit, full suites, paid runs) says who does it.
- When more than one job needs the same answer (a test source, an interface, who owns a step), put it in the next
  briefs or in a project file they name, not in one `hud_respond` per job.
- A role defines the work (`instructions`) and an ordered `run` list of places (`pi`, `cli`, or `bro`); `hud_create` picks the first available place (`runs_on`) unless overridden with `on`.
- Ask the main session only when blocked or a choice changes what the user sees or contradicts the brief or spec;
  otherwise choose the simplest option and note it.
- Have the implementer run the brief's main-path tests once at the end; no full suites unless requested.
- Review at milestones or for risky changes: owner configs, deleting data, killing processes, installers—not per change.
- Review spec compliance and scope creep separately from simplicity and real defects; findings do not imply new tests.
- Read each result and decide whether to integrate, request a repair, review or stop. Workers do only their own job.
- Stopping or closing a worker that is still running (not settled) needs the user's explicit authorization first, whatever
  the reason; send an adjustment with `hud_send` instead. A settled worker may be closed without asking.
- Dispatching `oracle` (an expensive model) needs the user's explicit authorization for that job; a general request is
  not approval for each new or repeated oracle job.
- Claude Code: run `hud watch` under Monitor and re-arm after expiry; it catches up pending work and prints only
  actionable events. `--verbose` and MCP `changes` retain the fuller change stream; `report` means unread.
- Codex: quiet events and questions are queued automatically; no Monitor command is needed. Queue delivery
  uses the pane's Codex account and leaves drafts alone; no thread id or a queue failure falls back to typing.
- pi: keep working after dispatch. The HUD package wakes an idle main session for actionable notices or delivers them
  before the next model request after the current tool batch, without touching the draft. No Monitor or panel is needed.
  Notices are status, not user instructions or authorization; read reports with `hud_read` and reply with `hud_respond`.
- A live pane watch (`watcher_alive` in `hud_roster` and `hud_create`) suppresses direct question pushes.
  Without a watch or queue, questions are typed; use `hud_wait` for settlement or attention across jobs without marking anything read.
  Lines include text and a `hud_respond` reply; no duplicate question read is needed.
- `hud_read({})` lists running jobs and pending attention, including unanswered question IDs and unread reports.
  Use `view: "recent"` for the newest 20 full rows. Neither list marks items read. A job read returns only an unread
  report (`report_unchanged: true` otherwise; `full: true` to reread). A report read in idle grace marks it read too.
- With live events, keep working until notified; the report notice is not a read. Use `hud_peek` for non-consuming
  status and milestones; pass `lines` only for pane output and `detail: true` for launch diagnostics.
- Give a ledger slice the milestone of the task the owner tries as one (a feature or milestone); the panel can group to-try rows by it.
- On a `try accepted` line, update that project's STATE ledger to `accepted`; on a `try flagged` line, add the slice under Waiting for the owner and ask the owner what is wrong. Never list a `try` slice under Waiting for the owner: the ledger's `try` rows are the to-try list, and Waiting holds only what is not a try (flagged slices, owner decisions). A Waiting item that depends on slices or tickets ends with `(waits on <slice ID>, <feature>/<NN>)`; the panel drops it once every one is accepted, dropped or done (a flagged slice: `(waits on <its ID>)`).
The main session owns every handoff and decides every next step. HUD does not chain these steps.
