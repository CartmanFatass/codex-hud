# 03: hud_land records the landing in the ticket and STATE

**Status:** claimed
**Blocked by:** 01

**What to build:** When the job carried `ticket` (`<feature>/<NN>`) the landed ticket becomes ready-for-human with its acceptance ticked and a landing comment (SHA, gate counts). When the project keeps a STATE ledger, append one `try` slice line from the job's signature-bound hud_report summary and the landed SHA, under the job's slice or package name. Commit these with pathspec and push with the landing. Projects without a ledger or ticket skip this step.

- [ ] A land with ticket and slice updates both and commits them with pathspec
- [ ] A project without STATE or tickets lands without errors
- [ ] npm test and check:fixtures pass

## Comments
