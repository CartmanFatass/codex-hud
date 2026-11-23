# 01: general borrows any role's instructions for one job

**Status:** done
**Owner try:** no
**Blocked by:** none

**What to build:** Spec §2.1.2/§2.1.4 (D-2026-11-22-29). `hud_create` gains `instructions: "<role>"`, accepted only for `general` (other roles reject it like placement options). The job keeps general's place resolution (preset/on/model/thinking, or general's run chain) and general's concurrency slot, but launches with the named role's instructions: on pi, that role's place pi_role (from its active run's first pi place, else its `instructions` name) and `--hud-instructions <role instructions>.md`; on CLI harnesses (agy, claude, codex), the bundled `<instructions>.md` of that role. Unknown or hidden role → invalid_arguments naming valid roles. Record `instructions_from` on the job and show it in hud_read. Retry and headless resume keep it. Keep the tool schema addition small (one short property line).

- [x] general + instructions:imp on pi launches with pi_role implementer and implementer.md; on agy/claude CLI with implementer.md (fake-bin tests)
- [x] non-general roles reject `instructions`; an unknown role is refused with the valid list
- [x] retry_of and headless resume keep the borrowed instructions; job record and hud_read show instructions_from
- [x] tool schema grows by at most ~80 bytes; docs/reference.md documents it

## Comments

- Landed in this commit (replay base b588894e610d63f937565bdb8ca56feda4977df1); gate 5/5 passed.
