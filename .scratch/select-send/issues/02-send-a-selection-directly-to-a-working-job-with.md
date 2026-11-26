# 02: Send a selection directly to a working job, with the answer tied back to the excerpt

**Status:** done
**Owner try:** yes
**Live try:** Select text in a pane, press Ctrl+b a, pick a working job in the target list and send; the job's answer appears next to the excerpt on its card in the Inspector and on Execution, and picking a job that just ended shows "ended" and offers main.
**Blocked by:** select-send/01
**Objective:** interaction

**What to build:** D-2026-11-26-02: for tasks that gain from closer interaction, the composer's target picker also lists the project's working jobs (role, ticket/package, state). Sending creates an excerpt record (id, excerpt, source, question, target job, time) in HUD_HOME and delivers it to the job as a message carrying the id (`hud_send` to a working job only: never reopens or repairs a closed job; a target that ended shows "ended" and offers main instead). The worker answers through its normal tools with the id (a `reply_to` field on `hud_report` progress or a dedicated small reply tool); only a matching id marks it answered. The excerpt card (Inspector of the target job, and the Execution page) shows queued / answered / target ended / delivery unknown, and the answer next to the original excerpt even after the source pane changed or closed.

- [x] Tests with two synthetic workers: cross-sent excerpts answered in reverse order map to the right excerpts; a closed target is never reopened; a reply without a matching id does not mark anything answered
- [x] Owner try: select an error in one pane, send it to the worker changing that code, see its answer next to the excerpt ten minutes later

## Comments

- Landed in this commit (replay base cec13a4eb3dd035036afa020d2cc1de9f1f17855); gate 5/5 passed.
