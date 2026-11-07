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

For a repair, send the findings to the existing implementer when that backend can continue, then request another review. A fresh reviewer conversation is the default.

The main session owns every handoff. HUD does not chain these steps.

## Jobs

Give every job a clear brief, the relevant artifacts, the working location, and the completion criteria. Use the backend and the capabilities `hud roster show` reports.

Arm the returned wait mechanism, and read results when notified. Answer identified questions through the job's question channel. Handle external human requests, including login and permission screens, at their indicated location.

Keep request keys stable; never blindly re-create an uncertain launch. Close a job when its resources are no longer needed.

A preset change affects future jobs only. Use another backend only under the owner's routing instructions. If work has already happened, keep that handoff explicit.

Dispatch with the existing herdr / jev recipes using the resolved binding. This skill does not launch, wait, or retry on its own.
