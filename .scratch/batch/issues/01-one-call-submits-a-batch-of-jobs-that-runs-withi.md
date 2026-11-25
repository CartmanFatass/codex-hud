# 01: One call submits a batch of jobs that runs within reserved slots and notifies main once

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** claude-mod/11

**What to build:** Spec §2.1 (D-2026-11-25-03): a batch is a fixed flow for many independent jobs of one role. Add a batch form to `hud_create` (e.g. `items: [{brief_file|task, package?...}]` with the role and shared options, optional `max_parallel`) that returns one batch flow ID (reuse the ticket-queue / land flow machinery under `$HUD_HOME/flows` if it fits). The batch runner starts items as ordinary jobs (each still a normal job record with its own report), never more than min(max_parallel, role cap − 2) at a time, and admission always serves queued non-batch jobs of that role before batch members, so two Sonic slots stay free for interactive work (scouts, hud_sonic, main-session sonic). `hud_read({job: <batch flow>})` shows totals (done, failed, running, waiting) and the item→job map. Main gets exactly one notice when the batch ends (totals + how to list unread reports), and failures, stalls and questions of members individually as they happen (reuse claude-mod/11's package rollup path; batch members are not announced per create/queue/checkpoint). Keep the tool description within the MCP description size budget. Real use case to verify against: 140 Sonic labelling briefs in `tmp/tasks/HMASD-RESEARCH/briefs/` (use 3–4 of them for a live check, not the whole set).

- [ ] One hud_create call with items returns a batch flow ID; items become ordinary jobs with reports.
- [ ] At most min(max_parallel, cap−2) batch members run; a non-batch job of the role submitted during the batch starts before any waiting batch member.
- [ ] Main receives one end notice plus individual failure/stall/question notices, and no per-member create/queued/checkpoint/settled lines.
- [ ] hud_read on the batch flow shows totals and item→job mapping.
- [ ] Tests cover admission order, reserved slots, end notice and failure passthrough; a live run with 3–4 briefs works.
- [ ] Land gate passes.

## Comments
