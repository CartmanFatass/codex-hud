# 06: Model-facing text matches current lifecycle behaviour

**Status:** ready-for-agent
**Owner try:** no
**Blocked by:** none

**What to build:** Reviews: src/roles/tool-definitions.ts:83 and integrations/skills/hud-delegate/SKILL.md:16,27,61 still teach read-driven closure and 'a tab for every job', while spec §2.1.5 closes declared workers at turn end and routing may run headless; docs/reference.md:422-423 still says ./install does not register the Claude mod. Fix the text, keep schema bytes flat or smaller.

- [ ] Tool definitions and hud-delegate skill describe turn-end closure and headless routing correctly
- [ ] reference.md/zh install line fixed
- [ ] Tool schema bytes not larger than before

## Comments
