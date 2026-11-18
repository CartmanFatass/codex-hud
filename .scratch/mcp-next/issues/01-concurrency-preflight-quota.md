# 01: Fine-grained MCP locks, pre-flight CLI trust check and parsed quota cooldowns

**Status:** done (5a7b9631)
**Blocked by:** none

**What to build:** `docs/spec.md` §2.1 & `.scratch/mcp-next/spec.md` §1. Remove the global mutation bottleneck in `packages/hud-mcp/src/thin-main.ts`, reject untrusted CLI directories before opening any herdr tab, and parse exact quota reset durations when marking places exhausted.

- [x] Key-scoped concurrency in `thin-main.ts`: replace the single server-wide `mutations` Promise queue with per-key serialization (`request_key` for `hud_create`, `job` id for `hud_send`, `hud_respond`, `hud_close`) so a slow CLI launch never blocks `hud_respond` on another job or parallel `hud_create` calls with distinct keys; keep `exhausted.json` updates safe.
- [x] Pre-flight CLI trust check: export a pure/read-only `isCliDirTrusted(agent, dir, env)` helper from `src/cli/trust.ts` (`codex` always true; `grok`, `agy`, `claude` checked against their local trust config files without following symlinks or modifying files; missing config file returns `false`). Call it in `dispatchCli` before `herdr tab create`, failing immediately with `code: 'untrusted_cwd'` and reason `<agent> has not trusted <cwd>; run hud trust <cwd>` without opening a tab (keep the screen-dialog check as defense-in-depth).
- [x] Parsed quota reset TTL in `src/roles/exhausted.ts`: add `parseQuotaResetMs(text, nowMs)` recognizing common duration/reset patterns (`try again in 18m`, `in 2h 15m`, `retry after 45s`, `resets at HH:MM UTC`, ISO timestamps), clamped to `[60_000, 24 * 3600_000]` and falling back to `EXHAUSTED_TTL_MS` (1 hour) when absent; `markExhausted` uses it automatically.
- [x] Unit tests covering parallel `hud_create` + `hud_respond` non-blocking behavior, zero-tab `untrusted_cwd` rejection, and `parseQuotaResetMs` duration parsing.

## Comments
