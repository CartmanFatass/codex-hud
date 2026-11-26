# 05: Ticket-queue hand-backs to main can be answered, and runs refuse to start without the lead role

**Status:** ready-for-agent
**Owner try:** no
**Live try:** main answers the next accept hand-back of a handback_to main run with hud_respond
**Blocked by:** none
**Objective:** unattended

**What to build:** Two gaps seen 2026-11-26. (1) A queue run with handback_to main pauses at the accept step with choices finish/repair/escalate (src/mcp/ticket-queue-step.ts ~1385-1395), but nothing lets main answer it: hud_respond only resumes worker questions, and hud_tickets run on a paused run restarts it with all steps waiting (re-running review). Add the answer path: hud_respond with job = the run ID (q...) and answer = one of the hand-back's choices (plus optional reason text after a colon or newline) settles the asking step exactly like a lead decision (finish records the verdict and ends the run; repair expects repair tickets added to the feature and loops tickets -> review -> accept within the same run, bounded like lead repair; escalate pauses with the reason for the owner). Wrong choice or no pending hand-back = clear error. Document it in docs/reference.md where handback_to main is described, and make the pause notice say how to answer. (2) Run q8439de016de0be74 (universal-bar) failed at accept with 'Role lead is not configured or is hidden in this project' after its ticket landed. hud_tickets run (and unattended on) must check at start that every role the run will need (imp, reviewer, and lead when the hand-back target is lead) is enabled in the project, and refuse with the exact fix (e.g. hud setup to enable lead) before dispatching anything.

- [ ] hud_respond on a run paused at a main hand-back with finish / repair / escalate settles it as a lead decision would (tests for each)
- [ ] An invalid choice or a run with no pending hand-back returns a clear error
- [ ] hud_tickets run refuses to start when a needed role (including lead for a lead hand-back) is not enabled, naming the fix; nothing is dispatched (test)
- [ ] docs/reference.md and the pause notice say how main answers

## Comments
