# 05: Reviewer keeps its context under 150k

**Status:** done
**Blocked by:** none

**What to build:** Workers study §3.2, D-2026-11-22-18. reviewer.md: start from the brief's diff --stat and design intent, read diffs file by file (never one multi-commit diff), hand caller/test/spec lookups to parallel narrow sonics, re-read nothing already read. Reviewer default stays gpt-6.2-sol max.

- [x] Shipped reviewer instructions carry the file-by-file and sonic-lookup rules
- [x] npm test and check:fixtures pass

## Comments

- 2026-11-22: landed d647091e via sonic gate (same commit as 04).
