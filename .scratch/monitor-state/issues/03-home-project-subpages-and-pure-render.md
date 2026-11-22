# 03: Home, Project, subpages and pure render

**Status:** ready-for-human
**Blocked by:** 02

**What to build:** 04 S3 (may split S3a/S3b): nested Home/Project/Subpage/help/ViewPrefs state, immutable rendering, panel-state.ts deleted. Owner default: Home Split folds kept separate from Project folds.

- [x] Rendering no longer mutates state
- [x] check:fixtures and npm test pass

## Comments

- 2026-11-22 main: landed ee611bfe. Home and Project keep independent cursors, folds, filters and marks across tab switches; rendering no longer writes into panel state. A restart still carries one shared place (old reload format) until 04.
