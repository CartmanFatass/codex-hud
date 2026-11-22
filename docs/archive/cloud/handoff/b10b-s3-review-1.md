# B10B-s3 final review (Oracle, Opus max), round 1

Saved by the orchestrator from the reviewer's text. The review was read-only. Probes, mutants and benches ran on copies under the session scratchpad (`s3r/`).

**Verdict: fix required.** One P2, in rich navigation order. Every safety property holds. The P3s are optional.

## Findings

1. **`src/render/delegation/selection.ts:36-50`** (`destinationsOf`; also feeds `stopsOf` at 126-150 and `navigateDelegation`). **P2.**
   - **Defect:** In rich, the destinations stay in plan (depth-first) order, but `blocksOf` draws each native sub-row inside its nearest ancestor card. When a card's children mix natives and child cards (or a flat `↳` descendant), the drawn order differs from the destination order. ↑/↓, Home/End and `n`/`N` then leave screen order, which Q7 requires.
   - **Repro:** Root → A (delegated card) → N1 (native), B (delegated card), N3 (native, created after B). Screen order is A, N1, N3, B. ↓ from A walks A → N1 → B → N3 → N3. From N1, ↓ skips the visible N3. End lands on N3, inside A's card, above B.
   - **Fix:** Build the rich destinations in drawn order from `blocksOf`: a card's head, then its first five sub-rows, then the next block. Stops then follow. Add a test with this shape covering ↓, End and `n`.

2. **`src/render/monitor-input.ts:107-114`** (`onRow`) vs `control-bar.ts:272`. **P3.**
   - **Defect:** The key condition leaves out the bar's `keep >= 2` and whether a bar row is drawn at all. Below 32 columns, `o`/`L`/`R` act while ⇢/↻ are shed: 91 width/look/icon cases, and zero height too. This is below §4.2's 32-column floor; the legacy Switch behaves the same way.
   - **Fix:** Gate `rowAction` on the frame's drawn control, or document the floor.

3. **`src/render/control-bar.ts:357`** (decision 1). **P3.**
   - **Defect:** The row buttons' words drop at the `none` level together with the tabs' words, while the older button's word outlasts them. At 48 columns with both buttons, the bar shows a bare `⇢ ↻` next to 15–17 blank columns (`e-reconcile/48x12`; `g-resume/48x14`, which keeps `⊖ Hide`). The report's "a long older word" is wrong for `e-reconcile`, which has no older button.
   - **Fix:** Add a `none`-level attempt that keeps the row words, or shed ↻'s word before ⇢'s.

4. **`src/render/delegation/selection.ts:146`** (decision 5). **P3.**
   - **Defect:** Omitted conflict claims make their parent a stop. This is untested (a mutant that deletes the line survives), and it turns the root into a stop for conflicts the root cannot show.
   - **Fix:** The orchestrator ratifies it with a test, or defers it to segment 4.

5. **`tests/unit/b10b-s3-keys.test.ts:295-302`** (and `b10b-s3-selection.test.ts:298-303`). **P3.**
   - **Defect:** "A click on a ⊕N row selects it…" clicks the bar row at y = 0 and asserts `NOW > 0`; a mutant that refuses clicks on `put:` rows passes. The selection test never tests the hidden-node-to-ancestor case its name promises, and its filler assertion checks nothing.
   - **Fix:** Click the ⊕N line and assert the selection. Rename the selection test or drop the filler.

6. **`tests/unit/b10b-s3-input-keys.test.ts:167`**. **P3.**
   - **Defect:** The fake-`tmux` temp directory is never removed.
   - **Fix:** `t.after(() => fs.rmSync(bin, { recursive: true, force: true }))`.

7. **`docs/reference.md:125-127`, `docs/reference.zh.md:124-126`**. **P3.**
   - **Defect:** The `o` row omits Open. The `L`/`R` rows describe effects that nothing executes until B10D's dispatcher exists.
   - **Fix:** Add Open to the `o` row, and mark `L`/`R` as pending the dispatcher.

