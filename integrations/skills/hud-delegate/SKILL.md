---
name: hud-delegate
description: Hand work to a local HUD role - imp (implementer), reviewer, sonic (small chores), and any other role hud_roster lists. Use whenever the user delegates in plain words ("交给 imp", "让 implementer 做", "派个 sonic", "让 sonic 查一下", "review 一下", "起个 reviewer", "问 oracle", "delegate this", "dispatch a sonic") or a project's docs route work to a role. The main session writes the brief, dispatches with hud_create, reads the report when ready, and decides the next step.
---

# Delegate through HUD

The user names a role and a task in plain words; you do the rest. Never ask them to name a tool.

1. Use `hud_roster` with the job's `cwd` on first use or when project dispatch context is stale. It returns availability, effective assignments, continuation and the applicable convention. Later calls omit the text if unchanged. If you still have valid context, go straight to `hud_create`.
2. Write the task as the convention says. HUD adds a registered project's `.hud/brief.md` if present and supplies the worker interface; do not copy the standing brief or add report paths or worker protocol commands.
3. `hud_create` with `role`, the brief as `task`, and `cwd`. The HUD derives a key so an identical call returns the same job. Pass an explicit `request_key` only when you intend to launch a duplicate. Each role runs where its role file says; `general` also takes `preset`, `on`, `model` or `thinking` for one job when the user names a model. For advanced options use the tool schema and `hud_roster({cwd, detail:true})`.
   For ticketed work, use `hud_tickets({op: "ready"})`, then pass the chosen `ticket` and its `path` as `brief_file` instead of `task`. The live job is the claim; leave `ready-for-agent` in the file until `hud_land` records `ready-for-human`. No claim commit.
   Pass `checks` for the commands you would otherwise rerun yourself after the worker finishes.
   Pass `scout: "<question>"` to run `sonic` first in the target `cwd` (with `context_files`) and attach its dossier via `from_jobs` before starting the target; one notice or MCP task covers both, and a failed scout leaves a note instead. Scout is for where/what/how-many questions; why/which/is-it-wrong questions (root cause, design, review) stay with the deciding model. Any `sonic` report passed through `from_jobs` is prefixed with a one-line unverified-facts reminder in the brief's language.
4. Tell the user in one line: role, job id. Do not promise a tab: sonic runs headless, and Imp routing can choose headless on a supported continuable place when `mode` is omitted.
5. Follow the delivery `hint` in `hud_roster` or the session's first `hud_create` result. With MCP tasks or other live delivery,
   keep working until notified; do not poll or foreground-wait. Use `hud_read` for jobs without a task in a task session.
   If neither task nor live delivery is available, use `hud_wait` (`mode: "any"` or `"all"`).
   Answer questions within 20 minutes using the line's `hud_respond` reply.
   To inspect without collecting, use `hud_peek` for status and milestones; request `lines` only when you need pane output.
6. A report-ready notice leaves the report unread. Collect it with `hud_read({job})`, not by opening the report file.
   For the whole report or to reread, use `hud_read({job, mode: "full"})`. Check it (for code: the diff and named checks),
   then decide: accept, repair, review or stop. `hud_read({})` lists active project jobs and the caller's unread settled
   reports, folding older unread reports into a count. Worker-started children count on their parent; `view: "recent"`
   (without `job`) includes them in the newest 20 full rows. A `report` token in `changes` means unread.
   HUD closes pi and CLI workers with a valid report declaration at turn end, whether or not the report has been read. Open questions and open or uncollected sonic children hold closure.
   Workers publish with `hud_report` (or the provided fallback); no final chat marker is needed. Settled means finished, not accepted.
   To integrate a settled `isolation: "worktree"` job, call `hud_land({ job })` (configured by the project's `.hud/project.json` `land` block): HUD runs the gate, up to two source-worker repairs, the ticket record folded into the landed commit, fast-forward, `after`, optional push and worktree cleanup, and delivers one notice or MCP task. Use `hud_read({ job: "<flow>" })` to check flow state and current step.

The main session chooses the role, hands off the brief and the artifacts, reads the result, and decides what happens next. HUD does not start the next role on its own; requested fixed flows (`scout`, `hud_land`) chain only their own steps. A review verdict is information for you, not permission to continue.

Dispatch requires a herdr pane.

## Roles

The shipped defaults; `hud_roster` lists what is actually defined (files in `$HUD_HOME/roles/` add or override).

- `imp` implements a defined change against a brief and completion criteria (shipped place: `pi` implementer; the owner may add fallbacks or switch it in the Control plane, so trust `hud_roster`'s `runs_on`).
- `reviewer` independently assesses a specified change and reports findings (same as `imp` for switching). You decide whether to accept the change or request repairs.
- `sonic` does small, fully specified chores and `scout` dossiers: where/what/how-many lookups across several files, small patches and doc edits, running an exact command and returning its output; never test authoring, bug diagnosis, judging measurements, design or review — why/which/is-it-wrong questions stay with the deciding model (`pi` only; no CLI instructions file).
- `oracle` is the strongest-model seat: read-only, high-level judgement of any kind the brief sets (design, root cause, verifying a report, a review verdict, synthesis). When a job needs a method skill, name its `SKILL.md` path in the brief. `hud_create` accepts `architect` as another name for `oracle` (unless a role file defines its own `architect`).
- `hud_roster({detail:true})` includes merged `presets` (names and runs), current `preset`, fallbacks, sources and accepted options. For a `general` job where the user named a model, use a name from `presets` or select `on`, never both. `hud_peek({job, detail:true})` inspects launch diagnostics without collecting the report; `hud_read({job, detail:true})` includes them when collecting.
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

Use `hud_send` with `job` and `text` to add to a pi or CLI job. While the worker is working, the message is queued (`queued: true`). After report closure, HUD resumes the native session if available within `resume_s`; otherwise it starts a repair referencing the earlier brief and report, with the new job ID in `continued_as`. Use `jobs` instead of `job` to send to several working jobs at once without creating repairs. Pass `message_key` only for an intentional duplicate.

Use `hud_create({retry_of: job})` to run a failed or stopped job's brief again on an available place. The original options carry over unless overridden. Never blindly re-create an uncertain launch. The HUD falls through to another available place only on a confirmed pre-input launch failure; it does not chain jobs.
