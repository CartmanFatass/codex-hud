# 16: A follow-up send never fails the running task

**Status:** done
**Blocked by:** none
**Owner try:** no

**What to build:** Owner 2026-11-22: every `hud_send` or `hud_respond` to a working job makes the job's earlier MCP task end as `failed — no longer current. Use hud_read…` (src/mcp/thin-main.ts `sampleTask`, fence check ~3218; send path ~2470), so the main session sees a false failure each time it adds instructions. An addendum is not a failure. Make a follow-up to a job that already has a live task carry on that one task: re-fence the existing task to the new turn and extend its TTL, and have the send/respond return without opening a second task (or open one and end the old one silently, if the protocol allows that). The result is exactly one terminal notice per job for the chain, sent when the job reports, fails, asks or stops. Keep today's behaviour where a task really is stale: the job moved to another pane, was replaced by a repair job, or the send failed before reaching the worker. In those cases the notice says what happened, in words that do not read as a worker failure. Cover single sends, `jobs` fan-out, batch `messages`, `hud_respond`/`answers`, and the scout task.

- [x] Create a job, then send it two follow-ups while it works: no failed or cancelled notice; one completed notice at its report, carrying the latest turn's summary
- [x] `hud_respond` to an asking job continues the same task the same way
- [x] A send to a job whose pane changed, or which became a repair job, still ends the old task with a clear non-failure message naming the successor
- [x] Task TTL and batch notices still work; targeted thin-mcp task/send tests pass

## Comments

- Landed 97a258ea33cf74edddc2fc6e6590b8e79368d8bc; gate 5/5 passed.
