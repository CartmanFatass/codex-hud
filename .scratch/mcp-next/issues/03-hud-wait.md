# 03: Multi-job event-driven hud_wait tool

**Status:** claimed
**Blocked by:** 02

**What to build:** `docs/spec.md` §2.1 & `.scratch/mcp-next/spec.md` §3. Add `hud_wait` so main sessions can wait on several concurrent workers at once without blind serial polling.

- [ ] Register `hud_wait` in `packages/hud-mcp/src/thin-main.ts` and `src/harness/pi/role-client.ts` (`PI_ROLE_TOOLS`) with parameters `jobs?: string[]` (defaults to all unsettled jobs of the caller session), `mode?: 'any' | 'all'` (default `'any'`), and `wait_ms?: integer` (`0..120000`, default `60000`).
- [ ] Implement event-driven waiting using `fs.watch` on `$HUD_HOME/jobs` (with a fallback safety poll), waking immediately when: in `'any'` mode, at least one target job is settled (`idle_grace`, `closed`, `done`, `failed`, `stopped`), `blocked`, `waiting_orchestrator`, or has `open_questions > 0`; in `'all'` mode, all target jobs have settled OR any target job has `open_questions > 0`, `blocked`, `waiting_orchestrator`, or `failed` (so questions/failures never wait behind slow siblings).
- [ ] Return `{ ready: boolean, timed_out: boolean, triggered: string[], jobs: [...] }` with lightweight status summaries (and open questions preview) without implicitly stamping `read_at` (leaving `hud_read(job)` to read full reports and trigger read-close).
- [ ] Add unit tests in `tests/unit/thin-mcp.test.mjs` verifying `any` wake, `all` wake, early wake on question in `all` mode, and timeout.

## Comments
