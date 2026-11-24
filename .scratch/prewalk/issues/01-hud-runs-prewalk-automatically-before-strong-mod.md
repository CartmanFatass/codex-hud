# 01: HUD runs prewalk automatically before strong-model jobs

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** pool-pick/01

**What to build:** Spec §2.1 (D-2026-11-24-05). Generalise the existing `scout` flow and pool-pick into one prewalk step HUD runs on its own before a job starts. Prewalk has two types (owner 2026-11-24): **scout**, 0–3 `sonic` jobs gathering facts (no new role), and **pick**, the Decision API choosing entries from an owner pool (pool-pick/01; for frontend-imp: the art direction from the style pool). A role may have either or both; the role's prewalk switch governs both. Owner role files only (`$HUD_HOME/roles`): `"prewalk": "on"|"off"` next to the existing `pool` field; shipped defaults: imp, oracle and frontend-imp `on`, reviewer and sonic `off`. Settings switch `autoPrewalk` (default on) turns all automatic prewalks off at once. The owner decides whether a role prewalks; the Decision API decides how much (owner 2026-11-24: 0–3 sonics by the size of the task).

With prewalk on, unless the caller passes its own `scout` or skips prewalk for this job, make one Decision API call (same discipline as `src/mcp/sonic-thinking.ts`: brief as untrusted quoted data, fixed choices only) with three yes/no choices, one per scout kind, and start one headless sonic per yes, in parallel (0–3). Each kind has a fixed question built from the brief:
- **code**: the files, symbols, commands and tests in this checkout a worker needs for the brief, with path:line citations;
- **docs**: the project's own spec, design docs, tickets and decisions that bear on the brief, with path:line citations;
- **web**: primary external sources (official docs, specs, source repositories, release notes) for the libraries, APIs and tools the brief depends on, each claim with its URL; search queries name only public technologies, never paths, names or other private content from the brief. Sonic uses the web search/fetch tools pi already provides (for example the owner's deepseek-search extension); if headless sonic launches do not load them, enable them for this kind only.
All kinds: facts only, no design, diagnosis or judgement. Decision API off, failing or timing out: fall back to `code` only. Attach the reports via from_jobs as the scout flow does today; the target waits at most 5 minutes in total, then starts with whatever has arrived plus the existing note for the rest. The caller skip is a minimal schema addition (the declaration budget test must pass). Record `prewalk: [{kind: 'code'|'docs'|'web'|'pool', source: 'decision'|'brief'|'caller'|'default', job?, result, ms}]` on the job record, archive and hud_create receipt (fold pool-pick's `pool_pick` into it). Update the hud-delegate skill and hud-convention so the main session stops adding routine scouts by hand, and widen the sonic role description to include web fact gathering. Nothing chains after the target.

- [ ] With prewalk on and a stubbed Decision API answering code+web, an imp dispatch starts two sonics in parallel, then imp with both reports attached; answering none starts imp directly; role off or switch off makes no call
- [ ] Decision API failure falls back to one code scout; a caller scout, a caller skip and a prewalk over 5 minutes behave as specified (tests)
- [ ] The web scout's brief forbids private content in queries and the sonic launch has web tools available (test or live check)
- [ ] prewalk entries appear on job.json, the archive row and the receipt; reviewer and sonic never prewalk by default
- [ ] docs/reference.md, the hud-delegate skill and the sonic role text describe prewalk briefly; the declaration budget test passes

## Comments
