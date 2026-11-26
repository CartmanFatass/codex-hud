# 05: HUD no longer needs pi-roles installed

**Status:** done
**Owner try:** no
**Blocked by:** 04

**What to build:** `.scratch/pi-worker/spec.md` slice 5. Remove the legacy launch path and the `hud.mjs` worker branch (keep its main-session delegate), `pi-mcp-config.ts`, PATH checks for `pi-role`/`pi-role-reap`/`pi-dispatch` (roster, role-control, setup, doctor, install.d/herdr.sh), and update docs (reference, ARCHITECTURE, installer READMEs). The owner's interactive pi and `~/Fishpref/pi-roles` are not touched.

- [x] A synthetic install with no pi-roles on PATH runs Sonic, an imp tab and a reviewer headless job.
- [x] grep of executable and installer paths finds no pi-roles names.
- [x] Land gate passes.

## Comments

- Landed in this commit (replay base 947e75d5a33d5678125305a0875232a49a489e09); gate 5/5 passed.
