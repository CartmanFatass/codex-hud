# 11: Feature/Objective navigation state: Tickets filter survives the round trip, request fold matches render, no fabricated Objective

**Status:** ready-for-agent
**Live try:** on 项目 Tickets (t), filter with / to one feature, Enter on it, Esc: the filtered list and the same row return; from an Execution Inspector open the Objective row: with more than four requests, Enter on 'more requests' expands them; a crumb at 40 columns still shows the feature slug
**Blocked by:** 07
**Objective:** interaction

**What to build:** Repair of milestone review j3173891f358ab140 findings 4, 6, 7 and its two minor items (nav-redesign/06–07). (4) src/render/monitor-input.ts:32–34 clears the Tickets `/` filter whenever filterScope changes, and src/render/filter.ts:13–16 returns no scope for sub-pages, so opening a Feature from a filtered Tickets list drops the query and Esc restores the old offset/revealed on the unfiltered list (selected feature can be off-screen). Keep the filter while a Feature sub-page opened from Tickets is open (and its Inspector), restore it on Esc; still clear it when actually leaving Tickets. (6) src/render/work-view.ts:224–226 reads state.project.folded 'waiting:more' when the underlying tab is not Home (e.g. Execution), but src/render/workboard-input.ts:418–431 toggles home.requestsExpanded unless the tab is Project, so 'more requests' on an Objective/Feature opened from the Execution Inspector does nothing visible and changes Home. Use one shared choice of state for render and input. (7) src/render/work-view.ts:309–317 and src/render/work-inspector.ts:150 build a placeholder Objective with state 'active', features [] and evidence [] when the linked record is missing; the page then claims 'active' and no evidence. Keep the receipt's id/title, show that the current record is unavailable (no state, no empty sections), and build the placeholder in one place. Minor: docs/reference.md ~894–900 still describes the old Tickets feature drill-down (For you/Working lanes, folded Done, Enter expands) contradicting line ~866 — rewrite it to the Feature page behaviour and make the Tickets footer hint say open/details for feature rows. Minor: src/render/feature-detail.ts:48–60 builds the whole crumb before clipping, so a long Objective id pushes the slug off a 40-column frame; reserve room for the slug and shorten/omit ancestors first. Leave the programmatic-only inline feature fold in project-view.ts in place (fixtures still use it).

- [ ] Filter → open Feature → Esc restores the same query, list, row and scroll; leaving Tickets still clears the filter (tests)
- [ ] On an Objective and a Feature opened via Execution → Inspector, with more than four requests, Enter/click on 'more requests' expands them and Home's flag is unchanged (test)
- [ ] An Inspector Objective whose record is missing shows its id/title and an unavailable note, not 'active' or empty Features/Evidence (test, EN/ZH)
- [ ] A Feature crumb with a long Objective id keeps the full slug visible at 40 columns (test)
- [ ] docs/reference.md no longer describes the replaced Tickets drill-down; Tickets footer hint matches open/details
- [ ] npm test, test:mjs and check:fixtures pass

## Comments
