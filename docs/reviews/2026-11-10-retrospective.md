# Retrospective: why the universal-hud effort failed, and the dispatch design choices that follow

Written 2026-11-10 by the orchestrator (Claude Code) at the owner's request, as input for a design discussion with
other models. It is deliberately blunt about the orchestrator's own part. Numbers come from git, the task directories
and `docs/reviews/2026-11-10-test-volume-audit.md`.

## 1. Summary

The owner wanted one HUD for Claude Code, Codex and pi: a delegation MCP with a few fixed roles, a side panel, and one
status line per client, built on top of things that already existed (codex-hud, claude-hud, a p10k-style pi footer,
herdr, pi-roles, Jev). In about ten days, a multi-model team (one orchestrator, pi implementers/reviewers/architects,
a cheap helper model) produced roughly 650 commits, +102k source lines, +215k test lines and +83k doc lines, and **no
build the owner could install and use**.

The same way of working had succeeded before on small, clear tasks: take someone's open-source repo and cut or extend
it to the owner's needs. It failed here because this was a project of many parts with no written boundary, and the
team optimised every part locally while nobody held the whole.

After the owner stopped the work on 2026-11-10 and set a spec plus a lighter workflow, five installer and role slices
were built and merged in about 25 minutes of wall time, with no review rounds and one question in total (§6).

## 2. What happened

| Period | Main activity | Outcome |
| --- | --- | --- |
| Oct (early) | Fork codex-hud, panel, first delegation tools | Small, useful, about 13k source / 8k tests |
| 11-01 to 11-06 | An own execution platform: run ledger (SQLite), process supervisor, native host, identity proofs, receipts | ~450 commits; made obsolete by the 11-07 scope decision |
| 11-07 | Scope convergence: fixed roles, execution through herdr/pi-roles/Jev, simple installer | The right decision, recorded as one entry in an append-only concept log |
| 11-07 to 11-10 | R-queue packages (R0..R7), each with an implementer/reviewer pair | Still built an installer runtime package (plan IDs, receipts, byte-exact restore, release digests) that the 11-07 entry had ruled out |
| 11-10 | Owner stops the work, asks where the time went | Spec, new workflow, M1 slices |

Rough split of what was built: about a third is product the owner wants, about a third was thrown away (the
execution platform; the retirement slice still to run removes ~15k source and ~22k test lines), and about a third is
over-protection: guards, proofs, options and tests for threats a single-user local tool does not have.

Process volume: 154 pi runs, ~200 task directories, 127 review rounds, 322 questions from agents to the orchestrator.
Tests grew to 1.4–2x the source. A typical late test plan had 40+ numbered items; the unit suite reached 4,500 tests and
~6 minutes of wall time, half of it in performance and scale tests.

## 3. Where the time went

1. **Building the wrong thing well.** The execution platform was carefully engineered and reviewed, then discarded.
   Review quality was high; direction was not checked.
2. **Building a ruled-out thing.** The installer runtime package contradicted a decision already written down. The
   decision lived in a long log; the briefs did not cite it, and no one checked new work against it.
3. **Hardening.** Each package proved its slice against an adversarial model nobody had asked for: process ancestry
   digests, identity proofs between local processes, hash-pinned releases, fail-closed parsers for the owner's own
   config. Example still in the tree: opening the panel from pi walks the whole process ancestry and compares
   digests before showing a side pane.
4. **Review loops.** Every finding became a guard plus a regression test, usually in a new place with new fixtures.
   Three fake herdrs and four fake pis exist because each package built its own.
5. **Questions.** 322 questions, each answered locally by the orchestrator, usually with the "safer" option offered.
   Each answer was reasonable alone; together they ratcheted complexity up.
6. **Meta-work.** The delegation tooling (pi-roles, dispatch, helper panes, reaping, run ledger) was itself under
   construction during the project, and the project's product was a delegation tool. Work on the tool, the tool's
   tool, and the product blurred.

## 4. Root causes

### 4.1 No boundary document

There was a concept document with a growing decision log (§15), but no short, owner-owned page saying what the
product must do, what it does not do, and what threats it guards against. An append-only log does not bound anything:
a later entry can be missed, an earlier one can be quoted against it, and an agent reading 3,000 lines picks whatever
supports its local task.

### 4.2 The orchestrator routed instead of owning scope

The orchestrator's job became dispatching tasks, answering questions and merging green work. It measured progress by
gates passing, not by "can the owner use it". When an implementer or architect proposed more structure, the
orchestrator usually approved it because the proposal was locally sound. Over a long session (many context
compactions) it lost the thread of the real requirement and followed the implementers. The owner's phrase: the
orchestrator was led by the implementers.

### 4.3 Every task was an implementer/reviewer pair

A reviewer looking at one package hunts defects in that package. It has no view of the product and no incentive to
say "delete this". Its findings can only add: a guard, a check, a test. Running that pair on every task, up to three
rounds each, turned the whole project into local defect-hunting. Review was frequent but narrow; nobody reviewed the
direction.

