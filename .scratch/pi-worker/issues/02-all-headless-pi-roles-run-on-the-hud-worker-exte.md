# 02: All headless pi roles run on the HUD worker extension with the read-only guard

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** 01

**What to build:** `.scratch/pi-worker/spec.md` slice 2. Port the pi-roles guard (`strict` for reviewer; `oracle` mode that also allows `/tmp`, `/dev/shm` and the job dir but blocks repo edits, git mutations, in-place edits, installs), session-mode `hud_ask` (persist, end turn, resume exact session, `HUD_RESUME_SESSION_ID` check), `hud_sonic` with ready notices, borrowed instructions for `general`, and the rest of the role defaults table. Route every headless pi job through the new path. Delete the test-only twins `integrations/pi/roles/*.md` and `integrations/pi/skills/helper-pane` and point fakes/tests at `packages/hud-mcp/instructions`. `pi_role` accepts only the five shipped names (R4) with a clear error.

- [ ] Ported guard tests (reviewer strict, oracle mode allowances and blocks).
- [ ] Headless ask → hud_respond → resume works without pi-role; effective model/thinking correct for role files omitting fields, presets and borrowed instructions.
- [ ] Land gate passes.

## Comments
