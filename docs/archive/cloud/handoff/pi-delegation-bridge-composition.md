# Pi delegation bridge composition handoff

This experimental backend bridge exposes the existing eight `delegate_*` tools through the official Pi 1.4.0 extension interface. It does not adapt chat UI, constrain native Pi agents, install settings or grant target launch capabilities. HUD-managed creation remains one level. See [usage and identity boundary](../pi-delegation-bridge.md).

## Composition identity

- Accepted budget base: tree `b2d1a3b977bf6ca0093f3f67d9332894257469ac`, remote commit `169156998cd1f80ce59f627c129100069842d5ca` (local equivalent `c2b10a1c99231e3a60f4188633099bab51253bb1`). This base includes the accepted panel, shared summary and reversible migration work.
- Preserved Pi input: tree `059bbb6f073c1e877420509d58a8401f75ce4042`, based on `4164f24d7d285f4c99754d741a591d1e416ac17d`.
- Exact initial union: tree `837794914993df3ad41a8ea73b9df186f065b7ff`. All 22 Pi paths match the input blobs and modes; they have no overlap with the budget or intermediate changes. Those base paths are unchanged.
- Reviewed test-integration correction: tree `3cff659156a6960230f7d6c08796380c934c8022`. Only package test orchestration, two test files and two documents differ from the exact union. This handoff is an additional documentation-only record.

The accepted 250 ms original-receipt admission budget and 100 ms cumulative contention allowance are preserved exactly. No additional budget relaxation, callback/COMMIT retry, authority bypass or duplicate-call retry is introduced.

## Finite cloud verification

Node 24.22.1, Linux x64, synthetic fixtures and isolated temporary homes:

- Initial union: three builds and 116 focused tests passed without skips: context 55, channel 9, bridge 7, budget 12, Pi config/source 13, identity/stdio 6, one-level/replay 14.
- The bridge tests reached the previously blocked lifecycle, concurrent cleanup and entrypoint-replacement assertions.
- Installed official Pi 1.4.0 no-model probe passed using the actual loader and session context. Provider validation remains false.
- The local preview contained 451 allowlisted files. Every archive entry hash and 1,269 relative imports were checked. Both packaged budget modules were imported and their 249/250 ms boundary checked. This preview used the initial union; executable preview inputs remained unchanged by the later test/document correction. It is not a standalone installation or release.

## Test integration correction and retained failure

Normal `npm test` now explicitly builds hud-mcp after `build:test`; missing MCP output is not silently skipped on a supported host. Channel tests consume normal `dist-test` modules and require no SQLite gate.

The six full synthetic-host cases conditionally load SQLite only when their Linux, Node and loader requirements are available. This fixture requires unflagged TypeScript loading and module hooks: Node 22.18+ or Node 24+ with those features enabled. This is distinct from the ledger's Node 22.13 minimum and is not a product capability change. The pure cleanup case always runs.

After this correction, three builds, channel 9/9 and budget 12/12 passed. The first affected bridge run had 6 PASS / 1 FAIL: a lifecycle reconnect returned `busy` instead of the expected binding refusal. Its cause was not established as SQLite contention. One unchanged isolated bridge rerun, permitted by review, passed 7/7 with no skips. The original failure is retained; no deadline, assertion or retry policy was changed.

Restricted-loader simulations for Node 18, 20 and 22.13 each produced 65 PASS / 6 explicit host-case SKIP while prohibiting SQLite and separate MCP output. Missing module-hook and TypeScript-feature simulations each kept cleanup passing with six host cases skipped. The independent channel dependency guard passed 9/9. These are Node 24 simulations, not executions on those other engines. Formatting, fixture hygiene and diff checks passed; the initial missing-formatter setup failure remains recorded separately.

## Limits

Historical 30 ms-budget failures remain historical failures. The new composition does not retrospectively change them. Intermittent `busy` under load remains possible and does not authorize automatic retries. No full historical suite, formal performance qualification, real provider/native-agent conversation, successful qualified target launch, real settings activation, standalone install, release or main-branch merge is established here. Hosted CI status must be read for the exact published commit.
