# 01: A ticket queue waits for blockers in other features

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** none

**What to build:** Owner 2026-11-24 accepted: the main session should be able to publish a feature's tickets and start its queue right away even when some tickets are blocked by another feature's tickets that have not landed yet (e.g. toktrack's web build waiting on `models-ux/02` and `projects-ux/02`); the queue holds those tickets and starts each one when its blockers are done, instead of the main session remembering to start the queue later. First find what happens today when `hud_tickets({op: "run"})` meets a `**Blocked by:** other-feature/NN` that is not done (`src/mcp/ticket-queue*.ts`, `src/mcp/local-tickets.ts`, the Project tab's Queued/Stalled rules in `docs/reference.md` ~751-759): whether it waits, skips, fails or completes the queue early. Then make it wait: a cross-feature blocker that is not `done` holds the ticket as Queued (shown so in the queue's state and the panel), the runner rechecks when any land completes (event-driven, no polling loop beyond what the runner already does), and starts it when every blocker is done. A blocker that is `wontfix` releases it; a blocker that does not exist is an error at `run` time as today. A queue whose only remaining tickets wait on other features stays alive and says what it waits on; it does not count as failed or completed. Update `docs/reference.md`. Budget about 80 source lines and 3 tests. Stop and report if it needs more.

- [ ] Test: a queue started with ticket A ready and ticket B blocked by another feature's not-done ticket runs A, keeps B queued and names the blocker; when the other feature's ticket lands, B starts
- [ ] Test: a wontfix blocker releases the ticket; a queue with only cross-feature-waiting tickets stays alive and is neither failed nor completed
- [ ] The land gate passes

## Comments
