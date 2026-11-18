# 01: A live child process means the worker is still working

**Status:** ready-for-agent
**Blocked by:** none

**What to build:** Owner, 2026-11-17: agy is misjudged when it runs a background command: herdr may show idle while
the work goes on, and the supervisor can end or close a working job. Two live runs (`tmp/tasks/agy-bg-test/`, job
`jd01d592a43b12e03` normal background, `j7715476d28018864` `IsDaemon: true`) showed the command always runs as a
descendant of the agy process (`agy → bash -c → sleep`), and disappears when it finishes; herdr showed `idle` for
5–10 s with the child alive and still `working` after the job closed.

- [ ] For a CLI job, a live descendant process of the recorded worker pid (`STATUS.json` `pid`, matched with
      `pid_start_time`) means working: the turn is not settled, no quiet-job Decision API call is made, no "write the
      report" prompt is typed, and the job is not closed by the watcher.
- [ ] Applies to every CLI agent; it only ever delays an end, never causes one.
- [ ] Read from `/proc` inside the supervisor's existing judge/tick; no new poll loop, no new process spawns.
- [ ] When the last child exits, the existing rules resume within one tick.
- [ ] Main-path tests with a fake CLI that spawns a long-lived child (temp HOME/HUD_HOME, no real agy): idle +
      report + live child → not settled; child exits → settles; quiet + live child → no Decision API call.

## Comments
