# 02: One line per job on Home

**Status:** ready-for-agent
**Blocked by:** 01
**Owner try:** yes

**What to build:** Owner 2026-11-22, looking at the landed compact Home (screenshot of a busy run, about 14 jobs): still too crowded. What the screenshot shows:
- Every job takes 2–4 rows: a lane header with the ticket id and state, then a worker row, then for landing jobs a gate line and a report sentence.
- Titles are the raw task text (`Implement .scratch/perf-t…`) instead of the ticket title.
- Role words (`imp`, `general`) take room.
- Each queued job takes two rows.

Target:
- One row per job: state glyph, ticket id, short ticket title (from the ticket file when the job has one, else the brief title; never the raw task text), then role icon (the statusline table: `⚒ ✎ ✦ ◈ ⚖ ⚡ •`) with model mark and age on the right.
- A lane header appears only when a lane holds more than one job.
- A landing job gets at most one sub-row (`落地 · gate[3] test:mjs · 1分`). Its report sentence moves to the Inspector.
- Queued jobs fold into one row (`◷ 排队 3 · perf-hygiene/07 · native-statusline/01 · perf-ts/08`).
- Finished jobs within the hide window fold into one `✓ N` row unless a report is unread.
- Asking and failed jobs keep their full card. The summary row, progress block and footer stay.

Sample first: update `docs/design/home-compact/sample.html` with a "v2" busy frame next to the current one, at 120/80/50 columns, ZH and EN. The build follows once the owner settles it.

- [x] Sample v2 opened for the owner and settled (owner 2026-11-22: "接受设计"; sample 0bd69fdc)
- [ ] A busy fixture of 14 jobs fits in about 16 rows at 80 columns (today it takes about 38)
- [ ] Titles come from ticket or brief titles; panel width rules hold; references are updated
