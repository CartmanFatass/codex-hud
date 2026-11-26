# Milestone review: native pi workers and the herdr fork lifecycle (2026-11-26)

Reviewer j5521aa747dd52730 (astra high). Brief: tmp/tasks/review-worker-stage/brief.md. MyHUD 26350ad3..6c5da7ae
(herdr-fork/06, pi-worker/04, pi-worker/05); herdr-hud 3027f8dd..76b187b0 (herdr-fork/05, /07).

Verdict: changes-required (fix first). No path signals a foreign PID or closes another launch's tab.

## Blocking (main's call in brackets)

1. Spec: a Sonic collection reminder counts as collection. `src/worker/sonic-jobs.ts:48–60` drops a child once
   `sonic-prompted` exists; `tab-lifecycle.ts:435–453` then lets the tab settle with an unread child. Settle only on
   the `sonic-collected` receipt. [fix]
2. Fork: the detector is pinned to the declared kind (`pane.rs:3027–3047,3086–3112`, handoff `1016–1052`), so the
   05 "detected kind wins" path never sees a conflicting root. [not blocking: HUD always declares the right kind;
   follow-up fork slice deletes or corrects the dead path and its test]
3. Spec: an async answer unacknowledged for 20 s while Pi is idle fails a live job (`tab-lifecycle.ts:306–313,
   417–425`). Surface the undelivered decision to main, keep waiting, accept a late acknowledgement once. [fix]
4. A managed startup timeout clears the name but the root keeps running; `reap-tab.ts:101–104,146–147` then sees the
   unnamed root as foreign and the retained tab never closes (`watch-runtime.ts:479–488`). At retention expiry,
   recognise the failed launch's own unnamed root by endpoint, launch, terminal, pane set and exact PID/start. [fix]

## Deletion boundary for herdr-fork/08

Delete: stock `tab create` → shell-typed `agent start` branches in `harness-cli.ts`/`harness-pi.ts`, busy-pane loops
and `retryBusyPane`; `src/runtime/cli-invocation.ts`; the `--exec-witness` branch (not the hud-cli supervisor);
supervisor witness adoption, stock foreground rediscovery and stock address-loss probing; the direct primary Pi
startup-shell snapshot hook. Replace the silent fallback with one fail-closed fork capability check; drain or refuse
old shell-launched receipts safely.
Keep: `tab-shell.ts`, `tab-owner.ts`, the stock reaper and close reconciliation used by browser (`harness-bro.ts`,
`browser-runner.ts`) and the split Pi helper shell; `sameTaskDirectory`, worker-tree grants and the `tree-owner`/
`tree-pane` protocol; `reapDirect`, exact PID/start and endpoint checks, root `pane.exited` matching on launch and
terminal, missed-event reconciliation, report/turn checks, stop precedence, failure retention, resume gate.

## Optional

- `tab-lifecycle.ts:267–274,306–315`: a busy Pi past the delivery deadline re-polls every 1 ms; use the fallback
  interval while busy.
- Tab policy keeps constant/unreachable inputs (`contract`, `helperPending`, `WarmInput.deadline/now`, print-mode
  branches; `tab-policy.ts:16–85`, `tab-lifecycle.ts:363–392,540–552`).
- `HUD-FORK.md`: a Blocked startup returns `agent_blocked` before `agent_not_ready`; document or align.

Follow-up: fix job for 1, 3, 4 and the first two optional items; herdr-fork/08 scope updated to the boundary above.
