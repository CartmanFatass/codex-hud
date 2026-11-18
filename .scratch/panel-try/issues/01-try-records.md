# 01: `y` accepts, `n` flags a try from the panel

**Status:** ready-for-agent
**Blocked by:** none

**What to build:** `docs/spec.md` §2.2, "try records" (owner, 2026-11-17). The owner tries landed work and today has
to tell the main session in chat which slices pass. On the Progress page's to-try view (PANEL-NEXT 02, `t`), the
selected row can be accepted or flagged in one key; the main session hears it and updates STATE.

- [ ] On the to-try view, `y` on a milestone row accepts every slice of that milestone still `try`; on a slice row it
      accepts that slice. `n` flags in the same way. Nothing happens elsewhere. Key hints and Help (`?`) list them;
      mouse needs nothing new.
- [ ] Each key appends one record to `$HUD_HOME/tries.jsonl` (`at`, project root, `accept` or `flag`, milestone,
      slice ids). The panel writes nothing else and never a project file. Latest record per slice wins.
- [ ] The panel shows the mark at once (accepted `✓`, flagged a clear flag mark, in the theme's inks) on the to-try
      rows and in the counts, until STATE itself shows the slice `accepted` (accept) or the record is older than the
      slice's ledger line change (flag); then STATE alone decides.
- [ ] `hud watch` prints one line per new record, e.g. `try accepted MyHUD 0.1.4: PANEL-TIDY, BAR-NOTICE` and
      `try flagged MyHUD SIDEBAR-ONE`; a record already reflected in STATE is not printed again on catch-up. MCP
      `changes` carry the same lines for a session whose cwd is that project. The convention (`hud-convention.md`) gets
      one line: on a try line, update STATE's ledger (accepted) or add the flagged slice under Waiting for the owner and
      ask the owner what is wrong.
- [ ] Main-path tests (synthetic STATE, temp HUD_HOME): `y`/`n` on a milestone row and a slice row write the right
      record; overlay marks and counts; overlay drops once STATE agrees; watch prints each record once.

## Comments
