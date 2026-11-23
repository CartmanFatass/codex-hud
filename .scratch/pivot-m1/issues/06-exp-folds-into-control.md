# 06: EXP folds into Control

**Status:** done
**Owner try:** no
**Blocked by:** 01

**What to build:** Spec §2.2 main tabs (Home, Project, Control); removal item 23. Move the EXP tab's controls into Control without deleting ledgers or disabling configured features. Decouple the `experiments` gate (`src/settings.ts:29`) from the quota proxy refresh (`src/collectors/exp-proxy-refresh.ts:29`), pi EXP usage (`src/harness/pi/exp-usage.ts:93`), the p10k footer (`p10k-footer.ts:507`) and the Codex statusline (`codex-statusline.ts:105`), so each keeps working when the tab is gone; `exp.codex.enabled` becomes editable from Control (today only `exp-view.ts:228`).

- [x] Test: with an existing settings file that enabled experiments, the quota proxy, pi EXP usage, p10k footer and Codex line behave as before
- [x] Control shows and edits the former EXP controls, including `exp.codex.enabled`; no EXP main tab
- [x] `npm test` passes; reference.md (EN/ZH) updated

## Comments

- Landed in this commit (replay base 1fc51274522f1dca6acc92a9e4a29c7e9b66e079); gate 5/5 passed.
