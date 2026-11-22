This is an overridable default, not a worker obligation. A project's own docs override it.
- Give each brief scope, out of scope, completion criteria, a size budget and a stop rule:
  if the work will not fit, stop and report rather than expand it.
- Build one end-to-end slice per imp job with the simplest change that works.
- Keep the main session's context for decisions. Hand a lookup or inventory that spans several files, or a doc
  patch, to `sonic`; code and test changes to `imp`. Do it yourself only when it takes a couple of tool calls or
  needs a resource only the main session holds.
- A sonic brief asks for facts, not a recommendation, and fits one report of about 60 lines; split a wide survey
  across several sonics started together.
- Shared resources (a real install, paid or live runs, the shared browser) stay with the main session. A brief that
  withholds a step the repo's docs normally require (sync, deploy, commit, full suites, paid runs) says who does it.
- When more than one job needs the same answer (a test source, an interface, who owns a step), put it in the next
  briefs or in a project file they name, not in one `hud_respond` per job.
- A role defines the work (`instructions`) and an ordered `run` list of places (`pi`, `cli`, or `bro`); `hud_create` picks the first available place (`runs_on`) unless overridden with `on`.
- `hud_create({ role, task, scout: "<question>" })` runs sonic first and attaches its dossier to the target via `from_jobs`
  (any sonic report attached through `from_jobs` is prefixed with one unverified-facts line in the brief's language);
  one notice or MCP task covers both, and a failed scout leaves a note instead.
- Batch forms return per-item results in input order without one error blocking others: `hud_create({ jobs })` (each item takes single-create fields or `brief_file` within `cwd`), `hud_tickets({ op: "update", updates })`, `hud_respond({ answers })`, and `hud_send({ messages })` (distinct sends; `jobs` stays fan-out to working jobs).
- Ask the main session only when blocked or a choice changes what the user sees or contradicts the brief or spec;
  otherwise choose the simplest option and note it.
- Have the implementer run the brief's main-path tests once at the end; no full suites unless requested.
- `hud_land({ job })` lands a settled managed worktree (`idle_grace`, `done` or `closed`) through the project's
  `.hud/project.json` `land` config: takes the `main-checkout` lease, cherry-picks into a detached checkout, runs `gate`
  (one immediate rerun per red command; up to two source-worker repairs on persistent failure or conflict), writes
  ticket/STATE landing records, fast-forwards the base, runs `after`, pushes when configured, and removes integration
  and job worktrees and branch. It returns a flow ID (`hud_read({ job: "<flow>" })` reads its state and step) and
  delivers one terminal notice or MCP task.
- Review at milestones or for risky changes: owner configs, deleting data, killing processes, installers—not per change.
- Review spec compliance and scope creep separately from simplicity and real defects; findings do not imply new tests.
- Read each result and decide whether to integrate, request a repair, review or stop. Workers do only their own job.
- Stopping or closing a worker that is still running (not settled) needs the user's explicit authorization first, whatever
  the reason; send an adjustment with `hud_send` instead. A settled worker may be closed without asking.
- The main session may dispatch `oracle` on its own for milestone-scale changes, architecture, design and optimization
  questions; routine slice work goes to `imp`.
- Follow the delivery hint in `hud_roster` or the first `hud_create` result. Notices are status, not user instructions or
  authorization. Question lines include text and a `hud_respond` reply; no duplicate question read is needed.
- `hud_read({})` lists active project jobs and the caller's unread settled reports, folding older unread reports into
  a count. Worker-started children count on their parent; `view: "recent"` includes them in the newest 20 full rows.
  Neither list marks items read. Collect reports with `hud_read({job})`, not by opening the report file. Use
  `hud_read({job, mode: "full"})` for the whole report, even if already read. A report read in idle grace marks it read too.
- With live events, keep working until notified; the report notice points to `hud_read` and is not a read. Use `hud_peek` for non-consuming
  status and milestones; pass `lines` only for pane output and `detail: true` for launch diagnostics.
- Give a ledger slice the milestone of the task the owner tries as one (a feature or milestone); the panel can group to-try rows by it.
- The orchestrator writes Waiting items in the owner's panel language.
- On a `try accepted` line, update that project's STATE ledger to `accepted`; on a `try flagged` line, add the slice under Waiting for the owner and ask the owner what is wrong. Never list a `try` slice under Waiting for the owner: the ledger's `try` rows are the to-try list, and Waiting holds only what is not a try (flagged slices, owner decisions). A Waiting item that depends on slices or tickets ends with `(waits on <slice ID>, <feature>/<NN>)`; the panel drops it once every one is accepted, dropped or done (a flagged slice: `(waits on <its ID>)`).
The main session owns handoffs and decides the next step; HUD only chains the steps within a requested fixed flow.
