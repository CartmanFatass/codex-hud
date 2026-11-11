# Discussion record: dispatch core, workflow corrections, roles versus workflow

Recorded 2026-11-10 by the orchestrator (Claude Code) from a discussion with the owner. It follows
`docs/reviews/2026-11-10-retrospective.md`. Each item is marked **decided** (the owner said so) or **proposed** (the
orchestrator's recommendation, not yet adopted). `docs/spec.md` stays the boundary; nothing here changes it until the
owner edits it.

## 1. Finding: the dispatch core conflicts with the spec

The five merged M1 slices are registration scripts of 33–96 lines. None of them touched the dispatch core, so the
retrospective's §6 numbers show only that small, clear tasks are fast. Read from the code, not run:

- `./install` links `hud-mcp` to the file in the repo. Starting a pi role first calls `facadeRelease`
  (`src/roles/pi-owned/facade-context.ts:19`), which requires the program to run from `releases/<sha256>/` with a
  verified manifest and otherwise fails with `not_installed`. A repo install would refuse `hud_create` for imp,
  reviewer and sonic.
- Every tool call must prove the caller's identity (`packages/hud-mcp/src/role-source.ts`) or it returns
  `identity_unverified`. `docs/handoff/STATE.md` records that ordinary Codex sessions are refused by design. Spec §3
  rules out identity proofs between local processes, and M1 needs the six tools from all three clients.
- Size: `src/roles` is 8.6k lines (`facade.ts` alone 2,059) and `packages/hud-mcp/src` is 5.5k.

So M1-S5 is where the old stack meets the spec, not a plain end-to-end run.

## 2. Decided: thin dispatch layer, depending on the installed pi-roles

- **Decided (owner):** rewrite the six tools as a thin layer instead of patching the existing facade.
- **Decided (owner):** M1 depends on the pi-roles already installed on the machine, not on a copy built into the HUD.

Shape of the thin layer (proposed with the recommendation the owner accepted):

- `hud_create` calls `pi-dispatch`, `hud_read` reads the STATUS files, `hud_respond` writes `qN.answer.md`,
  `hud_close` calls `pi-role-reap`. This is the path accepted live on 2026-11-08 (R2b).
- Job records are plain JSON under `$HUD_HOME/jobs`; `request_key` de-duplication stays.
- No identity proofs and no release verification.
- Budget: about 500 lines plus one main-path test against a fake herdr.
- The old facade is deleted with M2. Jev and oracle jobs come back in M3.

## 3. Additions to the retrospective

1. The product is a dispatch tool, and it was never used to dispatch its own work. The six tools passed live
   acceptance on 2026-11-08; from that day the orchestrator could have used `hud_create` for real tasks. That feedback
   loop did not need the owner to install anything.
2. The retrospective's remedies are again process (eight questions, eight levers, four indicators), which its own §4.7
   criticises. Three things are enough: the one-page spec, a budget and stop rule per slice, and the owner using each
   milestone.
3. M2 is defined too narrowly. It deletes only the retired execution stack, but a large part of the over-protection
   sits in the live dispatch path.

## 4. Proposed: workflow corrections

The owner named three problems in the old workflow: local scope optimisation, the same dispatch for every task
whatever its size (implementer plus reviewer even for small fixes), and test accumulation. One cause sits under all
three: the workflow fixed the process and left the judgement (what a task is worth, when it is enough, whether it
needs checking) to whoever executed it.

### 4.1 Local optimisation: put a price on the work

- A size budget and a stop rule in every brief (already in `docs/delegation.md`).
- Two lines of background in every brief: who uses it and what it guards against.
- Asymmetric authority: a worker may decide alone to do less or simpler; anything that adds (a guard, an option, an
  abstraction, a new file) beyond the budget is reported back. The orchestrator may approve reductions; growth goes
  to the owner.
- Dispatch vertical slices, not modules. A module has no natural end; a slice ends when the owner can see it work.

### 4.2 Uniform dispatch: three tiers, chosen at dispatch time

Risk is the cost of being wrong times how hard the error is to notice, not the amount of code.

| Tier | Test | Handling |
| --- | --- | --- |
| Trivial | One file, a few dozen lines, obvious approach | The orchestrator edits it or hands it to sonic; no brief, no review |
| Normal | One slice; the owner would notice an error when trying it | One implementer, its own main-path test; the orchestrator reads the diff |
| Risky | Irreversible (configs, deleting data, killing processes) or hard to see (concurrency, recovery) | Implementer plus one targeted review |

`docs/delegation.md` has the second and third tiers. The trivial tier is missing.

Two changes to review itself:

- Give the reviewer a question ("can this install lose an existing config?"), not "find defects".
- A finding is not an obligation. The orchestrator filters: fix what real use would hit, note the rest in one line.

### 4.3 Test accumulation: tests belong to behaviours, not to tasks

- Keep one list of behaviours the owner would notice, one test each. A task adds a test only when it adds a
  behaviour; otherwise it extends an existing test.
- Test at the outermost seam (CLI command, MCP tool call, rendered frame), so internals can change or go without
  touching tests.
- A regression test only for a bug found in real use, not for a case a review imagined.
- A time ceiling for the default suite (for example one minute). Performance and mutation tests run by hand.
- One shared fake herdr and one shared fake pi for the whole project.

### 4.4 Long tasks: state is rewritten, not appended

- Three short files carry everything across sessions: the spec (owner), the state (one screen: done, next, decisions
  waiting for the owner), and the slice list. The state file is rewritten each time. `docs/handoff/STATE.md` is 670
  lines today and its title still names the 2026-11-03 handoff.
- A fresh orchestrator per milestone that reads only those three files.
- The owner steps in at three points: the spec, the slice list, and trying the result. Questions in between are
  batched.

### 4.5 Caution against over-correcting

No review plus tight budgets can produce work that passes the main path and breaks on second use, with the owner as
the only tester. The signal is a bug the owner hits that a main-path test would have caught. The response is to raise
the test or review tier for that area only, not to add a global rule.

## 5. Roles and workflow are separate layers

**Owner's position:** the MCP has two parts that should be decoupled: roles that can be defined for any harness, and
the workflow (the dispatch pattern), which is also customisable. Decoupling makes each easy to tune, and the HUD must
not be bound to one workflow.

Where they are coupled today:

- Role names are a fixed enum of five in `src/roles/roles.ts`, each with a capability contract. A new role needs a
  code change.
- Workflow is in the tool parameters and descriptions: oracle's `propose` / `converge` phases are a `hud_create`
  parameter, and the `hud_send` description says when an implementer accepts a fix.
- Role texts carry sequence: the pi implementer starts its own closing reviewer.

**Proposed** shape: three layers, where roles and workflow meet only through the brief.

| Layer | Form | Holds | How to change it |
| --- | --- | --- | --- |
| Role | One file per role | Name, harness, model, effort, role text, which helpers it may call | Edit the file; the next dispatch uses it |
| MCP | Six tools | Create, read, send, respond, close a job for a role | No change needed |
| Workflow | Prose in the skill | When to use which role, how to write a brief, when to review | Edit the text, or a project's docs override it |

Two checks that the split holds:

1. The MCP's code and tool descriptions name no role and no order. The role list is built from the files at start.
2. A role text says only how the role does its own job and how it reports. It names no other role and no earlier or
   later step. Anything that varies per task (budget, whether to ask, whether to self-test) arrives in the brief.

Details:

- For pi, pi-roles already keeps one markdown file per role. A HUD role file for pi points at it and does not copy
  the format.
- "Which helpers it may call" is a role permission, empty by default. When to use a helper is workflow and arrives in
  the brief.
- Each further harness costs one adapter (how to start, how to tell it is done, how it asks). M1 connects pi only;
  the role file has a harness field from the start.
- Workflow stays prose. Fields for stages or transitions would be the workflow engine that spec §3 rules out. Several
  patterns means several files.
- The panel shows job facts only (running, question pending, finished, closed), not workflow stages.

## 6. Waiting for the owner

- **Spec §2.1** says "fixed roles (imp, reviewer, sonic, oracle, jev)". The owner's position in §5 changes that
  line. Suggested wording: "Roles are defined by files under `$HUD_HOME/roles/`; the HUD ships five defaults. The MCP
  knows no particular role and no workflow." Oracle's two phases then leave the tool parameters and become two
  briefs. Cheapest inside the thin-layer slice, where the role lookup is rewritten anyway.
- Whether to add the trivial tier, "review with a question" and the behaviour list (§4.2, §4.3) to
  `docs/delegation.md`.
