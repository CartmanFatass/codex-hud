# 11: Ordinary-queue item holds keep their approval fence through land, survive successor runs and stay out of ready lists

**Status:** ready-for-agent
**Live try:** Start an ordinary ticket queue on a scratch feature with three tickets: one whose report has an owner-decision blocker (lead escalates, item held), one independent that lands, and one whose land gate fails once and is repaired; then answer an unrelated to:main question to start a successor run. hud_tickets ready and the project board never list the held ticket; the successor shows one actionable notice for the hold; the repaired land goes back through blocker triage if its commit changed.
**Blocked by:** none
**Objective:** unattended

**What to build:** Milestone review j059e4af7ec78077e of unattended/04 (685632f2). (1) Ordinary queues pass no approved head to startLand (src/mcp/ticket-queue-step.ts:1186 passes `item.approved_head` only for unattended), so a land repair (src/mcp/land-runner.ts:569-585) can replace source_sha and publish a commit whose blocker/assumption approval was for another head. Carry the approval fence (head + report sig) through land for every run mode, and return changed evidence to triage; keep this separate from unattended's spec-file prohibition. (2) A successor run (src/mcp/ticket-queue.ts:234-262,469-479) copies the held item but starts with an empty outbox, so main loses the actionable resume notice; derive the hold notice from the durable item hold for the current flow. (3) `hud_tickets op:ready` and the project board use readOpenHolds, which reads only unattended runs (src/unattended/state.ts:77-79,125-136; src/mcp/local-tickets.ts:133-135,349-359; src/collectors/project-board.ts:694); include ordinary-run item holds.

- [ ] A land repair that changes the approved commit of a blocker- or assumption-approved item sends it back to triage instead of publishing (test, ordinary run)
- [ ] A successor run started while an item is held carries exactly one actionable notice for that hold, naming the current flow (test)
- [ ] hud_tickets ready and the project board exclude tickets held in an ordinary run (test)
- [ ] npm test, npm run test:mjs and check:fixtures pass

## Comments
