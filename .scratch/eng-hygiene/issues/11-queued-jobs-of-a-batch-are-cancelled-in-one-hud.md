# 11: Queued jobs of a batch are cancelled in one hud_close call, distinct from closing a running worker

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** none

**What to build:** On 2026-11-25 the main session needed to cancel 39 queued (never started) sonic jobs of package `hmasd-label`. `hud_close` takes one `job`, so it took one call per job; after 13 calls Claude Code's permission classifier refused the rest as 'closing a running worker requires owner approval' although each job's STATUS was `queued` with no worker, and the owner would have had to approve each call (they ran a `hud act stop` loop instead). Change `hud_close` so that: (1) it also accepts `jobs: [id...]` and a selector `{package, state: "queued"}` (optionally `preset`) that removes only queued jobs and returns per-item results and counts; (2) running/working members are never closed by the batch form (reported as skipped); (3) the tool description, schema text and results say plainly that removing a queued job cancels work that never started and has no worker, separate from closing a running worker (single `job` keeps today's behaviour). Keep the tool description short (MCP description size is budgeted; check existing size tests). Mirror the batch form in `hud act stop` if cheap (e.g. `--package P --queued`).

- [ ] One hud_close call removes all queued jobs selected by `jobs` or `{package, state:'queued'}` and reports per-item results.
- [ ] Working jobs are skipped, never closed, by the batch form.
- [ ] Description/result wording distinguishes cancelling a queued job (no worker) from closing a running worker.
- [ ] Tests cover jobs list, package selector, mixed states and the single-job path unchanged; MCP description size tests pass.
- [ ] Land gate passes.

## Comments
