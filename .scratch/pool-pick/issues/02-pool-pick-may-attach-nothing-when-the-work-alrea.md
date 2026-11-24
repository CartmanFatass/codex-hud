# 02: Pool pick may attach nothing when the work already has an art direction

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** 01

**What to build:** Owner 2026-11-24: when a mature art direction already exists, the pick must be able to attach nothing; design its inputs, outputs and handling so it is dependable. Change pool-pick/01 as follows. Deterministic steps first, no model call: (1) role prewalk off or `poolPick` off: no pick, nothing attached. (2) The brief names pool entries: use them (`source: brief`). (3) The project declares an established look in `.hud/project.json` as `"design": "<repo-relative path>"`: attach that file as a reference instead of pool entries (`source: project`, `need: existing`). Otherwise one Decision API call, fixed choices only. Input: the brief (untrusted quoted data, first 4000 chars), the pool index (file, title, Kind, Status, Fits) and the README rules, plus two facts: the role and the project name (HUD infers nothing else about existing UI). Output choices: `need`: `existing` (the brief changes or extends a UI that already has its own look) or `new` (a new page, app or sample without a look); `kind`: `personal` or `showcase`; then ranked entry slots as in 01 (slot 1 required only when need is new; later slots may be NONE). Handling: need `existing` attaches nothing from the pool. need `new`: drop unknown entries, drop entries whose Kind contradicts the chosen kind (`either` always fits), keep pool order of dimensions; if nothing is left, attach nothing and record why. Decision API off, failing or timing out: attach nothing (`source: failed`); the frontend worker's skill already falls back to its quick default when the brief names no style. Remove the role-file `default` fallback from 01. Record `{type: 'pick', need, kind, entries, source, ms, dropped?}` (in the prewalk list once prewalk/01 lands; until then in `pool_pick`), and show one receipt line, e.g. `pick: none (existing look)` or `pick: personal · layout-swiss-editorial + theme-dark-near-black + colour-on-elements`.

- [ ] A stubbed decision answering need existing attaches nothing; need new with a kind-contradicting entry drops it and records it in dropped
- [ ] A project with `design` in .hud/project.json attaches that file and makes no call; a brief naming entries makes no call
- [ ] Decision API failure or switch off attaches nothing; the role-file default field is gone from code and docs
- [ ] The receipt shows the one-line pick summary; docs/reference.md describes need, kind and the project design field

## Comments
