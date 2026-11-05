## RUNZ1 ruling: publish a clearly marked WIP

**Decision:** After completing the available checks and recording their actual results, commit and push the scoped implementation to `dots/runz1` as **WIP / NOT ACCEPTED / NOT MERGEABLE**. Do not leave the only copy uncommitted.

**Reason:** The dots-specific implementer prompt explicitly requires branch commit/push before the Oracle verifies and reviews that branch. Given the user’s stated preference for `dots.md`, this overrides the older README’s pre-acceptance commit prohibition **for package-branch publication only**. It does not override acceptance or merge gates. STATE.md also explicitly distinguishes pushed, frozen WIP from accepted work in its B10D precedent.

**Required safeguards:**
- Record the base and final commit SHA, exact commands, actual outcomes, and outstanding acceptance items. Distinguish passed checks, failed checks, and checks blocked or never run. Attribute failures to AF_UNIX, ptrace, or `/proc` support only where the captured evidence supports that diagnosis.
- Retain tests and production behavior unchanged by verification limitations. Do not weaken assertions, suppress failures, simulate required real-process evidence, or redefine supported profiles to obtain green results.
- Publish only RUNZ1-owned implementation/test files. The dispatcher separately records the report and this ruling in the authorized handoff/ruling paths.
- Apply public-repository hygiene to any published evidence: synthetic data only; no credentials, real session data, or private host paths.
- Use ordinary branch commits and non-force pushes, then verify the expected SHA exists remotely. Never modify `main`, rewrite history, stage `node_modules/.package-lock.json`, or perform local-only work.
- Do not merge RUNZ1 into `universal-hud` or mark it accepted. A branch review may identify remaining defects, but publication supplies reviewable evidence, not an acceptance verdict.

**Acceptance impact:** None. RUNZ1 still requires its real-process cases, green `run-control`, the full README check set, and extra-scan performance evidence at n ≥ 1000. Executor-blocked checks leave these requirements unmet. Completion requires evidence from an authorized capable environment. Any proposed relaxation of a gate, contract, or supported profile remains an owner decision.

Sources: [dots workflow](https://github.com/CartmanFatass/codex-hud/blob/universal-hud/docs/cloud/dots.md), [older README](https://github.com/CartmanFatass/codex-hud/blob/universal-hud/docs/cloud/README.md), [AGENTS.md](https://github.com/CartmanFatass/codex-hud/blob/universal-hud/AGENTS.md), [RUNZ1 acceptance](https://github.com/CartmanFatass/codex-hud/blob/universal-hud/docs/cloud/RUNZ1.md), [STATE.md](https://github.com/CartmanFatass/codex-hud/blob/universal-hud/docs/handoff/STATE.md).