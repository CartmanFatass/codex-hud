# 03: The worker zone shows one icon and count per role

**Status:** done
**Blocked by:** none
**Owner try:** yes

**What to build:** Owner 2026-11-22: the worker zone is still too busy. Show only how many workers of each role are active now, one icon per role followed by its count, the same way sonic already shows `⚡N`. Provider marks, model short names and effort glyphs leave the zone, and so do the narrowing rungs. Active means live: working or asking (02's rule). Roles with no active worker are absent; with none at all the zone is absent.

Icons (single cell where the terminal allows; ASCII fallback in brackets; colour = theme role):
| role | icon | ascii |
|---|---|---|
| imp | `⚒` | `I` |
| frontend-imp | `✎` | `F` |
| general | `✦` | `G` |
| oracle | `◈` | `O` |
| reviewer | `⚖` | `R` |
| sonic | `⚡` | `*` |
| any other role | `•` | `.` |

Order: imp, frontend-imp, general, oracle, reviewer, other, sonic last; two spaces between groups, e.g. `⚒3  ✦2  ◈1  ⚡4`. If any worker is asking, a single `!N` (alert colour, N = asking workers across roles) follows the last group. Keep one icon table in code (e.g. `ROLE_GLYPHS` beside `EFFORT_GLYPHS`) so Home can reuse it later. Applies to the Claude statusline, the Antigravity statusline and the pi footer (every `workSignals`/`rosterSeg` caller); Home is unchanged. Update docs/reference.md and docs/reference.zh.md.

- [x] Synthetic jobs: 3 imp, 2 general, 1 oracle, 4 running sonic → `⚒3  ✦2  ◈1  ⚡4`; one asking imp adds `!1`
- [x] No provider, model or effort text in the zone; ASCII mode prints `I3  G2  O1  *4`; `none` theme emits no escapes
- [x] Claude, Antigravity and pi footer outputs agree; targeted bar/statusline/pi-footer tests pass

## Comments

- Landed 9418fe3dd75004448a1301bcb284033b83a96e9c; gate 5/5 passed.
