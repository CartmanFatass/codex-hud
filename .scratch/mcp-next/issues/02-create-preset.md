# 02: Per-job role preset selection in hud_create

**Status:** done (421f61c9)
**Blocked by:** 01

**What to build:** `docs/spec.md` §2.1 & `.scratch/mcp-next/spec.md` §2. Allow `hud_create` to pick a named role preset for a single job without editing `$HUD_HOME/roles/*.json`.

- [x] Add optional `preset: { type: 'string' }` to `hud_create` inputSchema in `packages/hud-mcp/src/thin-main.ts` and `PI_ROLE_TOOLS` in `src/harness/pi/role-client.ts`, and include `'preset'` in `accepts_options` on `hud_roster` when a role has presets.
- [x] When `preset` is passed to `hud_create` (mutually exclusive with `on`; passing both returns `invalid_arguments`), look up the named preset in the role's merged `presets` list (returning `code: 'invalid_arguments', error: 'unknown preset: <name>'` if missing), select its first available non-exhausted place, and allow `model` / `thinking` overrides on top.
- [x] Record `preset` in `job.json` and return it in `hud_read` job observations; role files on disk remain untouched.
- [x] Update `integrations/skills/hud-delegate/SKILL.md` and `docs/reference.md` (and `docs/reference.zh.md`), plus unit tests in `tests/unit/thin-mcp.test.mjs`.

## Comments
