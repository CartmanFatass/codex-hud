---
name: hud
description: Show or collapse the shared interactive HUD dock. Use when the user invokes /hud.
disable-model-invocation: true
---

Run one `hud panel` command with Bash and report the state it prints (`opened`, `shown`, `hidden`, or `closed`), or report the error without retrying:

- bare `/hud` or `/hud toggle`: `hud panel` (shows or collapses the dock without stopping it)
- `/hud on`: `hud panel open` (opens or expands a collapsed dock)
- `/hud off`: `hud panel hide` (collapses the dock without stopping it)
- `/hud close`: `hud panel close` (stops the dock process)
- `/hud status`: `hud panel status` (reports `shown`, `hidden`, or `closed`)
