# 08: Mod re-announces a day-old job whose report was already read

**Status:** done
**Owner try:** no
**Blocked by:** none

**What to build:** 2026-11-23 08:49Z the mod woke the main session with `jc7501369ce13f2c2 imp: closed | closed after report read | Committed MONITOR-STATE-03 …`. That job was created 2026-11-22T09:02Z, its report read and closed at 09:32Z the same day; nothing in its dir changed today, and retention was deleting ~24 h-old closed jobs at the time (watch.log `delete … state=closed` every few minutes). Find which path emitted it (mod event cursor, retention/archive touching a row, jobs-revision change) and make retention, archive and deletion of an already-read or already-delivered job emit nothing. Spec §4 (22.28): notices only for what needs the owner/main session now.

- [x] Root cause named in the report with the code path
- [x] A test: retention deleting or archiving a read, closed job produces no mod/watch event
- [x] No change to delivery of genuinely new settlements

## Comments

- 2026-11-23 ~09:15Z second instance: `jcc981204b6b6e7a5 general: closed | closed after declared report` (native-statusline/01 work-summary job, created 2026-11-22T21:27Z, settled 21:56Z, report never read but observed_at 22:17Z, landed long ago as 8154e38f). Nothing in its dir changed today; mod watch pid started 08:12Z. So it is not only read jobs: an old unread-but-observed job also re-surfaces as a live event hours later.
