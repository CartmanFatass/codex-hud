# 03: Shorten long fixed waits with test-only timing overrides

**Status:** done
**Blocked by:** 01

**What to build:** Proposal 09 S3 with owner defaults Q1=A (optional params / HUD_* env overrides, production defaults byte-identical) and Q2=A (panel-backoff's 27 s case stays in the default suite, scaled through configurable refreshMs/max): src/cli/watch.ts, src/utils/panel-reload.ts, packages/hud-mcp/bin/hud-watch.mjs, src/collectors/adaptive-poll.ts; split panel-reload.test.mjs and job-retention.test.mjs; retime panel-backoff, hud-watch and thin-mcp-* tests.

- [x] Production defaults unchanged when no override is set (a test asserts it)
- [x] test:mjs green three runs in a row; wall time reported

## Comments
