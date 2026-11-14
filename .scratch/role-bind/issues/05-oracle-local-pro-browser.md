# 05: `oracle` is a local advisor; `pro` is the browser role

**Why (owner 2026-11-14):** "oracle was put under browser tasks; this logical role should be a local model; list GPT 6
Pro separately as pro." For this project the oracle runs on Fable for now.

**What to build:**
- New shipped role `pro` with the places the shipped `oracle` has today (bro: ChatGPT 6 Pro → Gemini → AI Studio
  gemini-4-argon); it is in the Control plane's Browser tasks group with `flow`.
- Shipped `oracle` becomes a local read-only advisor: `instructions: "oracle"`, `can_continue: false`, run
  `[cli claude model fable, pi pi_role architect]`. Add `packages/hud-mcp/instructions/oracle.md` (read-only: answer
  the brief's design question with facts and file:line, mark guesses, no edits/builds/commits, write the answer to the
  report path). It is in the Roles group, not Browser tasks.
- Everything that names oracle as a browser role follows (roster, Control plane groups, convention text, docs
  `reference.md`/`.zh.md`, `.scratch/role-bind/spec.md` item 3, tests).

**Who:** imp · **Size:** small (role files, one instructions file, group lists, tests) · **Blocked by:** none

**Status:** resolved

- [x] `hud_roster` lists `oracle` (cli/claude fable, fallback pi architect) and `pro` (bro chatgpt 6 Pro, fallbacks)
- [x] Control plane: oracle under Roles, pro and flow under Browser tasks
- [x] `hud_create role=pro` dispatches a browser task; `hud_create role=oracle` starts claude with `--model fable`
      (fake herdr), with the oracle instructions in the brief

## Comments
- 2026-11-14 (orchestrator): landed b56129ce (497/497). The agy job settled to idle_grace with its report on its own: first clean agy settle after the 04/05 stopgap.
