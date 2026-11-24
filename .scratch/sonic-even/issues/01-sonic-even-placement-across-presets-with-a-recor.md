# 01: Sonic even placement across presets, with a recorded verdict per report

**Status:** done
**Owner try:** no
**Blocked by:** none

**What to build:** Owner 2026-11-24: sonic should balance across its presets like imp's even mode (pool: deepseek, haiku, luna in ~/.hud/roles/sonic.json), and the engineering work should collect data to compare the models' results against DeepSeek. (1) Placement: add `sonicPlacement` (`fixed` default | `even`) and `sonicEvenPool` to settings (src/settings.ts, same validation as `impPlacement`/`impEvenPool`), reuse `pickEvenPreset` (src/mcp/imp-routing.ts) with the history of sonic starts in the last 24 h, for every sonic launch path (hud_create role sonic, `scout`, `hud_sonic` from workers). Record `route.placement: "even"` and `route.preset` on the job as imp does; retries keep the chosen preset. Settings → Models gets a Sonic placement row and a Sonic even pool row like imp's. Sonic still accepts no placement fields from callers. (2) Verdict: the main session can record how good a settled sonic report was, when it reads it: `hud_read({job, verdict: "ok" | "partial" | "wrong", verdict_note?})` on a sonic job writes `verdict {value, note, at}` into the job record once (a second call replaces it, last write wins) and changes nothing else; non-sonic jobs return invalid_arguments. The panel does not show it. Job archive keeps it. This is a fact for toktrack's model comparison; HUD does no analysis. Update docs/reference.md (EN; ZH by the translation pass) and the hud-delegate skill's sonic line with one sentence on recording a verdict. Budget about 150 source lines and 4 tests.

- [x] With sonicPlacement even and pool [deepseek, haiku, luna], consecutive sonic creates and scouts pick the preset with the fewest sonic starts in 24 h, ties in role-file order; the choice is on the job record
- [x] An unavailable or exhausted preset is skipped and reported, as for imp
- [x] hud_read with verdict on a settled sonic job records it in the job record and archive; on a non-sonic job it is refused
- [x] Settings → Models shows and edits Sonic placement and Sonic even pool
- [x] docs/reference.md and the hud-delegate skill updated

## Comments

- 2026-11-24 owner change (main session): `even` is a plain round-robin rotator per role (state file under HUD_HOME with the last index; next available preset in pool order, wrapping; unavailable ones skipped and reported), shared by imp and sonic; it replaces imp's "fewest starts in the last 24 hours" counting, whose code and tests are deleted. The first acceptance item reads "consecutive sonic creates and scouts take the pool's presets in turn".

- Landed in this commit (replay base 9c20bbdfac65419c0b5d9d75df9a88cbf34e298c); gate 5/5 passed.
