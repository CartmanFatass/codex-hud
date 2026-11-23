# 02: Home shows Waiting, Now/Next and a load line; plain Jobs open Inspector; Split and Changes go

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** 01

**What to build:** Spec §2.2 and §5 M1; removal items 1–7 and 22. Current-project Home shows: explicit Waiting (STATE `## Waiting for the owner` and open owner requests), STATE Now/Next, and one scoped load line where known. A plain Jobs list (one row per job, no animation) opens the Inspector, which keeps reports, original worker questions and stop actions; the native-subagent tree loads only there on demand. Delete: worker cards as Home, card filter, inline expansion, on-card actions, package/brief lanes, native-subagent lanes, card auto-open/fold/hide and expiry settings, finished-job reveal, folded queued/read rows, stage animations, activity sparklines, "cards win", the spare-row board, latest accepted slices, the "done today" footer and the Home tasks/tickets setting; the Split list/preview layout, sizing/focus controls and layout selector (ignore a saved Split preference; keep Control's model picker); the standalone Changes entry (merge its Git/worktree facts into project diagnostics). Keep collectors, receipts and data; delete only display code and its settings. Coupling notes: `review-carbon.md` §4 (`controller.ts:270-306` subagent scan, `hud-status.ts:138`, `notify.ts:275`, `header.ts:54`, `scheduler.ts:85`) in `/home/fires/projects/MyHUD/tmp/tasks/spec-pivot/`.

- [ ] Render test: Home with an owner request, STATE Now/Next and running jobs shows Waiting, Now/Next and the load line, and no worker card
- [ ] Test: a job row opens the Inspector with its report and original question; the subagent tree is not scanned until the Inspector asks
- [ ] A saved Split layout preference loads without error and is ignored; Control's model picker still works
- [ ] Removed settings in an existing settings file are ignored without error
- [ ] `npm test` passes; docs/reference.md (EN/ZH) updated for removed panels and keys

## Comments
