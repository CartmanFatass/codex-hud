# 09: Hotfix: Claude CLI workers start again (the witness shim execs the PATH name, not the versioned realpath)

**Status:** done
**Owner try:** no
**Blocked by:** none
**Objective:** pi-worker

**What to build:** Observed 2026-11-25 20:37 and 20:39 after pi-worker/07 landed (b8abfebb): every frontend-imp job on claude fails with herdr's `timeout: timed out waiting for agent startup` (jobs j3a0711153840bab8, jeed4b400b88964c7); agy works (j62c48d2fc462b3ca, witness adopted). The shim did run and wrote witness.json, so claude started. Cause: `src/mcp/dispatch/harness-cli.ts:137` takes `real = executable(place.agent)` from `src/roles/roster.ts:114`, which returns `fs.realpathSync`. On this machine `~/.local/bin/claude` is a symlink to `~/.local/share/claude/versions/2.1.332`; the shim and `execWitness` (`src/runtime/cli-invocation.ts`) exec that versioned file, so the kernel names the process `2.1.332`, argv[0] is the versioned path, and herdr's `agent start --kind claude` never recognizes a claude agent. Fix: the launch execs the path as found on PATH (the symlink, e.g. `~/.local/bin/claude`) with argv[0] the agent name, in both the witness branch and the plain branch of the shim; keep `executable()`'s realpath for any caller that needs it (check each caller; don't change trust or identity checks that rely on the resolved file). Witness identity stays exact PID + start ticks. Add a test whose fake agent is a symlink to a versioned file name and assert the started process's `comm` and argv[0] are the agent name (red before the fix). Then main live-checks a claude job.

- [x] A CLI agent reached through a symlink to a versioned file runs with comm and argv[0] equal to the agent name, through the witness branch and the plain branch
- [x] The witness still records the exact PID and start ticks of the agent process
- [x] Test with a symlinked versioned fake agent is red before the fix and green after
- [x] Land gate passes

## Comments

- Landed in this commit (replay base 602cc8103d163c4b66d892135009f973022a8597); gate 5/5 passed.
