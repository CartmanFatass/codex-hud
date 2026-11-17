---
name: hud-build
description: Build a spec whose tickets are published, as a task graph worked by HUD imps in parallel worktrees, integrated by the main session, closed with one milestone review.
disable-model-invocation: true
---

# HUD build

Adapted from mattpocock/skills `skills/engineering/implement-spec` @5863806 (MIT). Owned here; not tracked against
upstream. The executors are HUD roles (`hud-delegate`), never native or background subagents; the main session is the
only writer of tickets and of the integration branch.

You have a spec and its tickets (from `/to-spec` and `/to-tickets`, published as `docs/agents/issue-tracker.md` says).
If either is missing, stop and say which. The goal: the whole spec on one **integration branch**, every ticket closed
the way the tracker closes work, the owner trying the result.

The tickets are not a list of steps. They are a **task graph**: the tickets whose blockers are all done form the
**frontier**, and every frontier ticket is ready to build.

## Steps

1. **Read** the spec and the tickets; draw the graph (ticket, blocked by, files it will likely touch).
2. **Explore (optional).** When several tickets need the same investigation, dispatch one `oracle` or `general` job for
   it first. Its report is the notes file; later briefs point to it instead of repeating it. Copy what must outlive
   the job (job directories are deleted about a day after closing) into the tracker or the repo docs.
3. **Integration branch.** Branch from the current base, or use the milestone branch the project already has. If the
   tracker closes work through PRs, open a draft PR after the first integration.
4. **Dispatch the frontier.** One fresh `imp` job per frontier ticket, each in its own worktree on its own branch made
   from the integration branch tip (`git worktree add -b <branch> <dir> <integration-branch>`; pass `<dir>` as the
   job's `cwd`). Run tickets in parallel only when they touch different files; otherwise queue them. Pass the
   feature's slug as `package` so the Project tab links the job to its ticket. The brief, kept short:
   - context pointers: the spec, the ticket file or `#N`, the notes file, ADRs and the files to read first;
   - the seam to test at (agreed in the spec) and the main-path test to add; with `tdd` the worker builds red → green;
   - scope and out of scope, done-when (the ticket's acceptance list), a size budget and the stop rule;
   - "never edit the main checkout; commit in your worktree" (the integration step picks the commits).
5. **Integrate as each job settles.** Read the report and the diff, run the ticket's checks, then cherry-pick or merge
   the worktree branch onto the integration branch yourself. Tick the ticket's acceptance (on GitHub, then
   `hud tickets sync`), remove the worktree and its branch. A job that stopped on its stop rule gets a repair brief to
   the same job (`hud_send`, while it can continue) or a re-sliced ticket, never a wider brief.
6. **Advance the frontier.** When an integration unblocks tickets, dispatch them (step 4). Keep the project's slice
   ledger (if it has one) current at every dispatch and landing.
7. **Milestone review**, once, on the whole integration diff: per the convention's Review section (two axes, design
   intent in the brief, blocking bar). One fresh `imp` fixes the blocking findings in one pass.
8. **Close.** Mark the draft PR ready, or close the tickets the tracker's way; tell the owner what to try and how.
