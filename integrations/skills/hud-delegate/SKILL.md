---
name: hud-delegate
description: Hand work to a local HUD role in its own herdr tab - imp (implementer), reviewer, sonic (small chores), and any other role hud_roster lists. Use whenever the user delegates in plain words ("交给 imp", "让 implementer 做", "派个 sonic", "让 sonic 查一下", "review 一下", "起个 reviewer", "问 oracle", "delegate this", "dispatch a sonic") or a project's docs route work to a role. The main session writes the brief, dispatches with hud_create, reads the report when ready, and decides the next step.
---

# Delegate through HUD

The user names a role and a task in plain words; you do the rest. Never ask them to name a tool.

1. Use `hud_roster` with the job's `cwd` on first use or when project dispatch context is stale. It returns availability, effective assignments, continuation and the applicable convention. If you still have valid context, go straight to `hud_create`. If refreshing the roster and you still have its convention text, pass its `convention_version`; a matching version omits only that text, not availability.
2. Write the brief as the convention says. Do not add report paths or worker protocol commands; HUD supplies the worker interface.
3. `hud_create` with `role`, the brief as `task`, and `cwd`. The HUD derives a key so an identical call returns the same job. Pass an explicit `request_key` only when you intend to launch a duplicate. Do not pass `preset`, `on`, `model` or `thinking` unless the user asks for the override in this request. For advanced options use the tool schema and `hud_roster({cwd, detail:true})`.
4. Tell the user in one line: role, job id. The worker runs in its own tab.
5. Claude Code: run `hud watch` under Monitor and re-arm after expiry. Codex: events are queued automatically;
   no Monitor command is needed, and drafts stay untouched (missing thread id or queue failure falls back to typing).
   pi: keep working; native HUD notices wake an idle session or arrive before the next model request after the
   current tool batch, without touching the draft. No Monitor or foreground wait is needed in pi.
   These watches catch up pending work and deliver full questions, settlements/unread reports, new blocks and quiet-worker
   reasons—not working starts/resumes, answered questions or already-reported closure. `--verbose` and MCP
   `changes` retain the fuller stream. With a live watch, queue or pi's native notices, keep working until notified;
   do not poll or foreground-wait. Without one, use `hud_wait` (`mode: "any"` or `"all"`) and answer typed questions
   within 20 minutes using the line's `hud_respond` reply. A live pane-scoped watch suppresses direct pushes.
   To inspect without collecting, use `hud_peek` for status and milestones; request `lines` only when you need pane output.
6. A report-ready notice leaves the report unread. Collect it explicitly with `hud_read({job})`, check it (for code: the diff and named checks), then decide: accept,
   repair, review or stop. `hud_read({})` lists running jobs and pending attention, with question IDs and unread
   report flags when applicable; use `view: "recent"` (without `job`) for the newest 20 full rows. A `report` token
   in `changes` means unread. A job read omits an already-read report (`report_unchanged: true`; use `full: true`
   to reread). Reading a settled pi or CLI report closes the worker; an unread report keeps its idle deadline.
   Workers publish with `hud_report` (or the provided fallback); no final chat marker is needed. Settled means finished, not accepted.

The main session chooses the role, hands off the brief and the artifacts, reads the result, and decides what happens next. HUD does not start the next role when a job finishes. A review verdict is information for you, not permission to continue.

Dispatch requires a herdr pane.

## Roles

The shipped defaults; `hud_roster` lists what is actually defined (files in `$HUD_HOME/roles/` add or override).

- `imp` implements a defined change against a brief and completion criteria (shipped place: `pi` implementer; the owner may add fallbacks or switch it in the Control plane, so trust `hud_roster`'s `runs_on`).
- `reviewer` independently assesses a specified change and reports findings (shipped places: `pi` reviewer, then `agy` Hydrogen high; same as `imp` for switching). You decide whether to accept the change or request repairs.
- `sonic` does small, fully specified chores: lookups across several files, small patches and doc edits, running an exact command and returning its output; never test authoring, bug diagnosis, judging measurements or design (`pi` only; no CLI instructions file).
- `oracle` is the strongest-model seat (`cli` `claude` `fable` high, fallback `pi` `architect`): read-only, high-level judgement of any kind the brief sets (design, root cause, verifying a report, a review verdict, synthesis). When a job needs a method skill, name its `SKILL.md` path in the brief. It carries both former architect/oracle setups as the `architect` and `fable` presets; `hud_create` accepts `architect` as another name for `oracle` (unless a role file defines its own `architect`).
- `hud_roster({detail:true})` includes merged `presets` (names and runs), current `preset`, fallbacks, sources and accepted options. For a requested one-job override, use a name from `presets` or select `on`, never both. `hud_peek({job, detail:true})` inspects launch diagnostics without read-close; `hud_read({job, detail:true})` includes them when collecting.
- `pro` asks a strong web model (ordered `bro` places: ChatGPT Pro via `jev-ask`, Gemini web via `jev-ask`, AI Studio Argon via `jev-aistudio`). For research, the brief asks for primary sources (official docs, source code, specs) with each claim cited. Pass paths, not bodies: use `hud_create`'s `context_files` for local files and `from_jobs` for report IDs; HUD inlines bounded content for browser roles and lists references for local workers. For a code job that should not share the checkout, pass `isolation: "worktree"`; `hud_read(job)` then shows `git_summary`, and a clean or merged checkout is removed after the job closes.
- `flow` generates media in Google Flow through `jev-flow`; pass `kind: "image"` (default) or `kind: "video"` (state `cost: N credits` in the brief for video).
- Roles may configure ordered `run` places across `pi`, `cli` (`grok`, `agy`, `claude`, `codex`) and `bro` (`jev-ask`, `jev-aistudio`, `jev-flow`) in `$HUD_HOME/roles/*.json`. A CLI place runs only if `instructions/<instructions>.md` exists (`implementer.md`, `reviewer.md`, `oracle.md`); otherwise `hud_create` returns `unsupported_harness`.

## Details

### Questions

Watch question lines carry the first 2 KiB's question, options, default and full-text path; no extra read is needed.
`hud_read` with a `job` returns unanswered `qa/qN.md` questions by ID with the first 2 KiB; the compact list shows only the IDs. Answer with `hud_respond` using `job`, `request_id` and `answer`; it writes `qa/qN.answer.md` only once and never overwrites an existing answer.

### Helpers

Any non-sonic worker may use `hud_sonic` to start a fully specified sub-task and collect its report separately; the brief need not ask. The main session owns every next step.

### Repairs

Use `hud_send` with `job` and `text` to add to a pi or CLI job. While the worker is working, it reads the queued message after its current step (`queued: true`). During idle grace it can continue if the role allows and the report is still unread. If the worker closed because its report was read, the same call starts a repair, references the earlier brief and report, and returns the new job as `continued_as`. Use `jobs` instead of `job` to send to several working jobs at once without creating repairs. Pass `message_key` only for an intentional duplicate.

Use `hud_create({retry_of: job})` to run a failed or stopped job's brief again on an available place. The original options carry over unless overridden. Never blindly re-create an uncertain launch. The HUD falls through to another available place only on a confirmed pre-input launch failure; it does not chain jobs.
