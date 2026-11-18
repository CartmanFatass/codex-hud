# 02: The Split layout

**Status:** ready-for-agent
**Blocked by:** 01

**What to build:** `docs/spec.md` §2.2 "Panel layouts". Option 2 · Split of `docs/design/panel-v8/` (`options.html`,
`notes.md` "Option 2 · Split"), built as drawn, behind ticket 01's Layout setting.

- [ ] Split Home: a list on top (one row per package and per block: waiting, decided, progress; a question or a
      failure keeps a reason row), the preview of the cursor row below with today's cards unchanged; the cursor starts
      on the first row that needs the owner; the 40 × 24 give-way order from notes.md.
- [ ] Split Project: the hub and each page as a list over a preview (Progress: one ledger list with the cursor slice
      explained, History one folded row; Control plane: roles on top, the cursor role's places below where
      `p m e + - K J x` act); `y`/`n` on to-try rows.
- [ ] Keys and mouse as notes.md says: ↑↓ in the list, wheel or PgUp/PgDn over the preview, Enter into the preview,
      Esc back; click selects, second click is Enter.
- [ ] Classic and Inbox unchanged; frame tests for Split Home busy/idle/24 rows, hub, Progress and Control plane.

## Comments
