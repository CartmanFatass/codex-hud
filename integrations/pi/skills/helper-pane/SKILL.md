---
name: helper-pane
description: Use the owned implementer's sonic and reviewer helper tools within one HUD job.
---

Use call_sonic({brief_path, thinking?: 'low' | 'high'}) for fully specified small chores. Write the sub-request as a numbered sonic-q-N.md in the job directory, or supply an existing bounded worktree brief. The launcher snapshots the request and creates sonic_brief-N.md; the exact artifact remains sonic-N.md in the job directory. Request text cannot redirect its output. Explicit thinking applies only to that call; otherwise the parent's pinned routing snapshot applies.

Use call_reviewer({}) for independent closing review. Maintain impl-notes.md with claims and check evidence. The launcher creates review_brief-N.md and a fresh session for every review; review-N.md starts with `Verdict: accept` or `Verdict: changes-required`. Read findings, fix valid ones, rerun the affected checks and update notes before requesting a fresh review.

Only one helper can run at a time. At most 10 sonic reservations and 3 review reservations are available; failed reservations count. Helpers cannot launch helpers. You own sonic output and write the supplied tests yourself; never assign test authoring, bug diagnosis, measurement or design decisions to sonic. Escalate unresolved design or scope questions with ask_orchestrator. A missing or refused helper tool is not permission to invoke an alternative shell launcher.

Helper artifacts, wrappers, sessions and questions belong to the same job. Keep the launch contract's output paths authoritative. Write final reports and include actual check outcomes, review disposition, omissions and open questions. Completion does not trigger another role or authorize merge. QA waits up to 1200 seconds and may return the instruction “proceed with your proposed default”; this is not a human answer or evidence that a default action occurred.
