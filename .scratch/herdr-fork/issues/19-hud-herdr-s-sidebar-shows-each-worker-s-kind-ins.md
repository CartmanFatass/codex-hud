# 19: HUD: herdr's sidebar shows each worker's kind instead of its job id

**Status:** done
**Owner try:** no
**Blocked by:** none
**Objective:** herdr-fork

**What to build:** Owner 2026-11-26: herdr's left sidebar shows no worker kind. Its second agent row shows `display_agent`, else the agent `name`, else the kind (herdr src/client/shell/agent_sidebar.rs:275-280); HUD names direct-exec workers `<job>-primary`, so the row shows a job id. After a worker's direct start succeeds, HUD reports pane metadata through herdr's stock `pane.report_metadata` (`source: "hud"`, `display_agent`) as `<kind> · <preset or short model>` (e.g. `agy · neon`, `pi · fast`, `claude · opus`), plus tokens `hud_role`, `hud_ticket` for owners who customise sidebar rows. Main sessions untouched; a metadata failure never fails the job. Keep the managed `name` as is (HUD identity relies on it).

- [x] Fake fork tests: claude/agy/pi direct starts report display_agent and tokens once; failure is logged, job continues; main sessions get nothing
- [x] Live try: start an agy and a pi worker: the sidebar's second row reads `agy · neon` / `pi · fast`

## Comments

- 2026-11-26 main: owner: the vendor is not useful. Revised scope sent to j8e70a0deace0fa65: display_agent = short task title; tokens hud_role, hud_ticket, hud_icon (one glyph per HUD role: imp ◆, frontend-imp ◈, reviewer ◎, lead ★, sonic », oracle ◇, general ○, council ✦, other ·). herdr-fork/20 draws hud_icon in the state slot.

- Landed in this commit (replay base 31f126ff0d655a42428291d59e8eb2fe3a89d6bb); gate 5/5 passed.
