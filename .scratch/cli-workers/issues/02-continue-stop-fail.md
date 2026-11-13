# 02: CLI jobs continue, stop and fail like pi jobs

**What to build:** during idle grace, `hud_send` continues a CLI job that can continue: the agent turns working, the
job goes back to `working`, and the next done is judged against the report as it was when that turn started. While
working, `hud_send` types the message into the agent (queued, as for pi). `hud_close` on a working CLI job stops it
promptly (pi-role-reap's SIGTERM via the recorded pid and start time) and the job ends `stopped`; on an idle-grace job
it quits and closes. Closing the tab or the CLI exiting on its own ends the job `failed` ("agent exited" / "tab
closed"). If the supervisor process itself dies, the watcher notices on its next scan and marks the job failed
instead of keeping it open forever. The watcher's "move job-dir session files into pi's store before deleting" step
runs for pi jobs only.

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] Continuation in grace, with a second report check, covered by tests with a fake herdr
- [ ] hud_close: working → stopped; idle_grace → closed; tab closed → failed; CLI exit → failed
- [ ] A dead supervisor is detected by the watcher and the job settles failed
- [ ] Session preservation skipped for non-pi jobs; pi behaviour unchanged (existing tests)
