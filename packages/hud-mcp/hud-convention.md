This is an overridable default for the main session, not a worker obligation. A project's own docs override it.
It absorbs Matt Pocock's engineering flow (mattpocock/skills) into HUD's split: the main session decides and is the
only writer of specs, tickets and the integration branch; HUD roles execute; HUD never chains roles.

## The flow: idea → ship
1. Start where the request is. A clear request (the owner says what and the scope is evident) goes straight to a
   brief: ask only the one or two questions whose answer changes what gets built, record decisions that move the
   product boundary in the spec, and dispatch. Grill only a fuzzy idea or a change whose scope, non-goals or "done"
   are not clear; then suggest `/grill-with-docs` to the owner (it interviews and keeps `GLOSSARY.md` and ADRs
   current). A question that needs a runnable answer goes to a throwaway prototype job first.
2. Can one imp finish it in one session? Yes (most work) → the main session writes one brief for one imp; no spec,
   no tickets. No → the main session itself runs `/to-spec`, then `/to-tickets`: tracer-bullet vertical slices, each
   runnable end to end on its own, each declaring its blocking edges; the owner approves the list. Imps never write
   specs or tickets; they build from a brief.
3. Build: `/hud-build` works the tickets as a task graph (one fresh imp per ready ticket, each in its own worktree);
   for a single brief, `hud-delegate` directly.
4. Review once per milestone, not per ticket (below). The owner tries the result; that is the acceptance.
5. After a build that went sideways, look back and fix the environment (convention, role prompts, checks, docs),
   not just the code.

## Design vocabulary
Design with `codebase-design`'s words: module, interface, depth, seam, adapter, leverage, locality. Prefer deep
modules (much behaviour behind a small interface). One adapter is a hypothetical seam; add a seam only when two
things vary across it. The interface is the test surface: tests cross the same seam callers do. Domain words come
from `GLOSSARY.md`; decisions recorded in ADRs are not re-litigated without new evidence. Default to the smallest
change that works; a deepening refactor is its own idea and goes through the flow, never into an unrelated brief.

## Briefs
- Context pointers, not copies: name the spec, the ticket file or issue, the ADRs and the files to read first.
- The seam(s) to test at, agreed before the build; main-path tests the owner would notice, run once at the end;
  no full suites unless requested. Workers with `tdd` build red → green at that seam; hard bugs use
  `diagnosing-bugs` (a tight feedback loop that goes red first).
- Scope, out of scope, completion criteria, a size budget and a stop rule: if the work will not fit, stop and report.
- Workers ask only when blocked or when a choice changes what the user sees or contradicts the brief or spec;
  otherwise they choose the simplest option and note it. Workers do not commit unless the brief says so.

## Roles replace Matt's executing skills
`implement` / `implement-spec` → `hud-build` + `imp`; `research` → a role job (`oracle`, `general`) whose report is
the notes file; `code-review` → the milestone review below. A role defines the work (`instructions`) and an ordered
`run` list of places (`pi`, `cli`, `bro`); `hud_create` uses the first available (`runs_on`) unless `on` overrides,
and `hud_roster` lists each role's presets.

## Review
Once per milestone, or for risky changes (owner configs, deleting data, killing processes, installers). Two axes,
reported separately: spec (does it do what the spec asks, and nothing nobody asked for) and quality (real defects,
and what can be deleted). The review brief states the design intent. Findings block only if a real user would hit
them or the spec is violated; the rest is an optional list and implies no new tests. One fresh imp fixes the
blocking findings in one pass.

## Waiting and reading
- Claude Code: run `hud watch` under Monitor and re-arm after expiry; it catches up pending work and prints only
  actionable events. `--verbose` and MCP `changes` retain the fuller change stream; `report` means unread.
- Codex: quiet events and questions are queued automatically; no Monitor command is needed. Queue delivery
  uses the pane's Codex account and leaves drafts alone; no thread id or a queue failure falls back to typing.
- Other main sessions: typed questions plus `hud_read` with `wait_ms` for settlement. A live pane-scoped watch
  suppresses direct questions. Lines include text and a `hud_respond` reply; no duplicate question read is needed.
- `hud_read` lists open-question counts and unread-report flags; a job read returns only an unread report
  (`report_unchanged: true` otherwise; `full: true` to reread). A report read in idle grace marks it read too.
- A long or unknown pause: `hud-handoff` writes the state for a fresh session.
Read each result and decide: integrate, repair, review or stop. The main session owns every handoff and next step.
