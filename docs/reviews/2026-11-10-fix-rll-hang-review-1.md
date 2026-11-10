Verdict: changes-required

## Findings

### 1. Raw-group cleanup loses ownership when its leader exits first

**`tests/unit/run-light-leader.test.ts:162–177` (also `:240–242`) — Severity: major.** Raw groups retain only the leader's stamp, so cleanup discards their session before discovering surviving members if that leader has already been reaped.

Concrete failure scenario: launch the real shell through `spawnRawLeader`, submit RUN, and let its workload fork a long-lived grandchild. After STARTED, kill the identity-checked leader and await its exit, then trigger the fixture's abort listener. `ownChild()` recorded only `child.pid`; the direct-child discovery cannot recover the now-orphaned members, and the anchor check deletes the SID. The subsequent `/proc` enumeration therefore skips the still-live workload, grandchild and auxiliary shells. Destroying the parent's streams does not terminate those processes. This violates the required failure/timeout process-group cleanup, including the stated leader-death coverage.

I reproduced this with the **unmodified compiled fixture and raw-launch helper bodies**, the real `GROUP_LEADER_SCRIPT`, and real Python workload/grandchild processes. The test-context substitute supplied only hook registration and an AbortSignal; it did not replace cleanup or signalling. Actual output:

```text
before abort cleanup: workload=alive grandchild=alive
after actual abort listener and cleanup(): workload=alive grandchild=alive
identity-checked fallback: all captured members dead=true
probe-exit=0
```

A separate probe also left an orphaned grandchild alive after normal raw-leader/workload completion followed by `f.cleanup()`.

**Suggested fix:** retain independent stamped ownership anchors for raw-session members while they are observable—for example, capture command/waiter identities from protocol replies and retain descendant ownership before relinquishing the last anchor. Preserve stamp/cwd/argv checks; do not solve this by signalling an unanchored numeric SID. Add a real failure/timeout regression that reaps the raw leader first and verifies that its workload and grandchild are still killed.

## Verified

### Scope and implementation

- Read the task/review briefs, implementer notes, q1/q4/q5 decisions, repository agent guidance, relevant architecture rules, both complete changed files and the full diff against `2c6dcf67090064b66f17bc79905f7aac7f528921`. `git status --short` contains exactly the two expected modified files and no untracked files.
- The production repair matches q4: both protocol readers ignore INT/TERM; the waiter's ignore is after the workload fork and `command=$!`, before STARTED; the workload wait is performed once. The leader's ignore remains after waiter fork. No protocol validator, cancellation authority, production deadline, GNU-env launch path or `native_unknown` projection was changed.
- Existing assertions remain. Waiting for stamped victims to become dead before the original post-KILL assertions is justified: signal acknowledgement does not establish that every member has completed kernel teardown.
- All test registrations use the 20-second wrapper, except the deliberately shorter 3-second timeout probe. Cleanup waits are bounded. Existing failure/timeout probes exercise real processes, but keep the leader alive until cleanup and therefore miss finding 1.
- The fragmented-read tests exercise real readers, using FIONREAD without consuming their bytes. Historical negative logs show **6/6 leader cases failing** before repair and **5/6 forwarder cases failing** with its old trap restored—not six forwarder failures as claimed in the notes.
- The historical hang snapshots support a genuine protocol/wait race rather than a timeout-only workaround: the original uninstrumented topology hung once in 290 attempts; the reader-only diagnostic captured `BAD_DONE DONE|-1||`, with both readers ignoring INT/TERM and waiting indefinitely after the waiter/workload disappeared.
- Current paired controls show all six ordered waiter-disposition tests failing on reader-only code and all twelve selected tests passing on fixed code. The six exact-status interleavings also pass on reader-only code; this limitation is accurately disclosed and explicitly permitted by q4. Those tests retain real waits/statuses rather than manufacturing a bad DONE value.

### Recorded checks

Inspected the authoritative `checks/q4-final-pre-*.log` files and validation/load drivers. Required current-candidate logs are complete and newer than the newest changed source file (`2026-11-10 01:33:36`). Results:

| Check | Actual recorded result |
| --- | --- |
| `npm run build`, `npm run build:test`, `npm run build:hud-mcp` | Each `exit=0` |
| Target file alone ×3 | Each 89/89 pass, `exit=0` |
| Loaded whole-file runs | 20/20 completed, each 89/89 pass and `exit=0`; no test timeout or external guard; 48 owned nice(5) loops, CPUs 0–15, four concurrent files |
| Loaded file durations | 57,547–64,397 ms on the recorded WSL2 / Node 24.22.1 host |
| Uninstrumented CPU0 topology loop | 500 iterations, 0 hangs, 0 mismatches, `exit=0` |
| `npm run format:check`, `git diff --check` | Each `exit=0` |
| `npm run test:unit` | **Not green:** 4402 tests, 4373 pass, 3 fail, 26 skip, 0 cancelled; `exit=1` |
| Cold-launch isolated rerun | 1/1 pass, `exit=0` |

The full-unit failures are exactly the two owner-reserved workboard cases and the known PIROLE PR3 cold-launch flake. The orchestrator explicitly confirmed in review question q6 that these q4/q5-authorized failures are gate context, not new in-scope findings. They are not represented here as a green unit gate or independently baseline-qualified workboard tests.

### Independent commands

- `node --test dist-test/tests/unit/run-light-leader.test.js`, launched with fresh temporary HOME/HUD_HOME/CODEX_HOME and specified inherited overrides cleared: **89 tests, 89 pass, 0 fail/cancelled/skipped; 36,486 ms; exit=0**.
- `git diff --check`: **exit=0**, no output.
- Focused in-memory `node --input-type=module` cleanup probes using the actual compiled helpers: reproduced finding 1. The final abort probe used fresh HOME/HUD_HOME/CODEX_HOME; all captured probe members were confirmed dead after identity-checked fallback cleanup.
- Read-only log audit verified freshness, final exit markers and all twenty loaded-run results. No full suite was rerun and no repository files were changed.

<repo-parent>/MyHUD/tmp/tasks/FIX-RLL-HANG/review-1.md — 1 finding (major).
