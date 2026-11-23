# 03: A land repair does not fail on the worker's pre-turn state

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** none

**What to build:** Live 2026-11-22: panel-polish/02's land (flow f32c448e14d394e42) hit a docs/reference conflict and sent the repair to its tab CLI worker (frontend-imp on claude) at 04:04:42.882Z; the flow failed at 04:04:43.494Z with 'j32c448e14d394e42 needs the main session' although the worker had no question and was already repairing (hud doctor: state working, turn 2 sent 04:04:42.882, no questions). In src/mcp/land-repair.ts the wait loop's first read sees the row from before the new turn (blocked / waiting_orchestrator from the settled previous turn) and throws. Fix: judge only status written for the repair turn (e.g. require the turn seq/sent_at of the repair send, or status updated after `started`), so a stale pre-turn state cannot fail the flow; a real question during the repair still hands back to the main session.

- [ ] Synthetic test: a CLI worker whose previous turn ended waiting_orchestrator/blocked gets a land repair; the flow waits and lands when the repair report arrives
- [ ] A question asked during the repair turn still fails the flow with 'needs the main session: q<n>'
- [ ] Targeted land tests pass

## Comments
