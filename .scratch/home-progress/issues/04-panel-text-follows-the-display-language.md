# 04: Panel text follows the display language

**Status:** claimed
**Blocked by:** 03

**What to build:** Design slice 4 PANEL-LOCALE with owner answer 'translate': strip Slice/Ticket prefixes keeping -NN suffixes; <ID> · localized name from job sentences; to-try briefs also refresh on Home; WaitingBriefs: cached display-model translation of waiting items, open worker questions and open ticket titles not in the panel language, original folded below; convention: the orchestrator writes Waiting in the owner's language. Spec §2.2.4 and §2.2.8 sentences as told to the owner.

- [ ] With language zh, English waiting items, worker questions and ticket titles show in Chinese with the original folded
- [ ] No model call for text already in the panel language
- [ ] npm test and check:fixtures pass

## Comments
