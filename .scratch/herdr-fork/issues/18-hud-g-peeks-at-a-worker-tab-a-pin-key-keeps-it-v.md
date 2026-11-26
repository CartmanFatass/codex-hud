# 18: HUD: g peeks at a worker tab; a pin key keeps it visible

**Status:** ready-for-human
**Owner try:** yes
**Blocked by:** 17
**Objective:** herdr-fork

**What to build:** Owner 2026-11-26. With the fork's `hidden_tabs_peek` capability, Inspector and Execution `g` focus the worker's tab as a peek (it hides again when the owner leaves it); a new key `P` pins it visible (`tab.set_hidden false`); `H` hides as today. Help, footer hints and docs EN/ZH. Without the capability, keep today's behaviour.

- [x] Fake fork tests: g sends focus only; P sends set_hidden false; H set_hidden true; all for the job's own tab only; older fork unchanged
- [x] Live try: press g on a worker in Execution, switch back to the main tab: the worker tab disappears from the bar; press g then P: it stays

## Comments

- Landed in this commit (replay base e2752a6e2367e522eae560bfe9f2cf1f512bd769); gate 5/5 passed.
