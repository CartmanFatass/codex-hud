---
name: hud-delegate
description: Delegate a scoped task to a child harness through hud-mcp's delegate_* tools instead of hand-written Herdr or pi-role recipes. Covers choosing a profile from delegate.json, spawning with a stable request_key, waiting per parent harness (Claude background waiter, Codex idle turn, pi hud-wake extension), cursor rules, capacity refusals, blocked reports, cancel and resume, and when to hand off instead of waiting. Use when the current task routes work to an implementer or reviewer child, or when a delegation is running and needs waiting, reading or intervention.
---

# Delegating through hud-mcp

The parent session stays the orchestrator: it scopes the task, writes the brief, spawns, waits, reads the report and
verifies it. The child never talks to the user. One delegation is one `delegate_spawn` plus reads of the ledger.

## 1. When to delegate, and to which profile

- Delegate work that is scoped, self-contained and verifiable by a command. Keep architecture, contract and
  cross-cutting decisions in the parent.
- The project's delegation doc decides which kind of work goes to which profile; this skill has no routing table.
- A profile is a `name` in `<HUD_HOME>/delegate.json` and is passed as `backend`. Read that file for what exists.
- Pass `role`; the profile's `roles` map resolves model and effort only. It loads no template (§2). Pass
  `model`/`effort` only when the user or the brief names them.
- One child per brief. A second opinion is a second delegation with its own brief and request key.

## 2. Spawn

- `delegate_spawn{backend, role, brief, cwd, mode, request_key}`. `brief` is a file path; the child reads it first.
- `role` selects model and effort from the profile's `roles` map. No role loader exists: the child receives the
  brief plus generic whoami/report instructions, and nothing else.
- So the brief must carry the role. Copy `roles/implementer.md` or `roles/reviewer.md` verbatim at the top, or tell
  the child to read it by repo path (`<repo>/integrations/skills/hud-delegate/roles/<role>.md`).
