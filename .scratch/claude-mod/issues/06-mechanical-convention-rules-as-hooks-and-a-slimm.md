# 06: Mechanical convention rules as hooks and a slimmer default convention

**Status:** done
**Owner try:** no
**Blocked by:** 03

**What to build:** Design: oracle report j173e9f379178e359, 'Slice 4: Convention as Hooks' rule table. Main-session-only (`HUD_JOB_DIR` unset) fail-open hooks: explicit isolation on imp/frontend-imp creates (deny if missing, retries exempt), worktree→none rewrite for read-only roles, deny placement options on non-general roles, ask before `hud_close` of a running job, Grep on report.md guarded like Read, `hud_tickets add` needs explicit owner_try, flow ids refused by hud_land, `hud watch`/`hud_wait`/`wait_ms>0` refused while the mod watch is live. When `hud_roster` returns the default convention, the mod swaps in a short version (project/user conventions untouched). Add `.catch` fail-open to the existing slice-1 hooks. Land after claude-mod/05 to avoid register.ts conflicts, or keep hooks in their own file.

- [x] Each rule covered in `claude plugin test`, including worker bypass and fail-open on unexpected input
- [x] Default convention text shrinks by ≥55% in the mod's roster result; project or user conventions pass byte for byte
- [x] A unit test keeps the short convention and hook set aligned with packages/hud-mcp/hud-convention.md
- [x] `claude plugin validate` reports no gating hook without `.catch`

## Comments

- Landed in this commit (replay base dab52c5e3e61a17b15235466262e8a4e3ff22027); gate 5/5 passed.
