# MyHUD documentation archive

These records describe earlier versions of codex-hud and Universal HUD. They do
not define current behaviour or requirements: use the [product spec](../spec.md),
[architecture](../ARCHITECTURE.md), and [workflow](../delegation.md) instead.

| Location | Historical material |
| --- | --- |
| [root/](root/) | Early codex-hud reports, benchmarks and plans; the Universal HUD concept and engineering plan before the 2026-11-10 reset. |
| [cloud/](cloud/) | November 2026 cloud and dots briefs, handoffs, rulings and test evidence for the R0–R7 effort. |
| [cloud-development/](cloud-development/) | The November 2026 cloud development handbook and C–F roadmap. |
| [contracts/](contracts/) | November 2026 contracts 01–07 for the retired execution platform. |
| [architecture/](architecture/) | November 2026 native and managed harness architecture proposals. |
| [reviews/](reviews/) | Reviews dated before 2026-11-10, plus old UI-audit scripts and outputs. |
| [design/](design/) | Early November 2026 design notes and the Panel v7 concept. |
| [handoff/](handoff/) | Early November 2026 handoffs, B10D reports, and historical owner questions. Earlier STATE ledgers remain in [handoff/archive](../handoff/archive/). |
| [issues/](issues/) | The old [issue index](../../ISSUES.md)'s records. Current tickets live under `.scratch/`. |
| [statusline/](statusline/) | Early November 2026 statusline drafts and validation records. |
| [superpowers/](superpowers/) | September–November 2026 plans for the older panel and statusline. |
| [fig/](fig/) · [examples/](examples/) | Old codex-hud screenshots and retired routing configuration examples. |

The moved files are unchanged, so some links and commands inside them refer to
the old tree. Use Git history to see a file in its original context, for example:

```sh
git log --follow -- docs/archive/root/universal-hud-concept.md
```

Ripgrep skips this archive by default. Search it with `rg -u` or `git grep`, or
return to the [current documentation index](../README.md).
