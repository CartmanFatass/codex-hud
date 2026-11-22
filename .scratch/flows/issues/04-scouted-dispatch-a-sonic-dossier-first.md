# 04: Scouted dispatch: a sonic dossier first

**Status:** done
**Blocked by:** none

**What to build:** D-2026-11-22-19. `hud_create({ role, task, scout: "<question>" })`: HUD first runs a sonic job (role default) with the question and the task's context_files, then creates the target job with the sonic job in from_jobs; one notice/task covers both. If the scout fails, the target still starts, with the failure noted in its brief. Spec §2.1.4 one sentence.

- [ ] hud_create with scout starts sonic, then the target with from_jobs set, without a main-session call
- [ ] npm test and check:fixtures pass

## Comments
