# 01: MCP startup is not work; stop, cleanup and refused sends record the truth

**Status:** done (1c4530ce + 32e26e4f; live check 2026-11-18: a Claude worker settled 10 s after its report, read-close reaped it, hud_close recorded stopped)
**Blocked by:** none

**What to build:** `docs/spec.md` §2.1 (owner, 2026-11-18). Evidence and design: the oracle report
`docs/reviews/2026-11-18-supervisor-stuck.md` (§1–§4). The owner chose its fix 1 plus A, B and C.

- [ ] Fix 1 (report §4.1): `workerHasChild` (packages/hud-mcp/src/cli-judge.ts) does not count the bootstrap of an
      MCP server that a pre-turn known launcher started: `npm exec` / `npx` (and `uvx`, `pnpm dlx` when they have the
      same shape) → its `sh -c <entrypoint>` → that server, plus the server's own packaged helpers the report names
      (chrome-devtools-mcp's telemetry watchdog). Match parent/entrypoint relationships, not substrings. It keeps
      walking below them. Anything else new in the turn (a shell, a test runner, a build) still holds the turn, also
      under an old helper. An unrecognised shape stays conservative. One classification for settle, decide and
      auto-close (the existing `sampleChild` path); Pi's caller in hud-watch.mjs keeps its behaviour.
- [ ] A (report §3.A): CLI tab-close in hud-watch.mjs uses the same terminal-fact order as `judge()`: a stop marker →
      stopped; worker gone with a fresh report → closed; genuine tab loss without output → failed. Both writer orders.
- [ ] B (report §3.B): a terminal reap that fails stays pending on the existing slow timer until it succeeds or
      ownership no longer matches; no second killer; a cleanup error is not a task failure. hud-cli.mjs keeps `closed`
      as the lifecycle result.
- [ ] C (report §3.C): a `hud_send` rejected before any input (definite rejection) cancels its provisional turn so the
      job keeps its prior settlement; an ambiguous delivery keeps the conservative baseline.
- [ ] Tests (report §4 "Acceptance" and each of A–C): real /proc fixtures in tests/unit/thin-mcp.test.mjs for a
      pre-turn launcher whose shell/server/watchdog start after send (settles; read → closed), plus a real in-turn
      sleep direct and under the old helper/server (stays working, settles after it exits), and a same-named
      in-turn runner that is not exempt.
