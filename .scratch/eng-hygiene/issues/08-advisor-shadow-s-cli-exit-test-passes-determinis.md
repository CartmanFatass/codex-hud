# 08: advisor-shadow's CLI exit test passes deterministically under gate load

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** none

**What to build:** tests/unit/advisor-shadow.test.mjs 'hud advise --help and no-stdin invocations exit within 1 s; detached statusline runs stay silent' (around line 960) failed on the land gate's first run three times on 2026-11-25 (measured 1117/1147 ms; latest log /home/fires/.hud/flows/ff16b9489fe1315ca.json.gate-2.log) and passes alone. A 1 s wall-clock bound measured while 8 test files spawn processes conflates load with the behaviour. Find what the test is really guarding (a hang on missing stdin, a wait on --help) and assert that directly: e.g. exit happens without reading stdin / before any timer of the command's own fires, by observing the event or using the command's own clock, not wall time of a spawned process under load. Fix product code only if it really waits. No longer deadline, no retry, no assertion removed.

- [ ] Report names what the 1 s bound was guarding and how the new assertion checks it
- [ ] The test fails if the command waits on stdin or a timer (show by a temporary mutation)
- [ ] Passes 20 times in a row alongside the full mjs suite or a CPU hog

## Comments
