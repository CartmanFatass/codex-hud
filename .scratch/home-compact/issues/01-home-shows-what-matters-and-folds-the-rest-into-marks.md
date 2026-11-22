# 01: Home shows what matters and folds the rest into marks

**Status:** in-progress
**Blocked by:** none
**Owner try:** yes

**What to build:** Owner 2026-11-22: redesign Home so the important facts stay readable and secondary ones become icons, numbers, abbreviations and colour. Sonic is secondary: it is no longer shown as its own rows, only as an icon plus a number on its parent worker. Sample first (`docs/design/home-compact/sample.html`), then the build (job jac2f1a1c3b85ed15, general).

Owner addenda the same day (sent to the job 2026-11-22):
- The sonic mark on a worker counts only its sonic queries running now, never a cumulative total.
- A finished card hides from Home 5 minutes after it settles: the default `cardHideMinutes` goes from 15 to 5 (`cardFoldMinutes` stays 5; Settings still changes both). Asking, failed and flow rules in `src/render/work-visibility.ts` stay.

- [ ] Sample opened in the owner's browser and settled
- [ ] Sonic shows only as icon + running count on its parent worker
- [ ] Finished cards hide after 5 minutes by default
- [ ] Panel width rules (§8) hold; references updated in both languages
