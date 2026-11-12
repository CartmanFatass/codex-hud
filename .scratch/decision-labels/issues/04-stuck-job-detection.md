# 04: A running job that is going in circles is marked

**What to build:** for a running card (a HUD job or a native subagent) that has been quiet for a few minutes, the
Decision API reads its recent public activity (the last dozen tool calls and their result summaries, already read for
its sentence) and judges whether it is progressing or repeating the same failure. A "looping" verdict shows a ⚠ on the
card with the confidence in the Inspector. At most one call per card per 5 minutes, only while it stays quiet.
Display only: nothing is sent to the worker.

**Blocked by:** 01

**Status:** claimed (DL)

- [ ] No call for a card that has new activity or was judged less than 5 minutes ago
- [ ] A synthetic session repeating one failing command is marked; a progressing one is not
- [ ] The mark clears when new, different activity arrives
- [ ] EN and ZH, 80 and 120 columns
