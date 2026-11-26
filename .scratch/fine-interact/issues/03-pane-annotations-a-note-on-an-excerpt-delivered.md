# 03: Pane annotations: a note on an excerpt delivered at the job's next turn

**Status:** ready-for-human
**Owner try:** yes
**Live try:** Select text, choose "Note for next turn" for a working job: the note shows on the excerpt card and arrives once in that job's next prompt, then shows as delivered.
**Blocked by:** select-send/02
**Objective:** interaction

**What to build:** D-2026-11-26-02, lower priority. On a selection, "Note for next turn" attaches a short note to the excerpt record for a chosen job; HUD delivers it as part of that job's next prompt (not mid-turn), once, then marks it delivered. The note shows on the excerpt card; anchoring to the live screen (moving with content) is not built; the card keeps the original excerpt.

- [x] Tests: a note is delivered exactly once with the job's next prompt and never mid-turn; a closed job's pending notes are shown as undelivered
- [x] Owner try: annotate a log line for a running worker; on its next turn it addresses the note

## Comments

- Landed in this commit (replay base a6da6428041ba5d9143e23eea1715a0029a413b2); gate 5/5 passed.
