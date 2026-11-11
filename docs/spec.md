# HUD product spec (draft for the owner)

Status: **draft, 2026-11-10.** Only the owner changes this page. It is the boundary for every brief, answer and
review. When anything here conflicts with the concept document or older decisions, this page wins.

## 1. What it is

One HUD for Claude Code, Codex and pi, used by one person (the owner) on one Linux/WSL machine, inside herdr.

## 2. What it must do

1. **Delegate through one MCP.** From any of the three main sessions, start and use the fixed roles (imp, reviewer,
   sonic, oracle, jev) with six tools: `hud_roster`, `hud_create`, `hud_read`, `hud_send`, `hud_respond`,
   `hud_close`. CLI roles run through herdr and pi-roles; browser jobs run through Jev. The main session decides
   every next step; the HUD never chains roles itself.
2. **Show what is happening.** A side panel (Home, Work) shows the main session's jobs and their state. Each client
   keeps one status line: Claude's statusline (replacing claude-hud, same fields as the owner uses), pi's footer
   (taking in p10k-footer), Codex's existing tmux bar.
3. **Install and uninstall in one command.** `./install` with core plus chosen extensions (Claude, pi, Codex, Jev,
   herdr); `hud uninstall` removes them. Registration uses each client's official commands where they exist.

## 3. What it does not do

- No own execution platform: no ledger database, process supervisor, native host or bridge, no SDK-driven sessions.
  herdr, pi-roles and Jev already do execution.
- No workflow engine and no automatic role chaining.
- No multi-user or adversarial security model; no identity proofs between local processes.
- No transactional installer: no plan IDs, receipts or byte-exact restore. A plain backup of each edited client file
  is enough.
- No vendor version pins.
- No Windows native, no npm publishing, no cross-machine use.

## 4. Threat model and quality bar

- Trusted: the owner, the owner's own configs and tools. Guard against only two things: **irreversible loss of the
  owner's data or config**, and **running commands from an untrusted repository** (for example git config in a
  cloned repo).
- Everything else takes the simplest implementation that works. A new guard, option or abstraction needs a concrete
  reason written in the brief.
- Lightweight: no resident service; the statusline and panel stay at least as fast as what they replace.
- **Done means the owner can install it and use it**, not that the tests are green.

## 5. Milestones

- **M1, usable:** `./install` (core + Claude, pi, Codex extensions) and uninstall; MCP and skill registered in all
  three clients; `hud panel`; the six tools work for imp, reviewer and sonic through herdr. The owner installs and
  uses it.
- **M2, replace:** Claude statusline at claude-hud parity; pi footer replacing p10k-footer; Jev and oracle jobs.
- **M3, clean:** delete the retired execution stack (R6b slice L) and its tests.

## 6. How work is done

See `docs/delegation.md`. In short: each brief names the spec line it serves, what is out of scope, a size budget
and a stop rule. Review happens at milestones and before the owner installs, not per package. The owner trying the
build is the main review.
