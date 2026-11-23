# 03: Sonic runner deaths leave a diagnosable record

**Status:** done
**Owner try:** no
**Blocked by:** none

**What to build:** Scans (j5b0fbe7ad17f060f F5, j52c7712b41ba4a70 F2): 6 sonic children failed with `sonic runner exited without an exit receipt`; their sonic-session.jsonl ends `stopReason: aborted`, two died in the same millisecond when the parent imp's session restarted; all 27 headless stderr.log files are empty. Record the runner's exit code/signal and stderr on the receipt-missing path, write a partial report from the session tail when one exists, and name the cause ('parent session restarted' when the parent restarted).

- [x] Receipt-missing failures record exit code or signal and a stderr tail in STATUS/job record
- [x] A child aborted by its parent's restart says so in exit_reason
- [x] If the sonic session has assistant text, a partial report.md marked partial is written
- [x] Unit tests with a synthetic aborted runner

## Comments

Likely cause (carbon review j91fa6e1950156406 #6): `src/roles/worker-tree.ts:126` exempts a child `sonic-run` session from the worker-tree reap only when `slot === 'headless'`; a tab worker's (`primary`) reap SIGTERMs live sonic children. Fix that first and confirm with a test; also check inherited heap caps (`scripts/dist-lock.mjs:48-52`) do not reach child pi processes (`src/mcp/sonic-process.ts:24`).

- Landed in this commit (replay base bc82d4a879e6ee091020ead5b1237a91997fd0e7); gate 5/5 passed.
