# 02: The worker zone shows only running workers

**Status:** ready-for-agent
**Blocked by:** none
**Owner try:** yes

**What to build:** Owner 2026-11-22 after trying 01: the worker zone should permanently show only the workers that are running now, not a census that also keeps settled ones. Today `workSignals` (src/render/work-summary.ts) adds each worker settled within `NOTICE_MS` (3 min) with `✓`, `✓●` or `✗`. With close-on-delivery most workers settle quickly, so the zone mostly counts finished work. Change the worker zone (Claude statusline, Antigravity statusline, pi footer, and every caller of `workSignals`) to count only live workers: working, plus asking (`!`), which is still live and needs the owner. Drop the settled `✓`/`✓●`/`✗` marks from the zone and stop reading settled jobs for it (the `settledBefore: now - NOTICE_MS` reads in src/cli/statusline.ts). Sonic stays `⚡N` with N = running sonic queries. When nothing is running the zone is absent. Leave other notice-zone events (e.g. codex-statusline asks) as they are unless they render settled workers in the same zone. Update docs/reference.md and docs/reference.zh.md where they describe the zone.

- [ ] A worker settled 10 s ago is not counted; a working and an asking worker are
- [ ] No `✓`, `✓●` or `✗` worker mark remains in the zone; `!` stays for asking
- [ ] With only settled workers in the scope the zone renders nothing
- [ ] Claude, Antigravity and pi footer outputs agree on the same synthetic jobs
- [ ] Targeted statusline/bar/pi-footer tests pass; references updated
