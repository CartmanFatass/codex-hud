# 03: Status bars keep only the line and p10k themes

**Status:** done
**Owner try:** no
**Blocked by:** none

**What to build:** Owner approved (D-2026-11-22-27): remove the BAR-THEMES Gauge Plates, Tide, Micro Glyphs, Stacked, Headline, Triptych from the Claude, Codex and pi bars and pi ribbon (TS and native). A saved removed theme loads as `line`. Delete their renderers, settings entries, fixtures and tests. Update spec §2.2.1 (BAR-THEMES lines) and reference*.md.

- [x] Only line and p10k selectable; old values load as line
- [x] Native and TS outputs still byte-identical for line and p10k
- [x] Removed code and tests; bar tests pass
- [x] Spec and reference updated

## Comments

- Landed in this commit (replay base 0e07697ed808e154f083e641ef48ca9b2e311214); gate 5/5 passed.
