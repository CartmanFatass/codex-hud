# Brief for the orchestrator: MCP and workflow changes after the retrospective

Written 2026-11-10 from a discussion with the owner, who asked for this page so the running orchestrator can carry
it out. Background and reasons are in `docs/reviews/2026-11-10-retrospective.md` and
`docs/reviews/2026-11-10-workflow-discussion.md`. Where this page differs from the "proposed" items in the discussion
record, this page is the later one.

Finish what you are doing first. Nothing here interrupts M1.

Updated 2026-11-11: the owner agreed that the dispatch convention is one editable file handed out by `hud_roster`
(section G). D2 changed with it: the bridge is that file, not a skill.

Updated 2026-11-11 (owner, from `~/vibecoding/reports/Agent 编程工作流阅读清单.md`): TDD is a trial (D1); review,
test-usefulness and who-writes-code rules (E); the deletion direction (D4); four numbers in milestone reports (F); two
points in G; Matt's skills upstream is v1.3.2.

## What the owner settled in the discussion

- The old workflow failed because management itself was delegated: agents managed and reviewed agents, and nobody
  held "what do I want, and when is it enough". Mechanisms alone do not fix that; the owner being in the loop does.
- The owner wants the important technical decisions, with an explanation. The owner is a STEM graduate student, not a
  professional developer, and wants to learn from the project. In the old workflow the orchestrator answered 322
  questions on the owner's behalf; that is the thing to stop.
- Roles and workflow are separate. A role can be defined for any harness; the workflow (dispatch pattern) is prose
  that can be swapped. The HUD binds neither.
- No workflow that is always loaded. Matt Pocock's skills (local copy `~/projects/mattpocock-skills`) are the
  reference: their stages load only when the owner types them, and they do not chain by themselves. The toktrack set
  under `~/projects/TokWatch/toktrack/.claude/` is the counter-example: a chain in `CLAUDE.md` enforced by hooks on
  every task.
- The owner talks only to the orchestrator. The orchestrator uses imp, sonic, arch and reviewer; workers ask through
  pi's `ask_orchestrator`. That stays.

## Order of work

1. M1 reaches the owner: the owner installs it and uses it. This comes before everything below.
2. Spec wording (section A), confirmed by the owner.
3. Slice ROLE-FILES (section B).
4. Slice CONVENTION (section G), right after ROLE-FILES: it reads files on the same path.
5. M2 deletion, then a code walkthrough for the owner (section C).
6. Workflow files (section D). D4 touches only docs and can be done at any quiet moment.
7. The next milestone runs the whole new flow once as its trial (section F).

## A. Spec wording: ask the owner, then apply

`docs/spec.md` is the owner's. Show the owner the wording and apply it only on a yes.

- §2.1, replacing "the fixed roles (imp, reviewer, sonic, oracle, jev)": "Roles are defined by files; the HUD ships
  defaults. The MCP knows no particular role and no workflow."
- §2.1, replacing "The skill ships a short default workflow (…) that a project's own docs override": "The HUD ships a
  short default dispatch convention; a project's or the owner's own file replaces it whole. `hud_roster` returns the
  roles and the convention in effect." The owner agreed to this change on 2026-11-11; confirm only the wording.
- §5 M2: the deletion covers the old role facade and the old `hud-mcp` surface as well as the retired execution
  stack. Commit `3d47211` already put the facade into the spec; check that nothing is left to add.

## B. Slice ROLE-FILES: the thin layer reads roles from files

Serves spec §2.1 as reworded in A. Do not start before A is confirmed.

- **Now:** `packages/hud-mcp/src/thin-main.ts` (337 lines) has `roleMap = { imp, reviewer, sonic }` and two checks on
  the name `imp` (split pane; `hud_send` only for imp).
- **Wanted:** a role is one small file: name, harness (`pi` only for now), the pi-roles role it maps to, and the two
  properties that are name checks today (split pane, can continue). The HUD ships defaults for imp, reviewer, sonic
  and architect; files under `$HUD_HOME/roles/` add or override. `hud_roster` lists what the files say. The tool
  schema takes any role name and `hud_create` refuses an unknown one. No role name remains in the code.
- **Out of scope:** other harnesses, oracle and Jev (M3), enforcing which helpers a role may call, any workflow field.
- **Budget:** about 60 source lines net, one more case in `tests/unit/thin-mcp.test.mjs`. If it does not fit, stop and
  report.
- **Demo:** drop a role file for a new name into `$HUD_HOME/roles/`; `hud_roster` shows it; `hud_create` with that
  role opens the mapped pi role in herdr. `architect` works through the HUD the same way.

## C. M2 deletion, then a walkthrough

- **Scope:** everything the owner-facing paths do not reach. Start from what the installer, the thin MCP, the pi
  package, the panel, the Claude statusline and the pi footer import, and delete the rest with its tests. That
  includes `src/roles/facade.ts`, `src/roles/pi-owned/`, the old `hud-mcp` surface and the execution stack of slice L
  (the owner approved slice L on 2026-11-10; the facade is covered once A is confirmed).
