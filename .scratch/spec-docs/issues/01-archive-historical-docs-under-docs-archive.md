# 01: Archive historical docs under docs/archive

**Status:** ready-for-human
**Blocked by:** none

**What to build:** docs/neon-proposal/17-spec-and-docs-restructure.md Slice 1 (owner 2026-11-22: do 17; defaults Q4 A .rgignore hides docs/archive only, Q5 A docs/issues to docs/archive/issues and delete the empty docs/ANALYSIS-REPORT.md, Q6 A keep every review since 2026-11-10 in docs/reviews). git mv only (content unchanged, one commit for moves, a separate one for docs/README.md and docs/archive/README.md). Keep in place: docs/spec.md, docs/ARCHITECTURE.md, docs/reference*.md, docs/delegation.md, docs/handoff/STATE.md and its archive/, docs/agents/, docs/design/ files tests read, docs/probes the fixtures check reads, reviews since 11-10, docs/neon-proposal. Update every pointer (CLAUDE.md, AGENTS.md, STATE.md header, ISSUES.md, tests/check-fixtures.sh, tests/release-archive.test.mjs, .gitattributes). Recount the file list against the current tree.

- [x] git log --follow works on moved files; no content change in the move commit
- [x] No dangling relative link in kept docs (scripted check); npm test, check:fixtures and test:release pass

## Comments
