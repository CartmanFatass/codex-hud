# RUNZ1 ESRCH termination ruling

**Decision: strengthen original-harness and launcher termination checks for both `proveGroupGone` success paths. This is necessary and permitted within RUNZ1. Keep the general `processState` semantics unchanged.**

This clarifies the earlier RUNZ1 ruling. It does not change a contract, gate, supported profile, or owner-reserved decision.

Reviewed: branch `dots/runz1`, base `f1e2a8408fbc6ddef181978e8a2d9fd5831242e9`, and its pending process implementation. The implementer supplied the complete earlier `/root/oracle_runz1_scope` ruling. This consultation was read-only: no edits, tests, probes, or subagents.

## Reason

Contract 04’s ScopeCheck requires three independent facts:

1. The frozen scope has no live workload.
2. The original harness no longer executes.
3. All relevant launchers and submission channels are sealed or definitively terminated.

The ESRCH result establishes absence of the queried process group. It does not establish termination of an original harness or launcher that has escaped that group. [Linux `kill(2)` documentation](https://man7.org/linux/man-pages/man2/kill.2.html)

In the inspected implementation:

- `process.ts:69–84` classifies a matching leader record in state `Z` or `X` as `dead`.
- `process.ts:148` uses that classification for the harness and launchers.
- `process.ts:157` then returns `true` on group ESRCH.
- The stronger subject thread-group checks in `process-census.ts:157–170` occur only in the alternative proof.

Consequently, an escaped original subject whose TGID reports `Z` while a sibling thread remains live can pass the existing ESRCH route. Terminating the main thread does not necessarily terminate the process or its other threads. [Linux `pthread_exit(3)` documentation](https://man7.org/linux/man-pages/man3/pthread_exit.3.html)

This violates contract 04 ScopeCheck, T-04-5/T-04-11/T-04-24, and contract 02’s original-harness and launcher prerequisites. PGID absence does not waive them.

The earlier ruling explicitly said: “Preserve this requirement for original-harness and launcher termination too.” Its preservation of the ESRCH route was not an exception to that requirement.

## Required implementation boundary

Use a dedicated termination proof within `proveGroupGone` and its direct helpers. A common precondition before either success return is the recommended organization; an equivalent structure is acceptable if no success path bypasses it.

For the original harness and every supplied launcher stamp, including the required original group leader:

- Validate the existing full identity and boot/PID-domain prerequisites.
- A present matching `Z`/`X` leader is insufficient by itself. Establish that no sibling task can still execute.
- A conservative validated terminal record with a single remaining terminal task is an acceptable direction. Equivalent sound whole-thread-group evidence is also acceptable.
- Task-list/read failures, malformed records, inconsistent identities or counts, and incomplete visibility cannot count as termination.
- In particular, failure to access `/proc/<pid>/task` is not evidence that no sibling remains. Linux documents that this directory can be unavailable after the main thread terminates. [Linux `proc_pid_task(5)` documentation](https://man7.org/linux/man-pages/man5/proc_pid_task.5.html)
- Preserve sound handling of kernel-confirmed disappearance and unambiguously replaced original identities. Do not make the original PID’s continued presence mandatory for proving its termination.
- Check original subjects regardless of their current PGID or SID. Do not filter escaped originals out of the termination obligation.

Preserve the caller’s separate permanent-submission-channel sealing requirement. This change does not create a new way to treat a live launcher as sealed.

**Do not redefine `processState` globally or modify its unrelated callers as part of this fix.** The stronger predicate is a proof requirement, not a broad redesign of process-state reporting.

## Keep the two scope proofs distinct

The ESRCH route must remain available for headless and shared-session visible scopes once all its prerequisites, including strengthened original-subject termination, are satisfied.

Do **not** import these alternative-proof conditions into the ESRCH route:

- `sid === pgid`;
- absence of every live process elsewhere in the session;
- a stable full-host census;
- rejection merely because an unrelated process starts or changes.

An unrelated live session outsider must still permit a valid ESRCH conclusion. An escaped original harness or supplied launcher is not such an outsider.

The alternative zombie-only proof retains all requirements from the earlier ruling: structural eligibility, complete visibility, whole-census identity corroboration, session-wide terminal membership, thread-group checks, and conservative refusal on ambiguity.

No polling, retry loop, persistent observer, new signaling authority, launch-topology change, or automatic pane interaction is authorized.

## Acceptance additions

Retain the complete RUNZ1 and earlier-ruling acceptance requirements. Add:

1. **Escaped harness regression:** real Linux processes establish that the frozen target group is empty and `kill(-pgid, 0)` actually returns ESRCH, while the original harness TGID reports `Z` and a sibling remains live outside that group. `proveGroupGone` must return `false`.

2. **Escaped launcher regression:** repeat with a supplied launcher as the surviving thread group and a genuinely terminated harness. It must also return `false`.

3. **Termination positive controls:** after the surviving subject’s whole thread group terminates and all other prerequisites hold, the ESRCH route returns `true`. At least one escape case should leave the original SID as well, demonstrating that subject checks are not session-filtered.

4. **Fault and identity cases:** ambiguous task visibility/read/count/identity evidence must not certify termination. Preserve correct handling of genuinely absent or replaced originals and rejection of wrong boot/domain evidence.

5. **Route isolation:** retain the visible ESRCH positive with an unrelated live session outsider and the visible zombie-held negative. Retain the alternative proof’s existing thread and race regressions.

The new regression must exercise `proveGroupGone`, not only the new helper. Restoring today’s ESRCH early-return behavior must make it fail. Use synthetic fixtures with bounded transitions and cleanup of owned processes and threads.

`run-control`, existing process regressions, and the full README check set remain required. Verify that failed proof prevents terminal receipt/reconciliation and slot release through the existing production integration.

Include the new common termination-check cost in full-proof measurements. Report the ESRCH path separately from the zombie alternative, with subject counts, host, commands, sample sizes, warm-up, percentile method, and refusal counts. Retain the existing n ≥ 1000 and three-run reporting requirements. No performance threshold is relaxed.

## Authority and disposition

- **Contract/design change:** none. This enforces existing termination prerequisites.
- **Gate/profile change:** none. Unsafe evidence becoming nonterminal is not a supported-profile withdrawal.
- **Owner decision:** none required for this scoped correction.
- **Ownership:** `src/core/run/process.ts`, direct helpers, and RUNZ1-owned tests. No other production files need changing for this ruling.
- Any independently discovered terminal path bypassing `proveGroupGone` must be reported separately before expanding ownership.

**RUNZ1 may proceed with this correction. The current ESRCH bypass must be fixed before acceptance. This is a design ruling, not implementation acceptance.**