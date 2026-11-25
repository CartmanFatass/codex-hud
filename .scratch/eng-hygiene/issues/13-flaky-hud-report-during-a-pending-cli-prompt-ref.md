# 13: Flaky: hud_report during a pending CLI prompt (refused) fails in the full gate

**Status:** done
**Owner try:** no
**Blocked by:** none

**What to build:** Observed 2026-11-25: `tests/unit/thin-mcp-worker-tools.test.mjs` case `hud_report during a pending CLI prompt belongs to the old turn (refused)` failed in the land gate's full run (`TZ=UTC node tests/run-mjs.mjs 8`) on two consecutive lands and passed on the immediate rerun both times. Logs: `~/.hud/flows/f39c49a0977d143eb.json.gate-1.log` and `~/.hud/flows/f05b45100d93a978c.json.gate-1.log`. Find the root cause from the logs and the test (timing under 8-way load: the `until` on the third token, the `rejected-prompt` / `release-prompt-result` fixture files, or a product race in turn-token handling). If the product has a race a real user can hit, fix the product; if only the test races, make the test wait for the state it needs. No longer timeouts, retries or skips as the fix. Size: small.

- [x] Root cause named in the report with the log lines that show it
- [x] The case passes 30 consecutive runs under the gate's 8-way concurrency (or a load that reproduced the failure before the fix)
- [x] No timeout increase, retry or skip is the fix
- [x] Land gate passes

## Comments

- Landed in this commit (replay base 4d0b12bae769c87dcd8e292a402cf8c124f35e36); gate 5/5 passed.
