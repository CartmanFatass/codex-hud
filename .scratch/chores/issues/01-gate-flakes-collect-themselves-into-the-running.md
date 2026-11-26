# 01: Gate flakes collect themselves into the running flake ticket

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** 02
**Objective:** unattended

**What to build:** Owner 2026-11-26 (automate the orchestration chores). Today main copies every 'passed on immediate rerun' test from land notices into a test-flakes running-list ticket by hand and dispatches it when a case repeats. Automate: when a land gate passes only on rerun, the land flow appends the test name, file, flow id and log path to the newest open running-list ticket of the project's flake feature (configured in .hud/project.json, e.g. `"flakes": {"feature": "test-flakes"}`; absent = off), creating a new running-list ticket when the newest is done or claimed. When the same test appears a second time, or the list reaches four cases, the ticket becomes ready-for-agent and is dispatched as one imp job through the normal ticket path (one at a time). Ticket edits are committed per the ticket-commit rule (chores/02) or batched safely; never edit while a land holds the main checkout.

- [ ] Tests: a rerun-pass gate appends one entry; a repeat or the fourth case dispatches one job; an absent config does nothing; no edit while the main checkout lease is held
- [ ] Live try: none (main watches the next flaky gate append itself)

## Comments
