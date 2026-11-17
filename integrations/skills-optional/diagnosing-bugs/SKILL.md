---
name: diagnosing-bugs
description: Diagnosis loop for HUD workers investigating bugs, test failures, or performance regressions. Use when the brief asks to diagnose, debug, or find the root cause of broken, throwing, failing, or slow behavior.
---

# Diagnosing Bugs

Adapted from mattpocock/skills `skills/engineering/diagnosing-bugs` @5863806 (MIT). Owned here; not tracked against upstream.

A discipline for hard bugs. Skip phases only when explicitly justified. Do not commit, and do not invoke skills or spawn subagents the brief did not name (`call_sonic` / `call_reviewer` stay allowed when the brief asks for them).

When exploring the codebase, read `GLOSSARY.md` (if it exists) to get a clear mental model of the relevant modules, and check ADRs in the area you're touching.

## Redact and stay in the brief's environment

This skill has you inspect commands, outputs, and captured artifacts. **Redact every secret first**: write `<REDACTED>` in its place. Build loops against env vars, so credentials stay out of logs and reports. Quote only the lines that carry the signal.

Never touch production or user data. Run only within the environment the brief provides.

## Phase 1: Build a feedback loop

**Build a feedback loop that catches the brief's symptom first.** Once you have a **tight** pass/fail signal that goes red on _this_ bug, bisection over inputs or configs, hypothesis-testing, and instrumentation all become mechanical. Bounded reading of the code to orient yourself or locate a seam is allowed—just don't skip building a falsifiable loop before fixing.

### Ways to construct one, in roughly this order

1. **Failing test** at whatever seam reaches the bug: unit, integration, e2e.
2. **Curl / HTTP script** against a local test server (only if provided by the brief).
3. **CLI invocation** with a synthetic fixture input, diffing stdout against a known-good snapshot.
4. **Headless browser script** (Playwright / Puppeteer) if available in the brief's environment.
5. **Replay a captured trace.** Save a synthetic or redacted request / payload / event log to a scratch file and replay it in isolation.
6. **Throwaway harness.** Spin up a minimal subset of the system (one service, mocked deps) that exercises the bug code path with a single function call.
7. **Property / fuzz loop.** For "sometimes wrong output", run many synthetic inputs and look for the failure mode.
8. **Differential loop.** Run the same input through two configs or two already-built trees (never a checkout) and diff outputs.

### Tighten the loop

Once you have _a_ loop, **tighten** it: faster (cache setup, narrow scope), sharper (assert on the specific symptom, not "didn't crash"), and deterministic (pin time, seed RNG, isolate temp dirs).

### Non-deterministic bugs

Raise the reproduction rate: loop the trigger 100×, parallelise, add stress, narrow timing windows, or inject sleeps until it reproduces reliably enough to debug.

### When the environment cannot reproduce the bug

If reproducing the bug requires an environment the brief does not provide (Windows desktop, real user data, paid model calls, or network access), **stop that part and report the evidence gap**—list what you tried and what is missing. Ask the orchestrator (`ask_orchestrator` on pi, or the `hud-ask` command in a CLI brief) only if an alternative within the brief's scope could unblock you; otherwise move on to any unaffected parts.

### Completion criterion: a tight loop that goes red

Phase 1 is done when you can name **one command** you have **already run at least once** (redacted output recorded) that is:

- [ ] **Red-capable**: drives the actual bug code path and asserts the **brief's exact symptom**, going red now and green once fixed.
- [ ] **Deterministic**: same verdict every run (or a pinned high repro rate for flakes).
- [ ] **Fast**: seconds, not minutes.
- [ ] **Unattended**: runs non-interactively with no terminal prompts.

## Phase 2: Reproduce + minimise

Do not proceed to Phase 3 until the bug is reproduced and minimised.

Run the loop and confirm it produces the failure mode the **brief** describes (not a nearby unrelated failure) across multiple runs, and capture the exact symptom.

### Minimise

Shrink the repro to the **smallest scenario that still goes red**: cut inputs, callers, config, and steps one at a time, re-running after each cut, until every remaining element is load-bearing.

## Phase 3: Hypothesise

Generate **3–5 ranked hypotheses** before testing any of them. Each must be **falsifiable**:

> Format: "If <X> is the cause, then <changing Y> will make the bug disappear / <changing Z> will make it worse."

Record the ranked list in your notes/report and proceed testing your ranking. Only ask the orchestrator (`ask_orchestrator` / `hud-ask`) if a fix direction changes a contract, and continue on unaffected parts.

## Phase 4: Instrument

Each probe maps to one prediction from Phase 3. **Change one variable at a time.**

1. **Debugger / REPL inspection** if supported, or **targeted logs** at boundaries distinguishing hypotheses (never "log everything and grep").
2. **Tag every debug log** with a unique prefix, e.g. `[DEBUG-a4f2]`, so cleanup is a single grep.
3. **Perf path.** Establish a baseline measurement (timing harness, `performance.now()`, profiler, query plan), then use measurement bisection over inputs or configs (never moving `HEAD`). Measure first, fix second.

## Phase 5: Fix + regression test

- **If a correct seam exists** (one exercising the real bug pattern at the call site), write the regression test **before the fix**:
  1. Turn the minimised repro into a failing test at that seam and watch it fail.
  2. Apply the fix and watch it pass.
  3. Re-run the Phase 1 loop against the original (un-minimised) scenario.
- **Otherwise** (if no correct seam exists): do not add a shallow-seam test; apply the fix, re-run the Phase 1 loop against the original scenario, and note in your report that no correct seam exists. If adding a seam changes a contract, ask the orchestrator.

## Phase 6: Cleanup

Required before reporting done:

- [ ] Original repro no longer reproduces (re-run the Phase 1 loop)
- [ ] Regression test passes, or the report notes that no correct seam exists; the brief's checks pass (no full suite unless the brief asks)
- [ ] All `[DEBUG-...]` instrumentation removed (`grep` the prefix)
- [ ] Throwaway harnesses and scratch artifacts deleted
- [ ] Leave changes in the working tree (no commit); state the winning hypothesis (root cause) in your report
