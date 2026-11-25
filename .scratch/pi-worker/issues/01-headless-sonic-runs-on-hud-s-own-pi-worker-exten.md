# 01: Headless Sonic runs on HUD's own pi worker extension without pi-roles

**Status:** done
**Owner try:** no
**Blocked by:** none

**What to build:** Design `.scratch/pi-worker/spec.md` (read whole; slice 1; owner approved removals R1–R4). HUD core builds the pi argv in process (no `pi-role`, no `--role-bundle`, no `--hud-*` flags) and writes a private per-job contract `<job>/pi-worker.json` read once by the extension via `HUD_JOB_DIR`. Add the worker extension (`src/harness/pi/worker/*` compiled to dist, thin `.mjs` entry; installed under `$HUD_HOME/pi-worker/` by core install, never `pi install`ed; checkout fallback for tests) with modules `contract`, `role-runtime` (verify model/thinking, fail fast; tool activation; role prompt section from `packages/hud-mcp/instructions/<name>.md` so the prompt matches today), `tools` (today's `hud.mjs` worker branch: hud_report/hud_progress/hud_lease for Sonic), `mistral-budget` (port of the owner's mistral-request-budget; images archived under the job dir), `web-search` (DeepSeek search/fetch; key from `~/.hud/credentials.env` `DEEPSEEK_SEARCH_API_KEY`, plus a one-time explicit `hud import` from the old key file), and a native writer of `tps` session entries in the same format pi-tps writes today (toktrack may read them; verify format). Add the in-code role defaults table keyed by today's `pi_role` names so role files that omit `model` keep today's model (the owner's sonic deepseek preset omits it). Lazy-load the dispatch graph in `src/worker/tools.ts` (orchestrator import costs ~80 ms). Route only headless Sonic through the new path; other roles stay on pi-role until later slices. No runtime legacy switch; rollback = revert.

- [x] Parity dump (role section, active tools, model, thinking) for headless Sonic matches the legacy path except the approved removals; test asserts it.
- [x] Unit tests: contract round trip, argv golden, role-runtime on a fake pi, Mistral budget and DeepSeek search with stubbed fetch, credentials import, tps entry format.
- [x] Live: ~10 real Sonic jobs incl. a web scout run on the new path with reports; cost probe (offline pi, temp HOME) reports pre-model startup before/after.
- [x] Land gate passes.

## Comments

- 2026-11-25 main: imp j9d0b51127341b4a9 committed d6787754 (worktree MyHUD-wt/pi-worker-41b4a9): real-pi parity
  matched, offline startup median 398 → 265 ms, 77/77 + 85/85 focused tests. Held: land only after the hmasd Sonic
  batch b8d86947d528de015 ends (it changes the Sonic launch path). After land, main: `hud import preview
  --deepseek-key --from <old key file>` then apply, then ~10 live Sonic jobs incl. a web scout, then project-lead
  acceptance.

- Landed in this commit (replay base 4dbb54abeb0adcd4293fd1bd3f2645ed23412bc1); gate 5/5 passed.
