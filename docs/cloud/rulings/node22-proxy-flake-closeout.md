# NODE22-PROXY named-flake closeout

Date: 2026-11-03, 20:50 UTC.

Decision: append exactly one isolated whole-suite rerun for each of the two reported named ledger_busy failures to the CURRENT admitted enabled-Node22 verification group, after its remaining already admitted stages and before returning its lease. Do not defer these prescribed closeout checks to another sweep. This is a bounded application of NODE22-PROXY §10 and docs/cloud/README.md, not a new fix round or general retry allowance.

The dispatcher must explicitly append and communicate these two commands to the current lease. Use the same frozen candidate, already identified generated output, exact Node 22.23.4 enabled-proxy profile and declared isolation wrapper. Check the per-suite rerun counters first; if either already consumed its one isolated rerun for this original result, do not run it again.

Run serially, with no competing workload:
1. node --test packages/hud-mcp/dist/tests/hud-mcp/delegation.test.js
2. node --test packages/hud-mcp/dist/tests/hud-mcp/resume-expected-run.test.js

Each is the entire affected suite, not a test-name-filtered selection, and inherits the brief's 900-second outer hud-mcp limit. No source/dependency/profile/timeout change, new build or new test group is added. A failure or timeout consumes that suite's single rerun; do not retry until green. A denied operation must remain blocked and must not be retried unchanged, whether inside these suites or elsewhere. Stop affected execution and preserve the blocker if access or cleanup prevents a permitted isolated run.

Retain the original hud-mcp aggregate exactly as reported: 81 pass, 2 fail, 1 skip, with both B45 accepted-spawn and G03 old-request-key failure traces. Retain each isolated command, unchanged source/build/profile identity, exit/result, timing and cleanup evidence separately. A passing isolated rerun does not erase the original failure or turn it into an originally green aggregate. The known-flake classification remains evidence for independent review, not an acceptance verdict.

Return the lease promptly after the remaining admitted stages and these at-most-two attempts finish or become blocked, including owned-child cleanup. RUNZ1-KILL and P065 retain their reservations and next windows; NODE22 gains no further profile, full-suite rerun, remediation, benchmark or automatic extension. All acceptance/integration gates remain unchanged.

Sources read through the connector: NODE22-PROXY.md blob 9e1032e832c71097de2508fb0cd5b421934fbe74, §10; docs/cloud/README.md blob 3029d6928c42534eee1c2fa86e1c33a2381f59cc, named ledger_busy flakes and one isolated-suite rerun; existing wave-1 resource-window ruling blob 20bded878c6b77601634fde1c223dd0f378b6ba2. Verified the named tests in delegation.test.ts and resume-expected-run.test.ts and the compiled test directory in package.json. Current execution outcomes above are dispatcher-reported, not independently rerun by this Oracle. No tests, builds or edits performed.