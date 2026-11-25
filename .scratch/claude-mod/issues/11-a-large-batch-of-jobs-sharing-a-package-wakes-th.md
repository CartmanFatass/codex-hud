# 11: A large batch of jobs sharing a package wakes the orchestrator with rollups, not one line per job

**Status:** done
**Owner try:** no
**Blocked by:** none

**What to build:** On 2026-11-25 the main session created ~140 headless sonic jobs with `package: "hmasd-label"` (sonic cap 9, the rest queued). Every create, every `queued (#N)` position, every `still working at 10 min` checkpoint and every settled report produced its own line in the orchestrator wake (Claude mod `HUD events` messages; the same lines feed other delivery paths), so the session received hundreds of low-value wakes. Change orchestrator delivery so that jobs sharing a `package` with 3 or more live members (working or queued) are treated as a batch: (1) per-member `queued (#N)` and `still working` lines are not delivered; (2) per-member settled/closed lines are folded into one rollup line per package, delivered at most once per 5 minutes while the batch is live, e.g. `hmasd-label batch: 42 done, 2 failed, 9 running, 85 queued`; (3) a member that fails, stalls, asks a question or needs an answer is still delivered at once and individually (attention first); (4) when the last member settles, one final line with the totals and how to list unread reports. Jobs without a package or in packages below the threshold keep today's behaviour. No duplicate wakes, and a notice is still not a read (spec §2). Apply it wherever orchestrator wake lines are produced (Claude mod, pi delivery, watch fallback) through one shared path if one exists.

- [ ] Batch members' queued and still-working lines are not delivered; their settlements arrive as at most one rollup per package per 5 minutes plus one final line.
- [ ] Failure, stall and question events of batch members are delivered immediately and individually.
- [ ] Jobs outside a batch are unchanged (existing notice tests pass).
- [ ] Tests cover threshold, rollup timing, failure passthrough and the final line.
- [ ] Land gate passes.

## Comments
