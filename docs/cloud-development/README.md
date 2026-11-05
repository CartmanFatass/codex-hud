# Universal HUD: cloud development documentation

This documentation set describes a cloud-first continuation of the Universal HUD project. It is the owner-requested operational revision, not evidence that an implementation, test, provider integration, or release has passed. It was prepared against integration commit `4899b3f5802657520509e5c0db1918395b031257` on 2026-11-05. Branches move; resolve and record the current target SHA before starting work.

- [Cloud development handbook](cloud-development.md): setup, isolation, checks, simulation and evidence.
- [Revised development roadmap](cloud-roadmap.md): independent slices, dependencies and next actions.
- [Engineering plan](../universal-hud-engineering-plan.md): original A–F scope and historical status; its global phase order is superseded for the cloud-development workflow described here. Its contract and safety requirements are not silently changed.
- [Contracts 01–07](../contracts/), [architecture](../ARCHITECTURE.md), [design](../design/hud-information-design.md), and [handoff state](../handoff/STATE.md): technical specifications and historical context. Resolve any behavioural conflict explicitly; do not silently change an executable contract.

Existing cloud instructions in `AGENTS.md`, `docs/cloud/README.md`, and `docs/cloud/dots.md` contain the earlier prohibition on simulating local-only work and phase sequencing. For this plan, *simulation is allowed and labelled as simulation*; it does not assert that a live provider or native platform has been validated. Follow the rest of the repository safety and isolation instructions. This documentation does not itself change code, CI, permissions, or supported-product claims.
