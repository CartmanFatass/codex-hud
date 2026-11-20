# UX-PASS milestone review (reviewer, 2026-11-20)

Range `4bdb9207^..2ebfb5f2`, PROJECT-CLI-PLACES excluded.

Verdict: changes-required

Spec — blocking

1. S4 hides the current pi provider when the role uses a resolvable bare model ID. `src/render/model-input.ts:53–61` counts `p.model` for explicit assignments, although the Control snapshot already supplies the qualified ID in `p.piModel.current` (`src/roles/role-control.ts:173–184`). In a synthetic chain with `gpt-current` resolving to `openai/gpt-current` and another place naming `arena/gpt-other`, the picker pins the current model but puts the OpenAI group behind “other.” Typing `gpt` puts the arena result before both OpenAI results. The current provider should be open and first in browse, and should be treated as in use by the filter. Count the resolved current ID already in the snapshot; leave genuinely ambiguous bare IDs uncounted. No new settings read or discovery is needed.

No further scope blocker found. The quick choice uses the existing `preset-edit op:run` writer, draft changes stay in memory, automatic zoom was removed, and CLI and AI Studio use the shared flat picker. The quota and panel changes use existing inputs; I found no new data source, poll, timer, subprocess, or on-disk format in the UX-PASS code. PROJECT-CLI-PLACES and the separate OWNER-VIEW spec decisions in the range were not evaluated as UX-PASS changes.

Simplicity and quality — blocking

2. The Control draft footer advertises `? help` but pressing it asks the owner to discard the draft. `src/render/chain-input.ts:186–193` treats Help as a leave action, and `src/render/monitor-input.ts:34,53` dispatches the chain before Help; the draft footer at `src/render/chain-input.ts:332–335` gets the pinned hint. Reproduced with a synthetic Control draft: Help remained closed and `controlChain.leave.key` was `help`. An owner looking up a key mid-edit must either abandon Help or throw away work to see it. Open Help over the draft, handle Help navigation before the underlying chain while it is open, and return to the same draft and place. Keep discard confirmation for actions that actually leave the draft, and keep text-input dialogs in charge of their own keys.

What can be deleted (non-blocking)

- `src/render/workboard-rows.ts:62–63` still exports the old `hintText`; its remaining import in `src/render/control-page.ts:11` is unused. All callers of `footRow` and `footerLayout`, including the picker, now use lists or `{ modal: [...] }`. Remove the string alternative and its legacy translation branch in `footerLayout`, along with the corresponding string branch in `src/render/filter.ts:71`. Keep the answer-key fitting beside expanded question options.

Optional

- Add a regression for each finding to the existing picker and Help tests. The useful boundaries are uniquely attributable versus ambiguous bare IDs, and opening/closing Control Help without losing the draft or moving its cursor. The current Help anchor tests exercise tabs at rest, not a draft.

Files read / checks

- Brief, agent and handoff docs, `docs/delegation.md`, `docs/spec.md`, `.scratch/ux-pass/spec.md`, picker tickets, both `docs/design/ux-pass/` designs, `docs/ARCHITECTURE.md`, and the EN/ZH reference diffs. Inspected `git diff 4bdb9207^..2ebfb5f2` for UX-PASS, including the picker, Control input and live writer, pi subscription/grant and shared bar renderer, footer/input/Help, EXP, Harnesses, and Project/Progress rendering along with their test and fixture changes. Consulted the existing Control attribution code to verify the snapshot fields.
- `git status --short`, `git rev-parse HEAD`, `git diff --name-only 2ebfb5f2..HEAD`: clean checkout at `adb30df72f456d8a403f016b95525edce0fbcae5`; only the 05 ticket and handoff ledger differ after the requested endpoint.
- `git diff --check 4bdb9207^..2ebfb5f2`: no issues. `./tmp/env.sh npm run check:fixtures`: OK.
- `./tmp/env.sh node --test tests/unit/{model-picker,model-picker-pane,panel-footers,panel-keys-rows,exp-page,control-tab,split-layout,kept-pages}.test.mjs`: 79 passed, 0 failed.
- `./tmp/env.sh node --test tests/unit/exp-proxy.test.mjs`: 8 passed, 0 failed. `./tmp/env.sh node --test dist-test/tests/unit/{bar-widths,bar-themes,pi-footer}.test.js`: 33 passed, 0 failed.
- `./tmp/env.sh node --input-type=module -e …`, importing `pickOf`/`pickView` and `handleMonitorInput` from `dist/`: both synthetic reproductions above confirmed. Tests used Node v24.22.1 and the existing compiled output; the read-only harness blocked a fresh scratch build. No full suite or live herdr session run.
