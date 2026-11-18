# 03: Fix the worker-close review findings

**Status:** ready-for-agent
**Blocked by:** 01, 02 (both in wt/worker-close-02, not landed)

Review: docs/reviews/2026-11-17-worker-close-review.md (verdict: fix first). One pass, in the same worktree.

- [ ] **Only children started in the current turn count (finding 2).** Claude and Codex workers keep their MCP
      servers (hud-mcp, codegraph, playwright, …) as children for the whole session; they start at launch, before the
      first turn is sent. A live descendant counts as "still working" only if it started at or after the current
      turn's `sent_at` (process start tick vs `/proc/uptime`, as the pre-01 `newerChild` did), for settlement, the
      quiet decision and every close. Same rule for pi read-close (`hud-watch.mjs`), with the pi job's latest
      dispatch/send time as the turn start. A child of an earlier turn no longer holds a later turn open (accepted).
      Test: a fake CLI with a long-lived child started before the turn + idle + read report → closes; one started
      in the turn → stays.
- [ ] **Automatic read-close never stops a resumed worker (finding 1).** Read-close happens only when the read
      report is newer than the latest admitted send/continuation (no continuation after the report), and the reap
      aborts instead of taking pi-role-reap's working-worker SIGTERM path if the worker is working when it gets
      there (check right before, or a non-forcing reap mode). Explicit `hud_close` keeps force-stop. Test: an
      admitted continuation, then a read → no reap; worker turns working during the reap → not killed.
- [ ] **A failed read-close reap is retried (finding 3)** on the existing slow safety tick; no new loop.
- [ ] `docs/reference.zh.md` mirrors the English read-close and child wording.
- [ ] Main-path tests, temp homes, fake workers only; `tmp/env.sh` build + cli-judge and thin-mcp suites pass.

## Comments
