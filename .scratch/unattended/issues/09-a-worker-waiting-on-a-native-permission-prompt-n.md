# 09: A worker waiting on a native permission prompt never fails its queue item; unclassifiable prompts reach main

**Status:** ready-for-agent
**Live try:** Start a ticket queue (ordinary and unattended) on a scratch feature whose fake CLI worker blocks on a synthetic permission prompt: the item stays working while the watcher classifies; an approvable prompt is answered and the item lands; an oversized edit preview or unknown footer yields one main notice naming the pane, not an item failure or silent owner load.
**Blocked by:** none
**Objective:** unattended

**What to build:** Milestone review j059e4af7ec78077e: a blocked CLI is published as `waiting_orchestrator` (src/mcp/cli-judge.ts:198-200) and the queue flags that as a worker problem (src/mcp/ticket-queue-step.ts:1099-1100), so an ordinary run fails and an unattended item is marked failed while the permission watcher is still classifying a prompt it then answers. Also, a recognized native heading with an oversized preview or unknown footer returns `undefined` from capture (src/mcp/worker-permissions.ts:27-58,138,185-189): nothing is recorded, and an older answered entry can suppress the new block (src/collectors/thin-jobs.ts:297-302). Change: (1) the queue defers a generic worker failure while the job's pane is a native permission wait that the watcher has not yet reconciled (pending/observing record or a bounded grace), and treats a prompt handed to main as a main item, not a worker failure; (2) separate 'main must inspect this pane' from 'safe to map its options': a recognized heading that cannot be parsed safely creates a manual main entry and notice; (3) a new block after an answered entry is never hidden.

- [ ] A queue item whose worker blocks on a synthetic permission prompt is not failed while classification is pending and lands after auto-approval (test, ordinary and unattended runs)
- [ ] A recognized but unparseable prompt yields one main notice with the pane and no key press (test)
- [ ] An answered older entry does not hide a new blocked state on the bar/panel (test)
- [ ] npm test, npm run test:mjs and check:fixtures pass

## Comments
