# 06: Main composes and runs its own workflows with check and hand-back steps

**Status:** done
**Owner try:** no
**Live try:** Ask main to compose a small workflow (build -> check -> review -> hand-back -> land) on a scratch ticket: hud_workflow plan shows the frozen plan and cost class, start runs it, the hand-back appears as one wake line and answering it picks the branch; a costly plan is refused without a fresh owner grant.
**Blocked by:** none

**What to build:** `.scratch/workflow/spec.md` slice 6. Add `check` (argv or a named project command, no shell interpolation, cwd from a job step, exit code decides, optional repair to the source worker ≤ 2) and `handback` (pause with `{request_id, step, ask, choices, refs}`, one wake line, answered with `hud_respond({job: <run>, request_id, answer})`, written once, `when` edges select the branch). New `hud_workflow` MCP tool: plan (validate, scale, cost class, frozen hash; launches nothing) / start (main confirmation; costly runs need a fresh owner grant bound to the proposed run, the unbound `/council` grant covers only a standalone council) / status / control (pause, resume, stop, retry_failed). Templates from `$HUD_HOME/workflows/` and registered projects' `.hud/workflows/` (shipped names reserved). Cost: council, `pro`/`flow`, any `bro` place incl. fallbacks, large fan-out (Sonic > 50 items or > 2 MiB, other roles > 12). Update docs/reference.md and ARCHITECTURE.

- [x] The build → check → review → hand-back → land recipe runs end to end (synthetic repo) in TOML and JSON forms.
- [x] Validation refusals (cycle, non-ancestor ref, unknown role, shell placeholder) and grant refusals (costly without grant, grant for another run, split-batch bypass) are tested.
- [x] Reference docs list the tool and template locations.
- [x] Land gate passes.

## Comments

- 2026-11-25 main: deferred by the owner (D-2026-11-25-08): complex workflows wait until one is designed on the engine. Not ready for agents.

- Landed in this commit (replay base 4533da53853ab3893961a089c6ab6b5a9377ba44); gate 5/5 passed.
