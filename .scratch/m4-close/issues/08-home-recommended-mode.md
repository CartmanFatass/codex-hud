# 08: Home can be ordered by the model, with a short progress brief on top

**What to build:** Settings offers a Home mode: Default (today's fixed order) or Recommended. In Recommended the
Decision API ranks the current cards by how much they matter to the owner now; Home puts the important ones first and
folds the unimportant settled ones. A one- or two-sentence brief at the top of Home says where the work stands (what
moved, what waits on the owner, what is next). Cards that need the owner are never folded or demoted. Without a key,
or when a call fails, Home falls back to Default silently.

**Blocked by:** None (can start immediately). Blocks 04 (the review covers it).

**Status:** resolved

- [x] Settings row Home mode: Default | Recommended (EN/ZH), saved; Default unchanged byte for byte
- [x] Recommended: one batched ranking call per change of the card set/states, at most once per 2 minutes, cached
- [x] Brief at the top of Home, 1–2 sentences, refreshed with the ranking; never invents facts beyond the cards
- [x] Needs-you cards stay first and visible whatever the ranking
- [x] No key / failure / models off → Default, no error text on Home
- [x] EN and ZH, 80 and 120 columns
