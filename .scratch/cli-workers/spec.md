# CLI-WORKERS: interactive CLI workers beside pi (0.1.1)

Owner decision (2026-11-13): roles may run on any interactive coding CLI herdr supports, not only pi. A role file
names the harness and the model; the owner registers roles freely and switches a role's harness or model by editing
its file. First kinds: `grok` (Grok Build), `agy` (Antigravity CLI), `claude` (Claude Code), `codex` (Codex CLI).
Interactive, held to the pi `imp` standard: own herdr tab, brief from the job dir, report.md, idle grace with
continuation, questions, stop, reap. `docs/spec.md` stays the boundary; this file only elaborates it.

## Rules every ticket keeps

- **The HUD never changes a harness's behaviour.** No home, session, config-dir, profile, worktree or settings flag
  or environment override is passed, and no CLI config, hook or trust list is edited. Each CLI keeps its sessions in
  its own default place; nothing is linked, moved or copied into the job dir, and nothing of theirs is ever deleted.
  `herdr agent start` runs the command through the owner's interactive shell, so the owner's shell functions (for
  example one that picks a Codex account) apply as usual. That is intended.
- **Never answer a directory-trust dialog with "trust".** If a CLI shows one, decline it so the CLI exits, and fail
  the launch with a reason telling the owner to open that CLI in the directory once and trust it (threat model:
  never run commands from an untrusted repository).
- Permission prompts are skipped with each CLI's own bypass flag, like pi imp, which never stops for approvals.
- pi and Jev jobs behave exactly as before.
- The pi run ledger is pi's: a CLI job's STATUS never carries `session_id` (pi-role-reap would record it). Use
  `agent_session_id` for the CLI's own session/conversation id.

## Role file shape (harness `cli`)

```json
{ "role": "grok-imp", "harness": "cli", "agent": "grok", "model": "grok-4.7", "thinking": "high",
  "can_continue": true, "idle_grace_s": 600, "args": [] }
```

`agent` ∈ grok | agy | claude | codex (herdr `--kind`). `model`/`thinking` optional (omitted: the CLI's own default;
`hud_create` may override both for one job). `idle_grace_s` default 600. `args`: extra CLI arguments appended
verbatim (the owner's own choice; never a shell string).

## Per-kind launch facts (probed 2026-11-13, herdr 0.9.5)

| | grok 1.0.77 | agy 1.5.4 | claude 2.1.322 | codex 0.167.0 |
|---|---|---|---|---|
| model / effort flags | `-m X --reasoning-effort Y` | `--model X --effort Y` | `--model X --effort Y` | `-m X -c model_reasoning_effort=Y` |
| bypass flag | `--permission-mode bypassPermissions` | `--dangerously-skip-permissions` | `--dangerously-skip-permissions` | `--dangerously-bypass-approvals-and-sandbox` |
| trust dialog | shown; herdr reports `idle` (not detected); text "Do you trust the contents of this directory?"; decline key `n` | shown; herdr `blocked`, `agent start` exits 1 `agent_not_ready`; text "Do you trust the contents of this project?"; decline = `down`,`enter` | shown; herdr `blocked`, `agent start` exits 1; text "Is this a project you created or one you trust?"; cursor rests on "No, exit": decline = `enter` | not shown with the bypass flag |
| startup quirk | none | reports `done` right after start, before any prompt | none | OSC-title spinner for 6–31 s at startup: phantom `working`→`done`; `agent start` needs `--timeout 90000` |
| exit | `/quit` or `/exit` | same | same | same |
| herdr `agent_session` (kind `id`) | after trust | after first prompt | at ready | after first prompt |

Common to all four: herdr's `pane.agent_status_changed` events go `working` → `done` per turn. The supervisor treats
`idle` or `unknown` as an exit only when the agent is gone (agy's idle can be herdr's fallback; a transcript viewer is
`unknown`). Exit still emits `idle`, then `pane.agent_detected` released and `unknown`. `herdr agent get`
has no PID: `herdr pane process-info --pane <pane>` → `foreground_processes[0].pid`; after exit the foreground is the
shell again. Events subscribe over `$HERDR_SOCKET_PATH`, method `events.subscribe`, subscription
`{"type":"pane.agent_status_changed","pane_id":…}`; `herdr agent wait <name> --until done --until blocked` is the
blocking CLI form. Do not use `revision` as a change counter (frozen for agy and claude); use `state_change_seq`.
Grok and agy may report done while background subagents still run.

## Lifecycle (mirrors pi-roles' dispatch extension)

STATUS.json in the job dir, written atomically by one supervisor process per job: `version: 1`, `task_dir` (real
path), `slot: "primary"`, `harness: "cli"`, `agent`, `role`, `model`, `thinking`, `state`, `output_path`,
`output_written`, `pid`, `pid_start_time` (field 22 of /proc/<pid>/stat, as pi-roles' processStartTime),
`agent_session_id`, `started_at`, `settled_at`, `idle_deadline_at`, `ended_at`, `exit_reason`, `error`,
`updated_at`. These keys let `pi-role-reap` stop and reap the job unchanged. `agent_session_id` is refreshed on
transitions (start, resume from blocked or grace, idle grace, close, fail). A later read does not wipe a known id;
agy and codex publish it only after the first prompt.

- `working` after the brief prompt is submitted.
- A `done` that follows our prompt: report.md changed and non-empty → `idle_grace` (deadline now + grace) when the
  role can continue, else close; report missing or unchanged → `failed` ("output missing, empty or unchanged"), quit.
- `idle_grace` → `working` again when herdr shows the agent working (a `hud_send` continuation); a new turn compares
  the report against its state at that turn's start.
- Grace ends unused → send `/quit`, wait for the agent to leave the pane, `closed` with `exit_reason: "settled"`.
  The job watcher's existing reap closes the tab.
- `blocked` during a turn (an approval or question UI) → the job shows as needing the owner, and the orchestrator
  pane gets one line naming the job and pane.
- Agent gone while not closing: `stopped` if `STATUS.json.stop-requested` exists (written by pi-role-reap), else
  `failed` ("agent exited").

Questions: a small `hud-ask` command the brief names by absolute path. It writes `qa/qN.md` in pi-roles' exact
format (`# Question qN from <role>@<cwd basename>`, question, `Options:` list, `Default if unanswered:`, `Context:`,
`Answer: write the answer to …`), pushes pi-roles' one-line `[tag] QUESTION qN: …` to the orchestrator pane with
`herdr agent prompt <ORCH>`, then blocks until `qa/qN.answer.md` (non-empty) or 20 min, printing the answer or
"No answer within …; proceed with your default".
