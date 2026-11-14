# 05: the report settles at turn end

**What:** idle grace or close starts only when the report is new, herdr is not working and no newer background child
is alive; idle grace consults background children too; drop the `turn !== 'done'` → leave branch.

**Who:** imp (agy) · **Size:** ~60 lines · **Blocked by:** 04 · **Status:** resolved (90ef78cd, as a stopgap; 08 replaces the loop)

- [ ] Report written while working, a slice expires, then done → idle_grace with output_written true
- [ ] No `/quit` before done; a live background child holds the grace
