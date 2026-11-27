# 03: Remove display-side model text

**Status:** done
**Owner try:** no
**Blocked by:** 02

**What to build:** Spec §2.2; removal items 8–14. Delete AI job and native-agent names, current-work/third lines, keyword colouring and the sentence-interval control; AI finished-result and failure sentences, including generated fallback or translation of worker summaries; model-judged outcome and confidence (keep declared verdicts, observed state and historical values); model looping warnings (keep execution-side quiet-job handling); automatic question categories and review-severity tallies; generated Inspector decision titles and rewrites; automatic translation of ordinary questions, ticket titles, route reasons, landed rows, owner requests and waiting items; and the Settings display-model controls (model-text master, model choice, call cap). Stop the background requests (`src/panel/model-services.ts:59-70`); delete `decision-labels.ts`, `decision-titles.ts` and `waiting-briefs.ts` if nothing on the execution side uses them. Keep the Decision API execution side (quiet-job, sonic thinking, imp auto routing) and the signed report summary. Readers to clean: `filter.ts:38-45`, `project-view.ts:317-320`, `work-inspector.ts:118,191` (`~/projects/MyHUD/tmp/tasks/spec-pivot/review-carbon.md` §4).

- [x] grep: no display path calls the Decision API or a text model; the execution-side calls remain and their tests pass
- [x] Test: the Inspector shows the worker's own question and report text, untranslated, with the declared summary
- [x] Old settings with display-model keys load without error
- [x] `npm test` passes; reference.md (EN/ZH) updated

## Comments

- Landed in this commit (replay base a6cd35f839c5faf49d303342613f71141fb92b9b); gate 5/5 passed.
