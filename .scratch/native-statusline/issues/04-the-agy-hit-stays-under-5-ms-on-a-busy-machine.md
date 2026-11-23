# 04: The agy hit stays under 5 ms on a busy machine

**Status:** done
**Owner try:** no
**Blocked by:** none

**What to build:** Acceptance pass 2026-11-22: agy cache hit p50 7.4 ms direct / 8.5 ms via sh -c (n=50, load 3.5-5.5) vs the <5 ms target; native lookup alone ≈1 ms, sh -c baseline 1.4 ms, Claude native launcher 4.3 ms. The gap is the bash launcher work before exec (bin/hud-statusline → hud-statusline-native.sh: PID/birth verification, stdin handling). Move what the agy hit path does in bash into the binary (or exec the binary first and let it verify), keeping the staleness policy tests unchanged. Also: under HUD_THEME=none / NO_COLOR=1 one leading ESC[0m remains; drop it.

- [x] Agy hit p50 < 5 ms measured n=50 under tmp/env.sh with a parallel CPU load (state the load), before/after in the report
- [x] statusline-agy and native-statusline tests unchanged in what they assert and passing
- [x] NO_COLOR output has no escape sequences (test)

## Comments

- Landed in this commit (replay base 693ca9b1da95905d8ee22e65c984472fd326a9a2); gate 5/5 passed.
