# 02: Derived keys, repair of a closed job, one send to several jobs, retry_of

**Status:** done
**Blocked by:** none

**What to build:** request_key and message_key become optional: the HUD derives them (hash of pane, role, cwd and task; job and text for a send), an explicit key still wins. hud_send to a job closed by a read creates the repair job itself with the earlier brief and report as references and returns continued_as. hud_send accepts jobs: [...] and sends only to working jobs, naming those skipped. hud_create({retry_of}) copies a failed job's brief and options onto the next available place. Proposal A3, A6, A7.

- [x] hud_create and hud_send work without a key and a retry of the same call returns the same job or send
- [x] hud_send to a closed job returns continued_as with a new job whose brief references the earlier brief and report
- [x] hud_send with jobs sends once per working job and lists skipped jobs
- [x] hud_create with retry_of re-dispatches a failed job's brief on the next place
- [x] Main-path tests pass

## Comments
