# 02: All headless pi roles run on the HUD worker extension with the read-only guard

**Status:** done
**Owner try:** no
**Blocked by:** 01

**What to build:** `.scratch/pi-worker/spec.md` slice 2. Port the pi-roles guard (`strict` for reviewer; `oracle` mode that also allows `/tmp`, `/dev/shm` and the job dir but blocks repo edits, git mutations, in-place edits, installs), session-mode `hud_ask` (persist, end turn, resume exact session, `HUD_RESUME_SESSION_ID` check), `hud_sonic` with ready notices, borrowed instructions for `general`, and the rest of the role defaults table. Route every headless pi job through the new path. Delete the test-only twins `integrations/pi/roles/*.md` and `integrations/pi/skills/helper-pane` and point fakes/tests at `packages/hud-mcp/instructions`. `pi_role` accepts only the five shipped names (R4) with a clear error.

- [x] Ported guard tests (reviewer strict, oracle mode allowances and blocks).
- [x] Headless ask → hud_respond → resume works without pi-role; effective model/thinking correct for role files omitting fields, presets and borrowed instructions.
- [x] Land gate passes.

## Comments

- Landed in this commit (replay base b8abfebbfdd23261dd06562eae2269ec4d519b18); gate 5/5 passed.
