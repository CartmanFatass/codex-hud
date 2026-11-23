# 05: Failed launch error says which pane and retries once on a busy pane

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** none

**What to build:** Scans: 595 of 631 jobs record herdr_pane w5D:p1 (the caller's pane) incl. headless ones; 4 launches failed `agent_pane_busy` when several were created in the same second; `exit_reason` sometimes holds a raw CLI JSON blob (6 jobs). Headless jobs should not record the caller's pane as their own; a pane-busy launch retries once after a short delay; exit_reason stores a short code with the JSON kept in stderr_tail.

- [ ] Headless job records have no herdr_pane (or a field clearly marked caller_pane)
- [ ] Simulated agent_pane_busy retries once then fails with a clear message
- [ ] exit_reason is a short code; raw JSON only in stderr_tail
- [ ] Unit tests

## Comments

Also (carbon #6, fable #8): record the attempted agent args in launch diagnostics (src/mcp/dispatch/harness-cli.ts:184-187) and treat herdr `invalid_agent_argument` as a before-input failure (src/mcp/dispatch/proc.ts:56-63,138) so it falls through to the next place or the prompt-file fallback.
