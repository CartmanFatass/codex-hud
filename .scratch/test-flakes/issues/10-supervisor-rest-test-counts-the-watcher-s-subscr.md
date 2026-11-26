# 10: Supervisor rest test counts the watcher's subscribe-time pane.get

**Status:** done
**Owner try:** no
**Blocked by:** none

**What to build:** `tests/unit/thin-mcp-cli-process.test.mjs:171` ("supervisor events: 60s at rest …") failed in two land gates on 2026-11-25 (f62da6fce5ec7a353, f9c65084a5e61a70c) and passed on rerun. Failure: the rest window saw `pane.get {pane_id}` before the expected `agent.get` calls (`assert.ok(extra.every(r => r.method === 'agent.get'))` at :198). Since herdr-fork/04 the watcher reconciles direct-exec roots (`runtime.reconcileTabs()` after its `hud-watch` subscribe reply, `probeDirectRoot` → `pane.get`), and the baseline waits only for the subscribe request to be sent, not for that reconciliation. Find the actual source of the `pane.get` and make the test wait for it to finish before snapshotting (or attribute requests to the supervisor vs watcher), without weakening the at-rest guarantee for the supervisor. If the request comes from the supervisor during rest, it is a product bug: fix the supervisor instead.

- [x] Report names the code path that issued the pane.get
- [x] The test passes 30 consecutive runs under `TZ=UTC node tests/run-mjs.mjs 8`-level load (e.g. 8 parallel copies), with the supervisor's zero-spawn/zero-STATUS-write assertions unchanged

## Comments

- Landed in this commit (replay base 432a09923f8b7c98f6688663f8925516eddd48dc); gate 5/5 passed.
