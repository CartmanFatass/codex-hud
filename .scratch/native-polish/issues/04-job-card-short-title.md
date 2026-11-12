# 04: HUD job cards show a short title, not the raw dispatch text

**What to build:** a HUD job's card on Home, the progress board's slice block and the Inspector show a short title:
the brief's first heading (e.g. `CLAUDE-BIND: …`) or the model's short name, instead of the raw task text the job
was dispatched with ("Read and carry out the brief /home/…").

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] A job whose brief starts with a `# heading` shows that heading as its card title
- [ ] Without a heading, the model's short name (master switch on) or the first line of the task, cut to fit
- [ ] No extra file reads beyond the bounded brief read the panel already does; no extra model calls
- [ ] Home frames at 80 and 120 columns, EN and ZH
