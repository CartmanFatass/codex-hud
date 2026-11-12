# 01: A settled job's card shows its outcome

**What to build:** when a HUD job settles, the Decision API reads the first lines of its report and its final status
and classifies the outcome: done / partial / failed / blocked, with a confidence. Home cards, the Inspector and the
progress board's slice block show it as a mark (e.g. a job whose report says live validation was not run shows
"partial"). This ticket also builds the shared path every later ticket uses: decision calls for display labels go to
Gemini first (free tier; the owner's key), fail over to OpenAI, are cached by input revision, and share an hourly cap.
They do not follow the Settings "Decision API" row (that row is Jev's browser jobs). Display only: a label never
changes a job's state or steers a worker.

**Blocked by:** GEMINI-DECIDE landing (outside this feature)

**Status:** ready-for-agent

- [ ] One decision call per settlement, input bounded to the report's head and the status; reopening the panel or an unchanged report makes no call
- [ ] Outcome mark on Home, in the Inspector and on the progress board, EN and ZH, 80 and 120 columns
- [ ] Master switch off or no decision key: no mark, no call
- [ ] Gemini 429 falls over to OpenAI; the hourly cap holds; tests with a fake decision endpoint
