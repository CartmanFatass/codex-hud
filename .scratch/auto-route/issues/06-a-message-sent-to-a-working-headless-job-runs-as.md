# 06: A message sent to a working headless job runs as its next turn

**Status:** done
**Owner try:** no
**Blocked by:** mcp-split/03

**What to build:** Found live 2026-11-22: with routing on, imp jobs start headless, and hud_send (single or {jobs} fan-out) to a working headless job returns not_continuable (sendJob: no primary pane), so the main session cannot steer most working imps. A tab worker queues the message for after its current step; a headless worker should do the same: record the message in the job dir and, when the current turn ends, resume the native session with it as the next turn (same resume path as a post-report send within resume_s). One process per turn stays.

- [x] hud_send and hud_send({jobs}) to a working headless pi, claude or agy job return ok with queued, not not_continuable
- [x] When the current turn ends (report or plain turn end), the session resumes with the queued message(s) in send order; nothing is dropped if the turn ends asking (delivered with the hud_respond resume)
- [x] The caller's MCP task stays current and wakes at the final report, as for a tab job's queued send (FANOUT-TASK)
- [x] Synthetic fake-bin tests for pi and one CLI harness; docs/reference.md (+ zh) headless paragraph says follow-ups to a working headless job run after its current turn

## Comments

- Landed 3c4dadcd77ee35bb47f139d6a286218128728c20; gate 5/5 passed.
