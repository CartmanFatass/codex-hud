# 06: The HUD ships as one release archive

**What to build:** one `hud-<version>.tar.gz` built from the repo, with `./install` inside (core plus the Claude, pi,
Codex, browser and herdr extensions as chosen), installable and uninstallable without the git checkout;
universal-hud is merged into main and the version is tagged.

**Blocked by:** 05

**Status:** ready-for-agent

- [ ] The archive installs into a clean temp HOME and `hud uninstall` removes it; the owner's real setup is untouched by the test
- [ ] No secrets, local paths or synthetic-only fixtures leak into the archive
- [ ] universal-hud merged into main, version tagged

**Owner (2026-11-12):** before the release, after both milestone reviewers accept, the architect role (Astra) reviews
the whole project once more (structure, boundaries, stability, cost). Its answer is advice: the orchestrator decides
which points block, asks the owner on unclear trade-offs, and fixes the blocking ones before packaging.