8. **`src/render/monitor.ts:912`**, pre-existing from segment 2. **P3.**
   - **Defect:** In the frame look, `titles.add(y)` marks the parent row instead of the title row. With a parent row, the parent line is width − 4 and the pane title is clipped inside the frame sides, which breaks the exact-width rule. Reproduced on the s2 base build.
   - **Fix:** `titles.add(y + lead)`, and frame the parent row like a body row.

## Verified

**Checks**
- `npm test`: 2436 tests, 2404 pass, 8 fail, 7 cancelled, 17 skipped. The failures are the known base ones (`b45-launch`, `hud-link-export`, `run-control`) plus one `b21-capacity` `ledger_busy` flake, which passes 5/5 alone.
- `test:mjs` 47/47; `test:core` 209 pass, 1 skipped; `test:visual` 331/331; `test:hud-mcp` 83 pass, 1 skipped; `b10b-*` 361/361.
- format, fixtures and diff-check clean.

**Frames:** 309 → 321 (12 added, 0 removed). Exactly the six listed frames changed. The other 303 frames are byte-identical. Legacy help identity is covered by a unit test, and a mutant fails it.

**Ownership and hygiene:** changes are limited to `src/render/**`, exactly the Q5 files, fixtures, the `b10b-s3-*` tests and the orchestrator's docs. There is no diff in `tree-page.ts`, core, collectors, packages, contracts or the design doc. Synthetic data only.

**Safety properties**
- **Keys and buttons:** both come from the same `rowActions`. A key acts only when its button is drawn; the only gap is finding 2, below 32 columns.
- **Sweep:** 3840 frames and 61,440 key presses.
  - Every line is exactly the width (apart from finding 8), and nothing throws.
  - Navigation keys and Enter/Space/`v` never emit an action.
  - Every copy carries the view model's own descriptor object.
  - Every action's key equals the selection.
  - Greyed clicks do nothing.
- **No command building:** the panel never builds a command (`actions.ts:105-110`). Mutants that clone the descriptor or build a command are killed.
- **No action without input:** paint, ticks and reconciles never act.
- **Selection follows nodes:** all seven Q2 cases are tested. Keys resolve against the frame the user saw.
- **Q6 flag:** correct. The `q6-flag`, `q6-clear` and `q6-false` mutants are killed, and a legacy state never carries the key.
- **Q5:** no key that reaches Codex today is lost. tmux uses `bind_command 0` with no `-r`, and the closed-panel no-op lists match.

**Mutation testing:** 47 mutants; 42 killed. Two survivors are equivalent. Three are real test gaps: findings 4 and 5, plus `l` on the fifth sub-row when its children are overflow.

**Rulings:** Q1–Q7, Enter and the defaults are implemented as ruled. Decisions 2–4 are fine.

**Decision 1: keep it.** It delivers §4.9's `⇢ Log` and `⇢ Log ↻ Resume` with words at 48 columns. Read literally, "through all" would give a bare ⇢ there, contradicting §4.9 and the ruling's own note on §4.13. Reverting it fails 16 tests and frames. The orchestrator should record it as the reading of default 3.

## Performance

p99 in ms over three runs on an idle host; n = 1000 after 200 warm-up, nearest-rank.

| Gate | Limit | p99 per run |
|---|---|---|
| compact no-change | 2 | 0.95 / 1.37 / 0.89 |
| rich no-change | 2 | 1.08 / 1.22 / 1.07 |
| compact changed | 10 | 9.47 / 9.15 / 8.95 (≈ 5% margin) |
| rich changed | 15 | 10.03 / 11.03 / 8.89 |

The gated "no-change" tick moves the selection every tick, so it is stricter than §6 #16.

The whole `renderMonitor` no-change tick was already above 2 ms on the s2 base:

| | s2 base | s3 |
|---|---|---|
| compact | 2.09–2.51 | 2.41–2.91 |
| rich | 3.41–3.59 | 3.31–4.90 |

Changed whole ticks stay within B10's render share (≤ 15 ms). Selection adds about 0.1–0.2 ms. **This does not bear on acceptance #4.** Record it as a pre-existing open item for B14's end-to-end gate. The implementer's numbers reproduce.
