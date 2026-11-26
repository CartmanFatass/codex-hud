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
- 2026-11-26 main: imp j22d7f22e6795fdc0 (8f6cc0cf, preset fast via the owner's even placement), landed 6c5da7ae (flow f22d7f22e6795fdc0). Owner approved the removal list first; the Project page's external role-file row also went (it only showed pi-roles files HUD no longer reads). Live on the owner's machine: sonic je3f027d43318bca5 (headless; citations and reads recorded), general pi tab j41d69e938847a521, reviewer j92335f087c1c9fb9 all launched as `pi` directly (no pi-role), reported and closed. Explicit `mode: headless` for reviewer is refused by the existing rule (role not continuable); the reviewer ran in its default mode.
