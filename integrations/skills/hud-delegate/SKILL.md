---
name: hud-delegate
description: Choose a fixed HUD role and hand work off one step at a time. The main session owns every handoff. Use when delegating design, implementation, review, a small task, or browser work.
---

# Delegate through HUD

The main session chooses the role, hands off the brief and the artifacts, reads the result, and decides what happens next. HUD does not start the next role when a job finishes. A review verdict is information for you, not permission to continue.

Read the bindings with `hud roster show`. That uses the calling Codex, Claude, or Pi session when its identity is available. Otherwise the report says `source: default (no session identity)` and no preset is selected. `hud roster use` needs that identity or an explicit root, and it never writes a default. The owner keeps the binding file. Do not invent a backend.

## Roles

- `oracle` proposes a design, or converges proposals into a decision. Request one phase at a time: `oracle.propose`, then `oracle.converge`. One request creates one job.
- `imp` implements a defined change against a brief and completion criteria.
- `reviewer` independently assesses a specified change and reports findings. You decide whether to accept the change or request repairs.
- `sonic` does bounded work: exploration, search, tests, and small patches.
- `jev` does browser work and page judgments, including a question to a web oracle.

## Recipes

- Design. Request a proposal, then convergence, when both are needed. Skip the proposal when a concrete proposal already exists.
- Build. Request implementation, then any required checks. Use sonic for those checks when the evidence is not already in hand. Then request review. You accept the change or send the findings back for repair.
- Small task. Request sonic, then evaluate the result.
- Browser task. Request jev, then use the result.

For a repair, send the findings to the existing implementer when that backend can continue, then request another review. A fresh reviewer conversation is the default. The owned Pi lifetime has the additional grace restriction described below.

The main session owns every handoff. HUD does not chain these steps.

## Jobs

Give every job a clear brief, the relevant artifacts, the working location, and the completion criteria. Use the backend and the capabilities `hud roster show` reports.

### Wait

Arm the returned wait mechanism, and read results when notified. For herdr jobs, hud_create returns `wait.command` and `wait.argv`: the absolute path of the running package's `bin/hud`, not a bare `hud` that may be off PATH, with an explicit 3600000 ms bound. If no bin resolves, the command keeps `hud` and adds `wait_path: unresolved`. Background that command in the main session and let its completion reach you. Jev jobs instead return a hud_read mechanism: use that returned mechanism, not `hud wait`, and its behavior is unchanged. For owned Pi jobs, the caller-armed wait is the only wake channel, and it settles on STATUS idle_grace, `closed` or `failed`. DONE means settled, not accepted: read the report yourself. A timeout is not a failure: the command exits 6 with `event: TIMEOUT` and the current observation, so re-arm the same command. Re-arm the returned mechanism after you answer a question, send a fix, or the wait times out.

### Questions

Use the job's question channel. For Pi jobs, answer identified questions with hud_respond and the request id; it writes `qN.answer.md` in the job's `qa` directory. The file protocol has no consumption receipt, so `consumed` stays false. Owned Pi uses its bounded QA timeout, default 1200 seconds, rather than waiting indefinitely. Handle external human requests, including login and permission screens, at their indicated location.

### Helpers

An owned Pi implementer starts its own sonic and reviewer through internal helper tools. When the job's `helpers` show those slots, do not launch duplicate sonic or reviewer jobs; read the helper evidence and the report.

### Repairs

Use hud_send with a stable message_key when the backend supports continuation. Codex, Claude and Grok jobs keep their existing open-job follow-up behavior; they do not require Pi STATUS. For owned Pi, send a fix to the same implementer only during idle_grace: that is Pi's model-declared prompt-cache TTL, not a fixed HUD timer. A send proves forwarding, not a new round, so keep the previous settled result until STATUS shows a new settlement. If the grace expired or the primary closed or failed, the continuation is unavailable: create a new job.

### Close

hud_close asks the owning backend to clean up. For owned Pi this uses the job-pinned HUD release to clean its owned agents and tab; other herdr and Jev jobs retain their own cleanup paths. Historical external/direct Pi jobs are read-only here: return cleanup to their owning release, never a PATH launcher or saved external reaper. This is explicit cleanup, not acceptance, and a repeated close is idempotent. Close when the resources are no longer needed; a settled job may still hold its tab.

Keep request keys stable; never blindly re-create an uncertain launch.

A preset change affects future jobs only. Use another backend only under the owner's routing instructions. If work has already happened, keep that handoff explicit.

Dispatch with the existing herdr / jev recipes using the resolved binding. This skill does not launch, wait, or retry on its own.
