# 03: Panel, notices and hud_read use the worker's summary

**Status:** done
**Blocked by:** 02

**What to build:** Proposal 18 Slices 2-3 without outcome/verdict: a settled job with a matching summary in the panel's language shows it as its result line with no small-model call (other language: the model translates it, summary given as input); MCP task wake text, hud watch lines and hud_read (single job and list) carry summary and files; Inspector shows reported files when there is no git diff; / filter matches the summary; src/cli/watch.ts ignores report-meta.json writes. docs/ARCHITECTURE.md, reference.md, reference.zh.md, packages/hud-mcp/README.md updated; spec already updated (2026-11-22).

- [x] Same-language settled job: zero small-model calls for its result line; other language: one call with the summary as input
- [x] Wake text, hud watch and hud_read show the summary; stale meta is ignored
- [x] npm test passes

## Comments
