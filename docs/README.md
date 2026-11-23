# MyHUD documentation

Start with the product spec for what HUD supports, the reference for how to use it,
and the architecture for how it works.
The [decisions log](decisions-log.md) records the history behind the spec, including superseded decisions.

## Core documents

| Document | Use it for |
| --- | --- |
| [Product spec](spec.md) | The active product boundary and milestones. It takes precedence over older documents. |
| [Architecture](ARCHITECTURE.md) | Processes, data flows, rendering, and rules for changes. |
| [Reference](reference.md) · [简体中文](reference.zh.md) | Installation, configuration, commands, and troubleshooting. |
| [Optional skills](optional-skills.md) | Skills shipped but not installed, for the main session to read on request. |
| [Delegation](delegation.md) | The workflow for decisions, slices, reviews, and acceptance. |

## Working documents

| Location | What lives there |
| --- | --- |
| [Project state](handoff/STATE.md) | Current milestone, open questions, and slice ledger. The Project page reads this file. |
| [Reviews](reviews/) | Dated reviews from 2026-11-10 onward. The Project page uses this directory for its latest-review link. |
| [Design](design/) | Current UI samples and design generators used by tests. |
| [Agents](agents/) | Ticket tracker, triage labels, and domain-document conventions. |
| [Releases](releases/) | Published release notes. |
| [Statusline](statusline/) | Parity coverage, native client details, and opt-in observation. |
| [Probes](probes/) | Historical probe records kept at their existing paths for the fixture scan. |

## Historical material

See the [archive index](archive/) for superseded plans, designs, old issues, and
cloud records. Earlier Project ledgers remain in the [handoff archive](handoff/archive/).
By default, ripgrep skips `docs/archive/`; use `rg -u` or `git grep` to search it.

## Source release

The source archive ships `spec.md`, `ARCHITECTURE.md`, `reference.md`, `reference.zh.md`,
and `optional-skills.md` from `docs/`. Working documents and historical records
are available in the repository, not the source archive.
