This is an overridable default, not a worker obligation. A project's own docs override it.
- Give each brief scope, out of scope, completion criteria, a size budget and a stop rule:
  if the work will not fit, stop and report rather than expand it.
- Build one end-to-end slice per imp job with the simplest change that works.
- Keep the main session's context for decisions. Hand a lookup or inventory that spans several files, or a doc
  patch, to `sonic`; code and test changes to `imp`, except user-facing UI (panel, statusline and footers,
  rendered pages, design samples, src/render/), which goes to `frontend-imp`. Do it yourself only when it takes a couple of tool calls or
  needs a resource only the main session holds.
- Pass `isolation: "worktree"` only when the job edits code or runs builds or tests; docs, design samples,
  studies and read-only roles (`sonic`, `oracle`, `reviewer`) work in the main checkout and commit with a pathspec.
  Edit tickets only through `hud_tickets` (`.hud/tickets/<feature>.json`, never hand-edited Markdown); workers never touch `.hud/tickets/**`.
- Per-role caps (Settings) queue jobs past the cap and start an `imp` at its cap as `general` when it has room; do not
  count jobs yourself before dispatching.
- Each role runs where its role file says; `general` also takes `preset`, `on`, `model` or `thinking` for one job when
  the user names a model.
- A sonic brief asks for facts, not a recommendation, and fits one report of about 60 lines; split a wide survey
  across several sonics started together.
- Shared resources (a real install, paid or live runs, the shared browser) stay with the main session. A brief that
  withholds a step the repo's docs normally require (sync, deploy, commit, full suites, paid runs) says who does it.
- When more than one job needs the same answer (a test source, an interface, who owns a step), put it in the next
  briefs or in a project file they name, not in one `hud_respond` per job.
- A role defines the work (`instructions`) and an ordered `run` list of places (`pi`, `cli`, or `bro`); `hud_create` picks the first available place (`runs_on`) unless overridden with `on`.
- For roles with prewalk on (`imp`, `oracle`, `frontend-imp` by default; `reviewer`, `sonic` off), pass `scouts: [{kind: "code"|"docs"|"web", ask: "..."}]` (0–3 parallel `sonic` scouts with a specific question, same kind allowed more than once, `[]` to skip scouts; `prewalk: false` skips scouts and pool pick); HUD attaches settled reports via `from_jobs` before starting the target (failures leave a note; one notice or MCP task covers both; owner pool picks still run when configured). Any sonic report attached through `from_jobs` is prefixed with one unverified-facts line in the brief's language.
- In MCP-task sessions, send one `hud_create` per job in parallel. Other sessions can batch with `hud_create({ jobs })` (each item takes single-create fields: pass `ticket: "<feature>/<NN>"` without `brief_file` for ticketed work, or `task` / `brief_file` within `cwd`). Batch forms return per-item results in input order without one error blocking others; also available: `hud_tickets({ op: "update", updates })`, `hud_respond({ answers })`, and `hud_send({ messages })` (distinct sends; `jobs` stays fan-out to working jobs).
- Ask the main session only when blocked or a choice changes what the user sees or contradicts the brief or spec;
  otherwise choose the simplest option and note it.
- Have the implementer run the brief's main-path tests at the end, rerunning only what a fix touched; no full suites unless requested.
- `hud_land({ job })` lands a settled managed worktree (`idle_grace`, `done` or `closed`) through the project's
  `.hud/project.json` `land` config: takes the `main-checkout` lease, cherry-picks into a detached checkout, runs `gate`
  (one immediate rerun per red command; up to two source-worker repairs on persistent failure or conflict), folds
  the ticket landing record into the landed commit, fast-forwards the base, runs `after`, pushes when configured, and removes integration
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
- Handle routine worker questions, failures, blockers and completions in main. Open an owner request with `hud_objective({ op: "request", text })` in the owner's panel language; pass `waits: true` if work waits and `objective` when linked. Text ending in `(waits on <feature>/<NN>)` clears itself once those tickets are done or dropped.
- Record the answer with `hud_objective({ op: "resolve", request, note })`, using the returned request ID.
- File tickets through `hud_tickets` (`op: "add"` into `.hud/tickets/<feature>.json`, `op: "commit"` when nothing lands) with `owner_try: false` when tests fully cover the behaviour; `true` only when the owner must interact with it to judge it (UI they drive, look and feel); verify installs and live behaviour yourself or by a worker live check. When the project has `.hud/objectives.md`, pass `objective` to `hud_tickets` add; it also lists the feature in that Objective. The main session accepts work after verification. On a `try accepted` line from Accept all, mark those tickets `done` via `hud_tickets({ op: "update" })` (legacy STATE `try` rows: `accepted`). A legacy `try flagged` line can still surface an earlier owner decision.
The main session owns handoffs and decides the next step; HUD runs prewalk before a job and chains only within a requested fixed flow, with nothing chaining after the target.
