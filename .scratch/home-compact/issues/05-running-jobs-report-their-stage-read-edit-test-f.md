# 05: Running jobs report their stage (read / edit / test) for the Home strip

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** 03

**What to build:** home-compact/03's stage strip needs a per-job stage that no collector provides today (frontend-imp j8a8ba270041f7d3d, 2026-11-22: tool kinds are not collected for thin jobs; only the Inspector reads transcripts). Add a bounded, incremental collector: for each running job, scan only the bytes appended since the last scan of the session/stdout file the panel already stats (pi session jsonl, headless stdout.jsonl, Claude/Codex/agy transcripts where available), classify the latest tool call as read / edit / test (e.g. read/grep/ls → read; edit/write → edit; bash running a test or build command → test), and expose it as the field home-compact/03's report specifies. Keep within §8 collection rules and the panel's performance budget.

- [ ] A fixture per harness format sets the stage correctly from appended tool calls; a harness without readable transcripts leaves the field absent
- [ ] Incremental: a second refresh with no new bytes reads nothing (test); per-refresh cost measured with 6 running jobs and stated in the report
- [ ] Home strip shows real read/edit/test cells on the golden frames; npm test and check:fixtures pass

## Comments
