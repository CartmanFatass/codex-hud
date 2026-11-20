# Lean HUD role tools

Owner-approved follow-up to `mcp-read-compact`, within `docs/spec.md` §1. Optimize the model-facing payload, not the panel, disk receipts or job semantics. Keep the eight orchestration verbs and their permissions. Changes apply to the actual MCP text and matching pi tool declarations; TUI-only folding is not a solution.

Ordinary successful replies should generally fit 100–300 UTF-8 bytes. Targets, not truncation limits: a seven-role synthetic roster about 4 KB on first call with the shipped convention and 0.6–1 KB when confirmed unchanged; ordinary single-job working read 60–150 B; create success 100–250 B. A smaller reply need not be padded. Do not budget away actionable changes, full first-time instructions, reports, questions, failures, worktree information or requested diagnostics. Measure actual `content[0].text`; schema bytes are measured separately. Baselines from a quiet synthetic run: roster 9,150 B, working read 435 B, eight tool schemas 5,912 B (create alone 3,206 B). No token/cost claims.

Normal native-monitor path: first dispatch roster / create / read report; same project and valid retained context thereafter create / read. No need to poll if a live asynchronous transport is delivering events. Explicit wait remains useful where no such transport exists. Dispatch policy, read-close and idempotency are unchanged.

Work only on private worktrees; no deployment, user-config changes, or integration into universal-hud here. No dependency on pi-async-hud or EXP. Serialize these tickets because each touches the thin server and schema/contract tests.
