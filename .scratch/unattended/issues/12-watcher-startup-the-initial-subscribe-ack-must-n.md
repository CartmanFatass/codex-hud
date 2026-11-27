# 12: Watcher startup: the initial subscribe ack must not clear permission outcomes and re-run a pass

**Status:** ready-for-agent
**Owner try:** no
**Live try:** none
**Blocked by:** none

**What to build:** Found by imp-daily-facts/01's land repair (job jf3074c6b9a617d38): tests/unit/worker-permissions.test.mjs:99 failed in gate[3] (reads=7, "The pane stayed blocked" 45 ms after start). Cause: src/runtime/watch.ts:104 -> watch-runtime.ts:1437, the initial events.subscribe ack calls reconcileTabs() -> permissionsSeen.clear() right after pass 1 wrote outcome "answered", which immediately triggers pass 2 and can re-handle an answered prompt (also a real-world double-handling risk for unattended/05's permission path). Make the subscribe ack not discard recorded permission outcomes (or reconcile without clearing answered prompts), keeping the at-most-once answer rule.

- [ ] Regression test: a permission prompt answered in pass 1 is not re-classified or re-sent when the initial subscribe ack arrives right after; worker-permissions.test.mjs passes 20/20 under 4-way parallel load.
- [ ] Tab reconcile still drops outcomes for panes that really disappeared.

## Comments
