# 05: HUD no longer needs pi-roles installed

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** 04

**What to build:** `.scratch/pi-worker/spec.md` slice 5. Remove the legacy launch path and the `hud.mjs` worker branch (keep its main-session delegate), `pi-mcp-config.ts`, PATH checks for `pi-role`/`pi-role-reap`/`pi-dispatch` (roster, role-control, setup, doctor, install.d/herdr.sh), and update docs (reference, ARCHITECTURE, installer READMEs). The owner's interactive pi and `~/Fishpref/pi-roles` are not touched.

- [ ] A synthetic install with no pi-roles on PATH runs Sonic, an imp tab and a reviewer headless job.
- [ ] grep of executable and installer paths finds no pi-roles names.
- [ ] Land gate passes.

## Comments
