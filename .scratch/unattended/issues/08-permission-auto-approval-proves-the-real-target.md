# 08: Permission auto-approval proves the real target and binds the key press to the prompt it classified

**Status:** ready-for-agent
**Live try:** In a scratch herdr pane bound to a synthetic job, show (a) a Claude Bash prompt `S=<scratchpad>; rm -f $S/*.png` (approved once), (b) the same prompt relying on an `S` only present in the launch environment (goes to main), (c) a multiline command preview containing a line `Bash command` (goes to main), (d) a prompt whose menu changes between capture and send (no key pressed, goes to main); restart the watcher between (a)'s send and its settle and confirm no second key press.
**Blocked by:** none
**Objective:** unattended

**What to build:** Milestone review j059e4af7ec78077e of unattended/05 (6614cc5d) found the approve path unsafe; fix it before any widening. (1) Execution-context evidence: drop the launch-environment inference of `S` (src/mcp/worker-permissions.ts:141-157, proc environ of the harness is not the tool shell); a variable is accepted only when the same command assigns it a literal path. (2) Recoverability: deletion is auto-approved only inside the scratchpad or job temp dir, or for git-tracked paths in the job worktree (recoverable from git); deletions of untracked files in the task dir or worktree go to main (an original reference image in the task dir must not pass). (3) Prompt identity: reject layouts with more than one permission heading on the visible screen or a heading inside the command/preview block; treat them as manual (main). (4) Delivery binding: immediately before `pane.send_keys`, re-read and require the same fingerprint and the same selected option; if herdr exposes a request/generation id or a conditional send, use it. (5) Ledger: an entry that ended `uncertain` or `sending` is not re-armed by a reflow to another fingerprint while the pane stays blocked; ambiguous transitions go to main for manual reconciliation; two consecutive identical prompts are distinguished by an observed unblocked state or go to main. Keep spend-before-send, the per-job lock and the private bounded ledger.

- [ ] Launch-environment-only variables and task-dir untracked deletions are not auto-approved; a same-command literal assignment in the scratchpad is (tests)
- [ ] A nested/duplicated heading or a menu that changes before delivery never gets a key press and reaches main (tests)
- [ ] After an uncertain send, a reflowed rendering of the still-open prompt is not answered again; an ambiguous transition reaches main (test)
- [ ] Existing worker-permissions tests still pass
- [ ] npm test, npm run test:mjs and check:fixtures pass

## Comments
