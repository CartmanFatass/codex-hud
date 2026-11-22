# RUNZ1 design ruling

**Decision: choose A.** Visible scopes that share the terminal SID retain the existing corroborated ESRCH path. A zombie-held visible PGID is not proven gone by two scans and must remain unknown/uncertain, holding its slot, until sufficient evidence becomes available.

This complies with contract 04 ScopeCheck and T-04-11 **without changing the contract, gates, or supported profiles**. However, the proposed headless two-scan algorithm, including the session-wide refinement, is **not yet sufficient**.

Reviewed base: `universal-hud` at `f1e2a8408fbc6ddef181978e8a2d9fd5831242e9`.

## Why A complies

Contract 04:73 requires a trustworthy **complete** no-live-workload proof, correct scope identity, original-harness termination, and sealed/dead launchers. T-04-11:246 makes `gone` conditional on that complete check. Neither makes two `/proc` scans complete merely because every listed PID was readable.

For a visible scope, live processes elsewhere in the terminal session can join its zombie-held PGID after both scans. Such scans therefore lack the completeness needed for the contract’s zombie-only positive case. Keeping that case unknown preserves the contract; it does not redefine an established complete proof as unknown.

The prohibition on requiring ESRCH exclusively is addressed by implementing a sound zombie-only proof for eligible own-session scopes. It does not require accepting unsafe shared-session evidence. RUNZ1 and HYG1 review 1 explicitly provide this visible-scope choice.

The existing visible-control and manual-stop decisions in concept §15 remain unchanged. No new signaling, helper, launch topology, or automatic pane interaction is authorized.

## Headless corroboration: required corrections

1. **Use structural eligibility, not an invented mode field.** Require the validated, frozen scope to satisfy `sid === pgid === group_leader.pid`, with matching boot/domain and the existing instance checks. Current production headless launch uses `detached: true` (`process.ts:285–290`); visible discovery preserves the terminal SID (`visible-process.ts:59,70`). `ProcessScope` need not change.

2. **Compare the whole session, not only the target PGID.** The implementer’s refinement is necessary: live or newly observed same-session processes outside the group can produce future joiners. This is corroborating evidence, not an enlargement of the managed scope.

3. **Session-wide subset alone still has a real race.** I reproduced:
   - Scan 1 snapshots PIDs.
   - The session/group leader forks B, then becomes a zombie.
   - Scan 1 reads only that zombie in the target session.
   - Scan 2 snapshots PIDs, including B.
   - B forks C, then calls `setsid()` before its stat is read.
   - Scan 2 filters B out because it now has another SID; C was absent from the snapshot.

   Both scans read every listed PID successfully. Their target-session sets were the identical zombie leader, satisfying the proposed subset rule, while C remained **S in the original SID/PGID**. Linux permits a non-group-leader to create a new session without moving its existing children. [setsid documentation](https://man7.org/linux/man-pages/man2/setsid.2.html)

   **Recommended bounded strengthening:** retain the full PID/start/boot/domain identity census from scan 1, before SID filtering. Require every identity observed in scan 2’s full census to exist in that first census, in addition to the session-wide zombie subset and no-live-session requirements. A new/reused identity must invalidate zombie corroboration even when its second-scan SID is different. This conservatively rejects unrelated process churn, but closes this escape-before-stat hole. An equally strong exclusion proof may be proposed instead.

4. **A zombie TGID does not prove its whole thread group is dead.** I also reproduced a TGID whose stat reported `Z` while a sibling thread remained `S` in the same SID/PGID. The live TID was absent from top-level `/proc` enumeration; the leader’s stat reported `num_threads=2`.

   The new proof must establish no live sibling tasks, not just test the leader’s state. Conservatively reject a zombie record unless complete thread-group termination is established, for example through validated terminal state and a single remaining task, with ambiguous cases unknown. Preserve this requirement for original-harness and launcher termination too. [pthread_exit documentation](https://www.man7.org/linux/man-pages/man3/pthread_exit.3.html)

5. **Strict read success is necessary, not sufficient for visibility.** Any enumerated stat failure, including ENOENT/ESRCH, invalidates the zombie corroboration attempt. Additionally, establish that the actual procfs view provides the relevant complete visibility. `hidepid=2/4` can omit processes without producing a stat failure. Unknown or restricted visibility must disable this alternative proof. The existing ESRCH path remains available under its current prerequisites. [Kernel procfs documentation](https://cdn.kernel.org/doc/html/latest/filesystems/proc.html)

These are bounded checks at already-authorized observation points. Do not add scanning loops, retry polling, or another persistent observer.

## Acceptance changes

Retain all RUNZ1 acceptance requirements and make these cases explicit:

- A truly zombie-only own-session group can end while kernel group existence still succeeds.
- Both HYG1 races remain nonterminal.
- The fork-after-second-snapshot followed by `setsid()` race remains nonterminal.
- A zombie thread-group leader with a live sibling thread remains nonterminal.
- New/reused census identities, failed reads, malformed records, and unestablished visibility cannot produce zombie corroboration.
- A shared-session visible zombie-held group remains unknown/uncertain and retains its slot. After actual group disappearance and all other termination/sealing prerequisites, the ESRCH route can finish it.
- A live process outside the target group must not block an otherwise valid ESRCH proof merely because it shares the SID. The session-wide restriction belongs only to the alternative proof.
- `run-control` and the complete README check set remain required.
- Report full proof cost and additional scan cost, p50/p99 with n ≥ 1000, commands and host, across at least three runs. Include census size and conservative refusals under churn.

The new counterexamples were exercised using real Linux processes without editing repository files. This is a design ruling, not implementation acceptance.

## Authority and ownership

- **Contract change:** none.
- **Gate or supported-profile change:** none.
- **Owner-reserved decision:** none for A and the conservative corroboration above.
- **Other package’s files:** none required. Keep implementation in RUNZ1’s owned process code/direct helpers and owned tests. The dispatcher may save this ruling in the prescribed documentation location.
- A new visible corroboration backend, changed launch/control topology, new platform requirement, or relaxation of completeness would be a separate design question and, where it changes contract/profile/gates, an owner question.

**Disposition:** the visible choice is settled as A. RUNZ1 may proceed within ownership, but must not treat the originally proposed headless two-scan/session-subset predicate as approved or sufficient.