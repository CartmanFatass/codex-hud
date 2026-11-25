# 10: Headless sonic on haiku finishes or fails cleanly when pi auto-compaction starts

**Status:** done
**Owner try:** no
**Blocked by:** none

**What to build:** On 2026-11-25 all 7 headless sonic jobs placed on the `haiku` preset (pi, anthropic/claude-haiku-5-5, thinking raised to `max` by the Decision API; preset says `high`) hung and were marked `failed | stalled`: jbb50ae20971711f6, jdfb403f4986dfaac, j080fad16bd7d9733, j83a99d8087fd37bc, j08578c3d9bfdb057 (+ running ones). Each job's stdout.jsonl ends with a `context_edit` entry (`replacement: null`) followed by `compaction_start` (reason `overflow` or `threshold`) and never `compaction_end`; one haiku turn produced ~13k reasoning tokens with `stopReason: length` at ~296k context. deepseek and luna jobs on the same task (reading a ~120 KB file and writing a label file) all succeeded. Find where the hang is (pi core compaction with this model, a pi extension that edits context, HUD's thinking choice for sonic, or HUD's headless runner) and fix the cause in what HUD owns; if the cause is outside HUD (pi core), make HUD's behaviour safe (e.g. thinking choice or compaction settings for headless sonic) and record the upstream issue. Do not change the owner's sonic even pool.

- [ ] Cause located with evidence from a job record or a reproduction.
- [ ] A headless sonic job on haiku that reaches the compaction point either completes or ends with a clear failure reason within the stall window, shown by a test or a live run.
- [ ] Land gate passes.

## Comments
