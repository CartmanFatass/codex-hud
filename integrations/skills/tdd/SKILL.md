---
name: tdd
description: Test-driven development for HUD workers. Use when the brief asks for test-first implementation or red-green slices.
---

# Test-Driven Development

Adapted from mattpocock/skills `skills/engineering/tdd` @5863806 (MIT). Owned here; not tracked against upstream.

TDD is the red → green loop. This skill is the reference that makes that loop produce tests worth keeping: what a good test is, where tests go, the anti-patterns, and the rules of the loop. Every section applies on every cycle: consult them before and during the loop, not after.

When exploring the codebase, read `GLOSSARY.md` (if it exists) so test names and interface vocabulary match the project's domain language, and respect ADRs in the area you're touching.

## What a good test is

Tests verify behavior through public interfaces, not implementation details. Code can change entirely; tests shouldn't. A good test reads like a specification: "user can checkout with valid cart" tells you exactly what capability exists, and it survives refactors because it doesn't care about internal structure.

See [tests.md](tests.md) for examples and [mocking.md](mocking.md) for mocking guidelines.

## Seams: where tests go

A **seam** is the public boundary you test at: the interface where you observe behavior without reaching inside. Tests live at seams, never against internals.

**Test at the brief's seams.** Seams and test plans come from the brief; local choices within those seams are yours. Only if a new seam or test would change a contract, ask the orchestrator (`ask_orchestrator` on pi, or the `hud-ask` command in a CLI brief) with each proposed seam and a one-line note on what it catches and misses, then continue on unaffected parts.

## Anti-patterns

- **Implementation-coupled**: mocks internal collaborators, tests private methods, or verifies through a side channel (querying the database instead of using the interface). The tell: the test breaks when you refactor but behavior hasn't changed.
- **Tautological**: the assertion recomputes the expected value the way the code does (`expect(add(a, b)).toBe(a + b)`, a snapshot derived by hand the same way, a constant asserted equal to itself), so it passes by construction and can never disagree with the code. Expected values must come from an independent source of truth: a known-good literal, a worked example, the spec.
- **Horizontal slicing**: writing all tests first, then all implementation. Bulk tests verify _imagined_ behavior: you test the _shape_ of things rather than user-facing behavior, the tests go insensitive to real changes, and you commit to test structure before understanding the implementation. Work in **vertical slices** instead: one test → one implementation → repeat, each test a **tracer bullet** that responds to what the last cycle taught you.

## Rules of the loop

- **Red before green.** Write the failing test first, then only enough code to pass it. Don't anticipate future tests or add speculative features.
- **One slice at a time.** One seam, one test, one minimal implementation per cycle.
- **Refactoring is not part of the loop.** Leave refactoring outside the red → green implementation cycle.
- **Stay within the brief.** Do not commit, and do not invoke skills or spawn subagents the brief did not name (`call_sonic` / `call_reviewer` stay allowed when the brief asks for them).
- **Run the brief's checks** at the end (no full suite unless the brief asks).
