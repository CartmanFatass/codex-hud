# 19: HUD: herdr's sidebar shows each worker's kind instead of its job id

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** none
**Objective:** herdr-fork

**What to build:** Owner 2026-11-26: herdr's left sidebar shows no worker kind. Its second agent row shows `display_agent`, else the agent `name`, else the kind (herdr src/client/shell/agent_sidebar.rs:275-280); HUD names direct-exec workers `<job>-primary`, so the row shows a job id. After a worker's direct start succeeds, HUD reports pane metadata through herdr's stock `pane.report_metadata` (`source: "hud"`, `display_agent`) as `<kind> · <preset or short model>` (e.g. `agy · neon`, `pi · fast`, `claude · opus`), plus tokens `hud_role`, `hud_ticket` for owners who customise sidebar rows. Main sessions untouched; a metadata failure never fails the job. Keep the managed `name` as is (HUD identity relies on it).

- [ ] Fake fork tests: claude/agy/pi direct starts report display_agent and tokens once; failure is logged, job continues; main sessions get nothing
- [ ] Live try: start an agy and a pi worker: the sidebar's second row reads `agy · neon` / `pi · fast`

## Comments