- The brief also names the absolute report path and the fallback question channel (the orchestrator's pane); the
  child cannot discover either.

```json
{
  "tool": "delegate_spawn",
  "arguments": {
    "backend": "codex-implementer",
    "role": "implementer",
    "brief": "<repo>/tmp/tasks/<WP>/brief.md",
    "cwd": "<repo>",
    "mode": "headless",
    "request_key": "<task>-impl-1"
  }
}
```

- The brief header, in this order:

```
<contents of roles/implementer.md, verbatim>
# Task
<what to deliver and the acceptance command>
# Report
<absolute report path>
# Fallback question channel
herdr agent prompt <orchestrator pane> "[<name>] QUESTION: <question>"
```

- `mode` is `headless` in this build. Visible launch is not available in this build; use headless, and do not branch
  on a code for it. Do not pass `layout`: it is refused with `visible_layout_not_in_this_build`.
- `request_key` is stable for the intent: derive it once (for example `<task>-impl-1`) and reuse the same string.
- After an uncertain result (transport error, timeout, `busy`) retry with the same key: the replay returns the
  original run instead of starting a second child.
- Never mint a new key for the same intent. A genuinely new intent gets a new key.
- Keep `name` short and stable; it is the label the user sees in the HUD.
- Read the response: `runId`, `linkId`, `advice.wake`. On a refusal read the code first (`backend_not_found`,
  `capability_unverified`, `concurrency_limit`, `slot_busy`, `busy`, …) and report it instead of retrying blindly.

## 3. Waiting, per parent harness

- Read `advice.wake` from the `delegate_spawn` result (or from `delegate_status`) before choosing a path.
- `adapter` is `claude_background_wait_v1`, `codex_queue_v1`, `pi_extension_v1` or `none`.
- `state` is `registered`, `unconfirmed`, `degraded` or `none`. Only `registered` means a working registration.
- Rely on a native wake only when `adapter` is not `none` and `state` is `registered`.
- `unconfirmed`: a delivery result is unknown, so a wake may or may not have arrived. Re-read status; do not count on
  the wake.
- `degraded` or `none`: no wake will arrive. Use a bounded wait and say in your report that delivery is unavailable.
- Claude parent: `advice.wake.armCommand` is the waiter. Run it exactly as returned, verbatim, in a real background
  task (`run_in_background`), one waiter per wait. It is present only for a valid registration.
- Do not edit that command: it already carries this run's `--after-seq`, `--owner-generation` and `--notify`.
- Claude parent without `armCommand`: run `hud run wait <runId> --after-seq <n> --timeout-ms <ms> --json` in a
  background task. It is a bounded read, needs no `--owner-generation` and no `--notify`, and prints one page.
- Codex parent: end the turn and idle. The queue wakes you with a new turn; no `sleep` loop and no polling tool call.
- pi parent: the `hud-wake` extension wakes you; do nothing extra.
- Any harness may use a bounded `delegate_wait{runId, afterSeq, timeoutMs}` when it needs the result in this turn.
- A wait may return early with `timedOut:true` and `reason:'timeout_configuration_unverified'`; that is a short page,
  not a failure.
- Never chain waits faster than you need the result. A wait loop is not a cache warmer (§5.3).

## 4. Cursor rules

- Keep one `lastSeenSeq` per run in your own context; it starts at 0.
- After every `delegate_wait` set it to the returned `nextSeq`; after `delegate_status` set it to `asOfSeq`.
- Drain `hasMore` with the returned `runId` and `nextSeq` until `hasMore` is false.
- A lost cursor after compaction or restart: call `delegate_status{runId}` and resume from `asOfSeq`.
- A wake is a hint, not a fact. Re-check ownership with `delegate_status` before acting on it.
- Ignore waiter lines from a stale generation (`orphaned`, `stale_generation`); they belong to an older context.
- A duplicate wake costs one empty page and nothing more: reading is idempotent, so read.

## 5. Capacity

- Defaults: 6 active runs per ledger and 4 per owner, set in `delegate.json` `limits`; headless and visible runs count
  alike.
- `concurrency_limit` is a transient refusal: `{active, limit, occupants, retryAdvisable}`.
- `retryAdvisable:true`: wait for a slot (a wake or a later turn), then retry with the same `request_key`.
- `retryAdvisable:false`: nested exhaustion or `uncertain` occupants. Wait on, cancel or inline your own children;
  reconcile `uncertain` runs. Never loop-retry.
- A visible run is closed by the user: ask the user to close a finished pane. Never close it yourself.
- A headless run that already reported keeps its slot until retirement: implementer 10 min, reviewer 2 min after the
  report, blocked-wait 60 min, max runtime 4 h, grace 10 s.

## 6. Reports and intervention

- A child ends with `delegate_report{runId, status, summary, reportPath}`; verify the file at `reportPath`.
- `status:'blocked'` means it needs you: an approval, a question or a decision (design §3.8 `needs`). Read the report,
  then answer.
- A report is not a terminal run: the process may still be alive and still hold its slot. Call
  `delegate_status{runId}` first, always.
- Answer a blocked child with `delegate_resume{linkId, mode, prompt, request_key}` or end it with
  `delegate_cancel{runId}`.
- Resume only when status shows a terminal `currentRun.state` (`ended`, `failed`, `cancelled`) and `slotHeld:false`.
  `slot_busy` means the run or its slot is still alive: wait for the run to end or for retirement (blocked-wait 60
  min, max runtime 4 h, §4.3), or cancel and wait, then resume. Never retry in a loop.
- `status:'failed'`, an interrupted child, or a run that ended without a report: call `delegate_status{runId}` first,
  then resume, cancel or reconcile per contract 03. The ledger says what happened; the prose does not.
- `uncertain` (supervisor lost): read `reconciliation` in status. Show `hud run reconcile`; run it only when the user
  asks.
- Status `resumable` is advisory: the read path never attests capability, so its reason can be
  `capability_unverified` even when a resume would be accepted.

## 7. Cancel and resume

- `delegate_cancel{runId}` records the intent and returns without waiting for exit; `grace` is optional.
- Visible runs: cancel returns `cancel.unconfirmed` with `visible_scope_control_unavailable`. Tell the user to stop the
  run in its pane; never signal the pane yourself.
- `delegate_resume{linkId, mode, request_key, prompt, expectedRun}` starts a new round on the same link.
- Resume needs a terminal current run and a free slot, exactly as in §6: read `delegate_status` first.
- Pass `expectedRun` with the runId you saw. On `expected_run_mismatch`, re-read status and decide again.
- On `slot_busy`, wait for the run to end or for retirement, then retry with the same `request_key` and the
  `expectedRun` you saw. Do not retry in a loop.
- Never auto-retry a mismatch with a new key or a new `expectedRun`.

## 8. Cache advice and handoff

- `advice` is facts, not a verdict: `harness`, `auth`, `model`, TTLs and `provenance`; `null` means unknown.
- HUD warming is off; pi's native `cacheWarming` is the only warming loop.
- Decide in this order (§5.3): unrelated work → a new session with a clean brief; related work with outstanding
  children or approvals → keep this session alive; short pause → native wake or a bounded wait; long or unknown pause
  → hand off.
- Hand off with the `hud-handoff` skill: write the fixed-form handoff, then continue in a fresh session.
- Cache expiry alone does not invalidate the conversation; `handoffMinTokens` is advisory.
