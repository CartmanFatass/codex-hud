# Triage Labels

The skills speak in terms of five canonical triage roles, plus two execution lifecycle statuses (`claimed` and `done`) used in `.hud/tickets/<feature>.json`. This file maps those roles to the `status` strings stored in this repo's ticket store.

| Role / lifecycle           | `status` in our tracker | Meaning                                                                                                   |
| -------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------- |
| `needs-triage`             | `needs-triage`          | Maintainer needs to evaluate this ticket                                                                  |
| `needs-info`               | `needs-info`            | Waiting on reporter or owner decision for more information                                                |
| `ready-for-agent`          | `ready-for-agent`       | Fully specified, ready for an AFK agent                                                                   |
| `ready-for-human`          | `ready-for-human`       | Requires human implementation or owner try (`owner_try: true` lands here)                                 |
| `claimed`                  | `claimed`               | Explicitly claimed for manual or wayfinding work (live HUD jobs claim tickets at read time without edits) |
| `done`                     | `done`                  | Completed and verified (`hud_land` records `done` by default when `owner_try` is `false`)                 |
| `wontfix`                  | `wontfix`               | Will not be actioned (dropped)                                                                            |

## Lifecycle notes

- Legacy `resolved` (and historical `closed` / `accepted` / `complete` aliases) maps to `done`; always write `done` in `.hud/tickets/*.json`.
- Live HUD jobs claim `ready-for-agent` tickets dynamically from job receipts — leave `status: "ready-for-agent"` in the store until `hud_land` records `done` (or `ready-for-human` when `owner_try: true`), or `hud_tickets({op: "update"})` sets `done` / `wontfix`.
- When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding `status` string from this table.