### 4.4 Each model optimised its own objective

- Implementer: completeness and safety of its slice.
- Reviewer: finding defects.
- Architect: robustness, extensibility, failure modes.
- Orchestrator: keeping the pipeline moving and the gates green.

Nobody's objective was "the simplest thing the owner can use this week". Without a stated complexity budget, each
role's local optimum was "more".

### 4.5 No threat model, no complexity budget

Without "single user, local machine, trusted configs", every agent defaulted to a multi-user, adversarial model.
Without a size budget and a stop rule, a brief could only grow. Test plans had a floor ("may add, never drop") and no
ceiling.

### 4.6 The owner was not in the loop

For about ten days the owner did not install or run the product, because there was nothing installable. The only
feedback came from agents reviewing agents. The earlier successful pattern (cut an existing repo down to my needs) had
a tight loop: the owner used the result within hours.

### 4.7 Rules about process instead of the product

As problems appeared, the fix was usually a new process rule (review tiers, test budgets, gate rules, question
protocols) saved to memory. The rule set grew; each rule was a patch over a symptom of 4.1–4.6. Process rules are
cheap to add and hard to remove, so they accumulated just like the guards in the code.

## 5. Why the paradigm worked before

| | Earlier small tasks | This project |
| --- | --- | --- |
| Base | One existing repo | Five existing tools plus new glue |
| Requirement | One feature, obvious when done | Many parts, "done" never written down |
| Boundary | The base repo's own shape | None; an append-only log |
| Feedback | Owner uses it within hours | Owner could not use anything for ten days |
| Review | Owner's use | Agents reviewing agents, per task |
| Size | Fits one session | Spanned dozens of sessions and compactions |

The paradigm (orchestrator + implementers + reviewers) is not wrong in itself. It lacks a component that small tasks
supply for free: a fixed outer boundary and a short feedback loop through the owner.

## 6. What changed on 2026-11-10, and first results

Changes:

1. `docs/spec.md`: one page, owner-owned. What it must do, what it does not do (no execution platform, no
   transactional installer, no version pins, no multi-user security), the threat model (only irreversible data/config
   loss and running untrusted repo commands), milestones, and "done means the owner can install it and use it".
2. `docs/delegation.md`, modelled on Matt Pocock's skills workflow (grill, spec, tracer-bullet tickets, one review per
   spec): grill the owner before a milestone, split it into vertical slices the owner approves, one implementer per
   slice with a size budget, a stop rule and no self-review, the orchestrator integrates, **one** review per milestone
   on two axes (spec incl. scope creep; simplicity incl. what to delete), the owner tries it.
3. Role texts: implementers ask only when blocked or when the choice changes what the user sees; reviewers report two
   axes and may recommend deletion; architects start from the simplest design for the stated threat model.
4. The HUD product's own role texts and skill were changed the same way (workers are neutral; the skill ships a short
   default workflow that a project's own docs override).

First results, same day, same models:

| Slice | Workflow | Wall time | Review rounds | Questions | Size |
| --- | --- | --- | --- | --- | --- |
| Statusline parity | old brief | ~1 h 40 min | 1 | 10 | ~1.9k lines incl. tests |
| pi footer port | old brief | ~1 h 50 min | 2 | 6 | +1.6k new lines |
| M1-S1 core installer | new | 6 min | 0 | 0 | 96-line script + 1 test |
| M1-S2 Claude extension | new | 5 min | 0 | 0 | ~70 lines + 1 test |
| M1-S3 pi extension | new | 12 min | 0 | 1 | +107 / −299 |
| M1-S4 Codex extension | new | 4 min | 0 | 0 | 33 lines + 1 test |
| M1-S6 role texts | new | 6 min | 0 | 0 | +30 / −25 |

Caveats: the new slices are smaller by design, and the milestone review and the owner's own trial have not happened
yet. The real test is whether the owner can install M1 and use it.

## 7. What the owner settled after reading this (2026-11-10)

A review by another model added what this page missed: the five M1 slices above never touched the dispatch core, and
the core itself contradicts the spec (pi roles start only from a hash-named release directory, and every tool call
must prove the caller's identity). The product is a dispatch tool that was never used to dispatch its own work. It
also pointed out that §7 and §8 of the first draft answered a process failure with more process.

Decisions:
- The dispatch core is rewritten as a thin layer over the locally installed pi-roles (about 500 lines); the old
  facade with its identity and release checks is deleted in M2. M1 depends on the local pi-roles.
- Only three things carry the workflow: the one-page spec, a budget and a stop rule per slice, and the owner using
  each milestone once (a milestone lasts at most about two days).
- No questions inside a slice: a blocked implementer stops and reports.
- One review before the owner installs, by a model from a different family than the implementer.
- One main-path test per capability the owner can see.
- A fresh orchestrator per milestone, working from the spec and a short STATE.
- Once the thin layer works, the orchestrator dispatches its own work through the HUD's tools.