- **Rule:** deletion only. If removing something needs new code beyond fixing imports, stop and report.
- **Review:** this is a risky change, so one targeted review with one question: after the deletion, does everything in
  spec §2 still work (install, uninstall, six tools, panel, statusline, footer)?
- **Report to the owner:** source and test line counts before and after, and the demo of spec §2 run for real.
- **Walkthrough:** after M2, take the owner through `thin-main.ts` and the path from a job file to the panel: how the
  data flows and why it is split that way. This is the owner's first learning session; the code is now small enough
  to read whole.

## D. Workflow files

### D1. Matt Pocock's skills, unchanged

- Update the local clone first (it is at `49dd158`, 2026-10-09; upstream is at v1.3.2, 2026-10-29).
- Install at user level, not into this repository (it is public). The owner's `~/.claude` and `~/.pi` are managed
  through `~/Fishpref`; tell the owner what will be installed and wait for a yes.
- For the orchestrator (Claude Code): `grill-with-docs`, `to-spec`, `to-tickets`, `prototype`, `code-review`,
  `wait-what`, `wayfinder`, plus the skills these call (each skill names them; at least `grilling`,
  `domain-modeling`, `research`) and `setup-matt-pocock-skills`. Not `triage`, not `pr`, nothing from `misc/`.
- For pi workers: `tdd`, as a trial, not a fixed step of every ticket: imp writes a failing test first only on the
  few external interfaces the owner has confirmed. Sources disagree on test-first for agents.
- `setup-matt-pocock-skills` is typed by the owner, once, in this repo. Tracker: local files.
- Do not edit these skills. Personal adjustments go into D2 and D4.

### D2. The bridge is the owner's convention file

The text that connects Matt's tickets to the HUD's roles is not a skill. It is the owner's dispatch convention, the
file section G serves. A draft is at `~/vibecoding/drafts/convention.md`: `implement-spec` with HUD roles in place of
subagents, plus the tiers, the question rules of D3, the review and the acceptance. Do not install it; the owner
edits it and copies it into place when satisfied.

The seam between the two halves is the ticket. `to-tickets` writes ticket files; the convention says what a ticket
must carry (title, what to build, acceptance criteria, blocked by, size budget, stop rule) and where tickets live.
Replacing Matt's front half later changes only that paragraph.

### D3. Questions, decisions and the architect

How the orchestrator handles an `ask_orchestrator` question:

| Kind | Handling |
| --- | --- |
| Local (naming, error handling inside a function) | Answer with the simplest option |
| Already settled in the spec, a ticket or a decision record | Answer by quoting it |
| Structural and not yet settled (where state lives, process split, interfaces between parts, where to test) | Do not answer. Collect these into one round for the owner |
| Beyond the spec | The worker stops and reports |

- A round for the owner follows `grilling`: each question numbered, with the recommended answer, the reason, what it
  costs and what the other option buys. The test for "structural" is whether the decision would appear in a one-page
  description of the architecture.
- Each settled structural decision gets a short decision record: what was chosen, why, what was given up.
- Workers set the `default` of every question to the simplest option, so a question that times out does no harm.
- A ticket that produces many questions was under-specified: fix the ticket.
- The architect is consulted before the spec is written: it returns options with their costs, including the smallest
  one, and the owner decides. It is not called in the middle of implementation.
- Check the pi-roles role texts (Fishpref) against the above and E; change only what is missing, following D4's
  deletion direction. `81e1859` already covers part of it.

### D4. Less that is always loaded

- `CLAUDE.md`: pointers only. Keep the project guide lines; replace the three-document reading order with
  `docs/spec.md` and the state file. No workflow text.
- `docs/handoff/STATE.md`: rewrite to one screen (done, next, decisions waiting for the owner). It is 670 lines and
  its title still names the 2026-11-03 handoff; the history is in git. From now on it is rewritten, not appended to.
- `docs/delegation.md`: the role and model table, the repo conventions, and pointers to the skills and to the
  dispatch convention. The loop description goes; the skills carry it.
- The memory index for this project: remove entries that only describe superseded process rules. Keep environment
  facts and pointers.
- Direction for D4 and the role-text check: delete, do not rewrite into longer versions. Remove ownership phrasing
  ("this is your codebase"; it invites tests and docs nobody asked for), long anti-over-engineering clauses written
  for older models (scope comes from each ticket), and caution clauses accumulated in memory, notes, instruction
  files and messages between agents, wherever they can go.

### D5. Three ways of working

The owner chooses by what they type; nothing forces the full flow.

| Way | For | What happens |
| --- | --- | --- |
| Direct | A small change (one file, obvious approach) | The orchestrator does it or hands it to sonic; no brief, no review |
| One slice | One clear feature | One imp job with a budget; the orchestrator reads the diff |
| Full flow | A milestone | grill, spec, tickets, `hud-implement-spec` |

