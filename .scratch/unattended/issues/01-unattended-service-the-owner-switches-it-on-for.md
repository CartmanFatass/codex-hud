# 01: Unattended service: the owner switches it on for chosen Objectives and their ticket queues keep moving

**Status:** ready-for-human
**Owner try:** yes
**Blocked by:** workflow/05, workflow/07
**Objective:** unattended

**What to build:** Spec §2.1 (26.02), D-2026-11-26-02, owner 2026-11-26: an unattended service the owner sets up and switches on explicitly, never inferred from activity or presence. `hud unattended on --objective <id> [--objective <id>...]`, `off`, `status` (and the same toggle in panel Settings). While on, one resident service per machine (exact PID + start recorded in HUD_HOME; one instance; survives the main session and MCP closing) starts the ticket-queue workflow run (workflow/05) for each chosen Objective's ready tickets, starts a new run when tickets become ready, and lets runs end with the `lead` acceptance (workflow/07): the lead answers worker questions within its authority, repairs failures, runs the milestone reviewer, accepts owner-try items as main does today, and lands. It never opens new Objectives, never edits `docs/spec.md`. Hand-back (owner's choice): only an item that would delete a user-visible feature or change the spec stops; it becomes an owner request on Home and the service continues with other items. Off stops starting new runs and lets running jobs finish (no kill). Home shows one line while it is on (Objectives, running count, open hand-backs); the bar shows a compact marker. Results and hand-backs are what the owner reads on return; no activity tracking.

- [x] Tests (fake herdr/CLIs): on with one Objective runs its two ready tickets in one Objective run (N + 2 sessions) to landed with the dispatcher's main session gone; a held ticket (unapproved removal or spec change) stays on Home and excludes its dependents while an unrelated ready ticket in the same Objective run still lands; off starts nothing new and kills nothing
- [x] One instance per machine: a second `on` updates the chosen Objectives instead of starting another service; status reports PID, Objectives, runs and hand-backs
- [x] Owner try: switch it on for a small Objective with two or three tickets, close the main session, come back to landed results and any hand-back on Home

## Comments

- Landed in this commit (replay base ccc3c9c7bbefe4fb405648367b23f83be4ea7459); gate 5/5 passed.

- Landed in this commit (replay base 776c1f02c5f5308e070cf25639b132a9f77a238f); gate 5/5 passed.
