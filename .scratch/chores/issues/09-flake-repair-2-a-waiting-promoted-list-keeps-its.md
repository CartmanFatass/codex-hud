# 09: Flake repair 2: a waiting promoted list keeps its place, and a persistent refusal does not self-wake the service

**Status:** ready-for-agent
**Live try:** none
**Blocked by:** 04
**Objective:** unattended

**What to build:** Repair of chores/01 and chores/04 after milestone review jcb3010cb6270dbe6 (findings 2 and 4; read its report for file:line). (1) src/mcp/land-flakes.ts ~538-542 returns an empty outcome when another flake job is active, and ~625-634 then records the promotion as done with no admitted job. If that active imp fails or is stopped instead of landing, nothing drains the waiting ready-for-agent running-list ticket: clean lands return early (~601) and the service only scans pending receipts. Keep a durable waiting-dispatch state tied to the promoted ticket. Acknowledge it only when that ticket is admitted or resolved some other way (done/claimed/wontfix), and admit it once capacity frees, including when the active flake imp fails or is stopped. (2) src/unattended/service.ts ~116 retries pending collections before the unchanged-input check, and each refused retry rewrites flows/f*.json (attempts, updated_at). That file is a watched input (~183), so one hand edit on the running list causes continuous retries. A retry's own output must not trigger the next retry: skip receipt rewrites when the refusal is unchanged, or exclude the receipt change from the wake stamp, or gate retries on a real input change. Keep the land green and the owner's edit intact as chores/04 requires.

- [ ] A promoted list that waits behind an active flake imp is admitted after that imp is stopped or fails, without another flake land (test)
- [ ] The waiting state is acknowledged only on admission or independent resolution of the ticket (test)
- [ ] While the refusal stays unchanged, retry attempts and receipt writes stay bounded across service wakes; after the refusal clears, the collection appends/admits exactly once (test)

## Comments
