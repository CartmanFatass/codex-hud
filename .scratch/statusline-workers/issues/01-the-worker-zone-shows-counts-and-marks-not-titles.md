# 01: The statusline worker zone shows counts and marks, not titles

**Status:** ready-for-human
**Blocked by:** none
**Owner try:** yes

**What to build:** Owner picked variant A of docs/design/statusline-workers/sample.html (2026-11-22), with one change: sonic shows no provider, model or effort, only `⚡` and its count (e.g. `⚡4`). Every other role: one group per provider + short model + effort with a count (`◎ sol-fast◕ 3  ▲ neon◕ 2  ✻ sonnet● 1  ⚡4`), no job titles anywhere; narrowing order as in the sample (drop model name, then effort glyph, leaving provider mark and count; `⚡N` never shrinks further). State marks as the README's "State" section. Applies to the hud-statusline (Claude Code, Codex, agy) and the pi footer's worker part. Follow the README's "For whoever builds it": a census of live workers (role, model id, effort, state) instead of the three-minute start events, so long-running workers stay counted; short names derived from the catalog (add neon, carbon and gpt-6.2-sol-fast entries); the LADDER rungs; rework the named frame tests and the notice rules in docs/reference.md and reference.zh.md.

- [x] Busy and quiet scenarios at 120/80/50 columns match the sample's A rows, with sonic as `⚡N`
- [x] A worker running for 30 minutes is still counted
- [x] npm test and check:fixtures pass

## Comments

### 2026-11-22: built (frontend implementer)

Worker zone built as variant A with sonic as `⚡N`: census in `workSignals`, groups and ladder in `bar-fields.ts`, short names from the catalog (`neon`, `carbon`, `gpt-6.2-sol-fast` added). Done: the named frame tests, `docs/reference.md`, `docs/reference.zh.md`, ARCHITECTURE §6, `docs/statusline/feature-coverage.md`, the design README "As built". `check:fixtures` passes and the targeted tests pass; the full `npm test` is left to the land gate (box stays open until it runs). Owner try: Claude statusline, Codex bar, agy and the pi footer with real jobs.

- Landed 8887e9dac297b36a8aff70a1c3f5ebb4a90277f1; gate 5/5 passed.
