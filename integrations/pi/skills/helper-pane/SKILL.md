---
name: helper-pane
description: Use the sonic and reviewer helper tools within one HUD job.
---

Use call_sonic({brief_path, thinking?: 'low' | 'high'}) for fully specified small chores. Every non-sonic role may call it: the implementer, the reviewer (including the helper reviewer) and the architect. A sonic slot gets no helper tools. Write the sub-request as a numbered sonic-q-N.md in the job directory, or supply an existing bounded worktree brief. The launcher snapshots the request and creates sonic_brief-N.md; the exact artifact remains sonic-N.md in the job directory. Request text cannot redirect its output. Explicit thinking applies only to that call; otherwise the parent's pinned routing snapshot applies.

Run the brief's main-path tests once at the end; no full suites unless the brief asks. Run long checks in the background, writing checks/<name>.log ending with exit=<code>. A reviewer verifies the supplied evidence and runs only focused or diagnostic checks needed to assess the change, never full suites. Missing unrequested full-suite evidence is not a finding.

Use call_reviewer({}) only when the brief says `review: yes`, for one independent pass; it is available to the implementer only. Maintain impl-notes.md with claims and check evidence. The launcher creates review_brief-N.md and a fresh session; review-N.md starts with `Verdict: accept` or `Verdict: changes-required`. Read findings, fix valid ones within the brief, check affected paths and update notes; do not request another review. Report the result to the main session, which decides every next step.

Placement and the helper mutex. The implementer's sonic runs in the recorded right pane. Any other caller's sonic runs in a new pane split down from the caller's own pane, inside the same owned task tab; the split intent is recorded in the sonic's journal before dispatch, and the call closes it when the sonic exits. A sonic called by the helper reviewer borrows that reviewer's helper reservation as a child reservation, so it neither waits on the job helper mutex the reviewer holds nor takes the right pane. A sonic called by the primary reviewer or the architect, with no outer helper, takes the job helper mutex normally. The caller blocks until its sonic settles.

Limits. Only one helper runs at a time per job. At most 10 sonic reservations, shared by all callers under one sonic-N numbering, and 3 review reservations are available; failed reservations count. A helper reviewer may call sonic through a child reservation; sonic cannot launch helpers. A sonic called by a read-only role may write only its own report, with the inherited job QA and scratch exceptions, never the worktree.

You own sonic output and write the supplied tests yourself; never assign test authoring, bug diagnosis, measurement or design decisions to sonic. Escalate unresolved design or scope questions with ask_orchestrator. A missing or refused helper tool is not permission to invoke an alternative shell launcher.

Helper artifacts, wrappers, sessions and questions belong to the same job. Keep the launch contract's output paths authoritative. Write final reports and include actual check outcomes, review disposition, omissions and open questions. Completion does not trigger another role or authorize merge. QA waits up to 1200 seconds and may return the instruction “proceed with your proposed default”; this is not a human answer or evidence that a default action occurred.