## E. Standing rules (short on purpose)

- From M1 on, dispatch through the HUD's six tools, not `herdr-delegate`. The architect follows once B is merged.
- A new process rule, guard or test needs a failure that actually happened. A hypothetical one does not qualify.
- A worker or the orchestrator may decide alone to do less. Anything that adds beyond the budget goes back up; growth
  beyond the spec goes to the owner.
- Tests sit at the outermost seam, one per behaviour the owner would notice. Deleted code takes its tests with it.
- Only imp writes code. Reviewer and architect give judgements and write only their own report. Parallel imps only
  when their files do not overlap. The role texts say the same.
- Review (reviewer briefs and the reviewer role text): look at the diff only, not code that was already there; no
  style checks. Two axes: against the spec (missing, wrong, unasked-for), and defects a user would hit plus what can
  be deleted. One round by default; a second only if the fix itself looks wrong; at most three; never loop until
  "clean". Findings come back to the orchestrator, who decides which get fixed.
- Tests prove they are useful: for each new test, imp's report says which production change would make it fail, or
  shows a red-then-green run. Tests that only check mocks are flagged in the report. Once per milestone, sample one
  important module with a mutation check (break one behaviour on purpose, see whether a test fails). Deleting
  useless tests is normal maintenance and needs no approval.

## F. Trial and what to report

The next milestone after M2 runs the full flow once. Change the flow only where something actually went wrong, and
tell the owner what that was.

At each milestone give the owner: the demo, the size (lines added and removed against what the owner can newly do), a
ten-sentence description of how the system works now, and four numbers: test count and source lines, review rounds,
the sampled mutation check's result, and the number of problems the owner found when trying it. A noun in that description that is not in the
spec or the glossary is something the owner has not agreed to; say why it exists.

## G. Slice CONVENTION: `hud_roster` hands out the dispatch convention

Serves spec §2.1 as reworded in A. Runs right after ROLE-FILES.

Two things were mixed under "dispatch rules". The **tool contract** (how the six tools wait, answer and close) belongs
to the MCP, is not editable, and stays in the tool descriptions and in `hud-delegate`. The **dispatch convention**
(when to use which role, how to write a brief, when to review) is prose the owner edits. This slice is about the
second.

- **Wanted:** the convention is one plain file. Lookup order: a file in the project, then one under `$HUD_HOME`, then
  the default the HUD ships. The first one found is used whole; there is no merging. `hud_roster` returns it together
  with the path it came from, next to the role list. No new tool: a session calls `hud_roster` when it starts to
  delegate, so the convention enters the context at that moment and not before.
- **Default:** the eight lines under "Default workflow" in `integrations/skills/hud-delegate/SKILL.md` move into the
  shipped default file. `hud-delegate` keeps the tool manual and says in one line that `hud_roster` returns the
  convention.
- **Guard rails:** the MCP does not parse the file; the file has no fields for stages or conditions; it has a size
  cap. Past any of these it becomes the workflow engine that spec §3 rules out.
- **Not for workers:** only the main session receives the convention. A worker still gets its role text and the
  brief, which keeps roles neutral.
- **The owner's file:** it exists only once the owner copies the default or the draft into `$HUD_HOME`. Installing or
  upgrading the HUD never writes or changes it.
- **Out of scope:** validation or a schema, a tool that sets the convention, one convention per role, template
  variables, choosing between several conventions (a project file is the switch).
- **Keep it short:** the convention file stays well under 20,000 characters; Claude Code truncates re-attached
  skills there after a context compaction.
- **Server instructions:** if it is simple, add one sentence to the MCP server instructions: "call `hud_roster`
  before dispatching". Do not use MCP prompts or resources; clients do not support them uniformly.
- These two points fit inside the budget below or are dropped.
- **Budget:** about 30 source lines, one more case in `tests/unit/thin-mcp.test.mjs`. If it does not fit, stop and
  report. File names and the project location are the implementer's choice; take the simplest and say which.
- **Demo:** `hud_roster` shows the default convention and its path; put a file under `$HUD_HOME` and it shows that
  one; put a file in a project and a session started there shows the project's.

## When the owner is needed

- A: yes or no on the two spec sentences.
- D1: yes on the installs; typing `/setup-matt-pocock-skills` once; naming the interfaces that get test-first.
- D2 and G: editing the convention draft and putting it in place.
- D3: answering rounds of structural questions.
- C: the walkthrough. Every milestone: looking at the demo and trying the build, about one to two hours in total.

## Not to build

No workflow engine, no hooks that enforce a flow, no workflow stages in the panel, no adapter for another harness
until the owner wants a role on one, no further process rules beyond this page. For the convention: no parsing, no
validation, no merging of files, no tool that writes it.
