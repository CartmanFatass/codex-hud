# 01: A land keeps the failing output of a gate test

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** none

**What to build:** Found 2026-11-22: land flow records (~/.hud/flows/<flow>.json `reruns`) keep only failing test names, so a flake that passes on the immediate rerun can only be diagnosed by reproducing it. When a gate command fails (first run or rerun), keep a bounded excerpt of that run's failure output (the failing tests' assertion/error blocks, else the last lines; cap ~8 KiB per rerun) next to the flow record, private 0600, and point to it from the rerun entry and the terminal notice. hud_read of the flow shows the path.

- [ ] A synthetic gate with a test that fails once then passes leaves an excerpt containing that test's assertion message, linked from reruns
- [ ] Excerpt is bounded and private (0600); old flow cleanup removes it with the flow record
- [ ] A green gate writes no excerpt
- [ ] docs/reference.md + reference.zh.md land paragraph mention the excerpt

## Comments
