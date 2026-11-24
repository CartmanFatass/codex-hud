# 02: Advisor shadow names the owner rules a main-session reply broke

**Status:** ready-for-human
**Owner try:** yes
**Blocked by:** 01

**What to build:** Spec §2.2 advisor shadow (D-2026-11-24-07). Setting `advisorRulesFile` (absolute path; default empty = no rule checks), read under the same `advisorShadow` switch as ticket 01. Format: Markdown list lines `- R<n>: <one sentence>`; at most 30 rules / 8 KiB; other lines ignored; re-read when the file's mtime changes. Trigger: a main session's assistant reply ends (Claude Code Stop / pi agent end), at most once per reply. Input to the Decision API, same discipline as ticket 01 (quoted untrusted data, scrubbed, own timeout): the owner's latest message (at most 2000 chars) and the reply (its last 4000 chars), plus the rules. Output: one yes/no predicate per rule, 'did this reply clearly break the rule?', with the statement that no is the default unless the reply plainly breaks it. Batch all rules in one call. Show, never inject: the bar notice zone shows `rules: R2 R5` for 10 minutes (next to the skill item from 01, same icon-set handling); the panel line under the session's project lists each broken rule's id and sentence. Nothing reaches any session, prompt or hook output. Record once: append `{kind: 'rule_hits', session, rules: ['R2', ...], at, ms}` to `$HUD_HOME/events/<YYYY-MM>.jsonl` (only when at least one rule is hit; count calls with no hit as a number on the same month's advisor counters, not one event per reply).

- [x] With a fixture rules file and a stubbed Decision API flagging R2 and R5, the bar shows `rules: R2 R5` and the panel lists both sentences; no hit shows nothing
- [x] Missing or oversized rules file disables rule checks without errors; mtime change reloads
- [x] No session, prompt or hook output receives advisor text (same test as 01)
- [x] docs/reference.md describes the rules file format and the shadow display
- [x] Owner try: turn on with the owner's approved rules file and watch for a few sessions

## Comments

- Landed in this commit (replay base c9d7e9d11446a1f46efcaf26ed7c888edb014fd2); gate 5/5 passed.
