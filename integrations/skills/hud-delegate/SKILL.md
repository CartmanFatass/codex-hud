---
name: hud-delegate
description: Hand work to a local HUD role in its own herdr tab - imp (implementer), reviewer, sonic (small chores), and any other role hud_roster lists. Use whenever the user delegates in plain words ("交给 imp", "让 implementer 做", "派个 sonic", "让 sonic 查一下", "review 一下", "起个 reviewer", "问 oracle", "delegate this", "dispatch a sonic") or a project's docs route work to a role. The main session writes the brief, dispatches with hud_create, waits for the job to settle, reads the report and decides the next step.
---

# Delegate through HUD

The user names a role and a task in plain words; you do the rest. Never ask them to name a tool.

1. Call `hud_roster` with the job's `cwd`, and call it again whenever the project changes; it returns the roles and convention in effect, which the main session follows (resolution order for `hud-convention.md`: a registered project's `.hud/hud-convention.md`, then `<cwd>/hud-convention.md`, then `$HUD_HOME/hud-convention.md`, then the shipped default; first file wins whole, text truncated at 20,000 characters).
2. Write the brief: the goal, scope and out of scope, completion criteria, a size budget and a stop rule. For a small
   ask the user's own sentence plus those limits is enough. Do not name a report file; HUD adds it.
3. `hud_create` with `role`, a short `request_key` (`request_key` is global across projects, so include the project and task slug, plus a ticket id when there is one, and keep it stable on retry), the brief as `task`, and `cwd`; optional `on` selects a harness/provider override for this job (defaults from `harnesses.json`; explicit `model`/`thinking` win), optional `model`/`thinking` apply to `pi` and `cli` places, and optional `kind` (`image` default, or `video`) applies to `flow`. Optional `idle_grace_s` (integer 60–3600) overrides CLI grace for this job; pi/browser overrides refuse (pi grace follows model cache lifetime inside pi-roles). Pi-only launch switches: boolean `lens`, `mcp`, `tps`, `ui_ext` (false disables UI extensions; true keeps defaults), `skills` (true includes personal skills; false keeps them excluded), `split` (reserve a right helper pane; defaults to the place). Omitted switches keep pi-role defaults. `pi_args` appends up to 128 strings (4096 characters each) verbatim after pi-role's `--`, without a shell. `hud_roster` lists `run`, `runs_on`, `exhausted` and `accepts_options`; `hud_read` shows the recorded launch options. A retry returns the original job unchanged even if options differ; use a new key for a different launch.
4. Tell the user in one line: role, job id. The worker runs in its own tab.
5. Claude Code: run `hud watch` under Monitor and re-arm after expiry. Codex: events are queued automatically;
   no Monitor command is needed, and drafts stay untouched (missing thread id or queue failure falls back to typing).
   Both catch up pending work and deliver full questions, settlements/unread reports, new blocks and quiet-worker
   reasons—not working starts/resumes, answered questions or already-reported closure. `--verbose` and MCP
   `changes` retain the fuller stream. Other main sessions receive typed questions and wait with `hud_read` and
   `wait_ms`. A live pane-scoped watch suppresses direct questions. Answer within 20 minutes using the line's
   `hud_respond` reply.
6. Read the report file through `hud_read`, check it (for code: the diff and named checks), then decide: accept,
   repair, review or stop. Lists include `open_questions` and `report_unread`; a `report` token means unread.
   A job read omits an already-read report (`report_unchanged: true`; use `full: true` to reread); idle-grace reads
   mark reports read too. Workers finish chat with only `report written: <path>`. Settled means finished, not accepted.

The main session chooses the role, hands off the brief and the artifacts, reads the result, and decides what happens next. HUD does not start the next role when a job finishes. A review verdict is information for you, not permission to continue.

Dispatch requires a herdr pane.

## Roles

The shipped defaults; `hud_roster` lists what is actually defined (files in `$HUD_HOME/roles/` add or override).

- `imp` implements a defined change against a brief and completion criteria (shipped places: `pi` implementer, then `pi` Grok 4.7; the owner may add fallbacks or switch it in the Control plane, so trust `hud_roster`'s `runs_on`).
- `reviewer` independently assesses a specified change and reports findings (shipped places: `pi` reviewer, then `agy` Hydrogen high; same as `imp` for switching). You decide whether to accept the change or request repairs.
- `sonic` does small, fully specified chores: lookups and small patches, never test authoring, bug diagnosis, measurement or design (`pi` only; no CLI instructions file).
- `oracle` is a local read-only advisor (`cli` `claude` `fable` high, fallback `pi` `architect`) for design questions grounded in repo facts. It carries both former architect/oracle setups as the `architect` and `fable` presets; there is no separate `architect` HUD role.
- `hud_roster` includes merged `presets` (names and runs) and `preset` (matching name or null). The owner applies presets with `c`/`C` on the Control plane; `hud_create` has no preset parameter.
- `pro` asks a strong web model (ordered `bro` places: ChatGPT Pro via `jev-ask`, Gemini web via `jev-ask`, AI Studio Argon via `jev-aistudio`).
- `flow` generates media in Google Flow through `jev-flow`; pass `kind: "image"` (default) or `kind: "video"` (state `cost: N credits` in the brief for video).
- Roles may configure ordered `run` places across `pi`, `cli` (`grok`, `agy`, `claude`, `codex`) and `bro` (`jev-ask`, `jev-aistudio`, `jev-flow`) in `$HUD_HOME/roles/*.json`. A CLI place runs only if `instructions/<instructions>.md` exists (`implementer.md`, `reviewer.md`, `oracle.md`); otherwise `hud_create` returns `unsupported_harness`.

## Details

### Questions

Watch question lines carry the first 2 KiB's question, options, default and full-text path; no extra read is needed.
`hud_read` also lists unanswered `qa/qN.md` questions by id with the first 2 KiB. Answer with `hud_respond` using `job`, `request_id` and `answer`; it writes `qa/qN.answer.md` only once and never overwrites an existing answer.

### Helpers

An implementer may use pi-roles' helpers when the brief asks; they open in a pane beside it only when called. Do not duplicate helper work; read the report. Sonic handles only fully specified chores, never tests, diagnosis, measurement or design. The main session owns every next step.

### Repairs

Use `hud_send` with `job`, a stable `message_key` and `text` to add to a pi or CLI job: while it works (STATUS `working`, `waiting_helper`, `waiting_orchestrator`) the message is queued and the worker reads it after its current step (`queued: true`); while it is in `idle_grace` it continues a role that can continue, including a CLI role that can continue. Duplicate message keys are not sent again. A finished job returns `not_continuable`: create a new job. CLI workers ask through the same `QUESTION` / `hud_respond` flow.

Keep request keys stable; never blindly re-create an uncertain launch.

HUD uses the locally installed pi-roles, browser CLIs (`bro`) and interactive CLIs; it does not chain or choose another backend automatically on failure. When a job fails with a quota or rate limit error, HUD marks that place exhausted for one hour (`$HUD_HOME/exhausted.json`) so the next `hud_create` uses the next available place, and names it in `exit_reason`. Browser (`bro`) roles cannot continue with `hud_send`.
