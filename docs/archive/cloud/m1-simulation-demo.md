# M1 cloud simulation demo

Run from this branch with Node 22 >= 22.13 or Node 24:

```sh
npm ci
npm run build
node scripts/demo-cloud-m1.mjs
```

The script uses actual project entrypoints in one repeatable walkthrough:

1. `bin/hud pi inspect` reads a synthetic pi v3 JSONL session, displays bounded
   observation JSON, checks token/context/cost fields and no transcript-body export.
   The supplied 1,000-token context window is a fixture assumption, not a model lookup.
2. `bin/hud pi launch --executable <node> -- <synthetic-child> ...` starts a tiny
   synthetic executable and checks exact argv and working-directory forwarding.
   This child is **not pi** and does not contact any provider.
3. `bin/hud-statusline-preview` renders a synthetic Claude stdin payload as
   `Claude (simulated) · ctx 42% · $0.12`.
   USD is Claude-provided estimated session cost, not an actual invoice.

A temporary HOME/HUD_HOME and an allowlisted environment isolate the demonstration
from user settings and credentials. Fixtures and child script are removed in
`finally`; the script never installs configuration. Each child has a 10-second
harness timeout, not a product latency guarantee. Assertion failures are visible,
exit nonzero and are not retried. Building writes only project build outputs.

## Provenance and scope

Base: `4899b3f5802657520509e5c0db1918395b031257`, including pi inspection and existing
Claude reader upgrades. Launch files are unchanged from reviewed
`8a5c4ee0bc6f397549f6e467983152adb0b7eb94`; preview files are unchanged from reviewed
`9f9ba8377e541e14157fe8046995b4f8854afa2d`. New work is only this guide and script.
No active collector/visibility or separate Claude action/Todo work is replaced.

Fixture shapes follow official documentation, with invented identifiers/values:

- [Pi session format](https://github.com/earendil-works/pi/blob/9b9cb30ae16e5802ba556b282b38fc41117ee5e1/packages/coding-agent/docs/session-format.md)
- [Pi CLI](https://github.com/earendil-works/pi/blob/9b9cb30ae16e5802ba556b282b38fc41117ee5e1/packages/coding-agent/docs/cli.md)
- [Claude statusline input](https://code.claude.com/docs/en/statusline)

This proves a **simulation walkthrough of three independently usable surfaces**,
not a connected cross-harness lifecycle or full Phase C/D completion. It does not
verify a real pi/Claude installation, provider authentication, managed
spawn/resume, MCP identity, panel collection, or default statusline replacement.
It does not consume RPC or claim `agent_settled` support. Launch retains the
reviewed signal limitation: only INT/TERM forwarded, other child signals map to 1.
See [launch scope](../pi-local-launch.md) and
[preview scope](../statusline/stdin-preview.md) for remaining integration work.
