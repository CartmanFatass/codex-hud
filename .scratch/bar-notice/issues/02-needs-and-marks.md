# 02: The pinned need names the job; HUD jobs and subagents look different; an unread report shows

**Status:** done (37cc5478)
**Blocked by:** 01

**What to build:** Owner, 2026-11-17 (notice items 4–6). Today a need is `! Work: 1 needs you`, English only, without
saying which job; a HUD job (own herdr tab) and a native subagent (inside this session) look alike; a finished job whose
report the owner has not read looks like any other finished job.

- [ ] A pinned need names the job: `! imp 首页修正 asks`. Several: the first one plus `+2`; when even that does not
      fit, `! 3 needs`. Nothing pinned when nothing is open. Bar language rules unchanged (bars stay English-only
      except the job's own title).
- [ ] HUD jobs and native subagents differ at a glance (a mark or ink; designer's choice), in every bar look.
- [ ] A settled HUD job whose report is unread carries an unread mark (e.g. `✓●`) until the report is read; read
      state comes from the same job reader the MCP uses (`report_unread`), no new polling.
- [ ] Main-path tests: several needs at three widths, a HUD job beside a subagent, unread → read.

## Comments
