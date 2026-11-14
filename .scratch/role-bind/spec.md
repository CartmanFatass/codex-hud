# Roles apart from where they run (0.1.4)

Owner 2026-11-14. Elaborates docs/spec.md §2 (roles); the spec wins on any conflict.

## Why

A role file today fixes both the work (implementer, reviewer, sonic) and where it runs (pi, agy, grok, claude,
codex, a browser site, model, thinking). Running the implementer elsewhere needs a new role name (`agy-imp`,
`grok-imp`, ...); each browser site is its own role (oracle, argon, gemini, flow, flow-video); the control plane
lists 14 roles for a handful of kinds of work; CLI workers always get `implementer.md`; and switching where a role
runs means asking the main session to pass overrides on every dispatch.

## What changes

1. **A role is the work.** Role file: `role`, `instructions` (the pi-roles role for pi; `instructions/<name>.md` for
   a CLI), `can_continue`, `idle_grace_s`, and `run`: an ordered list of places, the first is the primary, the rest
   are fallbacks. A place is `{ harness, agent?, model?, thinking?, ... }`; pi places keep today's pi fields (pi_role,
   split, launch switches). Today's role files keep loading (their single place becomes `run[0]`).
2. **Harnesses:** `pi`, `cli` (agent `agy`, `grok`, `claude`, `codex`) and `bro` (browser tasks; renamed from
   `jev` so it is not confused with Jev, the decision model). The browser tools keep their own names (`jev-ask`,
   `jev-aistudio`, `jev-flow`).
3. **Browser work is two roles, not one per site** (amended 2026-11-14 by ticket 05: the browser roles are `pro` and `flow`; `oracle` is a local read-only advisor on `cli` `claude` `fable` → `pi` `architect` with `oracle.md`): `pro` asks a strong web model (places: ChatGPT Pro, Gemini,
   AI Studio Argon); `flow` generates in Google Flow, and the job says image or video (`kind`, default image).
4. **The MCP shows logical roles.** `hud_roster` lists each role with its current place, its fallbacks and the
   harnesses it can run on. `hud_create(role, task, ...)` runs on the role's setting: its first available place as set on the control plane. Per-job overrides stay
   for flexibility: `on` (a harness, with its default model from a shipped table, overridable in
   `$HUD_HOME/harnesses.json`), `model`, `thinking` and today's pi switches.
5. **Fallback.** A place is unavailable when its harness or tool is missing, or it is marked exhausted. A job that
   fails on a quota or rate limit (pi, CLI or browser error text) marks its place exhausted for one hour and its
   failure reason names the place the next dispatch will use; the HUD does not retry the job itself (the main session
   re-dispatches). The owner can clear the mark on the control plane.
6. **A role runs on a CLI only if it has CLI instructions.** Shipped: `implementer.md` and a new read-only
   `reviewer.md`. Otherwise `unsupported_harness` naming the missing file.
7. **The control plane page switches places.** Rows grouped: roles (place, fallbacks, exhausted marks), browser
   tasks (pro and flow), harness availability. On a role the owner cycles the primary place's harness, model and
   thinking from the catalog, adds/removes/reorders fallbacks, clears an exhausted mark; the change is written to
   `$HUD_HOME/roles/<role>.json` (atomic) and the next dispatch uses it. Enter/`o` still opens the source file.
8. **Deleted (owner approved 2026-11-14):** role names `grok-imp`, `agy-imp`, `claude-imp`, `codex-imp` (use `imp`
   with a place or `on`); `argon`, `gemini` (now oracle places) and `flow-video` (now `flow` with `kind: video`).
   Docs, hud-delegate skill and release notes follow.
9. `hud setup` unchanged: show/hide by role name; pi role tuning as today.

## Out of scope

Per-project places, CLI instructions for sonic or architect, automatic retry, changes to how a job runs once started.

## Tickets

01 roles, places, fallback, `bro`, merged browser roles, deletions, docs/skill (agy-imp) · 02 place catalog and the
write API the panel uses (agy-imp) · 03 control plane page that switches places (frontend-implementer).
