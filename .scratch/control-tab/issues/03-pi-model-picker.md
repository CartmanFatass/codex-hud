# 03: Full pi model picker

**Status:** ready-for-agent
**Blocked by:** 01

**What to build:** The model picker from sample frames 6a–6c: every model of the pi providers that are on (from `pi --list-models`, exact `provider/model`, duplicates only when identical), one list grouped by provider headers with counts, typed case-insensitive filter over the full ID with pinned query and match count, current vs cursor marks, middle ellipsis for long IDs with the whole ID under the cursor. Discovery on opening Control (stale/absent cache) or `r`, coalesced; last good result kept on failure with an age notice; no subprocess per key or tick. The `include` curation and Tab "show all" go. Works with the existing model-edit action until ticket 05 replaces it. See design.md §4.

- [ ] synthetic multi-provider table with same-named models, long IDs, a newly seen provider, off/restore
- [ ] failed refresh keeps last good list; successful empty list distinguished
- [ ] typing never spawns a command
- [ ] 40-col ZH/EN frames match the sample
